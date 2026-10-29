/**
 * Natural feature shapes (Phase 19). Pure, deterministic functions of the feature parameters
 * (and, for rivers, of the landform L below them).
 *
 *  Landforms (additive Δh, compact support):
 *    mountain   h · (1 − t²)³ · (1 + ½ r · n)          t = distance / radius, n = seeded fBm
 *    hill       h · ½(1 + cos πt)
 *    ridge      h · (1 − t²)² · taper                  t = distance to the path / half width
 *    valley    −h · (1 − t²)² · taper                  (U-shaped)
 *    canyon    −h · flat floor + steep walls           (floor half the width, walls to the rim)
 *  Water features (carve: min with the landform):
 *    river      bed(s) = smoothed L(s) − depth, running minimum downstream ('downhill');
 *               flat bed over the channel width, banks rising at 1 : bankSlope
 *    lake       inside the shoreline: surface − depth · smoothstep(distance / shoreWidth)
 *    coast      sea side: sea level − offshoreSlope · d (≥ −maxDepth); beach band inland rising
 *               at beachSlope from the waterline
 */
import { smoothstep } from '@/core/math';
import { Rng } from '@/core/random';
import { ValueNoise } from '@/terrain/TerrainPresets';
import { centerlineOf, nearest, pointAt, resample, type Centerline } from '@/roads/curve';
import type { CoastFeature, Feature, LakeFeature, LineLandformFeature, P2, PeakFeature, RiverFeature } from './types';

export type Box = [number, number, number, number];

// ── shared geometry (cached per feature object) ────────────────────────────────

const noiseCache = new Map<number, ValueNoise>();
function noiseFor(seed: number): ValueNoise {
  let n = noiseCache.get(seed);
  if (!n) {
    n = new ValueNoise(new Rng(seed >>> 0 || 1));
    noiseCache.set(seed, n);
    if (noiseCache.size > 64) noiseCache.delete(noiseCache.keys().next().value!);
  }
  return n;
}

const lineCache = new WeakMap<Feature, Centerline>();

/** Centerline of a path feature (rivers include their meander). */
export function featureLine(f: LineLandformFeature | RiverFeature | CoastFeature): Centerline {
  let c = lineCache.get(f);
  if (c) return c;
  if (f.kind === 'coast') c = centerlineOf(extendEnds(f.points, 400));
  else if (f.kind === 'river' && f.meander.amplitude > 0) c = meandered(centerlineOf(f.points), f.meander);
  else c = centerlineOf(f.points);
  lineCache.set(f, c);
  return c;
}

function extendEnds(pts: readonly P2[], far: number): P2[] {
  const a = pts[0], b = pts[1], y = pts[pts.length - 2], z = pts[pts.length - 1];
  const da = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, dz = Math.hypot(z[0] - y[0], z[1] - y[1]) || 1;
  return [[a[0] + ((a[0] - b[0]) / da) * far, a[1] + ((a[1] - b[1]) / da) * far], ...pts, [z[0] + ((z[0] - y[0]) / dz) * far, z[1] + ((z[1] - y[1]) / dz) * far]];
}

/** Sideways sine offset with a seeded phase, tapered to zero at both ends (ends stay put). */
function meandered(c: Centerline, m: RiverFeature['meander']): Centerline {
  const phase = new Rng(m.seed >>> 0 || 1).next() * Math.PI * 2;
  const L = c.length;
  const pts: P2[] = c.samples.map((p) => {
    const taper = smoothstep(0, Math.min(20, L / 4), p.s) * smoothstep(0, Math.min(20, L / 4), L - p.s);
    const off = m.amplitude * taper * Math.sin((2 * Math.PI * p.s) / m.wavelength + phase);
    return [p.x - p.tz * off, p.z + p.tx * off];
  });
  return resample(pts);
}

function boxOfPoints(pts: readonly P2[], pad: number): Box {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  return [x0 - pad, z0 - pad, x1 + pad, z1 + pad];
}

/**
 * Static bounds of a feature's influence (independent of the terrain). Rivers: the channel,
 * meander and banks for up to 12 m of cut; a coast reaches the whole map (its sea side).
 */
export function featureBounds(f: Feature): Box {
  switch (f.kind) {
    case 'mountain':
    case 'hill':
      return [f.x - f.radius, f.z - f.radius, f.x + f.radius, f.z + f.radius];
    case 'ridge':
    case 'valley':
    case 'canyon':
      return boxOfPoints(featureLine(f).samples.map((p) => [p.x, p.z] as P2), f.width / 2 + 1);
    case 'river':
      return boxOfPoints(featureLine(f).samples.map((p) => [p.x, p.z] as P2), f.width / 2 + Math.min(40, f.bankSlope * (f.depth + 12)) + 1);
    case 'lake':
      return boxOfPoints(f.points, 1);
    case 'coast':
      return [-Infinity, -Infinity, Infinity, Infinity];
  }
}

// ── landforms ──────────────────────────────────────────────────────────────────

function peakDelta(f: PeakFeature, x: number, z: number): number {
  const t = Math.hypot(x - f.x, z - f.z) / f.radius;
  if (t >= 1) return 0;
  if (f.kind === 'hill') {
    const bell = 0.5 * (1 + Math.cos(Math.PI * t));
    return f.height * bell * (1 + 0.3 * f.roughness * noiseFor(f.seed).fbm(x / 12, z / 12, 3));
  }
  const u = 1 - t * t;
  const bell = u * u * u;
  return f.height * bell * (1 + 0.5 * f.roughness * noiseFor(f.seed).fbm(x / 9, z / 9, 4));
}

function lineDelta(f: LineLandformFeature, x: number, z: number): number {
  const line = featureLine(f);
  const hit = nearest(line, x, z);
  const half = f.width / 2;
  const t = hit.dist / half;
  if (t >= 1) return 0;
  // Ends taper over the first / last 15 % (at most 15 m) of the path.
  const e = Math.min(15, line.length * 0.15);
  const taper = smoothstep(0, e, hit.s) * smoothstep(0, e, line.length - hit.s);
  const n = 1 + 0.4 * f.roughness * noiseFor(f.seed).fbm(x / 8, z / 8, 3);
  if (f.kind === 'canyon') {
    // Flat floor over the middle half, steep walls (smoothstep over the outer half).
    const wall = t <= 0.5 ? 1 : 1 - smoothstep(0.5, 1, t);
    return -f.height * wall * taper * n;
  }
  const u = 1 - t * t;
  const shape = u * u * taper * n;
  return f.kind === 'ridge' ? f.height * shape : -f.height * shape;
}

/** Δh of an additive landform at a point (0 outside its support). */
export function landformDelta(f: PeakFeature | LineLandformFeature, x: number, z: number): number {
  return f.kind === 'mountain' || f.kind === 'hill' ? peakDelta(f as PeakFeature, x, z) : lineDelta(f as LineLandformFeature, x, z);
}

// ── water features ─────────────────────────────────────────────────────────────

/** Point sampler of the landform L (base + sculpt + additive features). */
export type LandformAt = (x: number, z: number) => number;

/** Smoothing window of the river bed profile (m). */
export const RIVER_SMOOTH = 10;

export interface RiverProfile {
  line: Centerline;
  /** Bed elevation at each centerline sample. */
  bed: Float64Array;
  /** Landform at each sample (for warnings / cut depth). */
  ground: Float64Array;
}

/** Bed profile of a river from the landform below it. */
export function riverProfile(f: RiverFeature, L: LandformAt): RiverProfile {
  const line = featureLine(f);
  const S = line.samples;
  const ground = new Float64Array(S.length);
  for (let i = 0; i < S.length; i++) ground[i] = L(S[i].x, S[i].z);
  const half = Math.max(1, Math.round(RIVER_SMOOTH / 2));
  const bed = new Float64Array(S.length);
  for (let i = 0; i < S.length; i++) {
    let sum = 0, k = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(S.length - 1, i + half); j++) { sum += ground[j]; k++; }
    bed[i] = sum / k - f.depth;
  }
  if (f.grading === 'downhill') for (let i = 1; i < S.length; i++) bed[i] = Math.min(bed[i], bed[i - 1]);
  return { line, bed, ground };
}

function profileAtS(p: RiverProfile, s: number): number {
  const S = p.line.samples;
  if (s <= 0) return p.bed[0];
  if (s >= p.line.length) return p.bed[S.length - 1];
  const f = (s / p.line.length) * (S.length - 1);
  const i = Math.min(S.length - 2, Math.floor(f));
  return p.bed[i] + (p.bed[i + 1] - p.bed[i]) * (f - i);
}

export interface Carve {
  h: number;
  /** Ground type of the carved surface (−1 = keep). */
  g: number;
}

/** River section at a point: channel bed and banks (null = outside the river's reach). */
export function riverCarve(f: RiverFeature, p: RiverProfile, x: number, z: number): Carve | null {
  const hit = nearest(p.line, x, z);
  // Beyond the ends: no carving (the channel stops at its end points).
  if ((hit.s <= 1e-6 || hit.s >= p.line.length - 1e-6) && endBeyond(p.line, hit.s, x, z)) return null;
  const bed = profileAtS(p, hit.s);
  const half = f.width / 2;
  if (hit.dist <= half) return { h: bed, g: f.material };
  return { h: bed + (hit.dist - half) / f.bankSlope, g: hit.dist <= half + 0.75 ? f.material : -1 };
}

function endBeyond(line: Centerline, s: number, x: number, z: number): boolean {
  const p = pointAt(line, s);
  const dir = s <= 1e-6 ? -1 : 1;
  return ((x - p.x) * p.tx + (z - p.z) * p.tz) * dir > 0.01;
}

/** Distance from (x, z) to a closed polygon's boundary, and whether it is inside. */
export function polygonDistance(poly: readonly P2[], x: number, z: number): { inside: boolean; dist: number } {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    const dx = xi - xj, dz = zi - zj;
    const L2 = dx * dx + dz * dz || 1e-12;
    const w = Math.max(0, Math.min(1, ((x - xj) * dx + (z - zj) * dz) / L2));
    const ex = x - (xj + dx * w), ez = z - (zj + dz * w);
    best = Math.min(best, ex * ex + ez * ez);
  }
  return { inside, dist: Math.sqrt(best) };
}

export function lakeCarve(f: LakeFeature, x: number, z: number): Carve | null {
  const pd = polygonDistance(f.points, x, z);
  if (!pd.inside) return null;
  const k = smoothstep(0, f.shoreWidth, pd.dist);
  return { h: f.surface - f.depth * k, g: f.material };
}

/** Signed distance to a coastline (+ = sea side). */
export function coastDistance(f: CoastFeature, x: number, z: number): number {
  const hit = nearest(featureLine(f), x, z);
  return hit.dist * hit.side * f.seaSide;
}

export function coastCarve(f: CoastFeature, seaLevel: number, x: number, z: number): Carve | null {
  const d = coastDistance(f, x, z);
  if (d >= 0) return { h: Math.max(seaLevel - f.maxDepth, seaLevel - f.offshoreSlope * d), g: f.material };
  if (-d <= f.beachWidth) return { h: seaLevel + f.beachSlope * -d, g: f.material };
  // Behind the beach the ground may rise at 1 : 2 (a dune / bluff face), never a cliff step.
  return { h: seaLevel + f.beachSlope * f.beachWidth + (-d - f.beachWidth) * 0.5, g: -1 };
}
