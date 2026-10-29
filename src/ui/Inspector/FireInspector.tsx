import { Fragment } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { EntityId } from '@/core/types';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { useViewStore } from '@/rendering/viewStore';
import { Section } from '@/ui/common/Panel';
import { fmt } from '@/ui/format';
import { FIRE_STATES, IK, isBurning } from '@/fire/FireWorld';
import { FUEL_IDS, FUEL_MATERIALS } from '@/fire/materials';
import { visibility } from '@/fire/relations';
import { energyText, powerText } from '@/thermal/units';
import styles from './Inspector.module.css';

const C = (K: number) => `${fmt(K - 273.15, 0)} °C`;

function Rows({ rows, testId }: { rows: [string, string][]; testId: string }) {
  return (
    <div className={styles.liveGrid} data-testid={testId}>
      {rows.map(([k, v], i) => (
        <Fragment key={`${k}:${i}`}>
          <span>{k}</span>
          <span>{v}</span>
        </Fragment>
      ))}
    </div>
  );
}

/**
 * Fire state of the selected object (Phase 27): its fuel items (material, state, remaining fuel,
 * moisture, incident flux, heat release, released energy, char depth, ignition time and cause), for
 * buildings the rooms (gas temperature, O₂, smoke, openings, heat release inside / outside, flashover)
 * and the picked member; for people their smoke exposure. Computed values only.
 */
export function FireObjectSection({ id }: { id: EntityId }) {
  const t = useT();
  useSimStore((s) => s.time);
  const pick = useViewStore((s) => s.simMember);
  const env = simulationController.getEnvironment();
  const fr = env.fire.rt;
  if (!fr) return null;
  const e = simulationController.getRuntime()?.entities.get(id);
  if (e?.source.type === 'human') {
    const x = e.exposure?.fire;
    if (!x) return null;
    return (
      <Section title={t('fire.inspect.title')}>
        <Rows testId="fire-exposure" rows={[
          [t('fire.inspect.smoke'), `${fmt(x.smoke * 1000, 3)} g/m³ (${t('fire.inspect.peak')} ${fmt(x.peakSmoke * 1000, 3)})`],
          [t('fire.inspect.visibility'), Number.isFinite(x.visibility) ? `${fmt(x.visibility, 1)} m (${t('fire.inspect.min')} ${fmt(x.minVisibility, 1)})` : t('fire.inspect.clear')],
          [t('fire.inspect.oxygen'), `${fmt(x.oxygen * 100, 1)} % ${t('fire.inspect.byMass')}`],
        ]} />
        <div className={styles.note}>{t('fire.inspect.noPhysiology')}</div>
      </Section>
    );
  }
  const fw = fr.fw;
  const items = fr.itemsOf(id);
  const rooms = fr.rooms.filter((R) => R.bt.e.id === id);
  if (!items.length && !rooms.length) {
    return (
      <Section title={t('fire.inspect.title')} defaultOpen={false}>
        <div className={styles.note} data-testid="fire-nofuel">{t('fire.inspect.noFuel')}</div>
      </Section>
    );
  }
  const w = fr.trt.world;
  let m0 = 0, m = 0, E = 0, hrr = 0, burning = 0, charred = 0, maxChar = 0;
  for (const i of items) {
    m0 += fw.m0[i]; m += fw.m[i]; E += fw.E[i]; hrr += fw.hrr[i];
    if (isBurning(fw.state[i])) burning++;
    if (fw.char[i] > 0) { charred++; maxChar = Math.max(maxChar, fw.char[i]); }
  }
  const rows: [string, string][] = [
    [t('fire.inspect.items'), t('fire.inspect.itemsValue', { n: items.length, b: burning })],
    [t('fire.inspect.fuel'), `${fmt(m, 0)} / ${fmt(m0, 0)} kg (${fmt(m0 > 0 ? (100 * m) / m0 : 0, 0)} %)`],
    [t('fire.inspect.hrr'), powerText(hrr)],
    [t('fire.inspect.released'), energyText(E)],
  ];
  if (charred) rows.push([t('fire.inspect.char'), t('fire.inspect.charValue', { n: charred, d: fmt(maxChar * 1000, 0) })]);
  // The single item of a tree crown / trunk, or the picked member.
  const detail: number[] = [];
  if (e?.source.type === 'tree') detail.push(...items);
  else if (pick && pick.owner === id) { const k = fr.itemsByMember(id)?.get(pick.member); if (k !== undefined) detail.push(k); }
  return (
    <Section title={t('fire.inspect.title')}>
      <Rows testId="fire-object" rows={rows} />
      {detail.map((i) => {
        const mt = FUEL_MATERIALS[fw.mat[i]];
        const r: [string, string][] = [
          [t('fire.inspect.material'), t(`fire.fuelMat.${FUEL_IDS[fw.mat[i]]}` as MessageKey)],
          [t('fire.inspect.state'), t(`fire.state.${FIRE_STATES[fw.state[i]]}` as MessageKey)],
          [t('fire.inspect.fuel'), `${fmt(fw.m[i], 1)} / ${fmt(fw.m0[i], 1)} kg`],
          [t('fire.inspect.surfaceT'), C(fw.surfaceT(i))],
          [t('fire.inspect.nodeT'), C(fw.fuelT(i))],
          [t('fire.inspect.incident'), `${fmt(fw.qInc[i] / 1000, 1)} kW/m²${fw.pilot[i] ? ` · ${t('fire.inspect.pilot')}` : ''}`],
        ];
        if (mt.thin) r.push([t('fire.inspect.moisture'), `${fmt(fw.m[i] > 0 ? (100 * fw.water[i]) / fw.m[i] : 0, 0)} %`]);
        if (!mt.thin) r.push([t('fire.inspect.ftp'), `${fmt(fw.ftpP[i] / 1e9, 2)} GW²s/m⁴`]);
        r.push([t('fire.inspect.hrr'), powerText(fw.hrr[i])]);
        if (fw.char[i] > 0) r.push([t('fire.inspect.charDepth'), `${fmt(fw.char[i] * 1000, 1)} mm`]);
        if (!Number.isNaN(fw.tIgn[i])) r.push([t('fire.inspect.ignited'), `${fmt(fw.tIgn[i], 1)} s · ${t(`fire.cause.${fr.cause[i] || 'flux'}` as MessageKey)}`]);
        if (fw.kind[i] === IK.member || fw.kind[i] === IK.heap) r.push([t('fire.inspect.side'), t(fw.room[i] >= 0 ? 'fire.inspect.inRoom' : 'fire.inspect.outdoors')]);
        return <Rows key={i} testId="fire-item" rows={r} />;
      })}
      {rooms.map((R) => {
        const F = fw.rooms[R.r], cp = w.comps[F.tc];
        const r: [string, string][] = [
          [t('fire.inspect.room', { n: R.story + 1 }), cp.alive ? C(w.compT(F.tc)) : t('fire.inspect.roomOpen')],
        ];
        if (cp.alive) {
          r.push(
            [t('fire.inspect.oxygen'), `${fmt((100 * F.o2) / F.gas, 1)} % ${t('fire.inspect.byMass')}${F.ventLimited ? ` · ${t('fire.inspect.limited')}` : ''}`],
            [t('fire.inspect.smoke'), `${fmt((F.soot / F.V) * 1000, 2)} g/m³ · ${t('fire.inspect.visibilityShort', { S: Number.isFinite(visibility(F.soot / F.V)) ? fmt(visibility(F.soot / F.V), 1) : '∞' })} · ε ${fmt(F.eps, 2)}`],
            [t('fire.inspect.openings'), `${fmt(F.Ao, 1)} m² · ${fmt(F.inflow, 2)} kg/s`],
            [t('fire.inspect.roomHrr'), `${powerText(F.hrr)} + ${powerText(F.hrrExt)} ${t('fire.inspect.outside')}`],
          );
          if (!Number.isNaN(F.flashover)) r.push([t('fire.inspect.flashover'), `${fmt(F.flashover, 0)} s`]);
        }
        return <Rows key={`r${R.r}`} testId="fire-room" rows={r} />;
      })}
      <div className={styles.note}>{t('fire.inspect.note')}</div>
    </Section>
  );
}
