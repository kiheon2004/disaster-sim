import { describe, expect, it } from 'vitest';
import { WindField } from '../environment/WindField';
import { createSampleCache, SpatialWindField } from './SpatialWindField';
import type { WindObstacle } from './obstacles';
import { DEFAULT_WIND_MODEL } from '@/core/model';
import { smoothstep } from '@/core/math';
import { Rng } from '@/core/random';
import type { Vec3 } from '@/core/types';

function randomObstacles(rng: Rng, n: number): WindObstacle[] {
  return Array.from({ length: n }, (_, i) => {
    const yaw = rng.range(0, Math.PI);
    return {
      id: `b${i}`,
      cx: rng.spread(140),
      cz: rng.spread(140),
      hx: rng.range(2, 9),
      hz: rng.range(1, 8),
      ax: [Math.cos(yaw), -Math.sin(yaw)] as [number, number],
      az: [Math.sin(yaw), Math.cos(yaw)] as [number, number],
      height: rng.range(2, 34),
      active: true,
    };
  });
}

/** Reference: the obstacle effect computed by scanning EVERY obstacle (same math, same order). */
function bruteForce(field: SpatialWindField, p: Vec3, excludeId?: string) {
  const f = field.global.flow();
  const n0 = -f[2];
  const n1 = f[0];
  const prm = field.params;
  // Extents as frozen by the field's last full rebuild.
  const { extD, extW } = (field as unknown as { index: { extD: Float64Array; extW: Float64Array } }).index;
  const out = { factor: 1, speedup: 1, turbulence: 0, source: null as string | null, corner: false };
  let minFactor = 1;
  let maxCorner = 0;
  field.getObstacles().forEach((o, idx) => {
    if (!o.active || o.id === excludeId) return;
    const H = o.height;
    const rx = p[0] - o.cx;
    const rz = p[2] - o.cz;
    const a = rx * f[0] + rz * f[2];
    const c = Math.abs(rx * n0 + rz * n1);
    const D = extD[idx];
    const W = extW[idx];
    if (a > -D && a < D && c < W && p[1] < H) {
      out.factor *= 0.3;
      if (0.3 < minFactor) { minFactor = 0.3; out.source = o.id; }
      return;
    }
    const vert = 1 - smoothstep(0.9 * H, 1.4 * H, p[1]);
    if (vert <= 0) return;
    const d = a - D;
    const L = prm.wakeLength * H;
    if (d > 0 && d < L) {
      const w = W + prm.wakeSpread * d;
      const lat = 1 - smoothstep(0.75 * w, 1.15 * w, c);
      if (lat > 0) {
        const decay = Math.exp(-d / (prm.wakeRecovery * H)) * (1 - smoothstep(0.7 * L, L, d));
        const fac = 1 - prm.shadowStrength * decay * lat * vert;
        out.factor *= fac;
        out.turbulence += lat * vert * Math.exp(-d / (1.5 * prm.wakeRecovery * H));
        if (fac < minFactor) { minFactor = fac; out.source = o.id; }
      }
    }
    const band = 0.5 * H;
    if (a > -D && a < D + 0.5 * H && c >= W && c < W + band) {
      const edge = (1 - (c - W) / band) * vert;
      if (edge > maxCorner) maxCorner = edge;
      out.turbulence += 0.6 * edge;
      out.corner = true;
    }
  });
  out.factor = Math.max(0.15, out.factor);
  out.speedup = 1 + prm.cornerSpeedup * maxCorner;
  out.turbulence = Math.min(1, out.turbulence);
  return out;
}

function points(rng: Rng, n: number): Vec3[] {
  // Mostly inside the world, some far outside (debris), heights up to above the tallest roof.
  return Array.from({ length: n }, (_, i) => [rng.spread(i % 10 === 0 ? 600 : 170), rng.range(0, 50), rng.spread(i % 10 === 0 ? 600 : 170)] as Vec3);
}

function expectSame(field: SpatialWindField, pts: Vec3[]) {
  let mismatches = 0;
  for (const p of pts) {
    const a = field.obstacleEffect(p);
    const b = bruteForce(field, p);
    if (a.factor !== b.factor || a.speedup !== b.speedup || a.turbulence !== b.turbulence || a.source !== b.source || a.corner !== b.corner) mismatches++;
  }
  expect(mismatches).toBe(0);
}

function setup(seed: number, bearing: number) {
  const rng = new Rng(seed);
  const wind = new WindField();
  wind.baseSpeed = 40;
  wind.fromBearing = bearing;
  wind.gustStrength = 0.3;
  const field = new SpatialWindField(wind, DEFAULT_WIND_MODEL, 3);
  field.setObstacles(randomObstacles(rng, 60));
  return { rng, wind, field };
}

describe('ObstacleIndex (flow-aligned spatial index)', () => {
  it.each([0, 37, 90, 135, 222.5, 300])('matches a full scan bit-for-bit (wind from %f°)', (bearing) => {
    const { rng, field } = setup(11 + bearing, bearing);
    expectSame(field, points(rng, 4000));
  });

  it('lists far fewer candidates than there are obstacles', () => {
    const { rng, field } = setup(5, 45);
    const pts = points(rng, 2000);
    const avg = pts.reduce((a, p) => a + field.candidatesAt(p[0], p[2]).length, 0) / pts.length;
    expect(avg).toBeLessThan(60 / 4);
  });

  it('stays exact while the wind turns by less than the rebuild angle', () => {
    const { rng, wind, field } = setup(21, 80);
    const pts = points(rng, 3000);
    field.obstacleEffect([0, 1, 0]); // build at 80°
    for (const b of [80.4, 81.1, 81.49, 79.2, 78.6]) {
      wind.fromBearing = b;
      expectSame(field, pts);
    }
  });

  it('removal, addition and moving obstacles keep it exact', () => {
    const { rng, field } = setup(33, 200);
    const pts = points(rng, 3000);
    field.obstacleEffect([0, 1, 0]);
    field.removeObstacle('b3');
    field.removeObstacle('b17');
    expectSame(field, pts);
    field.addObstacle({ id: 'new', cx: 10, cz: -20, hx: 6, hz: 4, ax: [1, 0], az: [0, 1], height: 25, active: true });
    expectSame(field, pts);
    field.updateObstacle('b5', { cx: -40, cz: 35, hx: 5, hz: 5, ax: [0, 1], az: [-1, 0], height: 30 });
    expectSame(field, pts);
    expect(field.getObstacles().find((o) => o.id === 'b5')!.cx).toBe(-40);
  });

  it('a removal only invalidates cached effects where its wake reached', () => {
    const { rng, field } = setup(44, 270);
    const pts = points(rng, 1500);
    const caches = pts.map(() => createSampleCache());
    const sampled = () => pts.map((p, i) => field.sample(p, 3, undefined, caches[i]).speed);
    sampled();
    const versions = caches.map((c) => c.cellVersion);
    const tallest = [...field.getObstacles()].sort((a, b) => b.height - a.height)[0];
    field.removeObstacle(tallest.id);
    const after = sampled();
    // Cached values equal a fresh computation (no stale wake)…
    expect(after).toEqual(pts.map((p) => field.sample(p, 3).speed));
    // …but only the caches in cells under the removed obstacle's region were recomputed.
    const recomputed = caches.filter((c, i) => c.cellVersion !== versions[i]).length;
    expect(recomputed).toBeGreaterThan(0);
    expect(recomputed).toBeLessThan(pts.length * 0.5);
  });
});
