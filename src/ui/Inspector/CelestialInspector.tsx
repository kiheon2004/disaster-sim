import { Fragment } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { EntityId, Vec3 } from '@/core/types';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { useViewStore } from '@/rendering/viewStore';
import { Section } from '@/ui/common/Panel';
import { fmt } from '@/ui/format';
import { symEigenvalues, symEigenvector, stretchAlong, barTension } from '@/celestial/tidal';
import { elements } from '@/celestial/orbit';
import { sci } from '@/ui/Viewport/CelestialHud';
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
const force = (N: number) => (Math.abs(N) >= 1e6 ? `${fmt(N / 1e6, 2)} MN` : Math.abs(N) >= 1e3 ? `${fmt(N / 1e3, 2)} kN` : `${fmt(N, 1)} N`);

/** Field facts at a point relative to the nearest live source: distance, |g|, Φ, v_esc, tide. */
function facts(p: Readonly<Vec3>) {
  const f = simulationController.getEnvironment().gravity.field!;
  const near = f.points.nearest(p[0], p[1], p[2]);
  const l = f.points.live[near.k];
  const g = f.sample(p[0], p[1], p[2], [0, 0, 0]);
  const phiC = f.points.potential(p[0], p[1], p[2]);
  const T = f.gradient(p[0], p[1], p[2], new Float64Array(9));
  const [l1] = symEigenvalues(T);
  return { f, l, d: near.d, g, gm: Math.hypot(g[0], g[1], g[2]), phi: f.potential(p[0], p[1], p[2]), vEsc: Math.sqrt(2 * Math.abs(phiC)), T, l1 };
}

/**
 * Celestial gravity at the selected object (Phase 32): distance to the nearest source, the local field, escape speed,
 * the tidal stretch along the object's long axis and the mid-section tension of a uniform bar of its mass and length
 * (m·λ·L/8 — a reference, vehicles / people have no internal model here), its orbit energy / angular momentum about
 * the source, the conic elements only when they are the exact orbit, and the capture state.
 */
export function CelestialObjectSection({ id }: { id: EntityId }) {
  const t = useT();
  useSimStore((s) => s.time);
  const live = useSimStore((s) => s.celestial !== null);
  const e = simulationController.getRuntime()?.entities.get(id);
  const f = simulationController.getEnvironment().gravity.field;
  if (!live || !e || !f || !f.points.live.length) return null;
  if (e.flags.captured) {
    return (
      <Section title={t('celestial.inspect.title')}>
        <Rows testId="celestial-object" rows={[[t('celestial.inspect.state'), t('celestial.inspect.captured')]]} />
      </Section>
    );
  }
  const p: Vec3 = [e.pose.position[0], e.pose.position[1] + e.dims[1] / 2, e.pose.position[2]];
  const F = facts(p);
  const m = e.source.physics.mass;
  // Long axis of the object's box in world (rotation of the local axis with the largest dimension).
  const d = e.dims, ax = d[0] >= d[1] && d[0] >= d[2] ? 0 : d[1] >= d[2] ? 1 : 2;
  const q = e.pose.quaternion, u: Vec3 = [0, 0, 0];
  const [x, y, z, w] = q;
  const R = [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
  for (let i = 0; i < 3; i++) u[i] = R[3 * i + ax];
  const lam = stretchAlong(F.T, u);
  const rows: [string, string][] = [
    [t('celestial.inspect.distance'), `${fmt(F.d, 2)} m · r_c ${fmt(Math.sqrt(F.l.cap2), 2)} · ε ${fmt(Math.sqrt(F.l.eps2), 2)} m`],
    [t('celestial.inspect.accel'), `${sci(F.gm)} m/s² · ${fmt(F.gm / 9.81, 2)} g₀`],
    [t('celestial.inspect.escape'), `${sci(F.vEsc)} m/s`],
    [t('celestial.inspect.tide'), `λ₁ ${sci(F.l1, 3)} s⁻² · ${t('celestial.inspect.alongAxis')} ${sci(lam, 3)} s⁻²`],
    [t('celestial.inspect.tension'), `${force(barTension(m, d[ax], lam))} ${t('celestial.inspect.tensionRef')}`],
  ];
  const physics = simulationController.getPhysics();
  if (e.dynamic && e.body !== null && physics) {
    const v = physics.getLinearVelocity(e.body);
    const r: Vec3 = [p[0] - F.l.x, p[1] - F.l.y, p[2] - F.l.z], vr: Vec3 = [v[0] - F.l.vx, v[1] - F.l.vy, v[2] - F.l.vz];
    const el = elements(F.l.mu, r, vr, Math.sqrt(F.l.eps2));
    const single = F.f.points.live.length === 1 && F.f.G[0] === 0 && F.f.G[1] === 0 && F.f.G[2] === 0;
    rows.push([t('celestial.inspect.speed'), `${fmt(Math.hypot(...v), 2)} m/s`]);
    rows.push([t('celestial.inspect.energy'), `${fmt(0.5 * (v[0] ** 2 + v[1] ** 2 + v[2] ** 2) + F.phi, 1)} J/kg`]);
    rows.push([t('celestial.inspect.angular'), `${fmt(Math.hypot(...el.h), 1)} m²/s`]);
    rows.push([t('celestial.inspect.orbit'), single && el.exact ? t('celestial.inspect.conic', { k: t(`celestial.kind.orbit.${el.kind}` as MessageKey), p: fmt(el.periapsis, 1), a: Number.isFinite(el.apoapsis) ? fmt(el.apoapsis, 1) : '∞' }) : t('celestial.inspect.noConic')]);
  }
  return (
    <Section title={t('celestial.inspect.title')}>
      <Rows testId="celestial-object" rows={rows} />
      {(e.source.type === 'human' || e.source.type === 'car') && <div className={styles.note}>{t('celestial.inspect.noBodyModel')}</div>}
    </Section>
  );
}

/** Celestial field at the probed ground point (Phase 32) and the probe bodies' orbit diagnostics. */
export function CelestialProbeSection() {
  const t = useT();
  useSimStore((s) => s.time);
  const c = useSimStore((s) => s.celestial);
  const probe = useViewStore((s) => s.waterProbe);
  const f = simulationController.getEnvironment().gravity.field;
  if (!c || !f || !f.points.live.length) return null;
  const rows: [string, string][] = [];
  if (probe) {
    const y = simulationController.getEnvironment().terrain.sampleHeight(probe.x, probe.z) + 1;
    const F = facts([probe.x, y, probe.z]);
    const n = symEigenvector(F.T, F.l1);
    rows.push([t('celestial.inspect.distance'), `${fmt(F.d, 2)} m`]);
    rows.push([t('celestial.inspect.accel'), `${sci(F.gm)} m/s²`]);
    rows.push([t('celestial.inspect.potential'), `${sci(F.phi)} J/kg`]);
    rows.push([t('celestial.inspect.escape'), `${sci(F.vEsc)} m/s`]);
    rows.push([t('celestial.inspect.tide'), `λ₁ ${sci(F.l1, 3)} s⁻² · (${n.map((v) => fmt(v, 2)).join(', ')})`]);
  }
  for (const p of c.probes) {
    const d = p.diag;
    rows.push([p.id, `${t(`celestial.probeState.${p.state}` as MessageKey)} · r ${fmt(d.r, 2)} (${fmt(d.rMin, 2)}–${fmt(d.rMax, 2)}) m · v ${fmt(d.v, 2)} m/s`]);
    rows.push(['', `${d.conserved ? t('celestial.inspect.errors') : t('celestial.inspect.changes')} ΔE/E ${d.maxErr.toExponential(1)} · ΔL/L ${d.lErr.toExponential(1)}${Number.isFinite(d.period) ? ` · T ${fmt(d.period, 3)} s (${d.revs})` : ''}`]);
  }
  if (!rows.length) return null;
  return (
    <Section title={t('celestial.probe.title')}>
      <Rows testId="celestial-probe" rows={rows} />
      <div className={styles.note}>{t('celestial.probe.note')}</div>
    </Section>
  );
}
