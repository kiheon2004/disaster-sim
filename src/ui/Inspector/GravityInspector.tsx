import { Fragment } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { EntityId, Vec3 } from '@/core/types';
import { GRAVITY } from '@/core/units';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { useViewStore } from '@/rendering/viewStore';
import { Section } from '@/ui/common/Panel';
import { fmt } from '@/ui/format';
import { forcesAt } from '@/simulation/forces/ForceLedger';
import { MT_ROOF } from '@/structure/graph';
import { MS } from '@/structure/types';
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

const vec = (v: readonly number[], d = 2) => `(${v.map((x) => fmt(Math.abs(x) < 10 ** -d / 2 ? 0 : x, d)).join(', ')})`;
const force = (N: number) => (Math.abs(N) >= 1e6 ? `${fmt(N / 1e6, 2)} MN` : Math.abs(N) >= 1e3 ? `${fmt(N / 1e3, 2)} kN` : `${fmt(N, 1)} N`);

/** Sources acting at a point (names of the experiments owning them). */
function sourcesAt(p: Readonly<Vec3>): { global: string | null; local: string[] } {
  const f = simulationController.getEnvironment().gravity.field!;
  const attr = { global: -1, local: 0 };
  f.sample(p[0], p[1], p[2], [0, 0, 0], attr);
  const ex = f.canonical;
  return { global: attr.global >= 0 ? ex[attr.global].id : null, local: ex.filter((_, i) => i < 31 && attr.local & (1 << i)).map((e) => e.id) };
}

/**
 * Gravity at the selected object (Phase 31): mass (never changes) and weight (mass × the local field), the local
 * vector and the experiments it comes from, velocity and contact state of a moving body, the gravity-field force the
 * ForceLedger applied (the local part — the uniform part is Rapier's own), the structural gravity load of a building
 * (ratio, dead load now, roof panels) and the cause of the last damage. Computed values only.
 */
export function GravityObjectSection({ id }: { id: EntityId }) {
  const t = useT();
  useSimStore((s) => s.time);
  const env = simulationController.getEnvironment();
  const f = env.gravity.field;
  if (!f) return null;
  const e = simulationController.getRuntime()?.entities.get(id);
  if (!e) return null;
  const p: Vec3 = [e.pose.position[0], e.pose.position[1] + e.dims[1] / 2, e.pose.position[2]];
  const g = f.sample(p[0], p[1], p[2], [0, 0, 0]);
  const gm = Math.hypot(g[0], g[1], g[2]);
  const m = e.source.physics.mass;
  const src = sourcesAt(p);
  const rows: [string, string][] = [
    [t('gravity.inspect.mass'), `${fmt(m, 1)} kg ${t('gravity.inspect.massConst')}`],
    [t('gravity.inspect.local'), `${vec(g)} m/s² · ${fmt(gm, 2)} m/s² · ${fmt(gm / GRAVITY, 2)} g₀`],
    [t('gravity.inspect.weight'), `${force(m * gm)} · ${t('gravity.inspect.earthWeight')} ${force(m * GRAVITY)}`],
    [t('gravity.inspect.sources'), `${src.global ? t('gravity.inspect.globalFrom', { id: src.global }) : t('gravity.inspect.project')}${src.local.length ? ` · ${t('gravity.inspect.localFrom', { ids: src.local.join(', ') })}` : ''}`],
  ];
  const physics = simulationController.getPhysics();
  if (e.dynamic && e.body !== null && physics) {
    const v = physics.getLinearVelocity(e.body);
    rows.push([t('gravity.inspect.velocity'), `${vec(v)} m/s · ${fmt(Math.hypot(v[0], v[1], v[2]), 2)} m/s`]);
    const ground = env.terrain.sampleHeight(e.pose.position[0], e.pose.position[2]);
    const contact = e.pose.position[1] - ground < 0.15;
    rows.push([t('gravity.inspect.contact'), `${t(contact ? 'gravity.inspect.onGround' : 'gravity.inspect.airborne')}${physics.isSleeping(e.body) ? ` · ${t('gravity.inspect.sleeping')}` : ''}`]);
    const fl = e.forces ? forcesAt(e, simulationController.getStep() - 1).gravityField : -1;
    if (fl > 0) rows.push([t('gravity.inspect.fieldForce'), force(fl)]);
  } else rows.push([t('gravity.inspect.fixed'), t(e.source.type === 'building' ? 'gravity.inspect.structural' : 'gravity.inspect.anchored')]);
  const model = e.modular?.structure?.model;
  if (model) {
    let k = 0, n = 0, dead = 0, roofs = 0, roofsFailed = 0, uMax = 0;
    for (let i = 0; i < model.n; i++) {
      if (model.state[i] === MS.ABSENT) continue;
      k += model.s.kM[i]; n++;
      if (model.alive(i)) dead += (model.g.weight[i] + model.s.extra[i]) * model.s.kM[i];
      if (model.g.type[i] === MT_ROOF && model.g.roofCap[i] > 0) { roofs++; if (model.state[i] >= MS.FAILED) roofsFailed++; else uMax = Math.max(uMax, model.s.util[i]); }
    }
    rows.push([t('gravity.inspect.ratio'), `${fmt(n ? k / n : 1, 3)} × g₀`]);
    rows.push([t('gravity.inspect.deadLoad'), force(dead)]);
    if (roofs) rows.push([t('gravity.inspect.roof'), t('gravity.inspect.roofLine', { n: roofs, f: roofsFailed, u: fmt(uMax / 1.25, 2) })]);
  }
  if (e.lastCause) rows.push([t('gravity.inspect.cause'), `${t(`cause.${e.lastCause}` as MessageKey)}${e.lastHazard ? ` · ${t(`hazardName.${e.lastHazard}` as MessageKey)}` : ''}`]);
  return (
    <Section title={t('gravity.inspect.title')}>
      <Rows testId="gravity-object" rows={rows} />
      {e.source.type === 'human' && <div className={styles.note}>{t('gravity.inspect.noPhysiology')}</div>}
    </Section>
  );
}

/** Gravity at the probed ground point (Phase 31): the local vector, its sources, potential, gradient. */
export function GravityProbeSection() {
  const t = useT();
  useSimStore((s) => s.time);
  const active = useSimStore((s) => s.gravity !== null);
  const probe = useViewStore((s) => s.waterProbe);
  if (!active || !probe) return null;
  const env = simulationController.getEnvironment();
  const f = env.gravity.field;
  if (!f) return null;
  const y = env.terrain.sampleHeight(probe.x, probe.z) + 1;
  const g = f.sample(probe.x, y, probe.z, [0, 0, 0]);
  const src = sourcesAt([probe.x, y, probe.z]);
  const phi = f.potential(probe.x, y, probe.z);
  const grad = f.gradient(probe.x, y, probe.z);
  let gn = 0;
  for (let i = 0; i < 9; i++) gn = Math.max(gn, Math.abs(grad[i]));
  const rows: [string, string][] = [
    [t('gravity.probe.at'), `(${fmt(probe.x, 1)}, ${fmt(y, 1)}, ${fmt(probe.z, 1)})`],
    [t('gravity.inspect.local'), `${vec(g)} m/s² · ${fmt(Math.hypot(g[0], g[1], g[2]), 2)} m/s²`],
    [t('gravity.inspect.sources'), `${src.global ? t('gravity.inspect.globalFrom', { id: src.global }) : t('gravity.inspect.project')}${src.local.length ? ` · ${t('gravity.inspect.localFrom', { ids: src.local.join(', ') })}` : ''}`],
    [t('gravity.probe.potential'), Number.isFinite(phi) ? `${fmt(phi, 1)} J/kg` : t('gravityHud.noPotential')],
    [t('gravity.probe.gradient'), `${fmt(gn, 4)} 1/s²`],
  ];
  return (
    <Section title={t('gravity.probe.title')}>
      <Rows testId="gravity-probe" rows={rows} />
      <div className={styles.note}>{t('gravity.probe.note')}</div>
    </Section>
  );
}
