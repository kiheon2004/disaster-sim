/**
 * Phase 35: runtime state of a vehicle-mode car (`e.vehicle`) and of the run (`runtime.vehicles`). Built from the settings at
 * load; never part of the WorldDocument (reset rebuilds it).
 */
import type { Vec3 } from '@/core/types';
import { vehicleGeometry, type VehicleGeometry } from '@/vehicle/geometry';
import { newVehicleState, type VehicleDynState } from '@/vehicle/dynamics';
import { neutralControls, type Controls } from '@/vehicle/powertrain';
import type { Drive, Variant } from '@/vehicle/params';
import { DEFAULT_SUBSTEPS, type Autopilot, type ControlInput, type ControlKey, type Occupant, type VehicleCar, type VehicleSettings } from '@/vehicle/settings';
import type { TireModel } from '@/vehicle/tire';

export const VEHICLE_DAMAGE = ['intact', 'damaged', 'severelyDamaged', 'disabled', 'destroyed'] as const;
export type VehicleDamageLevel = (typeof VEHICLE_DAMAGE)[number];
export const ROLLOVER = ['upright', 'twoWheels', 'onSide', 'onRoof'] as const;
export type RolloverState = (typeof ROLLOVER)[number];
export const OCCUPANT_STATES = ['outside', 'seated', 'ejected'] as const;

/** One collision episode with a partner (contiguous contact steps). */
export interface CollisionEpisode {
  partner: string;
  partnerKind: 'ground' | 'vehicle' | 'human' | 'structure' | 'object' | 'debris';
  start: number;
  end: number;
  /** Σ solver impulse (N·s, world vector on this vehicle), peak step-mean contact force (N), impulse-weighted contact point. */
  impulse: Vec3;
  peakForce: number;
  point: Vec3;
  /** Body velocity before (the step before the first contact) and after (the step after the last), m/s; closing speed. */
  vBefore: Vec3;
  vAfter: Vec3;
  dv: number;
  closing: number;
  /** Kinetic energy of this body before / after (J, translation + rotation). */
  keBefore: number;
  keAfter: number;
  open: boolean;
  steps: number;
  recorded: boolean;
}

export interface OccupantState extends Occupant {
  state: (typeof OCCUPANT_STATES)[number];
  /** Peak occupant load index of the reduced model (Level A): Δv-based, peak acceleration (m/s²) of the seat over the run. */
  peakDv: number;
  peakAccel: number;
  ejectedAt: number | null;
}

export interface VehicleSeries { dt: number; t: number[]; v: Record<string, number[]> }
export const VEHICLE_SERIES_KEYS = ['speed', 'accelLong', 'accelLat', 'yawRate', 'roll', 'pitch', 'wheelSpeed', 'slip', 'load', 'drive', 'brake', 'damage', 'energy'] as const;
export const VEHICLE_SERIES_CARS = 16;
export const VEHICLE_SERIES_MAX = 4000;

export interface VehicleEntity {
  geo: VehicleGeometry;
  level: 'vehicle' | 'rigid';
  variant: Variant;
  drive: Drive;
  abs: boolean;
  model: TireModel;
  substeps: number;
  dyn: VehicleDynState;
  /** Effective inputs of the last step, the constant / program / autopilot sources, a live override (keyboard / UI). */
  controls: Controls;
  base: ControlInput;
  program: ControlKey[];
  programIdx: number;
  autopilot: (Autopilot & { target: number; done: boolean; obstacle: number | null }) | null;
  live: ControlInput | null;
  /** What limits the controls: the vehicle's damage and its driver. */
  avail: { drive: number; steer: number; brake: number; driver: number; driverCause: string | null };
  damage: { index: number; level: VehicleDamageLevel; peakDv: number };
  rollover: RolloverState;
  /** Candidate rollover state and how long it has held (s). */
  rollCand: RolloverState;
  rollTime: number;
  /** Lateral load-transfer ratio (|F_left − F_right| / ΣF, 1 = one side unloaded), its peak. */
  ltr: number;
  peakLtr: number;
  occupants: OccupantState[];
  episodes: CollisionEpisode[];
  open: Map<string, CollisionEpisode>;
  /** Body state at the start of the step (velocity, angular velocity) for Δv, accelerations (m/s², body axes). */
  prevV: Vec3;
  prevW: Vec3;
  accel: Vec3;
  /** Mechanical energy ledger (J): kinetic + potential at the start, now; external work integrated; residual. */
  energy: { E0: number; E: number; ke: number; pe: number; residual: number; collision: number };
  series: VehicleSeries | null;
  frozen: boolean;
  /** Engine stopped by water in the intake (stays stopped for the run). */
  stalled: boolean;
  /** Time afloat (s): buoyancy carrying the weight with no wheel on the ground. */
  floatTime: number;
}

export interface VehicleRuntime {
  settings: VehicleSettings;
  /** Cars by id in a deterministic (sorted id) order. */
  order: string[];
}

export function createVehicleEntity(objectId: string, variant: Variant, dims: { length: number; width: number; height: number }, mass: number, s: VehicleSettings, withSeries: boolean): VehicleEntity {
  const car: VehicleCar = s.cars?.[objectId] ?? {};
  const geo = vehicleGeometry({ variant, ...dims }, mass);
  const parked = !car.controls && !car.program && !car.autopilot;
  return {
    geo,
    level: car.level ?? 'vehicle',
    variant,
    drive: car.drive ?? geo.spec.drive,
    abs: car.abs ?? s.abs ?? true,
    model: s.tire ?? 'saturating',
    substeps: s.substeps ?? DEFAULT_SUBSTEPS,
    dyn: newVehicleState(),
    controls: neutralControls(),
    base: parked ? { gear: 'P', handbrake: true } : { ...(car.controls ?? {}) },
    program: car.program ? [...car.program] : [],
    programIdx: 0,
    autopilot: car.autopilot ? { ...car.autopilot, target: 0, done: false, obstacle: null } : null,
    live: null,
    avail: { drive: 1, steer: 1, brake: 1, driver: 1, driverCause: null },
    damage: { index: 0, level: 'intact', peakDv: 0 },
    rollover: 'upright',
    rollCand: 'upright',
    rollTime: 0,
    ltr: 0,
    peakLtr: 0,
    occupants: (car.occupants ?? []).map((o) => ({ ...o, state: 'seated' as const, peakDv: 0, peakAccel: 0, ejectedAt: null })),
    episodes: [],
    open: new Map(),
    prevV: [0, 0, 0],
    prevW: [0, 0, 0],
    accel: [0, 0, 0],
    energy: { E0: NaN, E: NaN, ke: 0, pe: 0, residual: 0, collision: 0 },
    series: withSeries ? { dt: 0.25, t: [], v: Object.fromEntries(VEHICLE_SERIES_KEYS.map((k) => [k, []])) } : null,
    frozen: false,
    stalled: false,
    floatTime: 0,
  };
}
