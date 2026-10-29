import { Fragment } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { EntityId } from '@/core/types';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { useViewStore } from '@/rendering/viewStore';
import { Section } from '@/ui/common/Panel';
import { fmt } from '@/ui/format';
import { THERMAL_MATERIAL_IDS } from '@/thermal/materials';
import { sectionFactors, thermalStrain } from '@/thermal/structural';
import { contributionKey, TK } from '@/thermal/ThermalWorld';
import { WATER_MERGE } from '@/thermal/TerrainThermal';
import { energyText } from '@/thermal/units';
import styles from './Inspector.module.css';

const C = (K: number) => `${fmt(K - 273.15, 1)} °C`;
const dT = (K: number, ref: number) => `${K - ref >= 0 ? '+' : ''}${fmt(K - ref, 1)} K`;
const W = (v: number) => (Math.abs(v) >= 1e3 ? `${fmt(v / 1e3, 2)} kW` : `${fmt(v, 1)} W`);

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

/** Energy each source put into a receiver (by source name). */
function contributions(kind: number, index: number): [string, number][] {
  const env = simulationController.getEnvironment();
  const rt = env.thermal.rt;
  if (!rt) return [];
  const key = contributionKey(kind, index);
  const out: [string, number][] = [];
  for (const s of env.thermal.sources) {
    const v = rt.world.contribution(s.id, key);
    if (v) out.push([s.name, v]);
  }
  return out;
}

/**
 * Thermal state of the selected object (Phase 26): surface / interior temperature, the change from
 * the start, materials, heat capacity, current heat flows (convection, radiation, conduction, ground),
 * source contributions; for modular buildings the rooms, the hottest member and the strength factors,
 * and the picked member in detail (strength / stiffness factors, free expansion, restraint, thermal
 * force). Quantities that are not computed are not shown.
 */
export function ThermalObjectSection({ id }: { id: EntityId }) {
  const t = useT();
  useSimStore((s) => s.time);
  const pick = useViewStore((s) => s.simMember);
  const env = simulationController.getEnvironment();
  const rt = env.thermal.rt;
  if (!rt) return null;
  const e = simulationController.getRuntime()?.entities.get(id);
  if (e?.source.type === 'human') {
    const x = e.exposure?.thermal;
    if (!x) return null;
    return (
      <Section title={t('thermal.inspect.title')}>
        <Rows testId="thermal-exposure" rows={[
          [t('thermal.inspect.airT'), `${C(x.airT)} (${t('thermal.inspect.peak')} ${C(x.peakAirT)})`],
          [t('thermal.inspect.radiant'), `${fmt(x.radiant / 1000, 2)} kW/m² (${t('thermal.inspect.peak')} ${fmt(x.peakRadiant / 1000, 2)})`],
        ]} />
        <div className={styles.note}>{t('thermal.inspect.noPhysiology')}</div>
      </Section>
    );
  }
  const te = rt.entity(id);
  const w = rt.world, B = w.bodies, Tref = w.Tref;
  if (!te || !te.active) {
    return (
      <Section title={t('thermal.inspect.title')} defaultOpen={false}>
        <div className={styles.note} data-testid="thermal-object-inactive">{t('thermal.inspect.inactive', { T: C(Tref) })}</div>
      </Section>
    );
  }
  const matName = (m: number) => t(`thermal.mat.${THERMAL_MATERIAL_IDS[m]}` as MessageKey);
  const bodyRows = (b: number): [string, string][] => {
    const rows: [string, string][] = [
      [t('thermal.inspect.surface'), `${C(B.TS[b])} (${dT(B.TS[b], Tref)})`],
    ];
    if (B.mC[b] > 0) rows.push([t('thermal.inspect.core'), `${C(B.TC[b])} (${dT(B.TC[b], Tref)})`]);
    rows.push(
      [t('thermal.inspect.initial'), C(Tref)],
      [t('thermal.inspect.max'), C(Math.max(B.TmaxS[b], B.TmaxC[b]))],
      [t('thermal.inspect.material'), B.mC[b] > 0 && B.matC[b] !== B.matS[b] ? `${matName(B.matS[b])} / ${matName(B.matC[b])}` : matName(B.matS[b])],
      [t('thermal.inspect.mass'), `${fmt(B.mS[b] + B.mC[b], 0)} kg${B.mC[b] > 0 ? ` (${t('thermal.inspect.skin')} ${fmt((100 * B.mS[b]) / (B.mS[b] + B.mC[b]), 0)} %)` : ''}`],
      [t('thermal.inspect.capacity'), `${fmt((B.capacity(b, false) + B.capacity(b, true)) / 1000, 1)} kJ/K`],
      [t('thermal.inspect.energy'), energyText(B.ES[b] + B.EC[b])],
      [t('thermal.inspect.conv'), W(B.qConv[b])],
      [t('thermal.inspect.rad'), W(B.qRad[b])],
    );
    if (B.mC[b] > 0) rows.push([t('thermal.inspect.cond'), W(B.qCond[b])]);
    if (B.qGround[b] !== 0) rows.push([t('thermal.inspect.ground'), W(B.qGround[b])]);
    rows.push([t('thermal.inspect.sources'), energyText(B.Esrc[b])]);
    for (const [name, v] of contributions(TK.body, b)) rows.push([`  · ${name}`, energyText(v)]);
    return rows;
  };
  if (!te.b) {
    return (
      <Section title={t('thermal.inspect.title')}>
        <Rows testId="thermal-object" rows={bodyRows(te.body)} />
        {te.kind === 'building' && <div className={styles.note}>{t('thermal.inspect.legacyNote')}</div>}
        {te.kind === 'modular' && <div className={styles.note} data-testid="thermal-lod">{t('thermal.inspect.lodNote')}</div>}
        {te.kind === 'tree' && <div className={styles.note}>{t('thermal.inspect.treeNote')}</div>}
        <div className={styles.note}>{t('thermal.inspect.note')}</div>
      </Section>
    );
  }
  const bt = te.b, g = bt.g;
  let hot = -1, heated = 0, reduced = 0;
  for (let i = 0; i < g.n; i++) {
    const b = bt.body[i];
    if (b < 0) continue;
    if (B.TS[b] - Tref > 1) heated++;
    if (bt.fApplied[i] < 0.999) reduced++;
    if (hot < 0 || B.TS[b] > B.TS[bt.body[hot]]) hot = i;
  }
  const ids = e!.modular!.design.members;
  const rooms = Array.from(bt.comp).map((c, s) => (c >= 0 ? `${s + 1}F ${w.comps[c].alive ? C(w.compT(c)) : t('thermal.inspect.roomOpen')}` : '')).filter(Boolean);
  const rows: [string, string][] = [
    [t('thermal.inspect.heatedMembers'), `${heated} / ${g.n}`],
    [t('thermal.inspect.hottest'), hot >= 0 ? `${ids[hot].id} ${C(B.TS[bt.body[hot]])}` : '—'],
    [t('thermal.inspect.minFactor'), `${fmt(bt.minFactor * 100, 0)} % · ${t('thermal.inspect.reduced', { n: reduced })}`],
    [t('thermal.inspect.thermalFailures'), String(bt.thermalFailures)],
    [t('thermal.inspect.rooms'), rooms.join(' · ')],
    [t('thermal.inspect.restraintMode'), t(`thermal.restraint.${w.settings.restraint}` as MessageKey)],
  ];
  const i = pick && pick.owner === id ? pick.member : -1;
  const b = i >= 0 ? bt.body[i] : -1;
  let memberRows: [string, string][] = [];
  if (b >= 0) {
    const temps = { Ts: B.TS[b], Tc: B.TC[b], TmaxS: B.TmaxS[b], TmaxC: B.TmaxC[b], wS: bt.wS[i] };
    const f = sectionFactors(bt.tmat[i], temps);
    const o = 6 * i;
    const L = g.type[i] === 1 || g.type[i] === 4 ? g.box[o + 4] - g.box[o + 1] : g.length[i] || Math.max(g.box[o + 3] - g.box[o], g.box[o + 5] - g.box[o + 2]);
    const eps = thermalStrain(bt.tmat[i], bt.wS[i] * B.TS[b] + (1 - bt.wS[i]) * B.TC[b], Tref);
    memberRows = [
      ...bodyRows(b),
      [t('thermal.inspect.factors'), `${fmt(f.axial * 100, 0)} / ${fmt(f.bending * 100, 0)} / ${fmt(f.stiffness * 100, 0)} %`],
      [t('thermal.inspect.applied'), g.structural[i] ? `${fmt(bt.fApplied[i] * 100, 1)} %` : t('thermal.inspect.nonStructural')],
      [t('thermal.inspect.expansion'), `ε ${fmt(eps * 1000, 3)} ‰ · ΔL ${fmt(eps * L * 1000, 1)} mm (${t('thermal.inspect.free')})`],
      [t('thermal.inspect.restraint'), `r ${fmt(w.settings.restraint === 'full' ? 1 : w.settings.restraint === 'none' ? 0 : bt.restraint[i], 4)}`],
      [t('thermal.inspect.force'), `${fmt(bt.nApplied[i] / 1000, 1)} kN · u ${fmt(bt.util[i], 2)}`],
      [t('thermal.inspect.bowing'), `κ ${fmt(bt.bow[i] * 1000, 3)} /km`],
    ];
  }
  return (
    <>
      <Section title={t('thermal.inspect.title')}>
        <Rows testId="thermal-building" rows={rows} />
        <div className={styles.note}>{t('thermal.inspect.pickMember')}</div>
      </Section>
      {b >= 0 && (
        <Section title={t('thermal.inspect.member', { id: ids[i].id })}>
          <Rows testId="thermal-member" rows={memberRows} />
          <div className={styles.note}>{t('thermal.inspect.memberNote')}</div>
        </Section>
      )}
    </>
  );
}

/** The ground column, water and air at the clicked point (Phase 26). */
export function ThermalProbeSection() {
  const t = useT();
  useSimStore((s) => s.time);
  const active = useSimStore((s) => s.thermal !== null);
  const probe = useViewStore((s) => s.waterProbe);
  if (!active) return null;
  const rt = simulationController.getEnvironment().thermal.rt;
  if (!rt) return null;
  if (!probe) {
    return (
      <Section title={t('thermal.probe.title')}>
        <div className={styles.note}>{t('thermal.probe.hint')}</div>
      </Section>
    );
  }
  const w = rt.world, g = w.terrain, c = g.index(probe.x, probe.z);
  if (c < 0) return null;
  const rows: [string, string][] = [[t('thermal.probe.at'), `(${fmt(probe.x, 1)}, ${fmt(probe.z, 1)})`]];
  let depth = 0;
  for (let l = 0; l < g.nl; l++) {
    rows.push([t('thermal.probe.layer', { a: fmt(depth * 100, 0), b: fmt((depth + g.layers[l]) * 100, 0) }), C(g.T(c, l))]);
    depth += g.layers[l];
  }
  const G01 = g.area / (g.layers[0] / (2 * g.k[c * g.nl]) + g.layers[1] / (2 * g.k[c * g.nl + 1]));
  rows.push(
    [t('thermal.probe.below'), `${C(w.Tref)} (${t('thermal.probe.reference')})`],
    [t('thermal.probe.downFlux'), `${fmt((G01 * (g.T(c, 0) - g.T(c, 1))) / g.area, 1)} W/m²`],
    [t('thermal.probe.peak'), Number.isFinite(g.Tpeak[c]) ? C(g.Tpeak[c]) : C(w.Tref)],
    [t('thermal.probe.covered'), g.covered[c] ? t('thermal.probe.yes') : t('thermal.probe.no')],
  );
  if (w.water && w.water.h[c] > 0) rows.push([t('thermal.probe.water'), `${fmt(w.water.h[c], 3)} m · ${w.water.h[c] > WATER_MERGE ? C(w.waterT(c)) : t('thermal.probe.film')}`]);
  const a = w.air.index(probe.x, probe.z, 1);
  rows.push([t('thermal.probe.air'), `${C(w.air.T(a))} (${t('thermal.probe.airNote', { H: w.air.H })})`]);
  for (const [name, v] of contributions(TK.ground, c)) rows.push([`${t('thermal.probe.source')} ${name}`, `${energyText(v)} (${fmt(v / g.area / 1000, 1)} kJ/m²)`]);
  return (
    <Section title={t('thermal.probe.title')}>
      <Rows testId="thermal-probe" rows={rows} />
      <div className={styles.note}>{t('thermal.probe.note')}</div>
    </Section>
  );
}
