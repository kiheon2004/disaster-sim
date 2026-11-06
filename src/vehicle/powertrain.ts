/**
 * Phase 35: powertrain, brakes and steering (level B structure, level C generic parameters).
 *
 * Engine: full-load torque T_max up to the speed where T_max ω = P_max, then power-limited P_max / ω, zero above ω_max (rev
 * limiter). Delivered torque = throttle × full-load torque. Crankshaft speed ω_e = max(ω_idle, i |ω̄_driven|) with i = gear ×
 * final ratio: rigidly coupled above idle; below idle the launch device (clutch / converter) slips and passes the engine torque
 * at idle speed (stall launch) — the slipping clutch's heat is not modelled (documented limit).
 * Gearbox: automatic up-shift above 0.85 ω_max, down-shift below 0.4 ω_max (hysteresis) of the engine speed at the ROAD speed
 * (|v_x| / R × ratio — a spinning wheel does not shift up), at least 1 s in a gear, no torque for 0.25 s while shifting.
 * Torque at the driven wheels: T_wheel = T_e i η, split by the drive layout (FWD / RWD front / rear 100 %, AWD 50 / 50) and by an
 * open differential equally between left and right (equal torque — the wheel with less grip spins: the open-differential
 * behaviour). Drive work = Σ T_wheel ω (mechanical work at the wheels; no fuel / energy store is modelled).
 * Brakes: per-wheel torque = pedal × T_b,max (front / rear share), a Coulomb friction torque on the wheel spin: it can stop the
 * wheel (locks) but never reverses it. Parking brake / gear P: rear (P: driven) wheels held with a large friction torque.
 * ABS (optional): while the wheel's longitudinal slip under braking passes −0.15 the brake torque is released for that sub-step
 * and re-applied below −0.08 (a two-state slip controller acting on the computed slip, not a fixed pulse).
 * Steering: road-wheel angle δ = steer × δ_max × speed factor min(1, 12 / v), rate-limited; Ackermann for the inner / outer wheel:
 * cot δ_o − cot δ_i = t / L. The car turns only through the tyre forces this angle creates — no yaw is imposed.
 */
import type { Drive, VariantSpec } from './params';

export type Gear = 'P' | 'R' | 'N' | 'D';

export interface Controls {
  /** 0…1 */
  throttle: number;
  /** 0…1 */
  brake: number;
  /** −1 (right) … 1 (left) */
  steer: number;
  handbrake: boolean;
  gear: Gear;
}

export const neutralControls = (): Controls => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, gear: 'D' });

export interface PowertrainState {
  /** Current forward gear index (0-based). */
  gear: number;
  /** Remaining shift time (s). */
  shift: number;
  /** Crankshaft speed (rad/s), delivered engine torque (N·m). */
  omegaE: number;
  torqueE: number;
  /** Actual road-wheel angle (rad, positive = left turn) at the steering axis. */
  delta: number;
  /** Time in the current gear (s). */
  inGear: number;
}

export const newPowertrain = (): PowertrainState => ({ gear: 0, shift: 0, omegaE: 0, torqueE: 0, delta: 0, inGear: 0 });

export function fullLoadTorque(spec: VariantSpec, w: number): number {
  if (w >= spec.maxSpeed) return 0;
  const wb = spec.power / spec.torque;
  return w <= wb ? spec.torque : spec.power / w;
}

export const SHIFT_TIME = 0.25;
/** Minimum time in a gear before the next automatic shift (s). */
export const GEAR_HOLD = 1;

/** Wheel torque share of each wheel FL, FR, RL, RR for a drive layout. */
export function driveShares(d: Drive): [number, number, number, number] {
  return d === 'fwd' ? [0.5, 0.5, 0, 0] : d === 'rwd' ? [0, 0, 0.5, 0.5] : [0.25, 0.25, 0.25, 0.25];
}

/**
 * Engine / gearbox for one sub-step: from the mean driven wheel speed (rad/s) and the controls, the total drive torque at the
 * wheels (N·m, signed: positive drives forward). Updates the gear / shift state.
 */
export function driveTorque(spec: VariantSpec, pt: PowertrainState, c: Controls, meanDriven: number, dt: number, available = 1, roadOmega = meanDriven): number {
  if (c.gear === 'N' || c.gear === 'P') {
    pt.omegaE = spec.idle;
    pt.torqueE = 0;
    return 0;
  }
  const rev = c.gear === 'R';
  const ratio = (rev ? spec.reverse : spec.gears[pt.gear]) * spec.final;
  const coupled = Math.abs(meanDriven) * ratio;
  // Shift schedule on the road speed (output shaft at the rolling speed — wheelspin does not shift up), at least HOLD s in a gear.
  const road = Math.abs(roadOmega) * ratio;
  pt.inGear += dt;
  if (!rev) {
    if (pt.shift > 0) pt.shift = Math.max(0, pt.shift - dt);
    else if (pt.inGear >= GEAR_HOLD && road > 0.85 * spec.maxSpeed && pt.gear < spec.gears.length - 1) { pt.gear++; pt.shift = SHIFT_TIME; pt.inGear = 0; }
    else if (pt.inGear >= GEAR_HOLD && road < 0.4 * spec.maxSpeed && pt.gear > 0 && road * (spec.gears[pt.gear - 1] / spec.gears[pt.gear]) < 0.85 * spec.maxSpeed) { pt.gear--; pt.shift = SHIFT_TIME; pt.inGear = 0; }
  } else pt.gear = 0;
  pt.omegaE = Math.max(spec.idle, coupled);
  const thr = Math.min(1, Math.max(0, c.throttle)) * available;
  pt.torqueE = pt.shift > 0 ? 0 : thr * fullLoadTorque(spec, pt.omegaE);
  const r2 = (rev ? spec.reverse : spec.gears[pt.gear]) * spec.final;
  return (rev ? -1 : 1) * pt.torqueE * r2 * spec.efficiency;
}

/** Maximum brake torque per wheel (N·m) at full pedal: brakeG × m g R shared front / rear. */
export function brakeTorques(spec: VariantSpec, mass: number, g: number): [number, number, number, number] {
  const T = spec.brakeG * mass * g * spec.wheelRadius;
  const f = (T * spec.brakeFront) / 2, r = (T * (1 - spec.brakeFront)) / 2;
  return [f, f, r, r];
}

/** Steering: rate-limited road-wheel angle toward the target; returns the inner / outer (Ackermann) angles for left / right. */
export function steerAngles(spec: VariantSpec, pt: PowertrainState, steer: number, speed: number, wheelbase: number, track: number, dt: number, available = 1): [number, number] {
  const target = Math.max(-1, Math.min(1, steer)) * spec.steerMax * Math.min(1, 12 / Math.max(1e-6, Math.abs(speed))) * available;
  const step = spec.steerRate * dt;
  pt.delta += Math.max(-step, Math.min(step, target - pt.delta));
  const d = pt.delta;
  if (Math.abs(d) < 1e-6) return [d, d];
  // The steering angle is the bicycle-model angle at the axle centre: cot δ = L / R; inner / outer by ±t/2.
  const Rt = wheelbase / Math.tan(Math.abs(d));
  const inner = Math.atan(wheelbase / (Rt - track / 2)), outer = Math.atan(wheelbase / (Rt + track / 2));
  // Left turn (d > 0): the left wheel is the inner one.
  return d > 0 ? [inner, outer] : [-outer, -inner];
}
