/**
 * Terrain deformation (Phase 21) — data model. SI units: m, s.
 *
 * A deformation is a PRESCRIBED vertical displacement field w(x, z, t) of the ground surface:
 *
 *     w(x, z, t) = A · S(x, z) · f(t − t₀)          (separable sources, this phase)
 *
 *   A  signed amplitude (m): down for subsidence / depression / settlement, up for uplift / ridge
 *   S  spatial shape in [0, 1] (compact support: exactly 0 outside its region)
 *   f  time profile in [0, 1] (instant, linear, smooth, staged, cyclic)
 *
 * It is a KINEMATIC input (a boundary condition imposed on the world), not a model of why the
 * ground moves — no cavity collapse, slope failure or impact is computed here. Phase 22–23
 * phenomena compute their own fields and feed them through the same `DeformationSource` contract.
 *
 * Displacement and ground support are separate quantities: lowering the ground does NOT reduce
 * its bearing capacity by itself. A support change is only applied when a source states one
 * explicitly (`supportLoss`), and it is reported as such.
 */
import type { GridRect } from '@/terrain/TerrainData';

export type DeformationKind = 'subsidence' | 'uplift' | 'depression' | 'settlement' | 'ridge' | 'prescribed';
export const DEFORMATION_KINDS: readonly DeformationKind[] = ['subsidence', 'uplift', 'depression', 'settlement', 'ridge', 'prescribed'];

/** Direction of the displacement each kind produces (prescribed fields carry their own sign). */
export const KIND_SIGN: Record<DeformationKind, -1 | 1> = { subsidence: -1, uplift: 1, depression: -1, settlement: -1, ridge: 1, prescribed: 1 };

export type TimeProfile = 'instant' | 'linear' | 'smooth' | 'staged' | 'cyclic';
export const TIME_PROFILES: readonly TimeProfile[] = ['instant', 'linear', 'smooth', 'staged', 'cyclic'];

/** Radial falloff of bowl-like shapes. */
export type Falloff = 'smooth' | 'linear' | 'steep';
export const FALLOFFS: readonly Falloff[] = ['smooth', 'linear', 'steep'];

/** A displacement grid given by the user (or computed elsewhere), world-aligned. */
export interface PrescribedField {
  /** World position of value (0, 0), spacing (m), counts. */
  x0: number;
  z0: number;
  cell: number;
  nx: number;
  nz: number;
  /** Row-major (iz·nx + ix) vertical displacement (m, + up) at the final state. */
  values: number[];
}

/** The phenomenon spec (EventSpec member, saved in the experiment plan). */
export interface TerrainDeformationSpec {
  event: 'terrainDeformation';
  kind: DeformationKind;
  /** Centre (m, world x / z). Ridges: their midpoint. */
  center: [number, number];
  /** Radius of the affected area (m). Ridges: half width. */
  radius: number;
  /** Peak displacement magnitude (m, ≥ 0); the direction comes from the kind. */
  amount: number;
  /** Seconds from start to the final state (instant: ignored). */
  duration: number;
  profile: TimeProfile;
  /** Staged profile: number of equal steps. */
  stages?: number;
  /** Cyclic profile: period (s). */
  period?: number;
  falloff?: Falloff;
  /** Ridge: length (m) and bearing of its axis (deg, 0 = north, 90 = east). */
  length?: number;
  bearing?: number;
  /** Distributed settlement: relative spatial variability 0–1 of a seeded smooth field. */
  variability?: number;
  /** Seed of the variability field (default: the project seed). */
  seed?: number;
  /**
   * Explicit ground support loss at the centre (0 = none … 0.9): a multiplier (1 − loss·S·f) on
   * the bearing capacity under foundations. Independent of the displacement (see header).
   */
  supportLoss?: number;
  /** Prescribed kind: the field. */
  field?: PrescribedField;
  /** Absolute simulation time to start at (default: now). */
  startTime?: number;
  /** Display name of the source (the experiment instance id, e.g. "p1"; set by the schedule). */
  name?: string;
}

/** Model classification shown with every deformation. */
export type ModelClass = 'prescribed' | 'physics' | 'empirical';

/**
 * A source of terrain displacement in a running simulation (Phase 21 prescribed sources;
 * Phase 22 sinkhole / landslide and Phase 23 craters implement the same contract).
 */
export interface DeformationSource {
  readonly id: string;
  /** Phenomenon id (instance / event id) it belongs to. */
  readonly phenomenon: string;
  readonly kind: string;
  readonly model: ModelClass;
  readonly startTime: number;
  /** Seconds until its final state (it keeps that state afterwards: deformations persist). */
  readonly duration: number;
  /** Vertex rectangle of the runtime grid it can change (never written outside). */
  readonly rect: GridRect;
  /**
   * A number that changes whenever the contribution changes (the time factor for separable
   * sources). The engine re-samples a source only when its version differs from the last one.
   */
  version(localTime: number): number;
  /** Displacement contribution (m) over `rect` (row-major, rect-sized) at a local time. */
  sample(localTime: number, out: Float32Array): void;
  /** Ground support multiplier (0–1] at a point and local time (1 = unchanged). */
  support?(x: number, z: number, localTime: number): number;
  /**
   * Net volume added to the terrain (m³) at a local time — 0 for mass-conserving sources
   * (Phase 22 landslides move material); informational for prescribed fields.
   */
  netVolume?(localTime: number): number;
  /**
   * Part of the contribution at a point that is loose material lying ON the ground (deposits,
   * moving sediment) rather than a movement of the ground itself (Phase 22). Foundations follow
   * the ground without it; burial and lateral loads come from it.
   */
  overburdenAt?(x: number, z: number): number;
  /** Contribution at a point now (inspector; non-separable sources, Phase 22). */
  valueAt?(x: number, z: number, localTime: number): number;
  /**
   * Sub-rectangle of `rect` where the contribution may have changed since the last `sample`
   * (null = nowhere). Sources covering a large rect but changing locally (Phase 22's ground-
   * failure field covers the whole grid) let the engine diff, write and report only that part.
   * `sample` must still fill the whole rect.
   */
  changedRect?(): GridRect | null;
}
