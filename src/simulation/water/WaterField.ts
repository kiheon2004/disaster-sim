/**
 * WaterField: the flood model's grid and state (Phase 14). Pure data + queries — no Three.js,
 * no physics. The WaterSolver advances it; objects, damage, analysis and the renderer read it.
 *
 *   terrain vertices (201 × 201)            water cells (200 × 200, 1 m)
 *   ●───●───●                               ┌───┬───┐
 *   │ ╲ │ ╲ │   heights at vertices         │ h │ h │  depth, bed, velocity at cell CENTERS
 *   ●───●───●   (row-major, iz·nx + ix)     ├─qx┼───┤  discharge on cell FACES (staggered)
 *
 * Grid: the terrain's cells, one water cell per terrain cell, same origin and spacing, so a
 * water cell (ix, iz) spans vertices (ix, iz)…(ix+1, iz+1). The bed elevation of a cell is the
 * exact mean of the rendered/physics surface over it — (h00 + 2·h10 + 2·h01 + h11) / 6 for the
 * two triangles split along the (x1,z0)–(x0,z1) diagonal — so the water volume over a cell
 * matches the volume between the terrain and the water surface.
 *
 * Coordinates: +X east, +Z south (north edge = originZ). qx[iz·(nx+1) + ix] is the flow
 * through the WEST face of cell (ix, iz) toward +X (m²/s, per meter of face);
 * qz[iz·nx + ix] the flow through its NORTH face toward +Z.
 */
import { gravityDown } from '@/thermal/gravityScope';
import type { EntityId } from '@/core/types';
import type { TerrainData, WaterSettings } from '@/core/model';
import { groundMaterial } from '@/terrain/GroundMaterials';
import type { Inlet } from '../roads/RoadRuntime';
import type { TerrainSampler } from '@/terrain/TerrainSampler';
import {
  FLOOD_DEPTH, INFIL_RATE_FULL, MANNING_BY_GROUND, ROAD_MANNING, ROAD_PERMEABILITY, SOIL_STORAGE_FULL, WET_DEPTH, mmPerHour,
} from './waterParams';

/** Oriented rectangle footprint (world x/z, yaw about +Y like object rotations). */
export interface Footprint {
  id: EntityId;
  center: [number, number];
  /** Half extents along the object's local x / z (m). */
  half: [number, number];
  yaw: number;
}

/**
 * Mass budget (m³). Closed bookkeeping: everything that enters or leaves the water layer is
 * counted where it happens, so `error` measures purely numerical gain/loss.
 */
export interface WaterBudget {
  initial: number;
  rain: number;
  sources: number;
  boundaryIn: number;
  boundaryOut: number;
  infiltration: number;
  drainage: number;
  /** Phase 30 (climate): meltwater in, water frozen out, evaporated out, condensed / internal precipitation in (m³). */
  melt: number;
  frozen: number;
  evaporated: number;
  condensed: number;
  current: number;
  /** current − (initial + inputs − outputs). */
  error: number;
}

export function emptyBudget(): WaterBudget {
  return { initial: 0, rain: 0, sources: 0, boundaryIn: 0, boundaryOut: 0, infiltration: 0, drainage: 0, melt: 0, frozen: 0, evaporated: 0, condensed: 0, current: 0, error: 0 };
}

export function expectedVolume(b: WaterBudget): number {
  return b.initial + b.rain + b.sources + b.boundaryIn - b.boundaryOut - b.infiltration - b.drainage + b.melt - b.frozen - b.evaporated + b.condensed;
}

/** Relative conservation error: |error| / total water that ever entered. */
export function relativeError(b: WaterBudget): number {
  const scale = b.initial + b.rain + b.sources + b.boundaryIn;
  return scale > 0 ? Math.abs(b.error) / scale : 0;
}

/** Live statistics refreshed after every solver call. */
export interface WaterStats {
  volume: number;
  wetCells: number;
  floodedCells: number;
  maxDepth: number;
  /** Mean depth over flooded cells (m). */
  meanFloodDepth: number;
  maxSpeed: number;
  /** Substeps used by the last solver call and the smallest substep (s). */
  substeps: number;
  minDt: number;
}

export interface CellSample {
  ix: number;
  iz: number;
  index: number;
  bed: number;
  depth: number;
  surface: number;
  u: number;
  v: number;
  ground: number;
  blocked: boolean;
}

export class WaterField {
  readonly nx: number;
  readonly nz: number;
  readonly cell: number;
  readonly originX: number;
  readonly originZ: number;
  readonly cellArea: number;
  readonly count: number;

  // ── Static layers (built once per activation) ──
  /** Bed elevation per cell (m). */
  readonly bed: Float64Array;
  /** Manning n² per cell. */
  readonly n2: Float64Array;
  /** Infiltration capacity on dry soil (m/s) and soil storage (m). */
  readonly infilRate: Float32Array;
  readonly infilStore: Float32Array;
  /** Drainage capacity (m/s) — storm drains on paved cells. */
  readonly drainRate: Float32Array;
  /** Ground type of the cell (nearest vertex; 255 = road object). */
  readonly ground: Uint8Array;
  /** 1 = solid obstacle (building, masonry wall): no water, no flow through its faces. */
  readonly blocked: Uint8Array;
  /** Obstacle index owning a blocked cell (−1 = none). */
  readonly owner: Int32Array;
  /** For blocked cells: the open cell that receives the rain falling on the roof. */
  readonly redirect: Int32Array;

  // ── State ──
  /** Water depth per cell (m). Float64 so the mass budget closes to round-off. */
  readonly h: Float64Array;
  readonly qx: Float64Array;
  readonly qz: Float64Array;
  /** Cell-centered velocity (m/s), derived from the face discharges after each substep. */
  readonly u: Float32Array;
  readonly v: Float32Array;
  /** Cumulative infiltrated depth (m) — the soil bucket. */
  readonly infiltrated: Float32Array;
  /** Peak depth reached (m) and time spent flooded (s, depth ≥ FLOOD_DEPTH). */
  readonly maxDepth: Float32Array;
  readonly floodTime: Float32Array;

  /**
   * Heat carried by the water (Phase 26, J per cell above the thermal reference; null unless a
   * thermal run attached it). The solver moves it with the SAME face volumes as the water (upwind
   * temperature) — inflows (rain, sources, boundaries) enter at the reference temperature; heat leaving
   * with infiltration goes to `infilHeat` (→ ground), with drains / edges to `heatOut` (lost).
   */
  heat: Float64Array | null = null;
  infilHeat: Float64Array | null = null;
  heatOut = 0;
  /**
   * Phase 31 (R3): heat of inflowing water above the reference (J per metre of depth over one cell) — Phase 14 rain,
   * sources and edge inflow enter at the melting point when the reference temperature is below it (liquid inflow is not
   * supercooled); 0 otherwise (the Phase 26–30 reference-temperature inflow). Booked as negative `heatOut`.
   */
  inflowExcess = 0;
  heatMoved = 0;

  /**
   * Phase 30 (climate experiments only — null otherwise, the Phase 14 paths unchanged):
   *  infilFactor  infiltration capacity multiplier of frozen soil (impedance 10^(−Ω·Q))
   *  iceLoad      floating ice per cell as water depth (m): its weight presses on the water surface
   *  iceFric      Manning n² multiplier under an ice cover (Sabaneev composite roughness)
   *  frozen       1: the water is frozen to the bed (liquid under the ice too thin to flow) — no flow
   *  drainKeep    depth the storm drains leave on paved cells (m): the pavement's depression storage / wetting film
   *               (0 = the Phase 14 drains, which take everything up to their capacity)
   */
  infilFactor: Float32Array | null = null;
  iceLoad: Float64Array | null = null;
  iceFric: Float32Array | null = null;
  frozen: Uint8Array | null = null;
  drainKeep = 0;

  /** Inclusive cell range that may hold water (empty when x0 > x1). */
  x0 = 1;
  x1 = 0;
  z0 = 1;
  z1 = 0;

  readonly budget: WaterBudget = emptyBudget();
  readonly stats: WaterStats = { volume: 0, wetCells: 0, floodedCells: 0, maxDepth: 0, meanFloodDepth: 0, maxSpeed: 0, substeps: 0, minDt: 0 };
  /** Simulated seconds the solver has advanced. */
  time = 0;
  /** Bumped after every solver call (renderers compare it). */
  rev = 0;
  readonly obstacles: Footprint[];

  constructor(readonly terrain: TerrainSampler, settings: WaterSettings, obstacles: Footprint[] = [], roads: Footprint[] = [], inlets: readonly Inlet[] = []) {
    const t: TerrainData = terrain.data;
    this.nx = t.nx - 1;
    this.nz = t.nz - 1;
    this.cell = t.cellSize;
    this.originX = t.originX;
    this.originZ = t.originZ;
    this.cellArea = this.cell * this.cell;
    const n = (this.count = this.nx * this.nz);
    this.bed = new Float64Array(n);
    this.n2 = new Float64Array(n);
    this.infilRate = new Float32Array(n);
    this.infilStore = new Float32Array(n);
    this.drainRate = new Float32Array(n);
    this.ground = new Uint8Array(n);
    this.blocked = new Uint8Array(n);
    this.owner = new Int32Array(n).fill(-1);
    this.redirect = new Int32Array(n).fill(-1);
    this.h = new Float64Array(n);
    this.qx = new Float64Array((this.nx + 1) * this.nz);
    this.qz = new Float64Array(this.nx * (this.nz + 1));
    this.u = new Float32Array(n);
    this.v = new Float32Array(n);
    this.infiltrated = new Float32Array(n);
    this.maxDepth = new Float32Array(n);
    this.floodTime = new Float32Array(n);
    this.obstacles = obstacles;
    this.buildLayers(t, settings);
    for (const r of roads) this.rasterize(r, (i) => this.paveCell(i, settings));
    obstacles.forEach((o, k) => this.rasterize(o, (i) => {
      this.blocked[i] = 1;
      this.owner[i] = k;
    }));
    // Storm-drain inlets of network roads (Phase 18): sub-grid point sinks. An inlet's capacity
    // (m³/s) becomes extra drainage depth rate on the 1 m cell that contains it; the solver
    // limits it to the water present, so the budget (drainage term) stays exact.
    for (const inlet of inlets) {
      const i = this.indexAt(inlet.x, inlet.z);
      if (i >= 0 && !this.blocked[i]) {
        this.drainRate[i] += inlet.capacity / this.cellArea;
        this.inletCells++;
      }
    }
    this.computeRedirects();
  }

  /** Cells carrying a storm-drain inlet (Phase 18). */
  inletCells = 0;

  private buildLayers(t: TerrainData, s: WaterSettings) {
    const vx = t.nx;
    const hs = t.heights;
    const infilScale = s.infiltration ? s.infiltrationScale : 0;
    const drain = mmPerHour(Math.max(0, s.drainageCapacity));
    for (let iz = 0; iz < this.nz; iz++) {
      for (let ix = 0; ix < this.nx; ix++) {
        const i = iz * this.nx + ix;
        const v = iz * vx + ix;
        // Mean of the two collider triangles over the cell (see the header).
        this.bed[i] = (hs[v] + 2 * hs[v + 1] + 2 * hs[v + vx] + hs[v + vx + 1]) / 6;
        // Surface properties: average of the four corner vertices (paved fraction for drains).
        let perm = 0;
        let n = 0;
        let paved = 0;
        for (const c of [v, v + 1, v + vx, v + vx + 1]) {
          const g = groundMaterial(t.ground[c]);
          perm += g.permeability / 4;
          n += MANNING_BY_GROUND[g.id] / 4;
          if (g.paved) paved += 0.25;
        }
        const nn = n * s.roughnessScale;
        this.n2[i] = nn * nn;
        this.infilRate[i] = mmPerHour(perm * INFIL_RATE_FULL) * infilScale;
        this.infilStore[i] = perm * SOIL_STORAGE_FULL * infilScale;
        this.drainRate[i] = drain * paved;
        // Nearest vertex to the cell center = the bottom-right of the four? Use the rounding of
        // the center like TerrainSampler.sampleGroundType (ties → +1).
        this.ground[i] = t.ground[(iz + 1) * vx + ix + 1];
      }
    }
  }

  /** A road object covers this cell: asphalt infiltration, roughness and storm drains. */
  private paveCell(i: number, s: WaterSettings) {
    const infilScale = s.infiltration ? s.infiltrationScale : 0;
    this.infilRate[i] = mmPerHour(ROAD_PERMEABILITY * INFIL_RATE_FULL) * infilScale;
    this.infilStore[i] = ROAD_PERMEABILITY * SOIL_STORAGE_FULL * infilScale;
    const nn = ROAD_MANNING * s.roughnessScale;
    this.n2[i] = nn * nn;
    this.drainRate[i] = mmPerHour(Math.max(0, s.drainageCapacity));
    this.ground[i] = 255;
  }

  /** Call `fn` for every cell whose center lies inside the footprint. */
  private rasterize(f: Footprint, fn: (i: number) => void) {
    const c = Math.cos(f.yaw);
    const sn = Math.sin(f.yaw);
    const ext = Math.abs(c) * f.half[0] + Math.abs(sn) * f.half[1];
    const ezt = Math.abs(sn) * f.half[0] + Math.abs(c) * f.half[1];
    const ix0 = Math.max(0, Math.floor((f.center[0] - ext - this.originX) / this.cell));
    const ix1 = Math.min(this.nx - 1, Math.floor((f.center[0] + ext - this.originX) / this.cell));
    const iz0 = Math.max(0, Math.floor((f.center[1] - ezt - this.originZ) / this.cell));
    const iz1 = Math.min(this.nz - 1, Math.floor((f.center[1] + ezt - this.originZ) / this.cell));
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const dx = this.originX + (ix + 0.5) * this.cell - f.center[0];
        const dz = this.originZ + (iz + 0.5) * this.cell - f.center[1];
        // World → local (yaw about +Y: local x = (cos, 0, −sin)).
        const lx = dx * c - dz * sn;
        const lz = dx * sn + dz * c;
        if (Math.abs(lx) <= f.half[0] && Math.abs(lz) <= f.half[1]) fn(iz * this.nx + ix);
      }
    }
  }

  /** Rain on a roof drains to the nearest open cell (breadth-first, deterministic order). */
  private computeRedirects() {
    const { nx, nz, blocked, redirect } = this;
    const queue = new Int32Array(this.count);
    let head = 0;
    let tail = 0;
    for (let i = 0; i < this.count; i++) {
      if (blocked[i]) continue;
      // Seed with open cells next to a blocked one.
      const ix = i % nx;
      const iz = (i - ix) / nx;
      if ((ix > 0 && blocked[i - 1]) || (ix < nx - 1 && blocked[i + 1]) || (iz > 0 && blocked[i - nx]) || (iz < nz - 1 && blocked[i + nx])) {
        queue[tail++] = i;
      }
      redirect[i] = i;
    }
    while (head < tail) {
      const i = queue[head++];
      const ix = i % nx;
      const iz = (i - ix) / nx;
      const visit = (j: number) => {
        if (blocked[j] && redirect[j] < 0) {
          redirect[j] = redirect[i];
          queue[tail++] = j;
        }
      };
      if (ix > 0) visit(i - 1);
      if (ix < nx - 1) visit(i + 1);
      if (iz > 0) visit(i - nx);
      if (iz < nz - 1) visit(i + nx);
    }
  }

  /**
   * Bed motion bookkeeping (Phase 21). The bed moves under the water; the water COLUMN moves with
   * it (depth h preserved), so the water volume — and the mass budget — is unchanged by a bed
   * update. What changes is the free surface (η = bed + h) and the potential energy of the water:
   *   displacedVolume  Σ |Δbed|·A over wet cells (water moved vertically, m³)
   *   work             Σ ρ·g·h·A·Δbed over wet cells (J): work the moving ground does on the water
   * Kinetic effects of the bed's own velocity (vertical momentum, pressure pulses) are outside
   * the shallow-water model and are not represented.
   */
  readonly bedMotion = { updates: 0, displacedVolume: 0, work: 0, maxRise: 0, maxDrop: 0 };

  /**
   * Re-derive the bed of every cell touching a vertex rectangle from the terrain heights (which
   * the deformation engine has just changed). Depth-preserving: h, discharges and the budget are
   * untouched (see bedMotion). Returns the number of cells updated.
   */
  applyBedChange(rect: { x0: number; z0: number; x1: number; z1: number }): number {
    const t = this.terrain.data;
    const vx = t.nx, hs = t.heights;
    const cx0 = Math.max(0, rect.x0 - 1), cz0 = Math.max(0, rect.z0 - 1);
    const cx1 = Math.min(this.nx - 1, rect.x1), cz1 = Math.min(this.nz - 1, rect.z1);
    let n = 0;
    const m = this.bedMotion;
    for (let iz = cz0; iz <= cz1; iz++) {
      for (let ix = cx0; ix <= cx1; ix++) {
        const i = iz * this.nx + ix, v = iz * vx + ix;
        const bed = (hs[v] + 2 * hs[v + 1] + 2 * hs[v + vx] + hs[v + vx + 1]) / 6;
        const d = bed - this.bed[i];
        if (d === 0) continue;
        this.bed[i] = bed;
        n++;
        const h = this.h[i];
        if (h > 0) {
          m.displacedVolume += Math.abs(d) * this.cellArea;
          // Under the step's downward gravity (Phase 31 audit §11; the factor is exactly 1 without an experiment).
          m.work += 1000 * 9.81 * gravityDown() * h * this.cellArea * d;
        }
        if (d > m.maxRise) m.maxRise = d;
        if (-d > m.maxDrop) m.maxDrop = -d;
      }
    }
    if (n) {
      m.updates++;
      this.rev++;
    }
    return n;
  }

  /** A collapsed building / broken wall no longer blocks the flow. */
  removeObstacle(id: EntityId): boolean {
    const k = this.obstacles.findIndex((o) => o.id === id);
    if (k < 0) return false;
    let any = false;
    for (let i = 0; i < this.count; i++) {
      if (this.owner[i] !== k) continue;
      this.owner[i] = -1;
      this.blocked[i] = 0;
      this.redirect[i] = i;
      any = true;
    }
    return any;
  }

  // ── Geometry helpers ─────────────────────────────────────

  cellX(ix: number) {
    return this.originX + (ix + 0.5) * this.cell;
  }
  cellZ(iz: number) {
    return this.originZ + (iz + 0.5) * this.cell;
  }

  /** Cell index containing a world point, or −1 outside the grid. */
  indexAt(x: number, z: number): number {
    const ix = Math.floor((x - this.originX) / this.cell);
    const iz = Math.floor((z - this.originZ) / this.cell);
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return -1;
    return iz * this.nx + ix;
  }

  /** Expand the active range to include a cell. */
  touch(ix: number, iz: number) {
    if (this.x0 > this.x1) {
      this.x0 = this.x1 = ix;
      this.z0 = this.z1 = iz;
      return;
    }
    if (ix < this.x0) this.x0 = ix;
    if (ix > this.x1) this.x1 = ix;
    if (iz < this.z0) this.z0 = iz;
    if (iz > this.z1) this.z1 = iz;
  }

  hasWater(): boolean {
    return this.x0 <= this.x1;
  }

  /** Σ h·A over the grid (m³). */
  totalVolume(): number {
    let v = 0;
    const h = this.h;
    for (let i = 0; i < h.length; i++) v += h[i];
    return v * this.cellArea;
  }

  // ── Point queries (bilinear over cell centers, allocation-free) ──

  private bil = { i00: 0, i10: 0, i01: 0, i11: 0, fx: 0, fz: 0 };

  private bilinear(x: number, z: number) {
    const b = this.bil;
    let gx = (x - this.originX) / this.cell - 0.5;
    let gz = (z - this.originZ) / this.cell - 0.5;
    if (gx < 0) gx = 0;
    else if (gx > this.nx - 1) gx = this.nx - 1;
    if (gz < 0) gz = 0;
    else if (gz > this.nz - 1) gz = this.nz - 1;
    let ix = Math.floor(gx);
    let iz = Math.floor(gz);
    if (ix > this.nx - 2) ix = this.nx - 2;
    if (iz > this.nz - 2) iz = this.nz - 2;
    b.fx = gx - ix;
    b.fz = gz - iz;
    b.i00 = iz * this.nx + ix;
    b.i10 = b.i00 + 1;
    b.i01 = b.i00 + this.nx;
    b.i11 = b.i01 + 1;
    return b;
  }

  /** Inside the water grid? (Outside: no water.) */
  inside(x: number, z: number): boolean {
    return x >= this.originX && z >= this.originZ && x <= this.originX + this.nx * this.cell && z <= this.originZ + this.nz * this.cell;
  }

  /**
   * Water surface elevation at a point (m), interpolated from the WET neighbors only; −Infinity
   * when none of the four surrounding cells holds water.
   */
  sampleSurface(x: number, z: number): number {
    if (!this.hasWater() || !this.inside(x, z)) return -Infinity;
    const { i00, i10, i01, i11, fx, fz } = this.bilinear(x, z);
    const h = this.h;
    const w00 = (1 - fx) * (1 - fz);
    const w10 = fx * (1 - fz);
    const w01 = (1 - fx) * fz;
    const w11 = fx * fz;
    let sw = 0;
    let s = 0;
    if (h[i00] > WET_DEPTH * 0.1) { sw += w00; s += w00 * (this.bed[i00] + h[i00]); }
    if (h[i10] > WET_DEPTH * 0.1) { sw += w10; s += w10 * (this.bed[i10] + h[i10]); }
    if (h[i01] > WET_DEPTH * 0.1) { sw += w01; s += w01 * (this.bed[i01] + h[i01]); }
    if (h[i11] > WET_DEPTH * 0.1) { sw += w11; s += w11 * (this.bed[i11] + h[i11]); }
    return sw > 1e-6 ? s / sw : -Infinity;
  }

  /** Water depth above the actual ground at a point (m). */
  sampleDepth(x: number, z: number): number {
    const s = this.sampleSurface(x, z);
    if (s === -Infinity) return 0;
    const d = s - this.terrain.sampleHeight(x, z);
    return d > 0 ? d : 0;
  }

  /** Depth-averaged flow velocity at a point, written into `out` ([vx, vz], m/s). */
  sampleVelocity(x: number, z: number, out: [number, number]): [number, number] {
    out[0] = 0;
    out[1] = 0;
    if (!this.hasWater() || !this.inside(x, z)) return out;
    const { i00, i10, i01, i11, fx, fz } = this.bilinear(x, z);
    const w00 = (1 - fx) * (1 - fz);
    const w10 = fx * (1 - fz);
    const w01 = (1 - fx) * fz;
    const w11 = fx * fz;
    out[0] = w00 * this.u[i00] + w10 * this.u[i10] + w01 * this.u[i01] + w11 * this.u[i11];
    out[1] = w00 * this.v[i00] + w10 * this.v[i10] + w01 * this.v[i01] + w11 * this.v[i11];
    return out;
  }

  /** Raw values of the cell containing a point (inspector). */
  sampleCell(x: number, z: number): CellSample | null {
    const i = this.indexAt(x, z);
    if (i < 0) return null;
    const ix = i % this.nx;
    const iz = (i - ix) / this.nx;
    return {
      ix, iz, index: i, bed: this.bed[i], depth: this.h[i], surface: this.bed[i] + this.h[i], u: this.u[i], v: this.v[i],
      ground: this.ground[i], blocked: this.blocked[i] === 1,
    };
  }

  /** Refresh the statistics (called by the solver after a step). */
  updateStats() {
    const st = this.stats;
    let vol = 0;
    let wet = 0;
    let fl = 0;
    let flSum = 0;
    let maxD = 0;
    let maxS = 0;
    const { h, u, v } = this;
    if (this.hasWater()) {
      for (let iz = this.z0; iz <= this.z1; iz++) {
        for (let i = iz * this.nx + this.x0, e = iz * this.nx + this.x1; i <= e; i++) {
          const d = h[i];
          if (d <= 0) continue;
          vol += d;
          if (d > maxD) maxD = d;
          if (d >= WET_DEPTH) {
            wet++;
            const s = u[i] * u[i] + v[i] * v[i];
            if (s > maxS) maxS = s;
          }
          if (d >= FLOOD_DEPTH) {
            fl++;
            flSum += d;
          }
        }
      }
    }
    st.volume = vol * this.cellArea;
    st.wetCells = wet;
    st.floodedCells = fl;
    st.maxDepth = maxD;
    st.meanFloodDepth = fl ? flSum / fl : 0;
    st.maxSpeed = Math.sqrt(maxS);
  }
}
