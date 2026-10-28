/**
 * Deterministic point distributions for bulk placement (Phase 16): brush strokes, lines and
 * area fills. Pure functions of their inputs — the same seed + the same input path / shape give
 * exactly the same points (no Math.random). Coordinates are world x / z in meters.
 */
import { Rng } from '@/core/random';
import { hashString } from '@/core/math';
import { WORLD_HALF } from '@/core/units';

export type Vec2 = [number, number];

/** Stable sub-seed for (seed, label, index). */
export function subSeed(seed: number, label: string, index = 0): number {
  return (hashString(`${label}:${index}`) ^ Math.imul((seed >>> 0) + 0x9e3779b9, 0x85ebca6b)) >>> 0;
}

/** Point grid for "is there a point within `r`" queries (min-spacing rule). */
class PointGrid {
  private cells = new Map<number, Vec2[]>();
  constructor(private cell: number) {}
  private key(x: number, z: number) {
    return (Math.floor(x / this.cell) + 4096) * 8192 + (Math.floor(z / this.cell) + 4096);
  }
  add(p: Vec2) {
    const k = this.key(p[0], p[1]);
    const list = this.cells.get(k);
    if (list) list.push(p);
    else this.cells.set(k, [p]);
  }
  near(p: Vec2, r: number): boolean {
    if (r <= 0) return false;
    const r2 = r * r;
    const x0 = Math.floor((p[0] - r) / this.cell);
    const x1 = Math.floor((p[0] + r) / this.cell);
    const z0 = Math.floor((p[1] - r) / this.cell);
    const z1 = Math.floor((p[1] + r) / this.cell);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const list = this.cells.get((ix + 4096) * 8192 + (iz + 4096));
        if (!list) continue;
        for (const q of list) if ((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 < r2) return true;
      }
    }
    return false;
  }
}

export interface ScatterOptions {
  /** Brush radius (m). */
  radius: number;
  /** Objects per 100 m² (before the spacing rule removes some). */
  density: number;
  /** Minimum distance between two placed points (m). */
  spacing: number;
  seed: number;
}

/** Draws per stamp are capped so a huge brush with a high density stays interactive. */
const MAX_DRAWS_PER_STAMP = 400;

/**
 * Brush scatter along a stroke. The stroke is resampled into stamps at fixed arc-length steps,
 * so feeding the path incrementally (pointer moves) or all at once gives the same stamps and
 * — with one RNG stream consumed stamp by stamp — the same points.
 * Each stamp only adds points in the part of its disc not covered by earlier stamps, so the
 * density stays uniform however slowly the brush moves.
 */
export class BrushScatter {
  readonly points: Vec2[] = [];
  /** Stamp centers so far. */
  readonly stamps: Vec2[] = [];
  private grid: PointGrid;
  private stampGrid: PointGrid;
  private rng: Rng;
  private last: Vec2 | null = null;
  /** Arc length still to travel before the next stamp. */
  private toNext = 0;
  readonly step: number;

  constructor(readonly opts: ScatterOptions) {
    this.rng = new Rng(subSeed(opts.seed, 'brush'));
    this.grid = new PointGrid(Math.max(0.5, opts.spacing));
    this.stampGrid = new PointGrid(Math.max(0.5, opts.radius));
    this.step = Math.max(0.25, opts.radius * 0.5);
  }

  /** Continue the stroke to `p`. Returns the points added by this call. */
  extend(p: Vec2): Vec2[] {
    const before = this.points.length;
    if (!this.last) {
      this.last = [p[0], p[1]];
      this.stamp(this.last);
      this.toNext = this.step;
      return this.points.slice(before);
    }
    let [x, z] = this.last;
    let dx = p[0] - x;
    let dz = p[1] - z;
    let len = Math.hypot(dx, dz);
    while (len >= this.toNext) {
      x += (dx / len) * this.toNext;
      z += (dz / len) * this.toNext;
      this.stamp([x, z]);
      dx = p[0] - x;
      dz = p[1] - z;
      len = Math.hypot(dx, dz);
      this.toNext = this.step;
    }
    this.toNext -= len;
    this.last = [p[0], p[1]];
    return this.points.slice(before);
  }

  private stamp(c: Vec2) {
    const { radius: r, density, spacing } = this.opts;
    const expected = (density / 100) * Math.PI * r * r;
    // Stochastic rounding keeps the expected count exact for fractional values.
    let n = Math.floor(expected);
    if (this.rng.next() < expected - n) n++;
    n = Math.min(n, MAX_DRAWS_PER_STAMP);
    for (let i = 0; i < n; i++) {
      // Uniform in the disc.
      const a = this.rng.next() * Math.PI * 2;
      const d = Math.sqrt(this.rng.next()) * r;
      const q: Vec2 = [c[0] + Math.cos(a) * d, c[1] + Math.sin(a) * d];
      if (this.stampGrid.near(q, r)) continue; // already covered by an earlier stamp
      if (!insideWorld(q)) continue;
      if (this.grid.near(q, spacing)) continue;
      this.grid.add(q);
      this.points.push(q);
    }
    this.stampGrid.add(c);
    this.stamps.push(c);
  }
}

/** Scatter for a whole path at once (same result as feeding it point by point). */
export function brushScatter(path: readonly Vec2[], opts: ScatterOptions): Vec2[] {
  const s = new BrushScatter(opts);
  for (const p of path) s.extend(p);
  return s.points;
}

function insideWorld(p: Vec2, margin = 0): boolean {
  return Math.abs(p[0]) <= WORLD_HALF - margin && Math.abs(p[1]) <= WORLD_HALF - margin;
}

// ── Line placement ───────────────────────────────────────────────────────

export type LineOrient = 'along' | 'across' | 'fixed';

export interface LineOptions {
  /** Distance between consecutive objects along the path (m). */
  spacing: number;
  /** How objects face: local +x along the path, across it, or a fixed heading. */
  orient: LineOrient;
  /** Extra heading (rad) on top of the orientation (fixed: the heading itself). */
  yaw: number;
  /** Shift sideways from the path (m, + = right of the walking direction). */
  offset: number;
  /** Mirror the side offset on both sides (two rows, e.g. lamps on both sides of a road). */
  bothSides?: boolean;
}

export interface LinePoint {
  x: number;
  z: number;
  yaw: number;
}

/** Heading (rotation about +Y) whose local +x points along (dx, dz). */
export function yawAlong(dx: number, dz: number): number {
  return Math.atan2(-dz, dx);
}

/**
 * Points every `spacing` meters along a polyline (continuous across vertices), first point at
 * the start, plus the end point when it is at least half a spacing past the last one.
 */
export function lineLayout(path: readonly Vec2[], o: LineOptions): LinePoint[] {
  const out: LinePoint[] = [];
  if (path.length < 2 || o.spacing <= 0) {
    if (path.length === 1) out.push({ x: path[0][0], z: path[0][1], yaw: o.orient === 'fixed' ? o.yaw : o.yaw });
    return out;
  }
  const segs: { a: Vec2; dx: number; dz: number; len: number; start: number }[] = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const dx = path[i][0] - a[0];
    const dz = path[i][1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    segs.push({ a, dx: dx / len, dz: dz / len, len, start: total });
    total += len;
  }
  if (!segs.length) return out;
  const at = (s: number): LinePoint[] => {
    let seg = segs[segs.length - 1];
    for (const g of segs) if (s <= g.start + g.len + 1e-9) { seg = g; break; }
    const u = Math.min(seg.len, Math.max(0, s - seg.start));
    const x = seg.a[0] + seg.dx * u;
    const z = seg.a[1] + seg.dz * u;
    const base = yawAlong(seg.dx, seg.dz);
    const yaw = o.orient === 'fixed' ? o.yaw : base + (o.orient === 'across' ? Math.PI / 2 : 0) + o.yaw;
    // Right of the walking direction (dx, dz) is (−dz, dx) in this x-east / z-south frame.
    const rx = -seg.dz;
    const rz = seg.dx;
    const sides = o.offset !== 0 && o.bothSides ? [1, -1] : [1];
    return sides.map((k) => ({ x: x + rx * o.offset * k, z: z + rz * o.offset * k, yaw: k < 0 && o.orient !== 'fixed' ? yaw + Math.PI : yaw }));
  };
  const n = Math.floor(total / o.spacing + 1e-9);
  for (let i = 0; i <= n; i++) out.push(...at(i * o.spacing));
  if (total - n * o.spacing >= o.spacing / 2) out.push(...at(total));
  return out;
}

export function pathLength(path: readonly Vec2[]): number {
  let s = 0;
  for (let i = 1; i < path.length; i++) s += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  return s;
}

// ── Area fill ────────────────────────────────────────────────────────────

export type AreaShape =
  | { kind: 'rect'; x0: number; z0: number; x1: number; z1: number }
  | { kind: 'circle'; x: number; z: number; r: number }
  /** Union of brush discs (painted region). */
  | { kind: 'mask'; discs: { x: number; z: number; r: number }[] };

export function shapeContains(s: AreaShape, x: number, z: number): boolean {
  switch (s.kind) {
    case 'rect':
      return x >= Math.min(s.x0, s.x1) && x <= Math.max(s.x0, s.x1) && z >= Math.min(s.z0, s.z1) && z <= Math.max(s.z0, s.z1);
    case 'circle':
      return (x - s.x) ** 2 + (z - s.z) ** 2 <= s.r * s.r;
    case 'mask':
      return s.discs.some((d) => (x - d.x) ** 2 + (z - d.z) ** 2 <= d.r * d.r);
  }
}

export function shapeBounds(s: AreaShape): { x0: number; z0: number; x1: number; z1: number } {
  switch (s.kind) {
    case 'rect':
      return { x0: Math.min(s.x0, s.x1), z0: Math.min(s.z0, s.z1), x1: Math.max(s.x0, s.x1), z1: Math.max(s.z0, s.z1) };
    case 'circle':
      return { x0: s.x - s.r, z0: s.z - s.r, x1: s.x + s.r, z1: s.z + s.r };
    case 'mask': {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const d of s.discs) {
        x0 = Math.min(x0, d.x - d.r); z0 = Math.min(z0, d.z - d.r);
        x1 = Math.max(x1, d.x + d.r); z1 = Math.max(z1, d.z + d.r);
      }
      return { x0, z0, x1, z1 };
    }
  }
}

/** Area in m² (exact for rect / circle, 1 m grid estimate for masks). */
export function shapeArea(s: AreaShape): number {
  if (s.kind === 'rect') return Math.abs(s.x1 - s.x0) * Math.abs(s.z1 - s.z0);
  if (s.kind === 'circle') return Math.PI * s.r * s.r;
  const b = shapeBounds(s);
  let n = 0;
  for (let x = Math.floor(b.x0) + 0.5; x < b.x1; x++) for (let z = Math.floor(b.z0) + 0.5; z < b.z1; z++) if (shapeContains(s, x, z)) n++;
  return n;
}

export interface AreaOptions {
  mode: 'grid' | 'random';
  /** Grid: distance between rows / columns. Random: minimum distance between points. */
  spacing: number;
  /** Random mode: objects per 100 m². */
  density: number;
  /** Grid mode: random offset of each point, as a fraction of the spacing (0 = exact grid). */
  jitter: number;
  seed: number;
}

/** Hard cap on generated points (the preview and the edit stay responsive). */
export const MAX_AREA_POINTS = 5000;

export function areaFill(shape: AreaShape, o: AreaOptions): Vec2[] {
  const b = shapeBounds(shape);
  const out: Vec2[] = [];
  if (!(b.x1 > b.x0) || !(b.z1 > b.z0)) return out;
  const rng = new Rng(subSeed(o.seed, `area-${o.mode}`));
  if (o.mode === 'grid') {
    const s = Math.max(0.25, o.spacing);
    const nx = Math.floor((b.x1 - b.x0) / s);
    const nz = Math.floor((b.z1 - b.z0) / s);
    // Center the lattice inside the bounds.
    const ox = b.x0 + (b.x1 - b.x0 - nx * s) / 2;
    const oz = b.z0 + (b.z1 - b.z0 - nz * s) / 2;
    for (let j = 0; j <= nz; j++) {
      for (let i = 0; i <= nx; i++) {
        const x = ox + i * s + (o.jitter > 0 ? rng.spread(o.jitter * s * 0.5) : 0);
        const z = oz + j * s + (o.jitter > 0 ? rng.spread(o.jitter * s * 0.5) : 0);
        if (!shapeContains(shape, x, z) || !insideWorld([x, z])) continue;
        out.push([x, z]);
        if (out.length >= MAX_AREA_POINTS) return out;
      }
    }
    return out;
  }
  // Random: dart throwing with a minimum distance (deterministic stream).
  // Uniform draws over the bounding box at the requested density; the shape test keeps the
  // ones inside, so the density inside the shape is the requested one for any shape.
  const boxArea = (b.x1 - b.x0) * (b.z1 - b.z0);
  const draws = Math.min(MAX_AREA_POINTS * 4, Math.round((o.density / 100) * boxArea));
  const grid = new PointGrid(Math.max(0.5, o.spacing));
  for (let i = 0; i < draws; i++) {
    const x = b.x0 + rng.next() * (b.x1 - b.x0);
    const z = b.z0 + rng.next() * (b.z1 - b.z0);
    if (!shapeContains(shape, x, z) || !insideWorld([x, z])) continue;
    const p: Vec2 = [x, z];
    if (grid.near(p, o.spacing)) continue;
    grid.add(p);
    out.push(p);
    if (out.length >= MAX_AREA_POINTS) break;
  }
  return out;
}
