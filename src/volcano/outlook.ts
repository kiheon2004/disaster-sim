/**
 * Pre-run outlook of a volcano scenario (Phase 28) — what the editor preview shows BEFORE a run, from the
 * frozen terrain and the same material relations the run uses:
 *  - per vent: ground height, local slope and the bearing of steepest descent;
 *  - potential downslope directions: steepest-descent paths traced over the terrain from points of the
 *    vent (D8, stopping in pits / flats or at the world's edge) — where lava COULD start to go on the bare
 *    terrain, NOT a prediction of the flow's reach or width (the flow spreads, cools, builds its own levees
 *    and is diverted by its own deposits and by objects);
 *  - the initial material state at the eruption temperature: crystal fraction, viscosity, yield strength,
 *    the critical depth on the local slope (thinner lava does not move there), lock-up temperature;
 *  - erupted volume / mass, bomb and ash shares.
 */
import type { TerrainData } from '@/core/model';
import { LAVA_MATERIALS, crystalFraction, viscosity, yieldStrength, lockTemperature } from './materials';
import { criticalDepth } from './rheology';
import { totalVolume, peakTime } from './eruption';
import { volcanoIssues, type VolcanoSpec, type VentSpec } from './types';
import { ZERO_C } from '@/thermal/units';

export interface VentOutlook {
  x: number;
  z: number;
  ground: number;
  /** Slope (deg) and bearing of steepest descent (deg, 0 = north / −z, 90 = east / +x). */
  slope: number;
  bearing: number;
  hcr: number;
}

export interface VolcanoOutlook {
  vents: VentOutlook[];
  paths: [number, number][][];
  volume: number;
  mass: number;
  bombs: number;
  ash: number;
  crystals: number;
  viscosity: number;
  yieldStrength: number;
  lockC: number;
  peakAt: number;
  issues: string[];
}

function heightAt(t: TerrainData, ix: number, iz: number) {
  return t.heights[iz * t.nx + ix];
}

/** Steepest-descent path from a world point (D8 over the vertex grid), as world [x, z] points. */
export function steepestPath(t: TerrainData, x: number, z: number, maxLen = 120): [number, number][] {
  let ix = Math.round((x - t.originX) / t.cellSize), iz = Math.round((z - t.originZ) / t.cellSize);
  if (ix < 0 || iz < 0 || ix >= t.nx || iz >= t.nz) return [];
  const out: [number, number][] = [[t.originX + ix * t.cellSize, t.originZ + iz * t.cellSize]];
  let len = 0;
  for (let k = 0; k < 1000 && len < maxLen; k++) {
    const h = heightAt(t, ix, iz);
    let best = 0, bx = -1, bz = -1, bl = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const jx = ix + dx, jz = iz + dz;
      if (jx < 0 || jz < 0 || jx >= t.nx || jz >= t.nz) continue;
      const l = Math.hypot(dx, dz) * t.cellSize;
      const g = (h - heightAt(t, jx, jz)) / l;
      if (g > best + 1e-9) { best = g; bx = jx; bz = jz; bl = l; }
    }
    if (bx < 0 || best < 1e-4) break;
    ix = bx; iz = bz; len += bl;
    out.push([t.originX + ix * t.cellSize, t.originZ + iz * t.cellSize]);
  }
  return out;
}

function ventPoints(v: VentSpec): [number, number][] {
  const [ax, az] = v.position;
  if (v.kind === 'fissure' && v.end) {
    const [bx, bz] = v.end, n = Math.max(2, Math.min(9, Math.round(Math.hypot(bx - ax, bz - az) / 5) + 1));
    return Array.from({ length: n }, (_, k) => [ax + ((bx - ax) * k) / (n - 1), az + ((bz - az) * k) / (n - 1)] as [number, number]);
  }
  return [[ax, az], [ax + v.radius, az], [ax - v.radius, az], [ax, az + v.radius], [ax, az - v.radius]];
}

export function volcanoOutlook(s: VolcanoSpec, t: TerrainData, ground: (x: number, z: number) => number): VolcanoOutlook {
  const m = LAVA_MATERIALS[s.material] ?? LAVA_MATERIALS.basalt;
  const T = s.temperature + ZERO_C;
  const tau = yieldStrength(m, T);
  const vents: VentOutlook[] = [];
  const paths: [number, number][][] = [];
  for (const v of s.vents) {
    const [x, z] = v.kind === 'fissure' && v.end ? [(v.position[0] + v.end[0]) / 2, (v.position[1] + v.end[1]) / 2] : v.position;
    const e = 1;
    const gx = (ground(x + e, z) - ground(x - e, z)) / (2 * e), gz = (ground(x, z + e) - ground(x, z - e)) / (2 * e);
    const g = Math.hypot(gx, gz);
    const sin = g / Math.sqrt(1 + g * g);
    // Bearing of steepest DESCENT: opposite of the gradient (x east, z south → bearing from north = atan2(dx, −dz)).
    const bearing = g > 1e-6 ? ((Math.atan2(-gx, gz) * 180) / Math.PI + 360) % 360 : NaN;
    vents.push({ x, z, ground: ground(x, z), slope: (Math.atan(g) * 180) / Math.PI, bearing, hcr: criticalDepth(sin, m.thermal.bulk, tau) });
    for (const [px, pz] of ventPoints(v)) { const p = steepestPath(t, px, pz); if (p.length > 1) paths.push(p); }
  }
  const V = totalVolume(s);
  return {
    vents, paths, volume: V, mass: V * m.thermal.bulk, bombs: s.bombFraction ?? 0, ash: s.ashFraction ?? 0,
    crystals: crystalFraction(m, T), viscosity: viscosity(m, T), yieldStrength: tau, lockC: lockTemperature(m) - ZERO_C, peakAt: peakTime(s),
    issues: volcanoIssues(s),
  };
}
