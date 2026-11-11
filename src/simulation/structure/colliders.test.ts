/**
 * Phase 36 (structure v2): the building collider after a partial collapse — storey × bay cells derived from the structural
 * state (colliders.ts), the body swap with wake-up and fragment re-activation (cellCollider.ts), the v2 fragment nudge.
 *
 * Pure part: the collapse engine without physics (what opens a cell, what does not). Simulation part: Rapier bodies near a
 * collapsing corner bay — a car on the roof, a crate leaning on the wall, a settled fragment on the roof — and the same
 * scene without the v2 setting (v1 keeps the old box), ledgers, body counts, determinism.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Vec3 } from '@/core/types';
import type { WorldDocument } from '@/core/model';
import { createDesign, designParams } from '@/buildings/design';
import { defaultSpec, presetSpec } from '@/buildings/spec';
import { defaultOptions, type BuildingDesign, type BuildingMember, type BuildingSpec } from '@/buildings/types';
import { buildGraph, graphOf, MT_COLUMN, MT_DOOR, MT_SLAB, MT_WALL } from '@/structure/graph';
import { CollapseModel } from '@/structure/collapse';
import { createEmptyDocument, createWorldObject, nextSerial, type CreateObjectInput } from '@/world/WorldDocument';
import { SimulationController } from '../SimulationController';
import type { RuntimeEntity } from '../SimulationRuntime';
import type { SystemContext } from '../systems/SimulationSystem';
import { activate, structureOf, structuresOf } from './state';
import { spawnFragment } from './fragments';
import { CELL_LIMITS, cellBoxes, cellGrid, deriveCells, fullCells, mergeCells, nudgeOutOfBoxes, rectBox, sameCells, type CellBox, type CellGrid } from './colliders';

const rc3 = (): BuildingSpec => ({ ...defaultSpec(), system: 'rcFrame', width: 12, depth: 12, floors: 3, bay: 6 });

/** The collider box RuntimeBuilder gives a modular building (definition params; unscaled). */
function originalOf(d: BuildingDesign): CellBox {
  const p = designParams(d) as { width: number; depth: number; floors: number; floorHeight: number };
  return { x0: -p.width / 2, x1: p.width / 2, y0: 0, y1: p.floors * p.floorHeight, z0: -p.depth / 2, z1: p.depth / 2 };
}

function engine(d: BuildingDesign, v2 = true) {
  const g = d.edits ? buildGraph(d) : graphOf(d);
  const m = new CollapseModel(g);
  if (v2) m.enableV2();
  m.init(0);
  const original = originalOf(d);
  return { d, g, m, original, grid: cellGrid(g, original) };
}

function settle(m: CollapseModel, seconds = 30) {
  let t = 0;
  for (let k = 0; k < seconds * 60 && m.active; k++) { m.step(1 / 60, t); t += 1 / 60; }
  expect(m.active).toBe(false);
}

const cell = (grid: CellGrid, s: number, ix: number, iz: number) => s * grid.nx * grid.nz + iz * grid.nx + ix;
/** Off cells as "s,ix,iz". */
function off(grid: CellGrid, solid: Uint8Array): string[] {
  const out: string[] = [];
  for (let s = 0; s < grid.ns; s++) for (let iz = 0; iz < grid.nz; iz++) for (let ix = 0; ix < grid.nx; ix++) if (grid.valid[cell(grid, s, ix, iz)] && !solid[cell(grid, s, ix, iz)]) out.push(`${s},${ix},${iz}`);
  return out;
}
const vol = (b: CellBox) => (b.x1 - b.x0) * (b.y1 - b.y0) * (b.z1 - b.z0);
const inside = (a: CellBox, b: CellBox) => a.x0 >= b.x0 - 1e-9 && a.x1 <= b.x1 + 1e-9 && a.y0 >= b.y0 - 1e-9 && a.y1 <= b.y1 + 1e-9 && a.z0 >= b.z0 - 1e-9 && a.z1 <= b.z1 + 1e-9;

/** Members of a design by a predicate on (graph index). */
const pick = (g: ReturnType<typeof graphOf>, f: (i: number, cx: number, cz: number) => boolean) => {
  const out: number[] = [];
  for (let i = 0; i < g.n; i++) { const o = 6 * i; if (f(i, (g.box[o] + g.box[o + 3]) / 2, (g.box[o + 2] + g.box[o + 5]) / 2)) out.push(i); }
  return out;
};
/** The corner column line (−x, −z) on every storey and the floor panels of the corner bay. */
const cornerBay = (g: ReturnType<typeof graphOf>, grid: CellGrid, withFloors = true) => pick(g, (i, cx, cz) => g.level[i] >= 0 && (
  (g.type[i] === MT_COLUMN && g.box[6 * i] < grid.xb[0] + 0.8 && g.box[6 * i + 2] < grid.zb[0] + 0.8) || (withFloors && g.type[i] === MT_SLAB && cx < grid.xb[1] && cz < grid.zb[1])));

describe('cell colliders (pure engine)', () => {
  it('an intact building is ONE box — the collider it was built with; the grid follows the bays and storeys', () => {
    const { grid, original } = engine(createDesign(rc3()));
    expect([grid.nx, grid.nz, grid.ns]).toEqual([2, 2, 3]);
    expect(grid.xb[1]).toBeCloseTo(0, 9);
    const { boxes } = cellBoxes(grid, fullCells(grid), CELL_LIMITS.perBuilding);
    expect(boxes.length).toBe(1);
    // The original box is symmetric about the origin (2·max|x|, rounded to mm); the cells reach the members' own extent —
    // the same box, or (here, 5 mm on one side) inside it.
    expect(inside(boxes[0], original)).toBe(true);
    for (const k of ['x0', 'x1', 'y0', 'y1', 'z0', 'z1'] as const) expect(Math.abs(boxes[0][k] - original[k])).toBeLessThan(0.01);
  });

  it('the corner column line alone (every storey): the floors cantilever on the frame (alternate path) — no cell changes; one column alike', () => {
    for (const all of [true, false]) {
      const { g, m, grid } = engine(createDesign(rc3()));
      const cols = cornerBay(g, grid, false);
      expect(cols.length).toBe(3);
      m.fail(all ? cols : [cols[0]], 'drift', 'earthquake', 0);
      settle(m);
      const solid = deriveCells(grid, m, Infinity, fullCells(grid));
      expect(sameCells(solid, fullCells(grid))).toBe(true);
    }
  });

  it('the corner bay comes down (its column line and floor panels on every storey): its cells open, every other cell stays', () => {
    const { g, m, grid, original } = engine(createDesign(rc3()));
    m.fail(cornerBay(g, grid), 'impact', 'impact', 0);
    settle(m);
    const solid = deriveCells(grid, m, Infinity, fullCells(grid));
    expect(off(grid, solid)).toEqual(['0,0,0', '1,0,0', '2,0,0']);
    const { boxes } = cellBoxes(grid, solid, CELL_LIMITS.perBuilding);
    // An L-shaped plan stacked over the three storeys: two boxes, inside the original one, ¾ of its volume.
    expect(boxes.length).toBe(2);
    for (const b of boxes) expect(inside(b, original)).toBe(true);
    expect(boxes.reduce((s, b) => s + vol(b), 0) / vol(original)).toBeCloseTo(0.75, 2);
    expect(Math.abs(m.ledger.residual()) / m.ledger.original).toBeLessThan(1e-9);
  });

  it('part of a floor: the ground-storey ceiling panel of one bay → that cell only (the bay above keeps its own ceiling)', () => {
    const { g, m, grid } = engine(createDesign(rc3()));
    m.fail(pick(g, (i, cx, cz) => g.type[i] === MT_SLAB && g.level[i] === 0 && cx < 0 && cz < 0), 'impact', 'impact', 0);
    settle(m);
    expect(off(grid, deriveCells(grid, m, Infinity, fullCells(grid)))).toEqual(['0,0,0']);
  });

  it('part of a wall (a hall: no ceiling slab, the walls carry the roof): one wall segment → no change; every wall of the corner cell → it opens', () => {
    const spec: BuildingSpec = { ...defaultSpec(), system: 'masonry', structureMaterial: 'masonry', slabMaterial: 'reinforcedConcrete', claddingMaterial: 'masonry', width: 12, depth: 8, floors: 1, bay: 4, ceiling: false, roof: 'gable', roofPitch: 25 };
    const walls = (g: ReturnType<typeof graphOf>, grid: CellGrid) => pick(g, (i) => g.type[i] === MT_WALL && g.structural[i] === 1 && g.level[i] === 0 && g.box[6 * i] < grid.xb[1] - 1e-6 && g.box[6 * i + 2] < grid.zb[1] - 1e-6);
    {
      const { g, m, grid } = engine(createDesign(spec));
      // Rule (b) applies: no slab of level 0 anywhere.
      expect(grid.slabDesign.every((v) => v === 0)).toBe(true);
      const w = walls(g, grid);
      expect(w.length).toBeGreaterThan(1);
      const perimeter = w.find((i) => g.box[6 * i + 2] < grid.zb[0] + 0.5 && g.box[6 * i + 3] - g.box[6 * i] > 1)!;
      m.fail([perimeter], 'impact', 'impact', 0);
      settle(m);
      expect(off(grid, deriveCells(grid, m, Infinity, fullCells(grid)))).toEqual([]);
    }
    {
      const { g, m, grid } = engine(createDesign(spec));
      m.fail(walls(g, grid), 'impact', 'impact', 0);
      settle(m);
      expect(off(grid, deriveCells(grid, m, Infinity, fullCells(grid)))).toContain('0,0,0');
    }
  });

  it('a whole storey gone (truncate): the cells from it up are off — one box from the ground to its base, as truncate cut it', () => {
    const { m, grid, original } = engine(createDesign(rc3()));
    const s = 2;
    const solid = deriveCells(grid, m, s, fullCells(grid));
    const { boxes } = cellBoxes(grid, solid, CELL_LIMITS.perBuilding);
    expect(boxes.length).toBe(1);
    // truncate: halfExtents [dims0/2, base/2, dims2/2] at y = base/2 (modular.ts) — the same box.
    const base = m.g.analysis.stories[s].base;
    expect(boxes[0]).toEqual({ x0: grid.xb[0], x1: grid.xb[grid.nx], z0: grid.zb[0], z1: grid.zb[grid.nz], y0: original.y0, y1: base });
    expect(inside(boxes[0], { ...original, y1: base })).toBe(true);
  });

  it('cells only switch off: a cell the body no longer covers never comes back (new boxes ⊆ old boxes)', () => {
    const { m, grid } = engine(createDesign(rc3()));
    const prev = fullCells(grid);
    prev[cell(grid, 1, 1, 1)] = 0;
    const solid = deriveCells(grid, m, Infinity, prev);
    expect(off(grid, solid)).toEqual(['1,1,1']);
    // Falling / resting members cannot re-open it either: the corner bay comes down, the old hole stays.
    const e2 = engine(createDesign(rc3()));
    e2.m.fail(cornerBay(e2.g, e2.grid), 'impact', 'impact', 0);
    e2.m.step(1 / 60, 0);
    const mid = deriveCells(e2.grid, e2.m, Infinity, prev);
    expect(mid[cell(grid, 1, 1, 1)]).toBe(0);
    // While the corner bay is still falling (engine kinematics) its cells stay solid (rule c).
    expect(mid[cell(grid, 0, 0, 0)]).toBe(1);
  });

  it('merging: identical rectangles of consecutive storeys stack; over the cap the smallest boxes go and the rest still covers a subset', () => {
    const { grid } = engine(createDesign({ ...rc3(), width: 18, depth: 18 }));
    expect([grid.nx, grid.nz]).toEqual([3, 3]);
    const solid = fullCells(grid);
    // A checkerboard hole pattern on storey 1 only.
    for (const [ix, iz] of [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]]) solid[cell(grid, 1, ix, iz)] = 0;
    const rects = mergeCells(grid, solid);
    // Storeys 0 and 2 are full (one rectangle each, not stackable through storey 1); storey 1 has 4 single cells.
    expect(rects.length).toBe(6);
    const capped = cellBoxes(grid, solid, 2);
    expect(capped.boxes.length).toBe(2);
    for (let c = 0; c < solid.length; c++) if (capped.covered[c]) expect(solid[c]).toBe(1);
    // The two kept are the largest (the full storeys).
    const keptVol = capped.boxes.map(vol).sort((a, b) => b - a);
    const allVol = rects.map((r) => vol(rectBox(grid, r))).sort((a, b) => b - a);
    expect(keptVol).toEqual(allVol.slice(0, 2));
  });

  it('fragment nudge (v2): out of the live box it overlaps by the shortest free move; in a removed cell it stays; never into another box', () => {
    const boxes: CellBox[] = [{ x0: 0, x1: 6, y0: 0, y1: 9, z0: -6, z1: 0 }, { x0: -6, x1: 6, y0: 0, y1: 9, z0: 0, z1: 6 }];
    // In the removed corner (x < 0, z < 0): no move.
    const p: [number, number, number] = [-3, 4, -3];
    expect(nudgeOutOfBoxes(p, [0.5, 0.5, 0.5], boxes)).toBe(false);
    expect(p).toEqual([-3, 4, -3]);
    // Inside the first box near its −x face: out across that face (into the removed corner), not across the plan.
    const q: [number, number, number] = [0.3, 4, -3];
    expect(nudgeOutOfBoxes(q, [0.5, 0.5, 0.5], boxes)).toBe(true);
    expect(q[0]).toBeCloseTo(-0.52, 9);
    // Near the shared face with the second box: crossing +z would land in it — another face is taken.
    const r: [number, number, number] = [3, 4, -0.2];
    expect(nudgeOutOfBoxes(r, [0.4, 0.4, 0.4], boxes)).toBe(true);
    for (const b of boxes) expect(r[0] + 0.4 > b.x0 && r[0] - 0.4 < b.x1 && r[1] + 0.4 > b.y0 && r[1] - 0.4 < b.y1 && r[2] + 0.4 > b.z0 && r[2] - 0.4 < b.z1).toBe(false);
  });

  it('topple (v2 hinge): the bay that rotated off its hinge opens once it lies on the ground; the standing bay stays', () => {
    const d = twoBay();
    const { g, m, grid } = engine(d);
    const lost = d.members.map((x, i) => (x.type === 'column' && x.level === 0 && x.position[0] === -6 ? i : -1)).filter((i) => i >= 0);
    m.fail(lost, 'drift', 'earthquake', 0);
    settle(m);
    expect(m.events.some((e) => e.kind === 'hinge')).toBe(true);
    const solid = deriveCells(grid, m, Infinity, fullCells(grid));
    const o = off(grid, solid);
    expect(o).toContain('0,0,0');
    expect(o.every((c) => c.split(',')[1] === '0')).toBe(true);
    void g;
  });
});

/** Two RC bays along x (columns at x = −6, 0, +6, z = ±3), two storeys — structureV2.test.ts's hinge frame, its spec on the same grid. */
function twoBay(): BuildingDesign {
  const M: Omit<BuildingMember, 'rotation'>[] = [];
  const H = 3;
  for (const x of [-6, 0, 6]) for (const z of [-3, 3]) {
    M.push({ id: `p${x}${z}`, type: 'foundation', role: 'foundation', level: -1, position: [x, -0.3, z], size: [1.2, 0.6, 1.2], material: 'reinforcedConcrete' });
    for (const lv of [0, 1]) M.push({ id: `c${lv}${x}${z}`, type: 'column', role: 'primary', level: lv, position: [x, lv * H + H / 2, z], size: [0.4, H, 0.4], material: 'reinforcedConcrete' });
  }
  for (const lv of [0, 1]) {
    const y = (lv + 1) * H;
    for (const z of [-3, 3]) for (const xc of [-3, 3]) M.push({ id: `b${lv}${xc}${z}`, type: 'beam', role: 'primary', level: lv, position: [xc, y - 0.25, z], size: [6, 0.5, 0.3], material: 'reinforcedConcrete' });
    for (const x of [-6, 0, 6]) M.push({ id: `bz${lv}${x}`, type: 'beam', role: 'primary', level: lv, position: [x, y - 0.25, 0], size: [0.3, 0.5, 6], material: 'reinforcedConcrete' });
    for (const xc of [-3, 3]) M.push({ id: `s${lv}${xc}`, type: 'slab', role: 'primary', level: lv, position: [xc, y + 0.1, 0], size: [6, 0.2, 6], material: 'reinforcedConcrete' });
  }
  const spec: BuildingSpec = { ...defaultSpec(), system: 'rcFrame', width: 12, depth: 6, bay: 6, floors: 2, floorHeight: 3, groundFloorHeight: 3 };
  return { version: 1, spec, members: M.map((m) => ({ rotation: [0, 0, 0] as [number, number, number], ...m })), options: { ...defaultOptions(), allowUnsupported: true }, edits: 1 };
}

// ── Simulation: Rapier bodies around a collapsing corner bay ─────────────────────────────

const T = (x = 0, y = 0, z = 0, rot: Vec3 = [0, 0, 0]): CreateObjectInput['transform'] => ({ position: [x, y, z] as Vec3, rotation: rot, scale: [1, 1, 1] as Vec3 });

function world(inputs: CreateObjectInput[], v2: boolean): WorldDocument {
  const d = createEmptyDocument('p36-cells');
  for (const input of inputs) {
    const o = createWorldObject(input, nextSerial(d.objects, input.type));
    d.objects[o.id] = o;
  }
  d.settings.simulation.seed = 42;
  if (v2) d.settings.simulation.structure = { model: 'v2' };
  return d;
}

/** Enough of a system context to create a structure state / spawn a fragment outside the step loop. */
const ctxOf = (c: SimulationController) => ({ runtime: c.getRuntime()!, env: c.getEnvironment(), physics: c.getPhysics()!, time: 0, step: 0 } as unknown as SystemContext);
const ofType = (c: SimulationController, t: string) => [...c.getRuntime()!.entities.values()].filter((e) => e.source.type === t);

/** The corner bay of the rc3 building comes down (impact): what the engine decides from there. */
function collapseCorner(c: SimulationController, b: RuntimeEntity) {
  const ctx = ctxOf(c);
  const st = structureOf(b, ctx);
  const grid = st.cells?.grid ?? cellGrid(st.model.g, originalOf(b.modular!.design));
  st.model.fail(cornerBay(st.model.g, grid), 'impact', 'impact', 6);
  activate(b, ctx);
}

const H = 9.6; // rc3: 3 × 3.2 m

afterEach(() => {
  CELL_LIMITS.perBuilding = 48;
});

describe('cell colliders in the simulation (v2)', { timeout: 600_000 }, () => {
  async function scene(v2: boolean) {
    const inputs: CreateObjectInput[] = [
      { type: 'building', building: createDesign(rc3()), seed: 7, transform: T() },
      // A car parked on the roof over the corner bay (x, z < 0).
      { type: 'car', seed: 3, transform: T(-3.8, H + 0.1, -4.4) },
      // A tall crate leaning on the −x wall of the corner bay (gravity holds it against the wall).
      { type: 'crate', params: { material: 'wood', length: 0.3, width: 0.8, height: 3, cargo: 0, sealed: false, color: '#b08850' }, seed: 4, transform: T(-6.175 - 0.82, 0, -3.2, [0, 0, -0.2]) },
      // A house further away: one of its doors becomes a fragment laid on the roof.
      { type: 'building', building: createDesign(presetSpec('house')!, 'house'), seed: 8, transform: T(30, 0, 0) },
    ];
    const c = new SimulationController({ headless: true });
    await c.load(world(inputs, v2));
    c.advance(3);
    return c;
  }

  /** A door of the house torn off (fragment, exact mass) and laid flat on the roof over the corner bay, left to settle. */
  function fragmentOnRoof(c: SimulationController) {
    const ctx = ctxOf(c);
    const house = ofType(c, 'building')[1];
    const st = structureOf(house, ctx);
    const g = st.model.g;
    const door = pick(g, (i) => g.type[i] === MT_DOOR)[0];
    st.model.detachMember(door, 'uplift', 'wind', 3);
    const frag = spawnFragment(ctx, house, door, [0, 0, 0], 'wind')!;
    const thinZ = frag.size[2] < frag.size[0];
    const q: [number, number, number, number] = thinZ ? [Math.SQRT1_2, 0, 0, Math.SQRT1_2] : [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    c.getPhysics()!.setBodyPose(frag.body, [-1.6, H + Math.min(...frag.size) / 2 + 0.05, -1.6], q);
    activate(house, ctx);
    return frag;
  }

  it('a car on the roof above the collapsing corner bay falls through, a crate leaning on its wall topples in, a settled fragment on its roof falls; v1 keeps the old box', async () => {
    const out: Record<string, { car: number; crate: number; frag: number; rebuilds: number }> = {};
    for (const v2 of [false, true]) {
      const c = await scene(v2);
      const [b] = ofType(c, 'building');
      const [car] = ofType(c, 'car');
      const [crate] = ofType(c, 'crate');
      const ph = c.getPhysics()!;
      expect(car.pose.position[1]).toBeGreaterThan(H - 0.05);
      const crateTilt0 = crate.pose.quaternion[2];
      const frag = fragmentOnRoof(c);
      c.advance(3);
      // At rest: the fragment became a fixed body on the roof.
      expect(frag.structural!.settled).toBe(true);
      expect(frag.pose.position[1]).toBeGreaterThan(H);
      const bodies0 = ph.bodyCount();
      collapseCorner(c, b);
      c.advance(8);
      const m = b.modular!.structure!.model;
      const S = structuresOf(c.getRuntime()!);
      // Mass ledger closed; this building's fragments carry its 'bodies' account.
      expect(Math.abs(m.ledger.residual()) / m.ledger.original).toBeLessThan(1e-9);
      expect(S.fragments.filter((f) => f.structural!.owner === b.id).reduce((s, f) => s + f.mass, 0)).toBeCloseTo(m.ledger.mass.bodies, 3);
      // Bodies: the building's body is replaced one for one; new bodies are rubble heaps and fragments only.
      expect(ph.bodyCount()).toBeLessThanOrEqual(bodies0 + S.rubble.heaps.length + S.fragments.length);
      out[v2 ? 'v2' : 'v1'] = { car: car.pose.position[1], crate: Math.abs(crate.pose.quaternion[2] - crateTilt0), frag: frag.pose.position[1], rebuilds: S.cellRebuilds ?? 0 };
      if (v2) {
        const cells = b.modular!.structure!.cells!;
        expect(cells.boxes!.length).toBeGreaterThan(0);
        expect(cells.boxes!.length).toBeLessThanOrEqual(CELL_LIMITS.perBuilding);
        // A ray straight down over the corner bay no longer meets the building's body…
        const hit = ph.castRay([-3, 20, -3], [0, -1, 0], 40, null);
        expect(hit?.user?.entityId === b.id && hit.point[1] > 0.5).toBe(false);
        // …but over the standing bays it still does, at the roof.
        const keep = ph.castRay([3, 20, 3], [0, -1, 0], 40, null);
        expect(keep?.user?.entityId).toBe(b.id);
        expect(keep!.point[1]).toBeCloseTo(H, 3);
      }
      c.unload();
    }
    // v1: the single box stays — the car is still on it, the fragment still lies on the roof.
    expect(out.v1.rebuilds).toBe(0);
    expect(out.v1.car).toBeGreaterThan(H - 0.05);
    expect(out.v1.frag).toBeGreaterThan(H);
    // v2: the car fell through the open corner cells onto the rubble, the fragment fell, the crate toppled into the corner.
    expect(out.v2.rebuilds).toBeGreaterThan(0);
    expect(out.v2.car).toBeLessThan(H - 3);
    expect(out.v2.frag).toBeLessThan(H - 3);
    expect(out.v2.crate).toBeGreaterThan(out.v1.crate + 0.05);
  });

  it('topple in a run: the hinge and its release go into the log (v2 only), the toppled bay\'s cells open, the standing bay keeps its box', async () => {
    const logs: string[][] = [];
    for (const v2 of [false, true]) {
      const c = new SimulationController({ headless: true });
      await c.load(world([{ type: 'building', building: twoBay(), seed: 7, transform: T() }], v2));
      c.advance(0.5);
      const [b] = ofType(c, 'building');
      const ctx = ctxOf(c);
      const st = structureOf(b, ctx);
      const ms = b.modular!.design.members;
      st.model.fail(ms.map((x, i) => (x.type === 'column' && x.level === 0 && x.position[0] === -6 ? i : -1)).filter((i) => i >= 0), 'drift', 'earthquake', 0.5);
      activate(b, ctx);
      c.advance(6);
      logs.push(c.getRuntime()!.log.map((l) => l.message.key).filter((k) => k.startsWith('log.p36.')));
      if (v2) {
        const cells = st.cells!;
        const o = off(cells.grid, cells.solid);
        expect(o).toContain('0,0,0');
        expect(o.every((x) => x.split(',')[1] === '0')).toBe(true);
        const keep = c.getPhysics()!.castRay([3, 20, 0], [0, -1, 0], 40, null);
        expect(keep?.user?.entityId).toBe(b.id);
      }
      c.unload();
    }
    expect(logs[0]).toEqual([]);
    expect(logs[1][0]).toBe('log.p36.hinge');
    expect(logs[1].filter((k) => k.startsWith('log.p36.release')).length).toBe(1);
  });

  it('deterministic: the same collapse gives the same cell boxes, poses and body count, bit for bit', async () => {
    const one = async () => {
      const c = await scene(true);
      const [b] = ofType(c, 'building');
      collapseCorner(c, b);
      c.advance(6);
      const st = b.modular!.structure!;
      const r = JSON.stringify({ boxes: st.cells!.boxes, rebuilds: st.cells!.rebuilds, poses: [...c.getRuntime()!.entities.values()].map((e) => e.pose), bodies: c.getPhysics()!.bodyCount(), dy: Array.from(st.model.dy) });
      c.unload();
      return r;
    };
    expect(await one()).toBe(await one());
  });

  it('a whole storey (the top storey knocked off its walls, its floors arrested on the storey below): the v2 body ends where truncate cut the v1 box', async () => {
    const masonry3: BuildingSpec = { ...defaultSpec(), system: 'masonry', structureMaterial: 'masonry', slabMaterial: 'reinforcedConcrete', claddingMaterial: 'masonry', foundation: 'spread', bay: 4, occupancy: 'residential', width: 12, depth: 10, floors: 3 };
    const tops: number[] = [], from: number[] = [];
    let base = NaN;
    for (const v2 of [false, true]) {
      const c = new SimulationController({ headless: true });
      await c.load(world([{ type: 'building', building: createDesign(masonry3), seed: 7, transform: T() }], v2));
      c.advance(0.5);
      const [b] = ofType(c, 'building');
      const ctx = ctxOf(c);
      const st = structureOf(b, ctx);
      const g = st.model.g;
      st.model.fail(pick(g, (i) => g.level[i] === 2 && g.structural[i] === 1 && (g.type[i] === MT_COLUMN || g.type[i] === MT_WALL)), 'impact', 'impact', 0.5);
      activate(b, ctx);
      c.advance(6);
      from.push(b.modular!.collapsedFrom);
      base = b.modular!.initial.stories[b.modular!.collapsedFrom].base;
      for (const [x, z] of [[-4, -3], [4, -3], [-4, 3], [4, 3], [0, 0], [5.9, 4.9]]) {
        const hit = c.getPhysics()!.castRay([x, 20, z], [0, -1, 0], 40, null);
        tops.push(hit && hit.user?.entityId === b.id ? Math.round(hit.point[1] * 1000) / 1000 : NaN);
      }
      if (v2) expect(st.cells!.rebuilds).toBe(1);
      c.unload();
    }
    const n = tops.length / 2;
    expect(from).toEqual([2, 2]);
    expect(tops.slice(n)).toEqual(tops.slice(0, n));
    for (const t of tops) expect(t).toBeCloseTo(base, 3);
  });
});

