/**
 * Road centerlines (Phase 18): node a → control points → node b, as a centripetal Catmull–Rom
 * spline (no cusps or self-loops for any control layout), resampled at near-uniform arc length.
 * Straight segments (no control points) stay exactly straight.
 */
export type P2 = [number, number];

export interface CenterSample {
  x: number;
  z: number;
  /** Arc length from node a (m). */
  s: number;
  /** Unit tangent (x, z). */
  tx: number;
  tz: number;
}

export interface Centerline {
  samples: CenterSample[];
  length: number;
}

/** Target spacing of centerline samples (m) — the terrain / water grid is 1 m. */
export const SAMPLE_STEP = 1;

function catmull(p0: P2, p1: P2, p2: P2, p3: P2, n: number, out: P2[]) {
  // Centripetal parameterization (alpha = 0.5).
  const d = (a: P2, b: P2) => Math.max(1e-6, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
  const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
  for (let i = 1; i <= n; i++) {
    const t = t1 + ((t2 - t1) * i) / n;
    const lerp = (a: P2, b: P2, ta: number, tb: number): P2 => {
      const w = (t - ta) / (tb - ta);
      return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
    };
    const a1 = lerp(p0, p1, t0, t1), a2 = lerp(p1, p2, t1, t2), a3 = lerp(p2, p3, t2, t3);
    const b1 = lerp(a1, a2, t0, t2), b2 = lerp(a2, a3, t1, t3);
    out.push(lerp(b1, b2, t1, t2));
  }
}

/** Dense polyline through the points (endpoints exact). */
export function splinePoints(points: readonly P2[]): P2[] {
  if (points.length <= 2) return points.map((p) => [p[0], p[1]]);
  const out: P2[] = [[points[0][0], points[0][1]]];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    // Mirror the end tangents (phantom points) so the curve leaves the nodes smoothly.
    const pre: P2 = i === 0 ? [2 * p1[0] - p2[0], 2 * p1[1] - p2[1]] : p0;
    const post: P2 = i + 2 >= points.length ? [2 * p2[0] - p1[0], 2 * p2[1] - p1[1]] : p3;
    const n = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 0.5));
    catmull(pre, p1, p2, post, n, out);
  }
  return out;
}

/** Resample a polyline at ~`step` arc-length spacing with tangents. */
export function resample(poly: readonly P2[], step = SAMPLE_STEP): Centerline {
  const cum = [0];
  for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]));
  const L = cum[cum.length - 1];
  const n = Math.max(1, Math.round(L / step));
  const samples: CenterSample[] = [];
  let k = 0;
  for (let i = 0; i <= n; i++) {
    const s = (L * i) / n;
    while (k < poly.length - 2 && cum[k + 1] < s) k++;
    const seg = Math.max(1e-9, cum[k + 1] - cum[k]);
    const w = Math.min(1, Math.max(0, (s - cum[k]) / seg));
    const x = poly[k][0] + (poly[k + 1][0] - poly[k][0]) * w;
    const z = poly[k][1] + (poly[k + 1][1] - poly[k][1]) * w;
    samples.push({ x, z, s, tx: 0, tz: 0 });
  }
  // Tangents by central differences (endpoints one-sided).
  for (let i = 0; i < samples.length; i++) {
    const a = samples[Math.max(0, i - 1)];
    const b = samples[Math.min(samples.length - 1, i + 1)];
    let tx = b.x - a.x, tz = b.z - a.z;
    const l = Math.hypot(tx, tz);
    if (l < 1e-9) { tx = 1; tz = 0; } else { tx /= l; tz /= l; }
    samples[i].tx = tx;
    samples[i].tz = tz;
  }
  return { samples, length: L };
}

export function centerlineOf(points: readonly P2[], step = SAMPLE_STEP): Centerline {
  return resample(splinePoints(points), step);
}

/** Point / tangent at arc length s (clamped). */
export function pointAt(c: Centerline, s: number): CenterSample {
  const S = c.samples;
  if (s <= 0) return S[0];
  if (s >= c.length) return S[S.length - 1];
  let lo = 0, hi = S.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (S[m].s <= s) lo = m;
    else hi = m;
  }
  const a = S[lo], b = S[hi];
  const w = (s - a.s) / Math.max(1e-9, b.s - a.s);
  let tx = a.tx + (b.tx - a.tx) * w, tz = a.tz + (b.tz - a.tz) * w;
  const l = Math.hypot(tx, tz) || 1;
  tx /= l;
  tz /= l;
  return { x: a.x + (b.x - a.x) * w, z: a.z + (b.z - a.z) * w, s, tx, tz };
}

/** Nearest point on the centerline to (x, z): arc length, distance, side (+1 right of travel). */
export function nearest(c: Centerline, x: number, z: number): { s: number; dist: number; side: number } {
  // Squared distances (no sqrt / hypot in the loop) — this runs for every baked vertex.
  let bestD2 = Infinity, bestS = 0, bestSide = 1;
  const S = c.samples;
  for (let i = 0; i < S.length - 1; i++) {
    const a = S[i], b = S[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const L2 = dx * dx + dz * dz || 1e-12;
    let w = ((x - a.x) * dx + (z - a.z) * dz) / L2;
    w = w < 0 ? 0 : w > 1 ? 1 : w;
    const px = a.x + dx * w, pz = a.z + dz * w;
    const ex = x - px, ez = z - pz;
    const d2 = ex * ex + ez * ez;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestS = a.s + (b.s - a.s) * w;
      // Right of travel: cross(t, p − c) ≥ 0 in x/z with +z south (screen-right looking along t).
      bestSide = dx * ez - dz * ex >= 0 ? 1 : -1;
    }
  }
  return { s: bestS, dist: Math.sqrt(bestD2), side: bestSide };
}

/** Signed curvature radius at a sample (m, Infinity on straights) — from the tangent change. */
export function minRadius(c: Centerline): number {
  let r = Infinity;
  const S = c.samples;
  for (let i = 1; i < S.length - 1; i++) {
    const dTheta = Math.abs(Math.atan2(S[i - 1].tx * S[i + 1].tz - S[i - 1].tz * S[i + 1].tx, S[i - 1].tx * S[i + 1].tx + S[i - 1].tz * S[i + 1].tz));
    const ds = S[i + 1].s - S[i - 1].s;
    if (dTheta > 1e-6) r = Math.min(r, ds / dTheta);
  }
  return r;
}
