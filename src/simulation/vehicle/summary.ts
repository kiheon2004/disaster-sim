/**
 * Phase 35: read-only summaries of the vehicle model for the UI (inspector, results panel, overlay, CSV / JSON export) and the
 * devtools. Pure functions over runtime entities, damage events and (optionally) the physics engine's body velocities — they
 * never write simulation state.
 *
 * Velocities: with a physics engine the row reads the body's current linear / angular velocity; without one it falls back to
 * the velocity the vehicle system read at the start of the last step (≤ one step old) for a wheeled ('vehicle') car, and to
 * "not computed" for a rigid (Level 1) car, whose velocity the vehicle system never reads.
 *
 * A value the model did not compute (a rigid car has no wheels, a wheel off the ground has no slip, the energy ledger before
 * its first step, …) is `null` here, an empty CSV cell, `null` in JSON and a gap (NaN) in a series — never 0.
 */
import type { Vec3 } from '@/core/types';
import type { PhysicsEngine } from '@/physics/PhysicsEngine';
import type { RuntimeEntity } from '../SimulationRuntime';
import type { DamageEventRecord } from '../analysis/DamageEvent';
import { rotate, type Quat } from '@/vehicle/dynamics';
import { PARAMS, TIRE, VARIANTS, type Variant } from '@/vehicle/params';
import { DAMAGE_DV, DAMAGE_REF_DV, EPISODE_GAP_STEPS, EPISODE_MAX_STEPS } from './collisions';
import { ROLLOVER, VEHICLE_DAMAGE, VEHICLE_SERIES_KEYS, type RolloverState, type VehicleDamageLevel, type VehicleEntity, type VehicleRuntime } from './state';

/** Version of the vehicle export rows (CSV header comment, JSON field). Bump on a column / field change. */
export const VEHICLE_EXPORT_SCHEMA = 1;
/** Version of the vehicle model the rows were produced with. */
export const VEHICLE_MODEL_VERSION = 'vehicle-dynamics-1';
export const VEHICLE_NOTE = 'educational vehicle-dynamics model (levels A/B/C) — not a validated vehicle simulation, no crash-test data';
/** Documented limits (exported with every CSV / JSON). */
export const VEHICLE_LIMITS = [
  'educational model: generic per-variant parameters, not the data of any real vehicle',
  'no crash-test data: the damage index is a Δv-based educational proxy (levels at 3 / 7 / 12 / 20 m/s), not deformation',
  'wheels are ray casts from the strut mounts (one contact point per wheel, no tyre width, no curb climbing by the tyre shape)',
  'kinetic energy lost in a collision is not all deformation (partner, ground, rotation, friction, solver dissipation)',
  'occupants: reduced Level A only (seat Δv / peak acceleration; restrained / unrestrained, ejection by an assumed rule) — no injury prediction',
  'no fuel, battery, engine heat or clutch heat is modelled',
] as const;
export const VEHICLE_LEVEL_LEGEND = { A: 'conservation law / rigid-body mechanics', B: 'textbook vehicle-dynamics model or measured order of magnitude', C: 'explicit educational assumption' } as const;

export type VehicleCarEntity = RuntimeEntity & { vehicle: VehicleEntity };

/** Cars of a run with the vehicle state, in entity order. */
export function vehicleEntities(entities: Iterable<RuntimeEntity>): VehicleCarEntity[] {
  const out: VehicleCarEntity[] = [];
  for (const e of entities) if (e.vehicle) out.push(e as VehicleCarEntity);
  return out;
}

/** Where the effective inputs of a car come from (constant → program → autopilot; live input wins over all). */
export type ControlSource = 'parked' | 'constant' | 'program' | 'autopilot' | 'live';
export function controlSource(v: VehicleEntity): ControlSource {
  if (v.live) return 'live';
  if (v.autopilot && !v.autopilot.done) return 'autopilot';
  if (v.program.length) return 'program';
  return v.base.gear === 'P' && v.base.handbrake && v.base.throttle === undefined ? 'parked' : 'constant';
}

export interface WheelRow {
  /** FL, FR, RL, RR. */
  wheel: string;
  contact: boolean;
  /** Normal load (N), tyre forces in the wheel frame (N, x forward / y left), strut force (N). */
  Fz: number;
  Fx: number;
  Fy: number;
  Fs: number;
  /** Longitudinal slip (1), slip angle (rad): null while the wheel is off the ground. */
  kappa: number | null;
  alpha: number | null;
  /** Suspension compression (m), rate (m/s), spin (rad/s), road-wheel steer angle (rad). */
  compression: number;
  rate: number;
  omega: number;
  steer: number;
  driveT: number;
  brakeT: number;
  sliding: boolean;
  locked: boolean;
  abs: boolean;
  point: Vec3 | null;
}

export const WHEEL_NAMES = ['FL', 'FR', 'RL', 'RR'] as const;

/** One car's vehicle summary (inspector, results table, export). null = not computed. */
export interface VehicleRow {
  id: string;
  variant: Variant;
  level: 'vehicle' | 'rigid';
  drive: string;
  tire: string;
  abs: boolean;
  frozen: boolean;
  mass: number;
  /** COM (local, m), its height, static front axle share, wheelbase / track (m), principal inertia (kg·m²). */
  com: Vec3;
  hcg: number;
  frontShare: number;
  wheelbase: number;
  track: number;
  inertia: Vec3;
  position: Vec3;
  /** Forward speed (m/s, body x), speed magnitude, accelerations in body axes (m/s²), yaw rate (rad/s, about body up), roll / pitch (rad). */
  speed: number | null;
  speedAbs: number | null;
  accelLong: number | null;
  accelLat: number | null;
  accelVert: number | null;
  yawRate: number | null;
  roll: number;
  pitch: number;
  /** Effective inputs of the last step and their source. */
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
  gearSelector: string;
  controlSource: ControlSource;
  /** Powertrain (wheeled cars): gear number (1-based), engine speed (rpm), engine torque (N·m), steering angle (rad). */
  gear: number | null;
  engineRpm: number | null;
  engineTorque: number | null;
  steerAngle: number | null;
  driveTorque: number | null;
  brakeTorque: number | null;
  wheels: WheelRow[] | null;
  touching: number | null;
  airborne: boolean | null;
  damageIndex: number;
  damageLevel: VehicleDamageLevel;
  peakDv: number;
  rollover: RolloverState;
  /** Lateral load-transfer ratio now / peak (wheeled cars only). */
  ltr: number | null;
  peakLtr: number | null;
  availDrive: number;
  availSteer: number;
  availBrake: number;
  availDriver: number;
  driverCause: string | null;
  stalled: boolean;
  occupantsSeated: number;
  occupantsEjected: number;
  collisions: number;
  /** Mechanical energy (J): kinetic (incl. wheel spin), potential, spring, total now / at the start, residual of the ledger. */
  ke: number | null;
  pe: number | null;
  spring: number | null;
  E: number | null;
  E0: number | null;
  residual: number | null;
  /** Ledger (J, integrated): drive work at the wheels, brake, rolling, tyre slip, damper, aero, collision KE loss. */
  ledgerDrive: number | null;
  ledgerBrake: number | null;
  ledgerRolling: number | null;
  ledgerSlip: number | null;
  ledgerDamper: number | null;
  ledgerAero: number | null;
  ledgerCollision: number | null;
  autopilot: { active: boolean; done: boolean; target: number; points: number; speed: number; obstacle: number | null } | null;
}

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const fin = (v: number | null | undefined): number | null => (v === null || v === undefined || !Number.isFinite(v) ? null : v);
const vec = (v: readonly number[]): Vec3 => [v[0], v[1], v[2]];

/** Current body velocity / angular velocity (null when it cannot be read: no physics engine for a rigid car, no body). */
export function bodyVelocity(e: VehicleCarEntity, physics?: PhysicsEngine | null): { v: Vec3; w: Vec3 } | null {
  if (physics && e.body !== null && physics.hasBody(e.body)) return { v: physics.getLinearVelocity(e.body), w: physics.getAngularVelocity(e.body) };
  if (e.vehicle.level === 'vehicle' && e.body !== null && !e.vehicle.frozen) return { v: e.vehicle.prevV, w: e.vehicle.prevW };
  return null;
}

export function vehicleRow(e: VehicleCarEntity, physics?: PhysicsEngine | null): VehicleRow {
  const v = e.vehicle, g = v.geo, wheeled = v.level === 'vehicle';
  const q = e.pose.quaternion as unknown as Quat;
  const x = rotate(q, [1, 0, 0]), y = rotate(q, [0, 1, 0]), z = rotate(q, [0, 0, 1]);
  const kin = bodyVelocity(e, physics);
  const W = v.dyn.wheels;
  const started = Number.isFinite(v.energy.E0);
  const L = v.dyn.ledger;
  const c = v.controls;
  return {
    id: e.id, variant: v.variant, level: v.level, drive: v.drive, tire: v.model, abs: v.abs, frozen: v.frozen,
    mass: g.mass, com: vec(g.com), hcg: g.hcg, frontShare: g.frontShare, wheelbase: g.wheelbase, track: g.track, inertia: vec(g.inertiaDiag),
    position: vec(e.pose.position),
    speed: kin ? dot(kin.v, x) : null,
    speedAbs: kin ? Math.hypot(kin.v[0], kin.v[1], kin.v[2]) : null,
    // Accelerations come from the monitor's velocity difference over the step (wheeled cars; the rigid car's reference velocity is not read).
    accelLong: wheeled && started ? fin(v.accel[0]) : null,
    accelLat: wheeled && started ? fin(v.accel[2]) : null,
    accelVert: wheeled && started ? fin(v.accel[1]) : null,
    yawRate: kin ? dot(kin.w, y) : null,
    roll: Math.asin(Math.max(-1, Math.min(1, z[1]))),
    pitch: Math.asin(Math.max(-1, Math.min(1, x[1]))),
    throttle: c.throttle, brake: c.brake, steer: c.steer, handbrake: c.handbrake, gearSelector: c.gear, controlSource: controlSource(v),
    gear: wheeled ? v.dyn.pt.gear + 1 : null,
    engineRpm: wheeled ? (v.dyn.pt.omegaE * 60) / (2 * Math.PI) : null,
    engineTorque: wheeled ? v.dyn.pt.torqueE : null,
    steerAngle: wheeled ? v.dyn.pt.delta : null,
    driveTorque: wheeled ? W.reduce((a, b) => a + b.driveT, 0) : null,
    brakeTorque: wheeled ? W.reduce((a, b) => a + b.brakeT, 0) : null,
    wheels: wheeled ? W.map((w, i) => ({
      wheel: WHEEL_NAMES[i], contact: w.contact, Fz: w.Fz, Fx: w.Fx, Fy: w.Fy, Fs: w.Fs,
      kappa: w.contact ? w.kappa : null, alpha: w.contact ? w.alpha : null,
      compression: w.compression, rate: w.rate, omega: w.omega, steer: w.steer, driveT: w.driveT, brakeT: w.brakeT,
      sliding: w.contact && w.sliding, locked: w.locked, abs: v.dyn.abs[i], point: w.contact ? vec(w.point) : null,
    })) : null,
    touching: wheeled ? v.dyn.touching : null,
    airborne: wheeled ? v.dyn.airborne : null,
    damageIndex: v.damage.index, damageLevel: v.damage.level, peakDv: v.damage.peakDv, rollover: v.rollover,
    ltr: wheeled && started ? v.ltr : null,
    peakLtr: wheeled && started ? v.peakLtr : null,
    availDrive: v.avail.drive, availSteer: v.avail.steer, availBrake: v.avail.brake, availDriver: v.avail.driver, driverCause: v.avail.driverCause,
    stalled: v.stalled,
    occupantsSeated: v.occupants.filter((o) => o.state === 'seated').length,
    occupantsEjected: v.occupants.filter((o) => o.state === 'ejected').length,
    collisions: v.episodes.filter((ep) => ep.recorded).length,
    ke: started ? v.energy.ke : null,
    pe: started ? v.energy.pe : null,
    spring: started && wheeled ? v.dyn.springEnergy : null,
    E: started ? fin(v.energy.E) : null,
    E0: started ? v.energy.E0 : null,
    residual: started ? fin(v.energy.residual) : null,
    ledgerDrive: started && wheeled ? L.drive : null,
    ledgerBrake: started && wheeled ? L.brake : null,
    ledgerRolling: started && wheeled ? L.rolling : null,
    ledgerSlip: started && wheeled ? L.slip : null,
    ledgerDamper: started && wheeled ? L.damper : null,
    ledgerAero: started && wheeled ? L.aero : null,
    ledgerCollision: started ? v.energy.collision : null,
    autopilot: v.autopilot ? { active: !v.autopilot.done, done: v.autopilot.done, target: v.autopilot.target, points: v.autopilot.path.length, speed: v.autopilot.speed, obstacle: v.autopilot.obstacle } : null,
  };
}

export interface VehicleAggregate {
  vehicles: number;
  wheeled: number;
  rigid: number;
  frozen: number;
  damage: Record<VehicleDamageLevel, number>;
  rollover: Record<RolloverState, number>;
  collisions: number;
  stalled: number;
  occupantsSeated: number;
  occupantsEjected: number;
  /** Largest current |speed| (m/s), largest episode Δv (m/s), peak LTR, largest |energy residual| (J); null = none computed. */
  maxSpeed: number | null;
  maxPeakDv: number | null;
  maxPeakLtr: number | null;
  maxResidual: number | null;
}

const counts = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
const mx = (a: number | null, b: number | null) => (b === null ? a : a === null ? b : Math.max(a, b));

export function aggregateVehicles(entities: Iterable<RuntimeEntity>, physics?: PhysicsEngine | null): VehicleAggregate {
  const a: VehicleAggregate = {
    vehicles: 0, wheeled: 0, rigid: 0, frozen: 0, damage: counts(VEHICLE_DAMAGE), rollover: counts(ROLLOVER), collisions: 0, stalled: 0,
    occupantsSeated: 0, occupantsEjected: 0, maxSpeed: null, maxPeakDv: null, maxPeakLtr: null, maxResidual: null,
  };
  for (const e of vehicleEntities(entities)) {
    const r = vehicleRow(e, physics);
    a.vehicles++;
    if (r.level === 'vehicle') a.wheeled++; else a.rigid++;
    if (r.frozen) a.frozen++;
    a.damage[r.damageLevel]++;
    a.rollover[r.rollover]++;
    a.collisions += r.collisions;
    if (r.stalled) a.stalled++;
    a.occupantsSeated += r.occupantsSeated;
    a.occupantsEjected += r.occupantsEjected;
    a.maxSpeed = mx(a.maxSpeed, r.speedAbs);
    a.maxPeakDv = mx(a.maxPeakDv, r.collisions || r.peakDv > 0 ? r.peakDv : null);
    a.maxPeakLtr = mx(a.maxPeakLtr, r.peakLtr);
    a.maxResidual = mx(a.maxResidual, r.residual === null ? null : Math.abs(r.residual));
  }
  return a;
}

/** Damage events of the vehicle model (detail block `vehicle`). */
export const vehicleEvents = (events: readonly DamageEventRecord[]) => events.filter((ev) => ev.vehicle !== undefined);

/** Units of the series keys (chart axes, export). */
export const VEHICLE_SERIES_UNITS: Record<(typeof VEHICLE_SERIES_KEYS)[number], string> = {
  speed: 'm/s (forward)', accelLong: 'm/s²', accelLat: 'm/s²', yawRate: 'rad/s', roll: 'rad', pitch: 'rad', wheelSpeed: 'm/s (mean R·ω)',
  slip: '1 (largest |κ|)', load: '1 (LTR)', drive: 'N·m (Σ wheels)', brake: 'N·m (Σ wheels)', damage: '1 (index 0–1)', energy: 'J (ledger residual)',
};

export const VEHICLE_UNITS = {
  time: 's', length: 'm', mass: 'kg', inertia: 'kg·m²', speed: 'm/s', acceleration: 'm/s² (body axes: x forward, y up, z right)', angle: 'rad',
  angularVelocity: 'rad/s', force: 'N', torque: 'N·m', engineSpeed: 'rpm', energy: 'J', impulse: 'N·s', slip: '1 (κ)', slipAngle: 'rad (α)',
  ltr: '1 (|F_left − F_right| / ΣF_z)', damageIndex: '1 (educational Δv proxy 0–1)', inputs: 'throttle / brake 0–1, steer −1 (right) … 1 (left)',
} as const;

/** Model notes (CSV header / JSON). */
export const VEHICLE_NOTES = {
  damage: `index = √(Σ Δv²) / ${DAMAGE_REF_DV} m/s, levels damaged / severely damaged / disabled / destroyed at Δv_eq ${DAMAGE_DV.join(' / ')} m/s (assumed)`,
  episodes: `collision episode = contiguous contact steps with one partner (gaps ≤ ${EPISODE_GAP_STEPS} steps, ≤ ${EPISODE_MAX_STEPS} steps); impulse J = Σ F̄ Δt from the solver`,
  energy: 'residual = E − E0 − (drive − brake − rolling − slip − damper − aero − collision); hazards and Rapier contacts other than collisions are inside the residual',
  velocity: 'speed / yaw rate from the physics body; accelerations from the velocity change over the last step',
} as const;

export const VEHICLE_CSV_COLUMNS = [
  'time_s', 'vehicle_id', 'model_version', 'variant', 'level', 'drive', 'tire_model', 'abs', 'frozen', 'mass_kg', 'com_x_m', 'com_y_m', 'com_z_m',
  'x_m', 'y_m', 'z_m', 'speed_ms', 'speed_abs_ms', 'accel_long_ms2', 'accel_lat_ms2', 'accel_vert_ms2', 'yaw_rate_rads', 'roll_rad', 'pitch_rad',
  'throttle', 'brake', 'steer', 'handbrake', 'gear_selector', 'control_source', 'gear', 'engine_rpm', 'engine_torque_Nm', 'steer_angle_rad',
  'drive_torque_Nm', 'brake_torque_Nm', 'wheels_touching', 'airborne', 'damage_index', 'damage_level', 'peak_dv_ms', 'rollover', 'ltr', 'peak_ltr',
  'avail_drive', 'avail_steer', 'avail_brake', 'avail_driver', 'driver_cause', 'stalled', 'occupants_seated', 'occupants_ejected', 'collisions',
  'ke_J', 'pe_J', 'spring_J', 'energy_J', 'energy0_J', 'residual_J', 'drive_work_J', 'brake_J', 'rolling_J', 'slip_J', 'damper_J', 'aero_J', 'collision_J',
] as const;
export const VEHICLE_WHEEL_COLUMNS = ['vehicle_id', 'wheel', 'contact', 'Fz_N', 'Fx_N', 'Fy_N', 'strut_N', 'kappa', 'alpha_rad', 'compression_m', 'rate_ms', 'omega_rads', 'steer_rad', 'drive_Nm', 'brake_Nm', 'sliding', 'locked', 'abs_active'] as const;
export const VEHICLE_EPISODE_COLUMNS = ['vehicle_id', 'partner', 'partner_kind', 'start_s', 'end_s', 'steps', 'recorded', 'impulse_Ns', 'impulse_x', 'impulse_y', 'impulse_z', 'peak_force_N', 'x_m', 'y_m', 'z_m', 'dv_ms', 'closing_ms', 'ke_before_J', 'ke_after_J'] as const;
export const VEHICLE_OCCUPANT_COLUMNS = ['vehicle_id', 'human_id', 'seat', 'restrained', 'state', 'peak_dv_ms', 'peak_accel_ms2', 'ejected_s'] as const;
export const VEHICLE_EVENT_COLUMNS = ['time_s', 'object_id', 'event', 'hazard', 'kind', 'partner', 'partner_kind', 'dv_ms', 'closing_ms', 'impulse_Ns', 'energy_J', 'level'] as const;

type Cell = string | number | boolean | null | undefined;
/** CSV cell: missing / non-finite = empty (never 0). */
export const csvCell = (v: Cell): string => {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return '';
  const s = typeof v === 'number' ? String(+v.toPrecision(6)) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function rowCells(time: number, r: VehicleRow): Cell[] {
  return [
    time.toFixed(3), r.id, VEHICLE_MODEL_VERSION, r.variant, r.level, r.drive, r.tire, r.abs, r.frozen, r.mass, r.com[0], r.com[1], r.com[2],
    r.position[0], r.position[1], r.position[2], r.speed, r.speedAbs, r.accelLong, r.accelLat, r.accelVert, r.yawRate, r.roll, r.pitch,
    r.throttle, r.brake, r.steer, r.handbrake, r.gearSelector, r.controlSource, r.gear, r.engineRpm, r.engineTorque, r.steerAngle,
    r.driveTorque, r.brakeTorque, r.touching, r.airborne, r.damageIndex, r.damageLevel, r.peakDv, r.rollover, r.ltr, r.peakLtr,
    r.availDrive, r.availSteer, r.availBrake, r.availDriver, r.driverCause, r.stalled, r.occupantsSeated, r.occupantsEjected, r.collisions,
    r.ke, r.pe, r.spring, r.E, r.E0, r.residual, r.ledgerDrive, r.ledgerBrake, r.ledgerRolling, r.ledgerSlip, r.ledgerDamper, r.ledgerAero, r.ledgerCollision,
  ];
}

/**
 * Vehicle rows of a run (CSV): schema / model / notes / units comment lines, the final state of every car, the wheels, the
 * collision episodes, the occupants, the vehicle events, then the series of the charted cars. Not computed = empty cell.
 */
export function vehicleCsv(entities: Iterable<RuntimeEntity>, events: readonly DamageEventRecord[], time: number, physics?: PhysicsEngine | null): string {
  const cars = vehicleEntities(entities);
  const lines: string[] = [
    `# schema: disaster-sim.vehicles v${VEHICLE_EXPORT_SCHEMA}`,
    `# model: ${VEHICLE_MODEL_VERSION} — ${VEHICLE_NOTE}`,
    `# units: ${Object.entries(VEHICLE_UNITS).map(([k, u]) => `${k} ${u}`).join('; ')}`,
    `# notes: ${Object.values(VEHICLE_NOTES).join(' | ')}`,
    `# limits: ${VEHICLE_LIMITS.join(' | ')}`,
    '# empty cell = not computed (rigid Level 1 car: no wheels / powertrain; wheel off the ground: no slip; before the first step: no energy)',
    VEHICLE_CSV_COLUMNS.join(','),
  ];
  const rows = cars.map((e) => vehicleRow(e, physics));
  for (const r of rows) lines.push(rowCells(time, r).map(csvCell).join(','));
  const wheeled = rows.filter((r) => r.wheels);
  if (wheeled.length) {
    lines.push('', '# wheels (final state; forces in the wheel frame: x along the wheel heading, y to its left)', VEHICLE_WHEEL_COLUMNS.join(','));
    for (const r of wheeled) for (const w of r.wheels!) {
      lines.push([r.id, w.wheel, w.contact, w.Fz, w.Fx, w.Fy, w.Fs, w.kappa, w.alpha, w.compression, w.rate, w.omega, w.steer, w.driveT, w.brakeT, w.sliding, w.locked, w.abs].map(csvCell).join(','));
    }
  }
  const eps = cars.flatMap((e) => [...e.vehicle.episodes, ...e.vehicle.open.values()].map((ep) => [e.id, ep] as const));
  if (eps.length) {
    lines.push('', `# collision episodes (${VEHICLE_NOTES.episodes}; recorded = counted as a collision; open = still in contact)`, VEHICLE_EPISODE_COLUMNS.join(','));
    for (const [id, ep] of eps) {
      lines.push([id, ep.partner, ep.partnerKind, ep.start, ep.end, ep.steps, ep.recorded, Math.hypot(...ep.impulse), ep.impulse[0], ep.impulse[1], ep.impulse[2], ep.peakForce,
        ep.point[0], ep.point[1], ep.point[2], ep.open ? null : ep.dv, ep.closing, ep.keBefore, ep.open ? null : ep.keAfter].map(csvCell).join(','));
    }
  }
  const occ = cars.flatMap((e) => e.vehicle.occupants.map((o) => [e.id, o] as const));
  if (occ.length) {
    lines.push('', '# occupants (reduced Level A: the seat follows the vehicle — Δv and peak acceleration of the seat; not an injury prediction)', VEHICLE_OCCUPANT_COLUMNS.join(','));
    for (const [id, o] of occ) lines.push([id, o.human, o.seat, o.restrained, o.state, o.peakDv, o.peakAccel, o.ejectedAt].map(csvCell).join(','));
  }
  const evs = vehicleEvents(events);
  if (evs.length) {
    lines.push('', '# events', VEHICLE_EVENT_COLUMNS.join(','));
    for (const ev of evs) {
      const d = ev.vehicle!;
      lines.push([ev.time.toFixed(3), ev.objectId, ev.eventType, ev.hazard, d.kind, d.partner, d.partnerKind, d.dv, d.closing, d.impulse, d.energy, d.level].map(csvCell).join(','));
    }
  }
  const charted = cars.filter((e) => e.vehicle.series && e.vehicle.series.t.length);
  if (charted.length) {
    lines.push('', `# series (every 0.25 s, thinned ×2 for long runs; empty = not computed at that sample; units: ${VEHICLE_SERIES_KEYS.map((k) => `${k} ${VEHICLE_SERIES_UNITS[k]}`).join(', ')})`,
      ['vehicle_id', 'time_s', ...VEHICLE_SERIES_KEYS].join(','));
    for (const e of charted) {
      const s = e.vehicle.series!;
      const cols = VEHICLE_SERIES_KEYS.map((k) => vehicleSeriesOf(e.vehicle, k));
      for (let i = 0; i < s.t.length; i++) lines.push([e.id, s.t[i].toFixed(2), ...cols.map((c) => c[i])].map(csvCell).join(','));
    }
  }
  return lines.join('\n');
}

const nanNull = (a: readonly number[]) => a.map((v) => (Number.isFinite(v) ? v : null));

/** JSON block of the vehicles for the results export (undefined when the run has no vehicle dynamics). */
export function vehicleJson(entities: Iterable<RuntimeEntity>, events: readonly DamageEventRecord[], rt: VehicleRuntime | undefined, physics?: PhysicsEngine | null) {
  if (!rt) return undefined;
  const cars = vehicleEntities(entities);
  const variants = [...new Set(cars.map((e) => e.vehicle.variant))];
  return {
    schemaVersion: VEHICLE_EXPORT_SCHEMA,
    model: 'dynamics' as const,
    modelVersion: VEHICLE_MODEL_VERSION,
    note: VEHICLE_NOTE,
    notes: VEHICLE_NOTES,
    limits: VEHICLE_LIMITS,
    levels: VEHICLE_LEVEL_LEGEND,
    units: VEHICLE_UNITS,
    seriesUnits: VEHICLE_SERIES_UNITS,
    parameters: PARAMS,
    tire: { ...TIRE, muGround: [...TIRE.muGround], crrGround: [...TIRE.crrGround] },
    variants: Object.fromEntries(variants.map((k) => [k, VARIANTS[k]])),
    settings: rt.settings,
    aggregate: aggregateVehicles(cars, physics),
    vehicles: cars.map((e) => {
      const v = e.vehicle, g = v.geo;
      const s = v.series;
      return {
        ...vehicleRow(e, physics),
        geometry: { dims: g.dims, inertiaTensor: g.inertia, maxProduct: g.maxProduct, wheelCentres: g.wheels, mounts: g.mounts, springRate: g.k, damperRate: g.c, staticLoad: g.staticLoad, staticCompression: g.staticCompression, freeLength: g.freeLength },
        ledger: { ...v.dyn.ledger, collision: v.energy.collision },
        episodes: [...v.episodes, ...v.open.values()].map((ep) => ({ ...ep, impulseMagnitude: Math.hypot(...ep.impulse), dv: ep.open ? null : ep.dv, keAfter: ep.open ? null : ep.keAfter })),
        occupants: v.occupants.map((o) => ({ ...o })),
        series: s ? { dt: s.dt, t: s.t, ...Object.fromEntries(VEHICLE_SERIES_KEYS.map((k) => [k, nanNull(vehicleSeriesOf(v, k))])) } : null,
      };
    }),
    events: vehicleEvents(events).map((ev) => ({ time: ev.time, object: ev.objectId, event: ev.eventType, hazard: ev.hazard, ...ev.vehicle })),
  };
}

/** Series keys that only a wheeled car computes (a rigid car records placeholders there: no wheels, no reference velocity). */
const WHEELED_KEYS = new Set<string>(['accelLong', 'accelLat', 'wheelSpeed', 'slip', 'load', 'drive', 'brake']);

/** Samples of one series of a car for display / export (NaN = gap; keys a rigid car does not compute read NaN everywhere). */
export function vehicleSeriesOf(v: VehicleEntity, k: (typeof VEHICLE_SERIES_KEYS)[number]): number[] {
  const s = v.series?.v[k] ?? [];
  return v.level !== 'vehicle' && WHEELED_KEYS.has(k) ? s.map(() => NaN) : s;
}
