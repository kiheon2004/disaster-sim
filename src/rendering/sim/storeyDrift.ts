/**
 * Phase 36 (render-only): per-storey earthquake displacement of a modular building, read from the lumped storey model.
 *
 * Before, the renderer sheared a whole building linearly from its foundation to its top (one matrix), so a soft ground
 * storey looked like any other. Here the displacement at the top of every storey is reconstructed from the model's dof
 * displacements `u` (2 per dof, unit-local x / z, relative to the ground; dof 0 = foundation) with the storey → dof
 * mapping of the structural adapter (lumpStories): inside a dof group a storey takes its share of the group's
 * flexibility — the CURRENT share, from the members still standing (currentStories), cached per runtime revision.
 * The simulation's own story drifts (modular.ts updateStoryDrifts / syncModel) are not touched: they decide v1 results.
 * Only dofs up to the highest live one (truncateFrom) and storeys below the collapsed one are used — above that the
 * members are fallen and drawn by the collapse engine's offsets.
 *
 * There is no rotational dof in the storey model: torsion stays a demand factor (structureV2.ts) — floors are not twisted.
 */
import { lumpStories } from '@/buildings/structuralAdapter';
import { currentStories, type ModularRuntime } from '@/simulation/buildings/modular';
import type { StructuralModel } from '@/simulation/seismic/StructuralModel';

const shares = new WeakMap<ModularRuntime, { rev: number; share: Float64Array }>();

/** Flexibility share of every storey inside its dof group, per local axis [x0, z0, x1, …], for the structure as it stands. */
export function currentShares(mr: ModularRuntime): Float64Array {
  const c = shares.get(mr);
  if (c && c.rev === mr.rev) return c.share;
  const st = mr.initial.stories;
  const k = currentStories(mr);
  const share = lumpStories(st.map((s) => s.mass), st.map((s) => s.height), k.kx, k.kz, k.vx, k.vz).share;
  shares.set(mr, { rev: mr.rev, share });
  return share;
}

/**
 * Displacement of each storey top relative to the foundation, WORLD x / z, into `out`: out[0..1] = the foundation (0),
 * out[2(s+1) .. 2(s+1)+1] = top of storey s. Returns the number of live storeys written (0: nothing to draw).
 */
export function storeyDisplacements(mr: ModularRuntime, model: StructuralModel, ui: number, out: Float64Array): number {
  const L = mr.unit?.lumps;
  if (!L || ui < 0) return 0;
  const share = currentShares(mr);
  const o = model.off[ui], nLive = model.nLive[ui], u = model.u;
  const cs = model.cos[ui], sn = model.sin[ui];
  const bx = u[2 * o], bz = u[2 * o + 1];
  out[0] = 0;
  out[1] = 0;
  const floors = Math.min(mr.floors, mr.collapsedFrom, (out.length >> 1) - 1);
  let lx = 0, lz = 0, live = 0;
  for (let s = 0; s < floors; s++) {
    const j = L.dof[s];
    if (j < 1 || j > nLive) break;
    const lo = 2 * (o + j - 1), hi = 2 * (o + j);
    // The group starts from the dof below it; each storey adds its share of the group's drift.
    if (s === L.first[j - 1]) { lx = u[lo] - bx; lz = u[lo + 1] - bz; }
    lx += share[2 * s] * (u[hi] - u[lo]);
    lz += share[2 * s + 1] * (u[hi + 1] - u[lo + 1]);
    // Unit-local → world (as the model writes its top / base outputs).
    out[2 * (s + 1)] = lx * cs + lz * sn;
    out[2 * (s + 1) + 1] = -lx * sn + lz * cs;
    live = s + 1;
  }
  return live;
}

/** Root index of a member drawn with per-storey roots: 0 foundation, 1 + s storey s, 1 + F + s level s floor, 1 + 2F top. */
export function memberRootIndex(type: string, level: number, floors: number): number {
  if (level < 0) return 0;
  if (level >= floors) return 1 + 2 * floors;
  if (type === 'beam' || type === 'slab') return 1 + floors + level;
  if (type === 'column' || type === 'wall' || type === 'window' || type === 'door' || type === 'brace') return 1 + level;
  return 1 + 2 * floors;
}

/**
 * Affine shear of every root (render units): the displacement at height y (above the base, after the object scale) is
 * a + b·y per world axis. Storey s goes linearly from its bottom D(s − 1) to its top D(s) over [base_s, base_s + h_s];
 * its floor (level s beams / slabs) moves with D(s); the roof with the top live storey; the foundation stays. Storeys at
 * or above `live` move rigidly with the top live storey. `k`: the drawing's exaggeration. Writes [ax, az, bx, bz] per root.
 */
export function storeyShears(D: Float64Array, live: number, stories: readonly { base: number; height: number }[], floors: number, k: number, out: Float64Array): Float64Array {
  const set = (r: number, ax: number, az: number, bx: number, bz: number) => { out[4 * r] = ax; out[4 * r + 1] = az; out[4 * r + 2] = bx; out[4 * r + 3] = bz; };
  set(0, 0, 0, 0, 0);
  const tx = D[2 * live] * k, tz = D[2 * live + 1] * k;
  for (let s = 0; s < floors; s++) {
    if (s >= live) { set(1 + s, tx, tz, 0, 0); set(1 + floors + s, tx, tz, 0, 0); continue; }
    const h = Math.max(0.5, stories[s].height), y0 = stories[s].base;
    const bx = ((D[2 * (s + 1)] - D[2 * s]) * k) / h, bz = ((D[2 * (s + 1) + 1] - D[2 * s + 1]) * k) / h;
    set(1 + s, D[2 * s] * k - bx * y0, D[2 * s + 1] * k - bz * y0, bx, bz);
    set(1 + floors + s, D[2 * (s + 1)] * k, D[2 * (s + 1) + 1] * k, 0, 0);
  }
  set(1 + 2 * floors, tx, tz, 0, 0);
  return out;
}

/** Root for a point at height y (render units above the base): the storey containing it, rigid above the top. */
export function rootAtHeight(y: number, live: number, stories: readonly { base: number; height: number }[], floors: number): number {
  if (y < 0) return 0;
  for (let s = 0; s < live; s++) if (y < stories[s].base + stories[s].height) return 1 + s;
  return 1 + 2 * floors;
}
