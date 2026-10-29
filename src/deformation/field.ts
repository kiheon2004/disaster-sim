/**
 * Spatial shapes, time profiles and validation of prescribed deformations (Phase 21).
 * Pure functions of the spec (and seed): the same input gives the same field on every run.
 *
 * Shapes (t = distance / radius, S ∈ [0, 1], S = 0 for t ≥ 1):
 *   smooth   ½(1 + cos πt)                     C¹: zero slope at the centre and at the rim
 *   linear   1 − t                              cone
 *   steep    1 for t ≤ 0.5, then ½(1 + cos(π(t − 0.5)/0.5))   flat bottom + steep wall
 *   depression   always 'steep'                localized, steep-sided
 *   settlement   smooth × (1 + v·n(x, z)), n ∈ [−1, 1] seeded value noise (16 m scale), ≥ 0
 *   ridge    smooth across the axis (d / halfWidth) × smoothstep tapers over 15 % of the length
 *   prescribed   bilinear interpolation of the user grid (0 outside it)
 *
 * Time profiles f(τ), τ = local time, D = duration:
 *   instant  1 from τ = 0
 *   linear   τ / D
 *   smooth   smoothstep(τ / D)                  no jerk at start / end
 *   staged   ⌊n·τ/D⌋ / n, 1 at τ ≥ D           n equal steps
 *   cyclic   ½(1 − cos 2πτ/P) for τ ≤ D, then holds f(D)   repeated rise and recovery
 */
import { Rng } from '@/core/random';
import { smoothstep } from '@/core/math';
import { ValueNoise } from '@/terrain/TerrainPresets';
import type { TerrainData } from '@/core/model';
import type { GridRect } from '@/terrain/TerrainData';
import { KIND_SIGN, type DeformationKind, type TerrainDeformationSpec } from './types';

/** Hard limits (inputs outside are refused with a reason). */
export const LIMITS = {
  amount: [0, 30],
  radius: [2, 150],
  duration: [0, 3600],
  stages: [1, 50],
  period: [0.5, 600],
  length: [4, 300],
  variability: [0, 1],
  supportLoss: [0, 0.9],
  fieldCells: 2001 * 2001,
} as const;

/** Soft limits (warnings with the reason, never hidden). */
export const WARN = {
  /** Maximum surface slope added by the deformation (m/m): 1 = 45°. */
  slope: 1,
  /** Above this slope the water solver's CFL substeps and contact stability suffer. */
  slopeSevere: 3,
  /** Large displacement (m). */
  amount: 10,
} as const;

const noiseCache = new Map<number, ValueNoise>();
function noiseFor(seed: number): ValueNoise {
  let n = noiseCache.get(seed);
  if (!n) {
    n = new ValueNoise(new Rng((seed >>> 0) || 1).fork('settlement'));
    noiseCache.set(seed, n);
    if (noiseCache.size > 32) noiseCache.delete(noiseCache.keys().next().value!);
  }
  return n;
}

function radial(falloff: 'smooth' | 'linear' | 'steep', t: number): number {
  if (t >= 1) return 0;
  if (falloff === 'linear') return 1 - t;
  if (falloff === 'steep') return t <= 0.5 ? 1 : 0.5 * (1 + Math.cos((Math.PI * (t - 0.5)) / 0.5));
  return 0.5 * (1 + Math.cos(Math.PI * t));
}

/** Unit vector of a ridge axis from its bearing (deg; 0 = north = −z, 90 = east = +x). */
function axis(bearing: number): [number, number] {
  const a = (bearing * Math.PI) / 180;
  return [Math.sin(a), -Math.cos(a)];
}

/** World bounding box [x0, z0, x1, z1] of a deformation's support. */
export function deformationBounds(s: TerrainDeformationSpec): [number, number, number, number] {
  if (s.kind === 'prescribed' && s.field) {
    const f = s.field;
    return [f.x0, f.z0, f.x0 + (f.nx - 1) * f.cell, f.z0 + (f.nz - 1) * f.cell];
  }
  const [cx, cz] = s.center;
  if (s.kind === 'ridge') {
    const [ax, az] = axis(s.bearing ?? 90);
    const h = (s.length ?? 60) / 2, w = s.radius;
    const ex = Math.abs(ax) * h + Math.abs(az) * w, ez = Math.abs(az) * h + Math.abs(ax) * w;
    return [cx - ex, cz - ez, cx + ex, cz + ez];
  }
  return [cx - s.radius, cz - s.radius, cx + s.radius, cz + s.radius];
}

/** Unit spatial shape S ∈ [0, 1] (prescribed: the signed field value in m — see `amplitude`). */
export function shapeAt(s: TerrainDeformationSpec, x: number, z: number, seed: number): number {
  const kind: DeformationKind = s.kind;
  if (kind === 'prescribed') {
    const f = s.field;
    if (!f) return 0;
    const gx = (x - f.x0) / f.cell, gz = (z - f.z0) / f.cell;
    if (gx < 0 || gz < 0 || gx > f.nx - 1 || gz > f.nz - 1) return 0;
    const ix = Math.min(f.nx - 2, Math.floor(gx)), iz = Math.min(f.nz - 2, Math.floor(gz));
    if (f.nx === 1 || f.nz === 1) return f.values[Math.round(gz) * f.nx + Math.round(gx)] ?? 0;
    const ax = gx - ix, az = gz - iz, i = iz * f.nx + ix, v = f.values;
    return (v[i] * (1 - ax) + v[i + 1] * ax) * (1 - az) + (v[i + f.nx] * (1 - ax) + v[i + f.nx + 1] * ax) * az;
  }
  const [cx, cz] = s.center;
  if (kind === 'ridge') {
    const [ax, az] = axis(s.bearing ?? 90);
    const dx = x - cx, dz = z - cz;
    const along = dx * ax + dz * az, across = Math.abs(-dx * az + dz * ax);
    const h = (s.length ?? 60) / 2;
    if (Math.abs(along) >= h || across >= s.radius) return 0;
    const e = Math.max(1e-6, 0.15 * 2 * h);
    const taper = smoothstep(0, e, h - Math.abs(along));
    return radial('smooth', across / s.radius) * taper;
  }
  const t = Math.hypot(x - cx, z - cz) / s.radius;
  if (t >= 1) return 0;
  if (kind === 'depression') return radial('steep', t);
  const base = radial(s.falloff ?? 'smooth', t);
  if (kind === 'settlement') {
    const v = s.variability ?? 0;
    if (v <= 0) return base;
    const n = noiseFor(s.seed ?? seed).fbm(x / 16, z / 16, 3);
    return Math.max(0, base * (1 + v * n));
  }
  return base;
}

/** Signed amplitude multiplying the shape (prescribed: the field already holds metres). */
export const amplitude = (s: TerrainDeformationSpec) => (s.kind === 'prescribed' ? 1 : KIND_SIGN[s.kind] * s.amount);

/** Time factor f ∈ [0, 1] at local time τ (negative τ = not started = 0). */
export function timeFactor(s: TerrainDeformationSpec, tau: number): number {
  if (tau < 0) return 0;
  const D = s.duration;
  switch (s.profile) {
    case 'instant':
      return 1;
    case 'linear':
      return D <= 0 ? 1 : Math.min(1, tau / D);
    case 'smooth':
      return D <= 0 ? 1 : smoothstep(0, D, tau);
    case 'staged': {
      if (D <= 0 || tau >= D) return 1;
      const n = Math.max(1, Math.round(s.stages ?? 3));
      return Math.floor((n * tau) / D) / n;
    }
    case 'cyclic': {
      const P = Math.max(LIMITS.period[0], s.period ?? 4);
      const at = (u: number) => 0.5 * (1 - Math.cos((2 * Math.PI * u) / P));
      return at(Math.min(tau, Math.max(0, D)));
    }
  }
}

/** Seconds of the event (instant: one fixed step so the scheduler sees a start and an end). */
export const eventDuration = (s: TerrainDeformationSpec) => (s.profile === 'instant' ? 1 / 60 : Math.max(1 / 60, s.duration));

/** Vertex rectangle of a world box on a grid (clamped; null when outside). */
export function rectOn(t: Pick<TerrainData, 'nx' | 'nz' | 'cellSize' | 'originX' | 'originZ'>, [x0, z0, x1, z1]: [number, number, number, number]): GridRect | null {
  const c = (v: number, n: number) => Math.min(n - 1, Math.max(0, v));
  const r = {
    x0: c(Math.floor((x0 - t.originX) / t.cellSize), t.nx), z0: c(Math.floor((z0 - t.originZ) / t.cellSize), t.nz),
    x1: c(Math.ceil((x1 - t.originX) / t.cellSize), t.nx), z1: c(Math.ceil((z1 - t.originZ) / t.cellSize), t.nz),
  };
  const outside = x1 < t.originX || z1 < t.originZ || x0 > t.originX + (t.nx - 1) * t.cellSize || z0 > t.originZ + (t.nz - 1) * t.cellSize;
  return outside || r.x1 < r.x0 || r.z1 < r.z0 ? null : r;
}

/** Unit-shape grid of a spec over its rect (multiplied by amplitude × f at runtime). */
export function shapeGrid(s: TerrainDeformationSpec, t: Pick<TerrainData, 'nx' | 'nz' | 'cellSize' | 'originX' | 'originZ'>, seed: number): { rect: GridRect; values: Float32Array } | null {
  const rect = rectOn(t, deformationBounds(s));
  if (!rect) return null;
  const w = rect.x1 - rect.x0 + 1, h = rect.z1 - rect.z0 + 1;
  const values = new Float32Array(w * h);
  const A = amplitude(s);
  for (let iz = 0; iz < h; iz++) for (let ix = 0; ix < w; ix++) {
    const x = t.originX + (rect.x0 + ix) * t.cellSize, z = t.originZ + (rect.z0 + iz) * t.cellSize;
    values[iz * w + ix] = A * shapeAt(s, x, z, seed);
  }
  return { rect, values };
}

export interface DeformationIssue {
  /** i18n suffix: deform.issue.<code> */
  code: 'amount' | 'radius' | 'duration' | 'stages' | 'period' | 'length' | 'field' | 'outside' | 'edge' | 'steep' | 'verySteep' | 'large' | 'support';
  severity: 'error' | 'warning';
  value?: number;
}

/**
 * Checks of a spec. Errors refuse it (outside the hard limits); warnings explain why a result
 * may be unrealistic or numerically demanding — they never block the experiment.
 */
export function validateDeformation(s: TerrainDeformationSpec, t: Pick<TerrainData, 'nx' | 'nz' | 'cellSize' | 'originX' | 'originZ'> | null, seed = 1): { issues: DeformationIssue[]; maxSlope: number; maxAbs: number; volume: number } {
  const issues: DeformationIssue[] = [];
  const out = (v: number, [lo, hi]: readonly [number, number]) => !Number.isFinite(v) || v < lo || v > hi;
  if (s.kind !== 'prescribed' && out(s.amount, LIMITS.amount)) issues.push({ code: 'amount', severity: 'error', value: s.amount });
  if (s.kind !== 'prescribed' && out(s.radius, LIMITS.radius)) issues.push({ code: 'radius', severity: 'error', value: s.radius });
  if (out(s.duration, LIMITS.duration)) issues.push({ code: 'duration', severity: 'error', value: s.duration });
  if (s.profile === 'staged' && s.stages !== undefined && out(s.stages, LIMITS.stages)) issues.push({ code: 'stages', severity: 'error', value: s.stages });
  if (s.profile === 'cyclic' && s.period !== undefined && out(s.period, LIMITS.period)) issues.push({ code: 'period', severity: 'error', value: s.period });
  if (s.kind === 'ridge' && s.length !== undefined && out(s.length, LIMITS.length)) issues.push({ code: 'length', severity: 'error', value: s.length });
  if (s.supportLoss !== undefined && out(s.supportLoss, LIMITS.supportLoss)) issues.push({ code: 'support', severity: 'error', value: s.supportLoss });
  if (s.kind === 'prescribed') {
    const f = s.field;
    const bad = !f || !(f.nx >= 1 && f.nz >= 1 && f.nx * f.nz <= LIMITS.fieldCells && f.cell > 0 && f.values.length === f.nx * f.nz && f.values.every((v) => Number.isFinite(v) && Math.abs(v) <= LIMITS.amount[1]));
    if (bad) issues.push({ code: 'field', severity: 'error' });
  }
  let maxSlope = 0, maxAbs = 0, volume = 0;
  if (t && !issues.some((i) => i.severity === 'error')) {
    const g = shapeGrid(s, t, seed);
    if (!g) issues.push({ code: 'outside', severity: 'warning' });
    else {
      const { rect, values } = g;
      const w = rect.x1 - rect.x0 + 1, h = rect.z1 - rect.z0 + 1;
      for (let iz = 0; iz < h; iz++) for (let ix = 0; ix < w; ix++) {
        const v = values[iz * w + ix];
        maxAbs = Math.max(maxAbs, Math.abs(v));
        volume += v * t.cellSize * t.cellSize;
        if (ix + 1 < w) maxSlope = Math.max(maxSlope, Math.abs(values[iz * w + ix + 1] - v) / t.cellSize);
        if (iz + 1 < h) maxSlope = Math.max(maxSlope, Math.abs(values[(iz + 1) * w + ix] - v) / t.cellSize);
      }
      // Clipped by the map edge: outside the grid the ground is fixed (the y = 0 surroundings).
      const b = deformationBounds(s);
      const ex = t.originX + (t.nx - 1) * t.cellSize, ez = t.originZ + (t.nz - 1) * t.cellSize;
      if (b[0] < t.originX || b[1] < t.originZ || b[2] > ex || b[3] > ez) issues.push({ code: 'edge', severity: 'warning' });
      if (maxSlope > WARN.slopeSevere) issues.push({ code: 'verySteep', severity: 'warning', value: maxSlope });
      else if (maxSlope > WARN.slope) issues.push({ code: 'steep', severity: 'warning', value: maxSlope });
      if (maxAbs > WARN.amount) issues.push({ code: 'large', severity: 'warning', value: maxAbs });
    }
  }
  return { issues, maxSlope, maxAbs, volume };
}
