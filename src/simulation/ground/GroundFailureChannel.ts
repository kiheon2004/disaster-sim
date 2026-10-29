/**
 * The ground-failure channel (Phase 22): what sinkhole and landslide events write. It holds the
 * shared geotechnical field of the run (created on the first ground-failure event — runs without
 * one pay nothing) and registers ONE non-separable DeformationSource with the Phase 21 engine,
 * so terrain, collider, water bed, foundations, roads and renderers follow the field through the
 * same atomic update path as every other deformation.
 */
import type { TerrainData } from '@/core/model';
import type { DeformationSource } from '@/deformation/types';
import type { DeformationChannel } from '../deformation/DeformationChannel';
import { GeoField } from '@/ground/GeoField';
import type { SinkholeModel } from '@/ground/sinkhole';
import type { LandslideModel } from '@/ground/landslide';

/**
 * The field's contribution to the terrain, G = bed + h, over the whole grid. Its version is the
 * field revision (changes only when sediment moved or ground failed).
 */
export class GroundFailureSource implements DeformationSource {
  readonly id = 'src:groundFailure';
  readonly phenomenon = 'groundFailure';
  readonly kind = 'groundFailure';
  readonly model = 'physics' as const;
  readonly startTime = 0;
  readonly duration = Infinity;
  readonly rect: { x0: number; z0: number; x1: number; z1: number };
  /** G as last handed to the engine (the terrain = everything else + this). */
  readonly applied: Float32Array;

  constructor(readonly field: GeoField, private readonly channel: GroundFailureChannel) {
    this.rect = { x0: 0, z0: 0, x1: field.nx - 1, z1: field.nz - 1 };
    this.applied = new Float32Array(field.n);
  }

  version() {
    return this.field.rev;
  }

  sample(_tau: number, out: Float32Array) {
    const { bed, h } = this.field;
    for (let i = 0; i < out.length; i++) out[i] = bed[i] + h[i];
    this.applied.set(out);
  }

  /** Displacement of the ground-failure field at a point (nearest vertex). */
  valueAt(x: number, z: number) {
    const i = this.field.index(x, z);
    return i < 0 ? 0 : this.field.bed[i] + this.field.h[i];
  }

  /** Deposits and moving sediment at a point (bilinear over the vertices). */
  overburdenAt(x: number, z: number) {
    const f = this.field;
    const gx = (x - f.originX) / f.dx, gz = (z - f.originZ) / f.dx;
    if (gx < 0 || gz < 0 || gx > f.nx - 1 || gz > f.nz - 1) return 0;
    const ix = Math.min(f.nx - 2, Math.floor(gx)), iz = Math.min(f.nz - 2, Math.floor(gz));
    const ax = gx - ix, az = gz - iz, i = iz * f.nx + ix;
    const v = (k: number) => f.loose[k] + f.h[k];
    return (v(i) * (1 - ax) + v(i + 1) * ax) * (1 - az) + (v(i + f.nx) * (1 - ax) + v(i + f.nx + 1) * ax) * az;
  }

  support(x: number, z: number) {
    let s = 1;
    for (const m of this.channel.sinkholes) s *= m.support(x, z);
    return s;
  }

  netVolume() {
    const { bed, h, dx } = this.field;
    let v = 0;
    for (let i = 0; i < bed.length; i++) v += bed[i] + h[i];
    return v * dx * dx;
  }
}

export interface GroundFailureStats {
  updates: number;
  /** Last update split (ms) and totals. */
  stabilityMs: number;
  sinkholeMs: number;
  flowMs: number;
  newmarkMs: number;
  objectsMs: number;
  totalMs: number;
  flowSubsteps: number;
  maxSpeed: number;
  flowCells: number;
}

export class GroundFailureChannel {
  field: GeoField | null = null;
  source: GroundFailureSource | null = null;
  readonly sinkholes: SinkholeModel[] = [];
  readonly landslides: LandslideModel[] = [];
  stats: GroundFailureStats = { updates: 0, stabilityMs: 0, sinkholeMs: 0, flowMs: 0, newmarkMs: 0, objectsMs: 0, totalMs: 0, flowSubsteps: 0, maxSpeed: 0, flowCells: 0 };
  /** Runout boundary (open if any landslide asks for it). */
  boundary: 'closed' | 'open' = 'closed';
  /** Voellmy ξ of the run (the smallest asked for: the most resistive). */
  turbulence = Infinity;
  /** A model was added since the last update (evaluate in the step it starts). */
  urgent = false;

  constructor(readonly terrain: TerrainData, readonly deformation: DeformationChannel) {}

  ensure(): GeoField {
    if (!this.field) {
      this.field = new GeoField(this.terrain);
      this.source = new GroundFailureSource(this.field, this);
      this.deformation.ensure().add(this.source);
    }
    return this.field;
  }

  get active(): boolean {
    return this.field !== null;
  }

  /** Phenomenon index → its model (owner ids of the field). */
  modelOf(owner: number): SinkholeModel | LandslideModel | null {
    return [...this.sinkholes, ...this.landslides].find((m) => m.index === owner) ?? null;
  }

  nextIndex(): number {
    return this.sinkholes.length + this.landslides.length;
  }
}
