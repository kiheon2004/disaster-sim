/**
 * Phase 35: one physics step of a wheeled vehicle (level B; pure — no engine calls).
 *
 * The chassis is ONE Rapier rigid body (6 DOF, Rapier integrates it — no second integrator). Per step, for each wheel:
 *  1. Suspension (ray along −up from the strut mount, against the world): compression x = L_free + R − d_hit (≥ 0), rate
 *     ẋ = −(v_mount − v_surface)·up; strut force F_s = k x + c ẋ (+ a stiff bump stop beyond the travel), never tension (F_s ≥ 0).
 *     The massless wheel's links carry what the strut does not, so the ground's normal load is F_z = F_s / (up·n) ≥ 0.
 *  2. Contact kinematics: wheel heading = body forward turned by the steering angle, projected on the ground plane (normal n);
 *     contact-point velocity relative to the surface v = v_c + ω × (p − c) − v_surface → (v_x, v_y) in the wheel frame.
 *  3. Wheel spin and tyre (N sub-steps, chassis velocity frozen within the step — operator splitting): I_w ω̇ = T_drive − R F_x
 *     − T_rr − T_brake (brake and rolling resistance as Coulomb torques that stop but never reverse the wheel); transient slips
 *     and the tyre force (tire.ts). The sub-step mean of F_x, F_y is applied for the step.
 *  4. Force on the chassis at the contact point: the ground reaction F_z n + F̄_x x̂ + F̄_y ŷ (normal load + tyre forces); the opposite
 *     force on a dynamic body under the wheel.
 * Rolling resistance F_rr = C_rr F_z acts as the torque C_rr F_z R on the wheel (so a car at rest is never pushed by it).
 * Air drag is applied separately (aero.ts). Gravity is Rapier's (+ the Phase 31 field) — the vehicle adds no weight force.
 */
import type { Vec3 } from '@/core/types';
import type { VehicleGeometry } from './geometry';
import { brakeTorques, driveShares, driveTorque, newPowertrain, steerAngles, type Controls, type PowertrainState } from './powertrain';
import type { Drive } from './params';
import { capDeflection, contactForce, implicitSpin, lowSpeedWeight, relaxLateral, relaxLongitudinal, steadySlip, treadDamping, type TireForce, type TireModel, type TireState } from './tire';
import { TIRE } from './params';

export type Quat = readonly [number, number, number, number];

export function rotate(q: Quat, v: readonly number[], out: Vec3 = [0, 0, 0]): Vec3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  out[0] = v[0] + w * tx + (y * tz - z * ty);
  out[1] = v[1] + w * ty + (z * tx - x * tz);
  out[2] = v[2] + w * tz + (x * ty - y * tx);
  return out;
}
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[], o: Vec3 = [0, 0, 0]): Vec3 => {
  o[0] = a[1] * b[2] - a[2] * b[1]; o[1] = a[2] * b[0] - a[0] * b[2]; o[2] = a[0] * b[1] - a[1] * b[0];
  return o;
};

export interface WheelHit {
  /** Distance from the mount along −up to the hit (m); null = no ground within reach. */
  toi: number | null;
  point: Vec3;
  normal: Vec3;
  /** Velocity of the surface at the point (m/s; 0 for the ground), the surface's peak tyre friction and rolling resistance. */
  surfaceVel: Vec3;
  mu: number;
  crr: number;
}

export interface WheelState {
  omega: number;
  /** Spin angle (rad) for the rendering. */
  spin: number;
  tire: TireState;
  steer: number;
  contact: boolean;
  compression: number;
  rate: number;
  Fs: number;
  Fz: number;
  Fx: number;
  Fy: number;
  kappa: number;
  alpha: number;
  sliding: boolean;
  driveT: number;
  brakeT: number;
  locked: boolean;
  /** World contact point, the surface normal there and the force applied there this step (N). */
  point: Vec3;
  normal: Vec3;
  force: Vec3;
}

export interface VehicleLedger {
  /** Energies (J) integrated over the run: drive work at the wheels, brake / rolling / tyre-slip / damper / aero dissipation. */
  drive: number;
  brake: number;
  rolling: number;
  slip: number;
  damper: number;
  aero: number;
}

export interface VehicleDynState {
  wheels: WheelState[];
  pt: PowertrainState;
  abs: boolean[];
  ledger: VehicleLedger;
  /** Spring energy stored now (J). */
  springEnergy: number;
  /** All wheels off the ground (airborne / floating), wheels touching. */
  airborne: boolean;
  touching: number;
}

export function newVehicleState(): VehicleDynState {
  const w = (): WheelState => ({ omega: 0, spin: 0, tire: { k: 0, a: 0 }, steer: 0, contact: false, compression: 0, rate: 0, Fs: 0, Fz: 0, Fx: 0, Fy: 0, kappa: 0, alpha: 0, sliding: false, driveT: 0, brakeT: 0, locked: false, point: [0, 0, 0], normal: [0, 1, 0], force: [0, 0, 0] });
  return { wheels: [w(), w(), w(), w()], pt: newPowertrain(), abs: [false, false, false, false], ledger: { drive: 0, brake: 0, rolling: 0, slip: 0, damper: 0, aero: 0 }, springEnergy: 0, airborne: true, touching: 0 };
}

export interface BodyKinematics {
  pos: Vec3;
  q: Quat;
  v: Vec3;
  w: Vec3;
  /** World centre of mass. */
  com: Vec3;
}

export interface StepOptions {
  model: TireModel;
  drive: Drive;
  substeps: number;
  abs: boolean;
  /** Local gravity magnitude along −up for the brake sizing (m/s²). */
  g: number;
  /** Capability factors 0…1 (vehicle damage × driver): drive, steering, brakes. */
  driveAvail: number;
  steerAvail: number;
  brakeAvail: number;
}

const BUMP_STIFF = 10;

/**
 * One step: wheel forces (world, at the contact points) for the chassis. `hits[i]` from the world ray of wheel i (cast from
 * `mountWorld(i)` along −up with length L_free + R). Writes the wheel states and the ledger.
 */
export function stepVehicle(geo: VehicleGeometry, st: VehicleDynState, kin: BodyKinematics, hits: WheelHit[], c: Controls, o: StepOptions, dt: number) {
  const spec = geo.spec;
  const up = rotate(kin.q, [0, 1, 0]);
  const fwd = rotate(kin.q, [1, 0, 0]);
  const speed = dot(kin.v, fwd);
  const [dl, dr] = steerAngles(spec, st.pt, c.steer, speed, geo.wheelbase, geo.track, dt, o.steerAvail);
  const shares = driveShares(o.drive);
  const brakeMax = brakeTorques(spec, geo.mass, o.g);
  const R = spec.wheelRadius, Iw = spec.wheelInertia;
  const xs: Vec3[] = [], ys: Vec3[] = [], vx = [0, 0, 0, 0], vy = [0, 0, 0, 0], mu = [0, 0, 0, 0], crr = [0, 0, 0, 0];
  let touching = 0;
  st.springEnergy = 0;
  for (let i = 0; i < 4; i++) {
    const W = st.wheels[i], h = hits[i];
    W.steer = i === 0 ? dl : i === 1 ? dr : 0;
    W.Fs = W.Fz = 0;
    W.force[0] = W.force[1] = W.force[2] = 0;
    const reach = geo.freeLength[i] + R;
    const x = h.toi === null ? 0 : reach - h.toi;
    W.contact = h.toi !== null && x > 0;
    W.compression = Math.max(0, x);
    // Wheel heading in the world, projected on the contact plane.
    const hb = rotate(kin.q, [Math.cos(W.steer), 0, -Math.sin(W.steer)]);
    const n = W.contact ? h.normal : up;
    const hn = dot(hb, n);
    const fx: Vec3 = [hb[0] - hn * n[0], hb[1] - hn * n[1], hb[2] - hn * n[2]];
    const fl = Math.hypot(fx[0], fx[1], fx[2]) || 1;
    fx[0] /= fl; fx[1] /= fl; fx[2] /= fl;
    const fy = cross(n, fx); // to the wheel's left
    xs.push(fx); ys.push(fy);
    if (!W.contact) {
      W.rate = 0;
      W.kappa = W.alpha = 0;
      continue;
    }
    touching++;
    W.point[0] = h.point[0]; W.point[1] = h.point[1]; W.point[2] = h.point[2];
    W.normal[0] = h.normal[0]; W.normal[1] = h.normal[1]; W.normal[2] = h.normal[2];
    const r: Vec3 = [h.point[0] - kin.com[0], h.point[1] - kin.com[1], h.point[2] - kin.com[2]];
    const wr = cross(kin.w, r);
    const vp: Vec3 = [kin.v[0] + wr[0] - h.surfaceVel[0], kin.v[1] + wr[1] - h.surfaceVel[1], kin.v[2] + wr[2] - h.surfaceVel[2]];
    W.rate = -dot(vp, up);
    const xmax = geo.staticCompression[i] + spec.bump;
    let Fs = geo.k[i] * W.compression + geo.c[i] * W.rate;
    if (W.compression > xmax) Fs += BUMP_STIFF * geo.k[i] * (W.compression - xmax);
    W.Fs = Math.max(0, Fs);
    // Ground reaction: the strut carries F_s along up; the massless wheel's links carry the rest, so the ground's normal load is
    // N = F_s / (up · n) (≥ 0, the contact plane tilted at most ~78° from the strut).
    const un = dot(up, n);
    W.Fz = un > 0.2 ? W.Fs / un : 0;
    st.springEnergy += 0.5 * geo.k[i] * W.compression * W.compression;
    // Damper power (dissipated when the damper force is part of the applied strut force).
    if (W.Fs > 0) st.ledger.damper += geo.c[i] * W.rate * W.rate * dt;
    vx[i] = dot(vp, fx);
    vy[i] = dot(vp, fy);
    mu[i] = h.mu;
    crr[i] = h.crr;
  }
  st.touching = touching;
  st.airborne = touching === 0;
  // Sub-steps: wheel spin, transient slips, tyre forces (chassis velocity frozen).
  const N = Math.max(1, o.substeps), hsub = dt / N;
  const sumFx = [0, 0, 0, 0], sumFy = [0, 0, 0, 0];
  const tf: TireForce = { fx: 0, fy: 0, sliding: false, phi: 0 };
  const pedal = Math.min(1, Math.max(0, c.brake)) * o.brakeAvail;
  for (let s = 0; s < N; s++) {
    let mean = 0, nd = 0;
    for (let i = 0; i < 4; i++) if (shares[i] > 0) { mean += st.wheels[i].omega; nd++; }
    mean = nd ? mean / nd : 0;
    const Td = driveTorque(spec, st.pt, c, mean, hsub, o.driveAvail, speed / R);
    for (let i = 0; i < 4; i++) {
      const W = st.wheels[i];
      const Tdi = Td * shares[i];
      let fxi = 0, fyi = 0;
      let w1 = W.omega;
      // Coulomb torques on the wheel: brake (pedal; ABS limits it to the torque the tyre can carry; handbrake / P hold) and
      // rolling resistance — they can stop the wheel, never reverse it.
      let Tb = pedal * brakeMax[i];
      if (o.abs && Tb > 0 && W.contact) {
        const kap = steadySlip(vx[i], vy[i], R * W.omega).kappa;
        if (kap < -0.15) st.abs[i] = true;
        else if (kap > -0.08) st.abs[i] = false;
        // ABS (slip control): while active, the brake torque is held at what the tyre transmits near its peak (0.9 R μ F_z).
        if (st.abs[i]) Tb = Math.min(Tb, 0.9 * R * mu[i] * W.Fz);
      }
      const hold = (c.handbrake && i >= 2) || (c.gear === 'P' && shares[i] > 0);
      if (hold) Tb = Math.max(Tb, 4 * brakeMax[i] + 5000);
      const Trr = W.contact ? crr[i] * W.Fz * R : 0;
      const Tc = Tb + Trr;
      const dw = (Tc / Iw) * hsub;
      let used = 0;
      if (W.contact) {
        const Ck = TIRE.ckPerLoad * W.Fz, Ca = TIRE.caPerLoad * W.Fz;
        const lw = lowSpeedWeight(vx[i]);
        const cx = lw * treadDamping(Ck, TIRE.sigmaX, W.Fz, o.g), cy = lw * treadDamping(Ca, TIRE.sigmaY, W.Fz, o.g);
        relaxLateral(W.tire, vx[i], vy[i], hsub);
        const k0 = W.tire.k;
        const sy = -Ca * W.tire.a - cy * vy[i];
        const force = (k: number, w: number) => contactForce(o.model, Ck * k + cx * (R * w - vx[i]), sy, W.Fz, mu[i], lw, tf);
        // Wheel spin under a torque T from the sub-step's start state: implicit spin / slip in the grip range, explicit under a
        // sliding (bounded) force. Returns ω₁ and leaves the slip in W.tire.k.
        force(k0, W.omega);
        const sliding0 = tf.sliding, fx0 = tf.fx;
        const lin = Math.hypot(Ck * k0 + cx * (R * W.omega - vx[i]), sy);
        const scale = lin > 0 && !sliding0 ? Math.hypot(tf.fx, tf.fy) / lin : 1;
        const spin = (T: number): number => {
          W.tire.k = k0;
          if (sliding0) {
            const w = W.omega + ((T - R * fx0) / Iw) * hsub;
            relaxLongitudinal(W.tire, vx[i], R * 0.5 * (W.omega + w), hsub);
            return w;
          }
          return implicitSpin(W.tire, W.omega, vx[i], R, Iw, T, Ck * scale, cx * scale, hsub);
        };
        // Coulomb torques (brake, rolling resistance) inside the same solve: a constant torque against the rotation. If the
        // rotation would reverse within the sub-step, the wheel stops — and stays held while the Coulomb capacity reacts the net
        // tyre / drive torque (static friction of the brake); otherwise it turns the way the net torque drives it.
        const wFree = spin(Tdi);
        if (Tc > 0) {
          const d = wFree !== 0 ? Math.sign(wFree) : Math.sign(Tdi - R * fx0) || 1;
          const wC = spin(Tdi - d * Tc);
          if (wC * d > 0) {
            w1 = wC;
            used = dw;
          } else {
            W.tire.k = k0;
            relaxLongitudinal(W.tire, vx[i], 0, hsub);
            force(W.tire.k, 0);
            const Tnet = Tdi - R * tf.fx;
            if (Math.abs(Tnet) <= Tc) { w1 = 0; used = Math.abs(W.omega); }
            else { w1 = spin(Tdi - Math.sign(Tnet) * Tc); used = dw; }
          }
        } else w1 = wFree;
        force(W.tire.k, w1);
        // Static limit of the tread at low speed: the carcass deflects no further than the friction can hold (F ≤ μ F_z — the
        // excess is sliding), so a stopped or side-pushed tyre stores at most ≈ μ σ / 16 of deflection (no spring-back launch).
        if (o.model === 'saturating') capDeflection(W.tire, Ck, Ca, mu[i] * W.Fz, lw);
        fxi = tf.fx; fyi = tf.fy;
        W.sliding = tf.sliding;
        // Slip dissipation: F·(v_tread − v_contact) — the tyre does F_x v_x + F_y v_y on the body and −F_x R ω on the wheel.
        st.ledger.slip += (fxi * (R * 0.5 * (W.omega + w1) - vx[i]) - fyi * vy[i]) * hsub;
      } else {
        W.tire.k = W.tire.a = 0;
        w1 = W.omega + (Tdi / Iw) * hsub;
        if (Math.abs(w1) <= dw) { used = Math.abs(w1); w1 = 0; } else { used = dw; w1 -= Math.sign(w1) * dw; }
      }
      // Energy taken by the Coulomb torques over the sub-step ≈ T × mean |ω| (split brake / rolling by torque share).
      const meanW = 0.5 * (Math.abs(W.omega) + Math.abs(w1));
      const frac = Tc > 0 ? Math.min(1, used / dw) : 0;
      if (Tc > 0) {
        st.ledger.brake += (Tb / Tc) * Tc * frac * meanW * hsub;
        st.ledger.rolling += (Trr / Tc) * Tc * frac * meanW * hsub;
      }
      st.ledger.drive += Tdi * 0.5 * (W.omega + w1) * hsub;
      W.locked = Tb > 0 && w1 === 0 && W.contact;
      W.omega = w1;
      W.spin += W.omega * hsub;
      W.driveT = Tdi;
      W.brakeT = Tb;
      sumFx[i] += fxi;
      sumFy[i] += fyi;
    }
  }
  for (let i = 0; i < 4; i++) {
    const W = st.wheels[i];
    if (!W.contact) { W.Fx = W.Fy = 0; continue; }
    W.Fx = sumFx[i] / N;
    W.Fy = sumFy[i] / N;
    const s = steadySlip(vx[i], vy[i], R * W.omega);
    W.kappa = s.kappa;
    W.alpha = s.alpha;
    const fx = xs[i], fy = ys[i];
    // On the chassis at the contact: the ground's normal load along n plus the tyre forces in the contact plane — the ground
    // pushes nothing else (a strut force along a pitched body axis would add a spurious tangential push).
    const n = hits[i].normal;
    for (let k = 0; k < 3; k++) W.force[k] = W.Fz * n[k] + W.Fx * fx[k] + W.Fy * fy[k];
  }
}

/** World position of the strut mount of wheel i. */
export function mountWorld(geo: VehicleGeometry, kin: { pos: Vec3; q: Quat }, i: number, out: Vec3 = [0, 0, 0]): Vec3 {
  rotate(kin.q, geo.mounts[i], out);
  out[0] += kin.pos[0]; out[1] += kin.pos[1]; out[2] += kin.pos[2];
  return out;
}
