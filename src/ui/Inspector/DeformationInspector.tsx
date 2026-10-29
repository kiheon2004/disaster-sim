import { Fragment } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { EntityId } from '@/core/types';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { useViewStore } from '@/rendering/viewStore';
import { BETA } from '@/simulation/deformation/response';
import { Section } from '@/ui/common/Panel';
import { fmt } from '@/ui/format';
import styles from './Inspector.module.css';

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

/** Angular distortion as "1/N" (engineering convention). */
export const betaText = (b: number) => (b < 1e-5 ? '0' : `1/${Math.round(1 / b)}`);
const signed = (v: number, d = 3) => `${v >= 0 ? '+' : '−'}${fmt(Math.abs(v), d)}`;
const NEAR = 30;

/** The ground at the clicked point while a deformation runs (Phase 21). */
export function DeformationProbeSection() {
  const t = useT();
  useSimStore((s) => s.time);
  const active = useSimStore((s) => s.deform !== null);
  const probe = useViewStore((s) => s.waterProbe);
  if (!active) return null;
  const env = simulationController.getEnvironment();
  const engine = env.deformation.engine;
  if (!engine) return null;
  if (!probe) {
    return (
      <Section title={t('deform.inspect.title')}>
        <div className={styles.note}>{t('deform.inspect.hint')}</div>
      </Section>
    );
  }
  const time = simulationController.getTime();
  const { x, z } = probe;
  const h0 = engine.originalAt(x, z);
  const h = env.terrain.sampleHeight(x, z);
  const w = engine.displacementAt(x, z);
  const support = engine.supportAt(x, z, time);
  const rows: [string, string][] = [
    [t('flood.inspect.position'), `${fmt(x, 1)}, ${fmt(z, 1)}`],
    [t('deform.inspect.original'), `${fmt(h0, 3)} m`],
    [t('deform.inspect.current'), `${fmt(h, 3)} m`],
    [t('deform.inspect.displacement'), `${signed(w)} m`],
    [t('deform.inspect.support'), support < 0.999 ? `${Math.round(support * 100)} % ${t('deform.inspect.explicit')}` : t('deform.inspect.unchanged')],
  ];
  const sources = engine.sourcesAt(x, z, time);
  for (const s of sources.slice(0, 4)) rows.push([t('deform.inspect.source'), `${s.source.phenomenon} · ${t(`deform.kind.${s.source.kind}` as MessageKey)} ${signed(s.value, 2)} m (${t(`deform.model.${s.source.model}` as MessageKey)})`]);
  if (!sources.length) rows.push([t('deform.inspect.source'), '–']);
  const field = env.flood.field;
  if (field) {
    const eta = field.sampleSurface(x, z);
    rows.push([t('flood.inspect.depth'), eta === -Infinity ? '0 m' : `${fmt(Math.max(0, eta - h), 3)} m`]);
  }
  // Nearby buildings on moving ground and roads with a deformation state.
  const rt = simulationController.getRuntime();
  const near: { d: number; text: string }[] = [];
  if (rt) for (const e of rt.entities.values()) {
    if (!e.ground || e.source.type !== 'building') continue;
    const d = Math.hypot(e.pose.position[0] - x, e.pose.position[2] - z);
    if (d > NEAR) continue;
    near.push({ d, text: t('deform.inspect.buildingRow', { name: e.source.name ?? e.id, d: fmt(d, 0), s: signed(e.ground.settlement, 2), beta: betaText(e.ground.beta), c: Math.round(e.ground.contact * 100) }) });
  }
  near.sort((a, b) => a.d - b.d);
  for (const n of near.slice(0, 3)) rows.push([t('deform.inspect.building'), n.text]);
  if (rt?.roads) {
    const roads = rt.roads.segments
      .filter((s) => s.deform && s.samples.some((p) => Math.hypot(p.x - x, p.z - z) < NEAR))
      .slice(0, 3);
    for (const s of roads) rows.push([t('deform.inspect.road'), t('deform.inspect.roadRow', { id: s.id, o: fmt(s.deform!.offset, 2), g: fmt(s.deform!.grade * 100, 1), p: t(s.deform!.passable ? 'road.sim.passable' : 'road.sim.blocked') })]);
  }
  return (
    <Section title={t('deform.inspect.title')}>
      <Rows rows={rows} testId="deform-inspector" />
      <div className={styles.note}>{t('deform.inspect.note')}</div>
    </Section>
  );
}

/** Ground response of the selected object (simulation mode). */
export function DeformationLiveSection({ id }: { id: EntityId }) {
  const t = useT();
  useSimStore((s) => s.time);
  const e = simulationController.getRuntime()?.entities.get(id);
  const g = e?.ground;
  if (!e || !g) return null;
  const rows: [string, string][] = [
    [t('live.ground.settlement'), `${signed(g.settlement, 3)} m`],
    [t('live.ground.tilt'), `${fmt((g.tilt * 180) / Math.PI, 2)}° (1/${g.tilt > 1e-6 ? Math.round(1 / Math.tan(g.tilt)) : '∞'})`],
  ];
  if (e.source.type === 'building') {
    const cls = g.peakBeta >= BETA.severe ? 'severe' : g.peakBeta >= BETA.structural ? 'structural' : g.peakBeta >= BETA.cracking ? 'cracking' : g.peakBeta >= BETA.safe ? 'minor' : 'safe';
    rows.push(
      [t('live.ground.beta'), `${betaText(g.beta)} (${t('live.ground.peak')} ${betaText(g.peakBeta)})`],
      [t('live.ground.class'), t(`live.ground.class.${cls}` as MessageKey)],
      [t('live.ground.contact'), `${Math.round(g.contact * 100)} % (${t('live.ground.min')} ${Math.round(g.minContact * 100)} %)`],
      [t('live.ground.support'), g.support < 0.999 ? `${Math.round(g.support * 100)} %` : t('deform.inspect.unchanged')],
      [t('live.ground.bearing'), Number.isFinite(g.bearing0) ? `${fmt(g.bearing0, 2)} → ${fmt(g.bearingRatio, 2)}` : '–'],
    );
  }
  rows.push([t('live.ground.damage'), fmt(g.damage, 3)], [t('live.flood.health'), `${Math.round((1 - g.health) * 100)} %`]);
  return (
    <Section title={t('live.ground.title')}>
      <Rows rows={rows} testId="ground-live" />
      <div className={styles.note}>{t('live.ground.note')}</div>
    </Section>
  );
}
