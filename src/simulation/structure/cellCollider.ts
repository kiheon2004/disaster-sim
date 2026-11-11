/**
 * Phase 36 (structure v2): keeping a modular building's fixed body equal to its structural cells (colliders.ts).
 *
 * Only with `settings.simulation.structure = { model: 'v2' }` — v1 keeps the Phase 17 single box cut by truncate.
 * The body is swapped where truncate swapped it (postPhysics, between two Rapier steps):
 *  - only when the structure changed (the collapse model's structural revision) AND the solid cells changed, at most once
 *    per building every CELL_LIMITS.steps fixed steps — a change inside that window waits as `pending` (the building stays
 *    on the active list until it is flushed), so the result does not depend on how events fall within a frame;
 *  - the new body is a fixed body of the merged cell boxes (+ the slope plinth). It carries no mass that anything reads:
 *    Rapier ignores the mass of a fixed body and every getMass caller works on dynamic bodies only (SeismicForce, water,
 *    gravity tracking, celestial, people) — the building's mass lives in its MassLedger accounts;
 *  - free bodies and debris near the building (its old collider box + 0.5 m) are woken: Rapier would leave them asleep
 *    (PoseSyncSystem also puts calm bodies to sleep on uneven ground) floating where a wall or floor was;
 *  - settled fragments (fixed bodies, Phase 25) resting on a removed cell become dynamic again so they fall; their model
 *    state stays SETTLED and their mass stays in the 'bodies' account (a no-op for the ledgers).
 * New boxes always lie inside the old ones, so nothing is pushed out (no energy or momentum is added by a swap).
 */
import type { Vec3 } from '@/core/types';
import type { ShapeSpec } from '@/core/shapes';
import { qRotate } from '@/core/math';
import { foundationPlinth } from '@/terrain/groundPlacement';
import { scaleShape } from '../RuntimeBuilder';
import type { RuntimeEntity } from '../SimulationRuntime';
import type { SystemContext } from '../systems/SimulationSystem';
import { structuresOf, type StructureState } from './state';
import { CELL_LIMITS, cellBoxes, cellGrid, deriveCells, fullCells, mergeCells, rectBox, removedCells, sameCells, type CellBox, type CellGrid } from './colliders';

export interface CellColliderState {
  grid: CellGrid;
  /** Cells the current body covers. */
  solid: Uint8Array;
  scratch: Uint8Array;
  /** Boxes of the current body; null while the body RuntimeBuilder made is still in place. */
  boxes: CellBox[] | null;
  /** The building's original collider box (local). */
  original: CellBox;
  /** Fixed step of the last rebuild, a change waiting for the throttle, rebuilds so far. */
  last: number;
  pending: boolean;
  rebuilds: number;
}

/** The first collider shape of the building (definition params × object scale), as RuntimeBuilder made it. */
function originalBox(e: RuntimeEntity): CellBox {
  const s = scaleShape(e.def.colliders(e.source.params)[0], e.source.transform.scale);
  if (s.type !== 'box') throw new Error('modular building collider must be a box');
  const o = s.offset ?? [0, 0, 0], h = s.halfExtents;
  return { x0: o[0] - h[0], x1: o[0] + h[0], y0: o[1] - h[1], y1: o[1] + h[1], z0: o[2] - h[2], z1: o[2] + h[2] };
}

function cellsOf(e: RuntimeEntity, st: StructureState): CellColliderState {
  if (st.cells) return st.cells;
  const original = originalBox(e);
  const grid = cellGrid(st.model.g, original);
  return (st.cells = { grid, solid: fullCells(grid), scratch: new Uint8Array(grid.valid.length), boxes: null, original, last: -Infinity, pending: false, rebuilds: 0 });
}

/**
 * The structure of a v2 building changed (StructuralCollapseSystem.standing): rebuild its body if its solid cells
 * changed and the throttle allows, else remember the change.
 */
export function updateCellCollider(ctx: SystemContext, e: RuntimeEntity, st: StructureState) {
  const mr = e.modular!;
  if (e.body === null || e.flags.collapsed) {
    // Gone (total collapse removed the body): nothing left to rebuild; its boxes leave the global count.
    if (st.cells) {
      const S = structuresOf(ctx.runtime);
      S.cellBoxes = Math.max(0, (S.cellBoxes ?? 0) - (st.cells.boxes?.length ?? 0));
      st.cells.pending = false;
      st.cells.boxes = [];
    }
    return;
  }
  const c = cellsOf(e, st);
  const next = deriveCells(c.grid, st.model, mr.collapsedFrom, c.solid, c.scratch);
  if (sameCells(next, c.solid)) { c.pending = false; return; }
  if (ctx.step - c.last < CELL_LIMITS.steps) { c.pending = true; return; }
  c.pending = false;
  rebuild(ctx, e, c, next);
}

/** A change waiting for the throttle: applied once its window has passed (called every step while pending). */
export function flushCellCollider(ctx: SystemContext, e: RuntimeEntity, st: StructureState) {
  const c = st.cells;
  if (!c?.pending || ctx.step - c.last < CELL_LIMITS.steps) return;
  updateCellCollider(ctx, e, st);
}

function rebuild(ctx: SystemContext, e: RuntimeEntity, c: CellColliderState, next: Uint8Array) {
  const S = structuresOf(ctx.runtime);
  const own = c.boxes?.length ?? 0;
  const used = (S.cellBoxes ?? 0) - own;
  const cap = Math.min(CELL_LIMITS.perBuilding, Math.max(1, CELL_LIMITS.global - used));
  const { boxes, covered } = cellBoxes(c.grid, next, cap);
  const before = c.boxes ?? [c.original];
  const gone = mergeCells(c.grid, removedCells(c.solid, covered)).map((r) => rectBox(c.grid, r));
  const { physics } = ctx;
  physics.removeBody(e.body!);
  const shapes: ShapeSpec[] = boxes.map((b) => ({ type: 'box', halfExtents: [(b.x1 - b.x0) / 2, (b.y1 - b.y0) / 2, (b.z1 - b.z0) / 2], offset: [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2] }));
  const plinth = foundationPlinth(e.source, ctx.env.terrain);
  if (plinth > 0) shapes.push({ type: 'box', halfExtents: [e.dims[0] / 2 + 0.1, plinth / 2, e.dims[2] / 2 + 0.1], offset: [0, -plinth / 2, 0] });
  e.body = shapes.length
    ? physics.createBody({
      kind: 'fixed', position: e.pose.position, quaternion: e.pose.quaternion, shapes, mass: e.source.physics.mass,
      friction: e.source.physics.friction, restitution: e.source.physics.restitution, linearDamping: 0.05, angularDamping: 0.35, userData: { entityId: e.id },
    })
    : null;
  c.solid = covered;
  c.scratch = new Uint8Array(covered.length);
  c.boxes = boxes;
  c.last = ctx.step;
  c.rebuilds++;
  S.cellBoxes = used + boxes.length;
  S.cellRebuilds = (S.cellRebuilds ?? 0) + 1;
  wakeAround(ctx, e, before, gone);
}

/** World AABB of local boxes (current pose), grown by `pad`. */
function worldBounds(e: RuntimeEntity, boxes: readonly CellBox[], pad: number): [number, number, number, number, number, number] {
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  const p = e.pose.position;
  for (const b of boxes) for (const x of [b.x0, b.x1]) for (const y of [b.y0, b.y1]) for (const z of [b.z0, b.z1]) {
    const w = qRotate(e.pose.quaternion, [x, y, z]);
    for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], p[d] + w[d]); hi[d] = Math.max(hi[d], p[d] + w[d]); }
  }
  return [lo[0] - pad, lo[1] - pad, lo[2] - pad, hi[0] + pad, hi[1] + pad, hi[2] + pad];
}

const meets = (B: readonly number[], p: Vec3, r: number) => p[0] + r >= B[0] && p[0] - r <= B[3] && p[1] + r >= B[1] && p[1] - r <= B[4] && p[2] + r >= B[2] && p[2] - r <= B[5];

/**
 * After a swap: wake the free bodies and debris near the old collider; settled (fixed) fragments resting on a removed cell
 * fall again.
 */
function wakeAround(ctx: SystemContext, e: RuntimeEntity, before: readonly CellBox[], gone: readonly CellBox[]) {
  const { physics, runtime } = ctx;
  const B = worldBounds(e, before, 0.5);
  for (const o of runtime.entities.values()) {
    if (o === e || !o.dynamic || o.body === null) continue;
    if (!meets(B, o.pose.position, Math.hypot(o.dims[0], o.dims[1], o.dims[2]) / 2)) continue;
    physics.wake(o.body);
    o.quietSteps = 0;
  }
  const q = e.pose.quaternion, inv: [number, number, number, number] = [-q[0], -q[1], -q[2], q[3]];
  for (const d of runtime.debris) {
    const r = Math.hypot(d.size[0], d.size[1], d.size[2]) / 2;
    if (!meets(B, d.pose.position, r)) continue;
    const s = d.structural;
    if (s?.settled) {
      const p = d.pose.position, w = e.pose.position;
      const l = qRotate(inv, [p[0] - w[0], p[1] - w[1], p[2] - w[2]]);
      // Resting on (or in) a removed cell: over its plan, its bottom within 0.1 m of the cell top or lower.
      const onGone = gone.some((b) => l[0] + r > b.x0 && l[0] - r < b.x1 && l[2] + r > b.z0 && l[2] - r < b.z1 && l[1] - r <= b.y1 + 0.1 && l[1] + r >= b.y0);
      if (!onGone) continue;
      physics.setBodyKind(d.body, 'dynamic');
      s.settled = false;
      s.quiet = 0;
    }
    physics.wake(d.body);
  }
}
