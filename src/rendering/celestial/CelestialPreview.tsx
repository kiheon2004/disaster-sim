/**
 * Celestial preview in the editor (Phase 32): each source at its start (black core, capture sphere, softening sphere,
 * substep-limit radius) with its prescribed path, and each probe's PREDICTED orbit — the conic of the single unsoftened
 * source from the probe's initial conditions (closed form; the run integrates the full field, which may differ: the
 * tools panel says when the prediction is exact).
 */
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { PhenomenonInstance } from '@/phenomena/types';
import type { Vec3 } from '@/core/types';
import type { CelestialSpec } from '@/celestial/types';
import { G_N } from '@/celestial/constants';
import { circularSpeed, escapeSpeed, launchVelocity } from '@/celestial/orbit';
import { useDisposable } from '../useDisposable';
import { limitRadius } from './CelestialLayer';

/** Points of a probe's Kepler orbit (ellipse: closed; hyperbola / parabola: the branch within 400 m). */
export function conicPoints(mu: number, r: Readonly<Vec3>, v: Readonly<Vec3>, c: Readonly<Vec3>, n = 180): Vec3[] {
  const h: Vec3 = [r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]];
  const hm = Math.hypot(...h);
  const rm = Math.hypot(...r);
  if (!(hm > 1e-9)) return [[c[0] + r[0], c[1] + r[1], c[2] + r[2]], [c[0], c[1], c[2]]];
  const ev: Vec3 = [(v[1] * h[2] - v[2] * h[1]) / mu - r[0] / rm, (v[2] * h[0] - v[0] * h[2]) / mu - r[1] / rm, (v[0] * h[1] - v[1] * h[0]) / mu - r[2] / rm];
  const e = Math.hypot(...ev);
  const p = (hm * hm) / mu;
  // In-plane basis: P towards periapsis, Q = ĥ × P.
  const hn: Vec3 = [h[0] / hm, h[1] / hm, h[2] / hm];
  const P: Vec3 = e > 1e-9 ? [ev[0] / e, ev[1] / e, ev[2] / e] : [r[0] / rm, r[1] / rm, r[2] / rm];
  const Q: Vec3 = [hn[1] * P[2] - hn[2] * P[1], hn[2] * P[0] - hn[0] * P[2], hn[0] * P[1] - hn[1] * P[0]];
  const nuMax = e < 1 ? Math.PI : Math.acos(Math.max(-1, Math.min(1, (p / 400 - 1) / e)));
  const out: Vec3[] = [];
  for (let k = 0; k <= n; k++) {
    const nu = -nuMax + (2 * nuMax * k) / n;
    const rr = p / (1 + e * Math.cos(nu));
    if (!(rr > 0) || rr > 2000) continue;
    const x = rr * Math.cos(nu), y = rr * Math.sin(nu);
    out.push([c[0] + x * P[0] + y * Q[0], c[1] + x * P[1] + y * Q[1], c[2] + x * P[2] + y * Q[2]]);
  }
  return out;
}

export function CelestialPreview({ inst }: { inst: PhenomenonInstance }) {
  const spec = inst.spec as CelestialSpec;
  const ball = useDisposable(() => new THREE.SphereGeometry(1, 32, 16));
  const core = useDisposable(() => new THREE.MeshBasicMaterial({ color: '#000000' }));
  const cap = useDisposable(() => new THREE.MeshBasicMaterial({ color: '#ff4a4a', wireframe: true, transparent: true, opacity: 0.5, depthWrite: false }));
  const eps = useDisposable(() => new THREE.MeshBasicMaterial({ color: '#5fd0ff', wireframe: true, transparent: true, opacity: 0.35, depthWrite: false }));
  const lim = useDisposable(() => new THREE.MeshBasicMaterial({ color: '#d24bd8', wireframe: true, transparent: true, opacity: 0.35, depthWrite: false }));
  const lineMat = useDisposable(() => new THREE.LineBasicMaterial({ color: '#7ff0c0', transparent: true, opacity: 0.85 }));
  const pathMat = useDisposable(() => new THREE.LineBasicMaterial({ color: '#ffb35c', transparent: true, opacity: 0.8 }));
  const lines = useMemo(() => {
    const g = new THREE.Group();
    for (const p of spec.probes) {
      const s = spec.sources[p.source ?? 0];
      if (!s) continue;
      const c: Vec3 = s.motion === 'path' && s.path ? [s.path[0][1], s.path[0][2], s.path[0][3]] : s.center;
      const r: Vec3 = [p.position[0] - c[0], p.position[1] - c[1], p.position[2] - c[2]];
      const mu = G_N * s.mass, rm = Math.hypot(...r);
      const v = p.mode === 'custom' ? (p.velocity ?? [0, 0, 0]) : launchVelocity(r, p.direction, p.factor * (p.mode === 'circular' ? circularSpeed(mu, rm, s.softening) : escapeSpeed(mu, rm, s.softening)), p.mode === 'circular');
      const pts = conicPoints(mu, r, v, c);
      if (pts.length > 1) g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts.map((q) => new THREE.Vector3(...q))), lineMat));
    }
    for (const s of spec.sources) {
      const pts: Vec3[] = s.motion === 'path' && s.path ? s.path.map((w) => [w[1], w[2], w[3]] as Vec3) : s.motion === 'velocity' && s.velocity ? [s.center, [s.center[0] + s.velocity[0] * spec.duration, s.center[1] + s.velocity[1] * spec.duration, s.center[2] + s.velocity[2] * spec.duration]] : [];
      if (pts.length > 1) g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts.map((q) => new THREE.Vector3(...q))), pathMat));
    }
    g.traverse((o) => { o.raycast = () => null; });
    return g;
  }, [spec, lineMat, pathMat]);
  useEffect(() => () => lines.traverse((o) => { if (o instanceof THREE.Line) o.geometry.dispose(); }), [lines]);
  return (
    <group name="celestial-preview">
      <primitive object={lines} />
      {spec.sources.map((s, i) => {
        const c: Vec3 = s.motion === 'path' && s.path ? [s.path[0][1], s.path[0][2], s.path[0][3]] : s.center;
        const rl = limitRadius(G_N * s.mass, s.softening);
        return (
          <group key={i} position={c}>
            <mesh geometry={ball} material={core} scale={s.kind === 'blackHole' ? Math.max(0.2, s.capture) : Math.max(0.3, s.softening / 3)} raycast={() => null} />
            {s.kind === 'blackHole' && <mesh geometry={ball} material={cap} scale={s.capture} raycast={() => null} />}
            <mesh geometry={ball} material={eps} scale={s.softening} raycast={() => null} />
            {rl > (s.kind === 'blackHole' ? s.capture : 0) && <mesh geometry={ball} material={lim} scale={rl} raycast={() => null} />}
          </group>
        );
      })}
    </group>
  );
}
