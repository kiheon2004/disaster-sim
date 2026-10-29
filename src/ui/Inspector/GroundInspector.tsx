import { Fragment } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { EntityId } from '@/core/types';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { useViewStore } from '@/rendering/viewStore';
import { slopeAt } from '@/ground/common';
import { shockAt } from '@/impact/plan';
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

const NEAR = 30;
const fsText = (v: number) => (Number.isFinite(v) ? fmt(v, 2) : '∞');
const dir: [number, number] = [0, 0];

/**
 * The ground at the clicked point while sinkholes / landslides run (Phase 22): ground profile,
 * slope, soil thickness and water table, factor of safety and Newmark displacement, explicit
 * support of a sinkhole roof, mobile sediment (thickness, speed), deposits, height change and
 * the phenomenon that governs the point; nearby objects loaded or buried by sediment and roads
 * blocked by it.
 */
export function GroundProbeSection() {
  const t = useT();
  useSimStore((s) => s.time);
  const active = useSimStore((s) => s.ground !== null);
  const probe = useViewStore((s) => s.waterProbe);
  if (!active) return null;
  const env = simulationController.getEnvironment();
  const ch = env.groundFailure;
  const f = ch.field;
  const engine = env.deformation.engine;
  if (!f || !engine) return null;
  if (!probe) {
    return (
      <Section title={t('ground.inspect.title')}>
        <div className={styles.note}>{t('deform.inspect.hint')}</div>
      </Section>
    );
  }
  const { x, z } = probe;
  const i = f.index(x, z);
  if (i < 0) return null;
  const p = f.profile(i);
  const H = engine.terrain.heights;
  // Slope of the ground without the mobile layer (what stability sees).
  const beta = slopeAt(f, { ground: (k) => H[k] - f.h[k], infiltrated: () => 0, surcharge: () => 0 }, i, dir);
  const owner = f.owner[i] >= 0 ? ch.modelOf(f.owner[i]) : null;
  const support = ch.source?.support(x, z) ?? 1;
  const rows: [string, string][] = [
    [t('flood.inspect.position'), `${fmt(x, 1)}, ${fmt(z, 1)}`],
    [t('ground.inspect.material'), `${t(p.labelKey)} (c′ ${p.cohesion} kPa, φ′ ${p.friction}°)`],
    [t('ground.inspect.slope'), `${fmt((beta * 180) / Math.PI, 1)}°`],
    [t('ground.inspect.soil'), `${fmt(f.thickness[i], 2)} m`],
    [t('ground.inspect.water'), `${Math.round(f.water(i) * 100)} %${f.waterRise[i] > 0.005 ? ` (+${Math.round(f.waterRise[i] * 100)} % ${t('ground.inspect.infiltration')})` : ''}`],
    [t('ground.inspect.fs'), f.failed[i] ? t('ground.inspect.failed') : f.evaluate[i] ? fsText(f.fs[i]) : t('ground.inspect.notEvaluated')],
  ];
  if (f.nmD[i] > 1e-4) rows.push([t('ground.inspect.newmark'), `${fmt(f.nmD[i] * 100, 1)} cm`]);
  if (support < 0.999) rows.push([t('deform.inspect.support'), `${Math.round(support * 100)} %`]);
  const v = Math.hypot(...velocityOf(ch, i));
  rows.push(
    [t('ground.inspect.mobile'), f.h[i] > 0.005 ? `${fmt(f.h[i], 2)} m · ${fmt(v, 1)} m/s` : '–'],
    [t('ground.inspect.deposit'), f.loose[i] > 0.005 ? `${fmt(f.loose[i], 2)} m` : '–'],
    [t('ground.inspect.change'), `${f.bed[i] + f.h[i] >= 0 ? '+' : '−'}${fmt(Math.abs(f.bed[i] + f.h[i]), 3)} m`],
    [t('deform.inspect.source'), owner ? `${owner.name} · ${t('kind' in owner ? 'phen.meteor' : ch.sinkholes.includes(owner as never) ? 'phen.sinkhole' : 'phen.landslide')}` : '–'],
  );
  // Phase 23: distance to each impact and its computed ground shock at this point.
  for (const m of env.impact.models) {
    if (!m.plan.crater) continue;
    const r = Math.hypot(x - m.plan.arc.point[0], z - m.plan.arc.point[2]);
    const sh = shockAt(m.plan, r);
    rows.push([t('impact.inspect.point'), t('impact.inspect.pointRow', { id: m.name, r: fmt(r, 1), R: fmt(m.plan.crater.radius, 1), pgv: fmt(sh.pgv, 3), pga: fmt(sh.pgaApplied / 9.81, 2) })]);
  }
  const rt = simulationController.getRuntime();
  const near: { d: number; text: string }[] = [];
  if (rt) for (const e of rt.entities.values()) {
    const g = e.ground;
    if (!g || !(g.debrisRatio || g.overburden)) continue;
    const d = Math.hypot(e.pose.position[0] - x, e.pose.position[2] - z);
    if (d > NEAR) continue;
    near.push({ d, text: t('ground.inspect.objectRow', { name: e.source.name ?? e.id, d: fmt(d, 0), r: fmt(g.debrisRatio ?? 0, 2), o: fmt(g.overburden ?? 0, 2), dmg: fmt(g.damage, 2) }) });
  }
  near.sort((a, b) => a.d - b.d);
  for (const n of near.slice(0, 4)) rows.push([t('ground.inspect.object'), n.text]);
  if (rt?.roads) {
    for (const s of rt.roads.segments.filter((r) => r.deform?.debris && r.samples.some((q) => Math.hypot(q.x - x, q.z - z) < NEAR)).slice(0, 3)) {
      rows.push([t('deform.inspect.road'), t('ground.inspect.roadRow', { id: s.id, m: fmt(s.deform!.debris!, 2), p: t(s.deform!.passable ? 'road.sim.passable' : 'road.sim.blocked') })]);
    }
  }
  return (
    <Section title={t('ground.inspect.title')}>
      <Rows rows={rows} testId="ground-inspector" />
      <div className={styles.note}>{t('ground.inspect.note')}</div>
    </Section>
  );
}

function velocityOf(ch: ReturnType<typeof simulationController.getEnvironment>['groundFailure'], i: number): [number, number] {
  const f = ch.field!;
  const h = f.h[i];
  if (h < 0.02) return [0, 0];
  const ix = i % f.nx, iz = (i - ix) / f.nx, fx = f.nx - 1;
  const qx = ((ix > 0 ? f.qx[iz * fx + ix - 1] : 0) + (ix < f.nx - 1 ? f.qx[iz * fx + ix] : 0)) / 2;
  const qz = ((iz > 0 ? f.qz[(iz - 1) * f.nx + ix] : 0) + (iz < f.nz - 1 ? f.qz[iz * f.nx + ix] : 0)) / 2;
  return [qx / h, qz / h];
}

/** Sediment response of the selected object (simulation mode). */
export function GroundObjectSection({ id }: { id: EntityId }) {
  const t = useT();
  useSimStore((s) => s.time);
  const e = simulationController.getRuntime()?.entities.get(id);
  const g = e?.ground;
  if (!e || !g || !(g.debrisRatio || g.overburden || g.source)) return null;
  const rows: [string, string][] = [
    [t('ground.obj.load'), `${fmt(g.debrisRatio ?? 0, 2)} × ${t('ground.obj.capacity')}`],
    [t('ground.obj.damage'), fmt(g.debrisDamage ?? 0, 3)],
    [t('ground.obj.overburden'), `${fmt(g.overburden ?? 0, 2)} m`],
    [t('deform.inspect.source'), g.source ?? '–'],
  ];
  return (
    <Section title={t('ground.obj.title')}>
      <Rows rows={rows} testId="ground-object" />
      <div className={styles.note}>{t('ground.obj.note' as MessageKey)}</div>
    </Section>
  );
}

/** Impact responses of the selected object (Phase 23). */
export function ImpactObjectSection({ id }: { id: EntityId }) {
  const t = useT();
  useSimStore((s) => s.time);
  const e = simulationController.getRuntime()?.entities.get(id);
  if (!e || (!e.impact && !(e.seismic && e.seismic.pgaImpact > 0))) return null;
  const rows: [string, string][] = [];
  if (e.seismic && e.seismic.pgaImpact > 0) rows.push([t('impact.obj.shock'), `${fmt(e.seismic.pgaImpact / 9.81, 2)} g (${t('impact.obj.quake')} ${fmt(e.seismic.pgaQuake / 9.81, 2)} g)`]);
  if (e.impact) {
    rows.push(
      [t('impact.obj.hits'), `${e.impact.hits}`],
      [t('impact.obj.load'), `${fmt(e.impact.ejectaRatio, 2)} × ${t('ground.obj.capacity')}`],
      [t('impact.obj.impulse'), `${fmt(e.impact.impulse / 1000, 2)} kN·s`],
      [t('impact.obj.damage'), fmt(e.impact.damage, 3)],
      [t('deform.inspect.source'), e.impact.source],
    );
  }
  return (
    <Section title={t('impact.obj.title')}>
      <Rows rows={rows} testId="impact-object" />
      <div className={styles.note}>{t('impact.obj.note')}</div>
    </Section>
  );
}
