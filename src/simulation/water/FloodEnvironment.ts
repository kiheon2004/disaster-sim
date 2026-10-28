/**
 * FloodEnvironment (Phase 14): the water part of the EnvironmentState.
 *
 *   FloodEvents ──write──► forcing (rain, sources, boundary levels)
 *                                   │
 *                         WaterSolver ──► WaterField ──read──► objects, damage, analysis, renderer
 *
 * Nothing is allocated until the first water event starts (`activate()`): wind- and
 * earthquake-only runs build no grid and stay bit-identical to Phase 13. On activation the grid
 * is built from the frozen terrain, solid obstacles (buildings, masonry walls) and road
 * surfaces, and — if enabled — ground below the reference water level that is connected to a
 * fixed-level edge is filled to that level (the sea / river that is "already there").
 * The reference level itself is a static terrain setting; the dynamic depth lives here only.
 */
import type { BoundarySide, TerrainData, WaterSettings } from '@/core/model';
import { BOUNDARY_SIDES, defaultWaterSettings } from '@/core/model';
import type { EntityId } from '@/core/types';
import type { TerrainSampler } from '@/terrain/TerrainSampler';
import { WaterField, type Footprint } from './WaterField';
import { WaterForcing } from './WaterForcing';
import { WaterSolver } from './WaterSolver';
import { applyWaterState, type WaterStateSnapshot } from './waterStateCodec';

export class FloodEnvironment {
  field: WaterField | null = null;
  forcing: WaterForcing | null = null;
  solver: WaterSolver | null = null;
  private obstacles: Footprint[] = [];
  private roads: Footprint[] = [];
  /** Optional initial water state (mid-simulation snapshot) applied at activation. */
  initialState: WaterStateSnapshot | null = null;
  /** Simulation time of activation (s). */
  activatedAt = 0;

  constructor(
    readonly terrain: TerrainSampler,
    readonly settings: WaterSettings = defaultWaterSettings(),
  ) {}

  /** Solid footprints that block the flow, and road surfaces (set by the controller at load). */
  setFeatures(obstacles: Footprint[], roads: Footprint[]) {
    this.obstacles = obstacles;
    this.roads = roads;
  }

  get active(): boolean {
    return this.field !== null;
  }

  /** Build the water grid (idempotent). */
  activate(time: number): WaterField {
    if (this.field) return this.field;
    const t: TerrainData = this.terrain.data;
    const field = new WaterField(this.terrain, this.settings, this.obstacles, this.roads);
    const forcing = new WaterForcing(this.settings, t);
    if (this.initialState) applyWaterState(field, this.initialState);
    else if (this.settings.initialFromReference) fillFromBoundaries(field, forcing);
    field.budget.initial = field.totalVolume();
    field.updateStats();
    this.field = field;
    this.forcing = forcing;
    this.solver = new WaterSolver(field, forcing);
    this.activatedAt = time;
    return field;
  }

  /** Rising water starts / ends on an edge. */
  setBoundaryLevel(side: BoundarySide, owner: string, level: number) {
    this.forcing!.setBoundaryLevel(side, owner, level);
    this.solver!.touchEdge(side);
  }

  clearBoundary(side: BoundarySide, owner: string) {
    this.forcing?.clearBoundary(side, owner);
  }

  removeObstacle(id: EntityId) {
    this.field?.removeObstacle(id);
  }

  /** Rain rate falling right now (mm/h) — visuals and HUD. */
  rainIntensity(): number {
    return this.forcing?.rainIntensity() ?? 0;
  }

  // ── Point queries that work before activation (no water anywhere) ──

  depthAt(x: number, z: number): number {
    return this.field ? this.field.sampleDepth(x, z) : 0;
  }
}

/**
 * Initial condition: every open cell below a fixed-level edge's surface that is connected to
 * that edge (4-neighborhood) is filled up to it. Isolated hollows inland stay dry.
 */
export function fillFromBoundaries(field: WaterField, forcing: WaterForcing) {
  const { nx, nz, bed, blocked, h } = field;
  const level = new Float64Array(field.count).fill(-Infinity);
  // Plain array: a cell is re-queued when a higher edge level reaches it later.
  const queue: number[] = [];
  let head = 0;
  const seed = (i: number, L: number) => {
    if (blocked[i] || bed[i] >= L || level[i] >= L) return;
    level[i] = L;
    queue.push(i);
  };
  for (const side of BOUNDARY_SIDES) {
    const b = forcing.boundary(side);
    if (b.type !== 'fixedLevel') continue;
    const n = side === 'N' || side === 'S' ? nx : nz;
    for (let k = 0; k < n; k++) {
      const ix = side === 'W' ? 0 : side === 'E' ? nx - 1 : k;
      const iz = side === 'N' ? 0 : side === 'S' ? nz - 1 : k;
      seed(iz * nx + ix, b.level);
    }
  }
  while (head < queue.length) {
    const i = queue[head++];
    const L = level[i];
    const ix = i % nx;
    const iz = (i - ix) / nx;
    if (ix > 0) seed(i - 1, L);
    if (ix < nx - 1) seed(i + 1, L);
    if (iz > 0) seed(i - nx, L);
    if (iz < nz - 1) seed(i + nx, L);
  }
  for (let i = 0; i < field.count; i++) {
    if (level[i] === -Infinity) continue;
    h[i] = level[i] - bed[i];
    const ix = i % nx;
    field.touch(ix, (i - ix) / nx);
  }
}
