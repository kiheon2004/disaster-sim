/**
 * External forcing of the water model (Phase 14): what flood events WRITE and the solver READS.
 *
 *  - rain:        rainfall rates (m/s of water depth) over the map or a circular area
 *  - sources:     point inflows (m³/s) spread over the open cells within a radius
 *  - boundaries:  per map edge: closed / open / fixed water surface elevation; rising-water
 *                 events override an edge while they run, then it reverts to the configured one
 */
import type { BoundarySide, TerrainData, WaterBoundarySpec, WaterSettings } from '@/core/model';
import { BOUNDARY_SIDES } from '@/core/model';
import type { CircleArea } from '@/events/specs';
import type { WaterField } from './WaterField';

export type ResolvedBoundaryType = 'closed' | 'open' | 'fixedLevel';

export interface ResolvedBoundary {
  type: ResolvedBoundaryType;
  /** Water surface elevation (fixedLevel only), m. */
  level: number;
}

export interface RainForcing {
  id: string;
  /** m/s */
  rate: number;
  area: CircleArea | null;
  /** Cells inside the area (null = whole map). */
  cells: Int32Array | null;
}

export interface SourceForcing {
  id: string;
  /** m³/s */
  rate: number;
  /** Receiving open cells. */
  cells: Int32Array;
}

/** Lowest and highest bed elevation along an edge of the grid. */
export function edgeBedRange(t: TerrainData, side: BoundarySide): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  const n = side === 'N' || side === 'S' ? t.nx : t.nz;
  for (let k = 0; k < n; k++) {
    const ix = side === 'W' ? 0 : side === 'E' ? t.nx - 1 : k;
    const iz = side === 'N' ? 0 : side === 'S' ? t.nz - 1 : k;
    const h = t.heights[iz * t.nx + ix];
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  return [lo, hi];
}

/**
 * Configured boundary → effective type. `auto`: fixed at the reference water level when the
 * reference level is set and part of the edge lies below it (the sea / a river reaching the
 * edge), otherwise open (the terrain continues beyond the map).
 */
export function resolveBoundary(spec: WaterBoundarySpec, side: BoundarySide, t: TerrainData): ResolvedBoundary {
  const ref = t.settings.waterLevel;
  switch (spec.type) {
    case 'closed':
      return { type: 'closed', level: 0 };
    case 'open':
      return { type: 'open', level: 0 };
    case 'fixedLevel':
      return { type: 'fixedLevel', level: spec.level ?? ref ?? 0 };
    case 'auto': {
      if (ref !== null && edgeBedRange(t, side)[0] < ref) return { type: 'fixedLevel', level: ref };
      return { type: 'open', level: 0 };
    }
  }
}

export class WaterForcing {
  readonly rains: RainForcing[] = [];
  readonly sources: SourceForcing[] = [];
  /** Configured boundaries (resolved). */
  readonly base: Record<BoundarySide, ResolvedBoundary>;
  /**
   * Multi-hazard interactions (Phase 15), set by the WaterSolverSystem before each call:
   *  - windStress: kinematic surface stress τ/ρ_w (m²/s², world x / z) from the wind
   *  - groundDv:   change of the ground velocity over the call (m/s, world x / z) — in the
   *                ground's frame the water receives the opposite momentum (sloshing / seiche)
   * Both are exactly zero without wind / earthquake or with interactions off.
   */
  readonly windStress: [number, number] = [0, 0];
  readonly groundDv: [number, number] = [0, 0];
  /**
   * Air-pressure waves (Phase 24, interactions): ∫p dt (Pa·s) at each cell since the last solver
   * call, written by the BlastSystem with exact step integrals. The solver turns its gradient into
   * momentum (−h·∇∫p dt / ρ_w over the call) and clears it. Null until a wave crosses water.
   */
  airImpulse: Float64Array | null = null;
  /** Whether airImpulse holds anything to apply. */
  airPending = false;

  ensureAirImpulse(n: number): Float64Array {
    this.airPending = true;
    return (this.airImpulse ??= new Float64Array(n));
  }
  /** Event overrides (rising water). */
  readonly override: Partial<Record<BoundarySide, ResolvedBoundary & { owner: string }>> = {};

  constructor(settings: WaterSettings, terrain: TerrainData) {
    this.base = Object.fromEntries(BOUNDARY_SIDES.map((s) => [s, resolveBoundary(settings.boundaries[s], s, terrain)])) as Record<BoundarySide, ResolvedBoundary>;
  }

  boundary(side: BoundarySide): ResolvedBoundary {
    return this.override[side] ?? this.base[side];
  }

  /** Total rainfall rate at the map center region (mm/h) — informational (HUD, visuals). */
  rainIntensity(): number {
    let r = 0;
    for (const f of this.rains) r += f.rate * 3.6e6;
    return r;
  }

  addRain(field: WaterField | null, id: string, rateMs: number, area: CircleArea | null) {
    let cells: Int32Array | null = null;
    if (area && field) {
      const list: number[] = [];
      const r2 = area.radius * area.radius;
      for (let iz = 0; iz < field.nz; iz++) {
        const dz = field.cellZ(iz) - area.center[1];
        if (dz * dz > r2) continue;
        for (let ix = 0; ix < field.nx; ix++) {
          const dx = field.cellX(ix) - area.center[0];
          if (dx * dx + dz * dz <= r2) list.push(iz * field.nx + ix);
        }
      }
      cells = Int32Array.from(list);
    }
    this.rains.push({ id, rate: rateMs, area, cells });
  }

  removeRain(id: string) {
    const i = this.rains.findIndex((r) => r.id === id);
    if (i >= 0) this.rains.splice(i, 1);
  }

  addSource(field: WaterField, id: string, rate: number, position: [number, number], radius: number) {
    const list: number[] = [];
    const r2 = radius * radius;
    for (let iz = 0; iz < field.nz; iz++) {
      const dz = field.cellZ(iz) - position[1];
      if (dz * dz > r2) continue;
      for (let ix = 0; ix < field.nx; ix++) {
        const dx = field.cellX(ix) - position[0];
        const i = iz * field.nx + ix;
        if (dx * dx + dz * dz <= r2 && !field.blocked[i]) list.push(i);
      }
    }
    if (!list.length) {
      // Inside a building or off the map: the nearest open cell takes it.
      const ix = Math.min(field.nx - 1, Math.max(0, Math.floor((position[0] - field.originX) / field.cell)));
      const iz = Math.min(field.nz - 1, Math.max(0, Math.floor((position[1] - field.originZ) / field.cell)));
      const i = iz * field.nx + ix;
      list.push(field.blocked[i] ? field.redirect[i] : i);
    }
    this.sources.push({ id, rate, cells: Int32Array.from(list) });
  }

  setSourceRate(id: string, rate: number) {
    const s = this.sources.find((x) => x.id === id);
    if (s) s.rate = rate;
  }

  removeSource(id: string) {
    const i = this.sources.findIndex((r) => r.id === id);
    if (i >= 0) this.sources.splice(i, 1);
  }

  setBoundaryLevel(side: BoundarySide, owner: string, level: number) {
    this.override[side] = { type: 'fixedLevel', level, owner };
  }

  clearBoundary(side: BoundarySide, owner: string) {
    if (this.override[side]?.owner === owner) delete this.override[side];
  }

  /** Anything feeding water in right now? */
  active(): boolean {
    if (this.rains.length || this.sources.length) return true;
    for (const s of BOUNDARY_SIDES) if (this.boundary(s).type === 'fixedLevel') return true;
    return false;
  }
}
