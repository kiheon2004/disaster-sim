/**
 * Blueprint selection areas (Phase 20): a rectangle or a simple polygon on the ground plane,
 * and cutting lines (roads, rivers, ridges …) at its boundary.
 */
import type { P2 } from '@/landscape/types';
import { pointInPolygon, signedArea } from '@/roads/blocks';
import type { Centerline } from '@/roads/curve';

export type SelectionShape = { kind: 'rect'; x0: number; z0: number; x1: number; z1: number } | { kind: 'polygon'; points: P2[] };

/** Polygon of a shape (rectangles: 4 corners). */
export function shapePolygon(s: SelectionShape): P2[] {
  if (s.kind === 'polygon') return s.points.map((p) => [p[0], p[1]]);
  const x0 = Math.min(s.x0, s.x1), x1 = Math.max(s.x0, s.x1), z0 = Math.min(s.z0, s.z1), z1 = Math.max(s.z0, s.z1);
  return [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
}

export function polygonBounds(poly: readonly P2[]): [number, number, number, number] {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of poly) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  return [x0, z0, x1, z1];
}

export const polygonArea = (poly: readonly P2[]) => Math.abs(signedArea(poly));

/** A usable selection polygon: ≥ 3 points, ≥ 4 m², no edge crossing another (simple polygon). */
export function validPolygon(poly: readonly P2[]): boolean {
  if (poly.length < 3 || polygonArea(poly) < 4) return false;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent through the closing edge
      const c = poly[j], d = poly[(j + 1) % n];
      if (segmentHit(a, b, c, d, true)) return false;
    }
  }
  return true;
}

/** Crossing of segment a→b with c→d: [t on ab, u on cd]; t ∈ [0, 1) so a crossing at a shared sample point counts once. */
function segmentHit(a: P2, b: P2, c: P2, d: P2, strict = false): [number, number] | null {
  const rx = b[0] - a[0], rz = b[1] - a[1], sx = d[0] - c[0], sz = d[1] - c[1];
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * sz - (c[1] - a[1]) * sx) / den;
  const u = ((c[0] - a[0]) * rz - (c[1] - a[1]) * rx) / den;
  const tOk = strict ? t > 0 && t < 1 : t >= -1e-12 && t < 1 - 1e-12;
  return tOk && u >= -1e-12 && u <= 1 + 1e-12 ? [t, u] : null;
}

export const inside = (poly: readonly P2[], x: number, z: number) => pointInPolygon(poly, x, z);

/** Distance from a point to the polygon boundary (m). */
export function boundaryDistance(poly: readonly P2[], x: number, z: number): number {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[j], [bx, bz] = poly[i];
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
    const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
    d = Math.min(d, Math.hypot(x - ax - dx * u, z - az - dz * u));
  }
  return d;
}

/** Where a polyline enters / leaves: how much of it lies inside. */
export type Coverage = 'inside' | 'outside' | 'partial';

export function lineCoverage(poly: readonly P2[], pts: readonly { x: number; z: number }[]): Coverage {
  let a = 0, b = 0;
  for (const p of pts) (inside(poly, p.x, p.z) ? a++ : b++);
  return b === 0 ? 'inside' : a === 0 ? 'outside' : 'partial';
}

/**
 * Pieces of a centerline inside the polygon, as arc-length intervals [s0, s1] (in order), with
 * whether each end is a cut (boundary) or the line's own end. Crossing points are found exactly
 * on the sample polyline; pieces shorter than `minLength` are dropped.
 */
export function insideIntervals(poly: readonly P2[], line: Centerline, minLength = 0): { s0: number; s1: number; cutStart: boolean; cutEnd: boolean }[] {
  const S = line.samples;
  const cuts: number[] = [];
  for (let i = 0; i < S.length - 1; i++) {
    const a: P2 = [S[i].x, S[i].z], b: P2 = [S[i + 1].x, S[i + 1].z];
    for (let k = 0, j = poly.length - 1; k < poly.length; j = k++) {
      const h = segmentHit(a, b, poly[j], poly[k]);
      if (h) cuts.push(S[i].s + (S[i + 1].s - S[i].s) * h[0]);
    }
  }
  cuts.sort((x, y) => x - y);
  // (A crossing through a polygon corner is found on both edges: one cut.)
  const unique = cuts.filter((s, i) => s > 1e-6 && s < line.length - 1e-6 && (i === 0 || s - cuts[i - 1] > 1e-6));
  const bounds = [0, ...unique, line.length];
  const out: { s0: number; s1: number; cutStart: boolean; cutEnd: boolean }[] = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const s0 = bounds[k], s1 = bounds[k + 1];
    if (s1 - s0 < 1e-6) continue;
    const mid = pointOn(line, (s0 + s1) / 2);
    if (!inside(poly, mid[0], mid[1])) continue;
    if (s1 - s0 < minLength) continue;
    out.push({ s0, s1, cutStart: k > 0, cutEnd: k < bounds.length - 2 });
  }
  return out;
}

/**
 * Mean of `height` along a polygon's perimeter (sampled every `step` m): the DATUM of a blueprint
 * — the level its surroundings meet, so a hill stays a hill and a hollow stays a hollow when the
 * blueprint's ground is applied elsewhere.
 */
export function perimeterMean(poly: readonly P2[], height: (x: number, z: number) => number, step = 1): number {
  let sum = 0, n = 0;
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length];
    const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let j = 0; j < k; j++) { sum += height(ax + ((bx - ax) * j) / k, az + ((bz - az) * j) / k); n++; }
  }
  return n ? sum / n : 0;
}

/** Point at arc length s of a centerline (linear between samples). */
export function pointOn(line: Centerline, s: number): P2 {
  const S = line.samples;
  if (s <= 0) return [S[0].x, S[0].z];
  if (s >= line.length) return [S[S.length - 1].x, S[S.length - 1].z];
  let lo = 0, hi = S.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (S[m].s <= s) lo = m; else hi = m;
  }
  const w = (s - S[lo].s) / Math.max(1e-9, S[hi].s - S[lo].s);
  return [S[lo].x + (S[hi].x - S[lo].x) * w, S[lo].z + (S[hi].z - S[lo].z) * w];
}

/**
 * Points describing the piece [s0, s1] of a centerline: ≤ `max` points spaced evenly, ends
 * exact. A spline through them follows the original curve closely (the spacing is a few metres
 * against a 1 m sample step).
 */
export function piecePoints(line: Centerline, s0: number, s1: number, max = 48): P2[] {
  const L = s1 - s0;
  const n = Math.max(1, Math.min(max - 1, Math.ceil(L / 4)));
  const out: P2[] = [];
  for (let i = 0; i <= n; i++) out.push(pointOn(line, s0 + (L * i) / n));
  return out;
}
