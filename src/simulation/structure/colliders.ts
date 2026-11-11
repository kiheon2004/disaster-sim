/**
 * Phase 36 (structure v2): the fixed collider of a modular building derived from its structural state — pure (no
 * physics engine). Before, a building had ONE box over its whole plan, cut only when the highest storey with any standing
 * column / wall went (modular.ts truncate), so a collapsed corner or bay left an invisible wall (audit buildings.md §2).
 *
 * Cells are storey × bay: the bay lines of the design's plan grid (scaled), the edge cells reaching the members' extent,
 * all clamped to the building's original collider box; storeys between the story bases of the analysis. A cell is solid
 * while the structure is still there:
 *  (a) an alive slab of that level (the storey's ceiling) covers the cell centre;
 *  (b) the design has no slab there (a hall, a top storey without ceiling) and an alive structural column / wall of the
 *      storey lies in the cell;
 *  (c) a member inside the plan (not handed to the physics engine) is falling or resting where the cell is — engine blocks
 *      are kinematic and never touch Rapier bodies, so cars must not drive under them; once they settle into a rubble
 *      pile, the pile's own collider takes over. A member holds the cells its box overlaps now (a resting one from 0.3 m
 *      above its base: a crushed stub lying on a beam at the top of a storey belongs to the storey above).
 * Storeys at or above the lowest collapsed storey (truncate) are never solid. Cells only switch OFF (solid_new &=
 * solid_old): every new box set lies inside the previous one, so a swap can neither push a body out nor trap one inside.
 * Solid cells are merged into rectangles per storey (greedy runs) and identical rectangles of consecutive storeys are
 * stacked — an intact building is one box. At most `cap` boxes are kept (the smallest are dropped: still a subset).
 */
import { MT_COLUMN, MT_SLAB, MT_WALL, MT_WINDOW, type StructuralGraph } from '@/structure/graph';
import type { CollapseModel } from '@/structure/collapse';
import { MS } from '@/structure/types';
import { planGrid } from '@/buildings/generate';

/** Boxes per building, all cell bodies of the scene (soft), and fixed steps between two rebuilds of one building. */
export const CELL_LIMITS = { perBuilding: 48, global: 6000, steps: 6 };

/** Axis-aligned box in the building's local (scaled) frame — the frame of its physics body and of the structural graph. */
export interface CellBox { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }

export interface CellGrid {
  nx: number;
  nz: number;
  /** Storeys (the building's floors). */
  ns: number;
  /** Cell boundaries along x / z / y (nx + 1, nz + 1, ns + 1). */
  xb: Float64Array;
  zb: Float64Array;
  yb: Float64Array;
  /** Cells with a positive plan area (degenerate ones are never solid). */
  valid: Uint8Array;
  /** The design has a slab of the storey's level over the cell centre (cell index s·nx·nz + iz·nx + ix). */
  slabDesign: Uint8Array;
  /** Those slabs, and the structural columns / walls of the storey overlapping the cell (CSR per cell). */
  slabStart: Int32Array;
  slabItems: Int32Array;
  vertStart: Int32Array;
  vertItems: Int32Array;
}

const EPS = 1e-6;
/** Depth (m) above its base from which a resting piece occupies a storey — about a floor slab's thickness (0.16–0.25 m). */
const REST_SEAT = 0.3;

/** Index range [i0, i1] of the intervals of `b` that overlap (a, c) with a positive length (i1 < i0: none). */
function overlapRange(b: Float64Array, a: number, c: number): [number, number] {
  const n = b.length - 1;
  let i0 = 0;
  while (i0 < n && b[i0 + 1] <= a + EPS) i0++;
  let i1 = n - 1;
  while (i1 >= 0 && b[i1] >= c - EPS) i1--;
  return [i0, i1];
}

/** CSR from per-cell lists. */
function csr(lists: number[][]): [Int32Array, Int32Array] {
  const start = new Int32Array(lists.length + 1);
  lists.forEach((l, k) => (start[k + 1] = start[k] + l.length));
  const items = new Int32Array(start[lists.length]);
  lists.forEach((l, k) => items.set(l, start[k]));
  return [start, items];
}

/**
 * The cell grid of a building: the design's bay lines (scaled), the members' above-ground extent and the story bases,
 * clamped to `original` (the collider the building started with) so that every cell box lies inside it.
 */
export function cellGrid(g: StructuralGraph, original: CellBox): CellGrid {
  const spec = g.design.spec;
  const k = g.scale;
  const pg = planGrid(spec);
  // Edge cells reach the extent of the above-ground members (the same set the original box was sized from).
  let mx0 = Infinity, mz0 = Infinity, mx1 = -Infinity, mz1 = -Infinity;
  for (let i = 0; i < g.n; i++) {
    if (g.level[i] < 0) continue;
    const o = 6 * i;
    mx0 = Math.min(mx0, g.box[o]); mz0 = Math.min(mz0, g.box[o + 2]); mx1 = Math.max(mx1, g.box[o + 3]); mz1 = Math.max(mz1, g.box[o + 5]);
  }
  if (!Number.isFinite(mx0)) { mx0 = original.x0; mz0 = original.z0; mx1 = original.x1; mz1 = original.z1; }
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  const x0 = clamp(mx0, original.x0, original.x1), x1 = clamp(mx1, x0, original.x1);
  const z0 = clamp(mz0, original.z0, original.z1), z1 = clamp(mz1, z0, original.z1);
  const xb = new Float64Array(pg.nx + 1), zb = new Float64Array(pg.nz + 1);
  xb[0] = x0; xb[pg.nx] = x1;
  zb[0] = z0; zb[pg.nz] = z1;
  // Interior bay lines, kept monotone inside the extent (an edited design may have moved members past them).
  for (let i = 1; i < pg.nx; i++) xb[i] = clamp(pg.xs[i] * k[0], xb[i - 1], x1);
  for (let i = 1; i < pg.nz; i++) zb[i] = clamp(pg.zs[i] * k[2], zb[i - 1], z1);
  const ns = Math.max(1, g.floors);
  const yb = new Float64Array(ns + 1);
  yb[0] = original.y0; yb[ns] = original.y1;
  const st = g.analysis.stories;
  for (let s = 1; s < ns; s++) yb[s] = clamp(st[s]?.base ?? yb[s - 1], yb[s - 1], original.y1);
  const nx = pg.nx, nz = pg.nz, plan = nx * nz, N = plan * ns;
  const valid = new Uint8Array(N);
  for (let s = 0; s < ns; s++) {
    if (!(yb[s + 1] - yb[s] > EPS)) continue;
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) if (xb[ix + 1] - xb[ix] > EPS && zb[iz + 1] - zb[iz] > EPS) valid[s * plan + iz * nx + ix] = 1;
  }
  const slabs: number[][] = Array.from({ length: N }, () => []);
  const verts: number[][] = Array.from({ length: N }, () => []);
  const slabDesign = new Uint8Array(N);
  for (let i = 0; i < g.n; i++) {
    if (g.absent[i]) continue;
    const s = g.level[i];
    if (s < 0 || s >= ns) continue;
    const t = g.type[i], o = 6 * i;
    if (t === MT_SLAB) {
      for (let iz = 0; iz < nz; iz++) {
        const cz = (zb[iz] + zb[iz + 1]) / 2;
        if (cz < g.box[o + 2] - EPS || cz > g.box[o + 5] + EPS) continue;
        for (let ix = 0; ix < nx; ix++) {
          const cx = (xb[ix] + xb[ix + 1]) / 2;
          if (cx < g.box[o] - EPS || cx > g.box[o + 3] + EPS) continue;
          const c = s * plan + iz * nx + ix;
          slabDesign[c] = 1;
          slabs[c].push(i);
        }
      }
    } else if ((t === MT_COLUMN || t === MT_WALL) && g.structural[i]) {
      const [ix0, ix1] = overlapRange(xb, g.box[o], g.box[o + 3]);
      const [iz0, iz1] = overlapRange(zb, g.box[o + 2], g.box[o + 5]);
      for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) verts[s * plan + iz * nx + ix].push(i);
    }
  }
  const [slabStart, slabItems] = csr(slabs);
  const [vertStart, vertItems] = csr(verts);
  return { nx, nz, ns, xb, zb, yb, valid, slabDesign, slabStart, slabItems, vertStart, vertItems };
}

/** Every valid cell solid (the building as it was built). */
export function fullCells(grid: CellGrid): Uint8Array {
  return Uint8Array.from(grid.valid);
}

/**
 * Solid cells of the structure as it stands now (rules a–c above), below `collapsedFrom`, and never solid where `prev`
 * (the cells the current body covers) is not. Writes and returns `out`.
 */
export function deriveCells(grid: CellGrid, m: CollapseModel, collapsedFrom: number, prev: Uint8Array | null, out: Uint8Array = new Uint8Array(grid.valid.length)): Uint8Array {
  const { nx, nz, ns, xb, zb, yb } = grid;
  const plan = nx * nz;
  const live = Math.min(ns, collapsedFrom);
  out.fill(0);
  const alive = (i: number) => m.state[i] <= MS.SEVERE;
  for (let s = 0; s < live; s++) {
    for (let c = s * plan, e = (s + 1) * plan; c < e; c++) {
      if (!grid.valid[c] || (prev && !prev[c])) continue;
      let solid = 0;
      for (let q = grid.slabStart[c]; q < grid.slabStart[c + 1] && !solid; q++) if (alive(grid.slabItems[q])) solid = 1;
      if (!solid && !grid.slabDesign[c]) for (let q = grid.vertStart[c]; q < grid.vertStart[c + 1] && !solid; q++) if (alive(grid.vertItems[q])) solid = 1;
      out[c] = solid;
    }
  }
  if (live <= 0) return out;
  // (c) Members still with the building's engine (falling blocks, rubble resting on a floor): where they are now.
  const g = m.g;
  for (let i = 0; i < m.n; i++) {
    const st = m.state[i];
    if (st < MS.FAILED || st > MS.RESTING || m.external[i] || g.type[i] === MT_WINDOW) continue;
    const o = 6 * i;
    const half = ((g.box[o + 4] - g.box[o + 1]) / 2) * m.sy[i];
    const cy = (g.box[o + 1] + g.box[o + 4]) / 2 + m.dy[i];
    let x0 = g.box[o] + m.dx[i], x1 = g.box[o + 3] + m.dx[i], z0 = g.box[o + 2] + m.dz[i], z1 = g.box[o + 5] + m.dz[i], y0 = cy - half, y1 = cy + half;
    // A member turned about a hinge (v2) reaches beyond its upright box: its bounding sphere.
    if (m.rot && m.rot[4 * i + 3] !== 1) {
      const r = Math.hypot(x1 - x0, 2 * half, z1 - z0) / 2, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      x0 = cx - r; x1 = cx + r; z0 = cz - r; z1 = cz + r; y0 = cy - r; y1 = cy + r;
    }
    // Rubble at rest counts from REST_SEAT above its base: a piece lying on a beam or slab at the top of a storey (its
    // base up to a floor's depth below the next storey's base) belongs to the storey above, not to the one under it.
    if (st === MS.RESTING) { y0 += REST_SEAT; y1 = Math.max(y1, y0 + 0.01); }
    const [s0, s1] = overlapRange(yb, y0, y1);
    if (s1 < s0) continue;
    const [ix0, ix1] = overlapRange(xb, x0, x1);
    const [iz0, iz1] = overlapRange(zb, z0, z1);
    for (let s = s0; s <= Math.min(s1, live - 1); s++) {
      for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
        const c = s * plan + iz * nx + ix;
        if (grid.valid[c] && (!prev || prev[c])) out[c] = 1;
      }
    }
  }
  return out;
}

/** Same solid cells. */
export function sameCells(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A merged box in cell indices (inclusive ranges). */
export interface CellRect { ix0: number; ix1: number; iz0: number; iz1: number; s0: number; s1: number }

/** Greedy rectangles per storey (row runs grown downward), identical rectangles of consecutive storeys stacked. */
export function mergeCells(grid: CellGrid, solid: Uint8Array): CellRect[] {
  const { nx, nz, ns } = grid;
  const plan = nx * nz;
  const out: CellRect[] = [];
  /** Open stack of each plan rectangle (by key), as an index into out. */
  const open = new Map<number, number>();
  const used = new Uint8Array(plan);
  for (let s = 0; s < ns; s++) {
    used.fill(0);
    const base = s * plan;
    const at = (ix: number, iz: number) => solid[base + iz * nx + ix] === 1 && used[iz * nx + ix] === 0;
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        if (!at(ix, iz)) continue;
        let ix1 = ix;
        while (ix1 + 1 < nx && at(ix1 + 1, iz)) ix1++;
        let iz1 = iz;
        for (;;) {
          if (iz1 + 1 >= nz) break;
          let row = true;
          for (let x = ix; x <= ix1 && row; x++) row = at(x, iz1 + 1);
          if (!row) break;
          iz1++;
        }
        for (let z = iz; z <= iz1; z++) for (let x = ix; x <= ix1; x++) used[z * nx + x] = 1;
        const key = ((ix * 4096 + ix1) * 4096 + iz) * 4096 + iz1;
        const k = open.get(key);
        if (k !== undefined && out[k].s1 === s - 1) out[k].s1 = s;
        else { open.set(key, out.length); out.push({ ix0: ix, ix1, iz0: iz, iz1, s0: s, s1: s }); }
        ix = ix1;
      }
    }
  }
  return out;
}

/** Local box of a merged rectangle. */
export function rectBox(grid: CellGrid, r: CellRect): CellBox {
  return { x0: grid.xb[r.ix0], x1: grid.xb[r.ix1 + 1], z0: grid.zb[r.iz0], z1: grid.zb[r.iz1 + 1], y0: grid.yb[r.s0], y1: grid.yb[r.s1 + 1] };
}

const volume = (b: CellBox) => (b.x1 - b.x0) * (b.y1 - b.y0) * (b.z1 - b.z0);

/**
 * The boxes of a solid-cell set, at most `cap` (the smallest dropped — ties by order, deterministic), and the cells those
 * boxes really cover (what the body will hold; the next derivation starts from it).
 */
export function cellBoxes(grid: CellGrid, solid: Uint8Array, cap: number): { boxes: CellBox[]; rects: CellRect[]; covered: Uint8Array } {
  let rects = mergeCells(grid, solid);
  if (rects.length > cap) {
    const order = rects.map((r, k) => ({ k, v: volume(rectBox(grid, r)) })).sort((a, b) => b.v - a.v || a.k - b.k);
    const keep = new Set(order.slice(0, Math.max(0, cap)).map((o) => o.k));
    rects = rects.filter((_, k) => keep.has(k));
  }
  const covered = new Uint8Array(solid.length);
  const plan = grid.nx * grid.nz;
  for (const r of rects) for (let s = r.s0; s <= r.s1; s++) for (let iz = r.iz0; iz <= r.iz1; iz++) for (let ix = r.ix0; ix <= r.ix1; ix++) covered[s * plan + iz * grid.nx + ix] = 1;
  return { boxes: rects.map((r) => rectBox(grid, r)), rects, covered };
}

/** Cells set in `a` but not in `b`. */
export function removedCells(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] && !b[i] ? 1 : 0;
  return out;
}

/**
 * Phase 36 (v2) fragment spawn: a fragment whose box overlaps a LIVE box of its building is moved out of it across the
 * face needing the shortest move that leaves it clear of every live box (the four sides and the top; the bottom when there
 * is room under the box). No live box overlapped: it stays where it is. Nothing clear within one face of the box: null
 * (the caller keeps its original rule). `p` (local centre) is changed in place.
 */
export function nudgeOutOfBoxes(p: [number, number, number], half: [number, number, number], boxes: readonly CellBox[], gap = 0.02): boolean | null {
  const overlaps = (x: number, y: number, z: number, b: CellBox) => x + half[0] > b.x0 + EPS && x - half[0] < b.x1 - EPS && y + half[1] > b.y0 + EPS && y - half[1] < b.y1 - EPS && z + half[2] > b.z0 + EPS && z - half[2] < b.z1 - EPS;
  const hit = boxes.find((b) => overlaps(p[0], p[1], p[2], b));
  if (!hit) return false;
  const cands: [number, number, number][] = [
    [hit.x0 - half[0] - gap, p[1], p[2]], [hit.x1 + half[0] + gap, p[1], p[2]],
    [p[0], p[1], hit.z0 - half[2] - gap], [p[0], p[1], hit.z1 + half[2] + gap],
    [p[0], hit.y1 + half[1] + gap, p[2]],
  ];
  if (hit.y0 > 2 * half[1] + 2 * gap) cands.push([p[0], hit.y0 - half[1] - gap, p[2]]);
  let best: [number, number, number] | null = null, bd = Infinity;
  for (const c of cands) {
    const d = Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]);
    if (d >= bd || boxes.some((b) => overlaps(c[0], c[1], c[2], b))) continue;
    best = c; bd = d;
  }
  if (!best) return null;
  p[0] = best[0]; p[1] = best[1]; p[2] = best[2];
  return true;
}
