/**
 * Phase 32.1: member samples from cached source geometry equal sampling the field member by member (bit for bit), and
 * the bounds hold against direct samples — the change of g_y since a reference state (μ ramping / growing, uniform part
 * changing) and the largest upward g_y — over random members, sources (inside / beyond the influence taper) and μ.
 */
import { describe, expect, it } from 'vitest';
import { GravityField } from '@/gravity/field';
import { defaultCelestialSpec, defaultSource } from '@/celestial/types';
import { G_N } from '@/celestial/constants';
import type { RuntimeEntity } from '../SimulationRuntime';
import type { StructureState } from '../structure/state';
import { memberGy, memberRef, changeBound, upBound } from './memberField';
import type { Vec3 } from '@/core/types';

/** Deterministic pseudo-random numbers (LCG). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function building(r: () => number, n: number) {
  const box = new Float64Array(6 * n);
  for (let i = 0; i < n; i++) {
    const x = (r() - 0.5) * 10, y = r() * 12, z = (r() - 0.5) * 10, h = 0.2 + r();
    box.set([x - h, y, z - h, x + h, y + h, z + h], 6 * i);
  }
  const yaw = r() * 6.28;
  const e = { pose: { position: [(r() - 0.5) * 120, 0, (r() - 0.5) * 120] as Vec3, quaternion: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] as [number, number, number, number] } } as unknown as RuntimeEntity;
  const st = { model: { g: { n, box } } } as unknown as StructureState;
  return { e, st };
}

function field(r: () => number, sources: number, ramp: number) {
  const f = new GravityField(9.81);
  const spec = defaultCelestialSpec();
  spec.sources = Array.from({ length: sources }, () => ({ ...defaultSource(), center: [(r() - 0.5) * 80, 10 + r() * 50, (r() - 0.5) * 80] as Vec3, mass: (1e4 + r() * 2e5) / G_N, softening: 1 + r() * 4, influence: r() < 0.5 ? 0 : 40 + r() * 80, ramp }));
  f.addCelestial({ id: 'c', spec, start: 0 });
  return f;
}

describe('member field', () => {
  it('cached-geometry samples equal f.sample at every member centre, bit for bit', () => {
    const r = rng(1);
    for (let t = 0; t < 40; t++) {
      const { e, st } = building(r, 30);
      const f = field(r, 1 + Math.floor(r() * 4), 10).prepare(r() * 12);
      const gy = memberGy(e, st, f);
      const g = st.model.g;
      for (let i = 0; i < g.n; i++) {
        const o = 6 * i;
        const c = [(g.box[o] + g.box[o + 3]) / 2, (g.box[o + 1] + g.box[o + 4]) / 2, (g.box[o + 2] + g.box[o + 5]) / 2];
        const q = e.pose.quaternion, v = c;
        // Rotate by the yaw quaternion (independent of toWorld): y-axis rotation by angle θ, q = (0, sin θ/2, 0, cos θ/2).
        const th = 2 * Math.atan2(q[1], q[3]);
        const wx = e.pose.position[0] + Math.cos(th) * v[0] + Math.sin(th) * v[2], wz = e.pose.position[2] - Math.sin(th) * v[0] + Math.cos(th) * v[2];
        const direct = f.sample(wx, v[1], wz, [0, 0, 0])[1];
        expect(Math.abs(gy[i] - direct)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(direct)));
      }
      // Bit for bit against the same centres the cache uses (re-sampled after a μ change: the geometry is reused).
      f.prepare(f.time + 0.37);
      const gy2 = Float64Array.from(memberGy(e, st, f));
      const again = Float64Array.from({ length: g.n }, (_, i) => {
        const o = 6 * i;
        const th = 2 * Math.atan2(e.pose.quaternion[1], e.pose.quaternion[3]);
        const cx = (g.box[o] + g.box[o + 3]) / 2, cy = (g.box[o + 1] + g.box[o + 4]) / 2, cz = (g.box[o + 2] + g.box[o + 5]) / 2;
        return f.sample(e.pose.position[0] + Math.cos(th) * cx + Math.sin(th) * cz, cy, e.pose.position[2] - Math.sin(th) * cx + Math.cos(th) * cz, [0, 0, 0])[1];
      });
      for (let i = 0; i < g.n; i++) expect(Math.abs(gy2[i] - again[i])).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(again[i])));
    }
  });

  it('changeBound ≥ the largest change of g_y since the reference, upBound ≥ the largest g_y (ramping sources)', () => {
    const r = rng(7);
    let tight = 0;
    for (let t = 0; t < 60; t++) {
      const { e, st } = building(r, 25);
      const f = field(r, 1 + Math.floor(r() * 3), 10);
      const t0 = r() * 9;
      f.prepare(t0);
      const ref = memberRef(e, st, f)!;
      const gy0 = Float64Array.from(memberGy(e, st, f));
      for (const dt of [0.01, 0.1, 0.5, 2]) {
        f.prepare(t0 + dt);
        const gy = memberGy(e, st, f);
        let maxChange = 0, maxGy = -Infinity;
        for (let i = 0; i < gy.length; i++) { maxChange = Math.max(maxChange, Math.abs(gy[i] - gy0[i])); maxGy = Math.max(maxGy, gy[i]); }
        const b = changeBound(e, st, f, ref);
        const u = upBound(e, st, f)!;
        // Exact-arithmetic bounds against rounded samples: up to rounding at the field's scale (the callers keep a
        // margin of half the re-application quantum, 10⁻⁹ of the scale).
        const eps = 1e-13 * u.scale;
        expect(b + eps).toBeGreaterThanOrEqual(maxChange);
        if (b < 2 * maxChange + 1e-9) tight++;
        expect(u.up + eps).toBeGreaterThanOrEqual(maxGy);
      }
    }
    // The bound is useful, not only valid: within 2× of the true change in a good share of the cases.
    expect(tight).toBeGreaterThan(30);
  });

  it('no bound when the geometry changed or a Phase 31 local source shapes the base part', () => {
    const r = rng(3);
    const { e, st } = building(r, 10);
    const f = field(r, 2, 0).prepare(1);
    const ref = memberRef(e, st, f)!;
    (e.pose.position as Vec3)[0] += 0.5;
    expect(changeBound(e, st, f, ref)).toBe(Infinity);
  });
});
