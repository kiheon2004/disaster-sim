import { Fragment } from 'react';
import { useT } from '@/i18n/i18n';
import type { EntityId } from '@/core/types';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { useViewStore } from '@/rendering/viewStore';
import { Section } from '@/ui/common/Panel';
import { fmt } from '@/ui/format';
import { energyText } from '@/thermal/units';
import styles from './Inspector.module.css';

const C = (K: number) => (Number.isFinite(K) ? `${fmt(K - 273.15, 0)} °C` : '—');

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
 * Volcano state of the selected object (Phase 28): lava at it (depth, temperature, speed), deposit,
 * lateral lava load and its damage index, burial, held vehicle, contact time, ash on the roof and its load,
 * bombs that struck it, and the lava heat its thermal body received. Computed values only.
 */
export function VolcanoObjectSection({ id }: { id: EntityId }) {
  const t = useT();
  useSimStore((s) => s.time);
  const env = simulationController.getEnvironment();
  const vr = env.volcano.rt;
  if (!vr) return null;
  const e = simulationController.getRuntime()?.entities.get(id);
  const v = e?.volcano;
  if (!e || !v) return null;
  const p = e.pose.position;
  const s = vr.sampleAt(p[0], p[2]);
  const te = vr.trt.byEntity.get(id);
  const B = vr.trt.world.bodies;
  const heat = te && te.body >= 0 ? B.Esrc[te.body] : NaN;
  const rows: [string, string][] = [
    [t('volcano.inspect.lava'), `${fmt(v.lava, 2)} m (${t('volcano.inspect.peak')} ${fmt(v.peakLava, 2)} m)`],
    [t('volcano.inspect.deposit'), `${fmt(v.deposit, 2)} m`],
  ];
  if (s && s.depth > 0.01) rows.push([t('volcano.inspect.lavaState'), `${C(s.T)} · ${t('volcano.inspect.surface')} ${C(s.Ts)} · ${fmt(s.speed, 2)} m/s · ${fmt(s.crystals * 100, 0)} %`]);
  if (v.ratio > 0) rows.push([t('volcano.inspect.load'), `${fmt(v.ratio, 2)} · D ${fmt(v.damage, 2)}`]);
  if (v.contact > 0) rows.push([t('volcano.inspect.contact'), `${fmt(v.contact, 0)} s`]);
  if (v.noted.has('buried')) rows.push([t('volcano.inspect.buried'), t('volcano.inspect.yes')]);
  if (v.held) rows.push([t('volcano.inspect.held'), t('volcano.inspect.yes')]);
  if (v.ash > 0) rows.push([t('volcano.inspect.ash'), `${fmt(v.ash, 0)} kg · ${fmt(v.ashLoad, 2)} kPa`]);
  if (v.bombs > 0) rows.push([t('volcano.inspect.bombs'), `${v.bombs} · ${energyText(v.bombEnergy)}`]);
  if (Number.isFinite(heat)) rows.push([t('volcano.inspect.heat'), energyText(heat)]);
  return (
    <Section title={t('volcano.inspect.title')}>
      <Rows testId="volcano-object" rows={rows} />
      {e.source.type === 'human' && <div className={styles.note}>{t('volcano.inspect.noPhysiology')}</div>}
    </Section>
  );
}

/** Volcano state at the probed ground point (Phase 28): lava, deposit layers, temperatures, heat flux. */
export function VolcanoProbeSection() {
  const t = useT();
  useSimStore((s) => s.time);
  const active = useSimStore((s) => s.volcano !== null);
  const probe = useViewStore((s) => s.waterProbe);
  if (!active) return null;
  const vr = simulationController.getEnvironment().volcano.rt;
  if (!vr || !probe) return null;
  const s = vr.sampleAt(probe.x, probe.z);
  if (!s) return null;
  const rows: [string, string][] = [
    [t('volcano.probe.at'), `(${fmt(probe.x, 1)}, ${fmt(probe.z, 1)})`],
    [t('volcano.probe.depth'), `${fmt(s.depth, 2)} m (${t('volcano.inspect.peak')} ${fmt(s.peakDepth, 2)} m)`],
  ];
  if (s.depth > 0) rows.push(
    [t('volcano.probe.T'), `${C(s.T)} (${t('volcano.inspect.peak')} ${C(s.peakT)})`],
    [t('volcano.probe.Ts'), C(s.Ts)],
    [t('volcano.probe.speed'), `${fmt(s.speed, 3)} m/s`],
    [t('volcano.probe.solid'), `${fmt(s.crystals * 100, 0)} %`],
  );
  rows.push(
    [t('volcano.probe.deposit'), `${fmt(s.deposit, 3)} m`],
    [t('volcano.probe.layers'), `${fmt(s.lavaDeposit, 0)} / ${fmt(s.bombDeposit, 0)} / ${fmt(s.ash, 0)} kg`],
  );
  if (Number.isFinite(s.depositT)) rows.push([t('volcano.probe.depositT'), C(s.depositT)]);
  rows.push([t('volcano.probe.flux'), `${fmt(s.groundFlux, 0)} W/m²`]);
  return (
    <Section title={t('volcano.probe.title')}>
      <Rows testId="volcano-probe" rows={rows} />
      <div className={styles.note}>{t('volcano.probe.note')}</div>
    </Section>
  );
}
