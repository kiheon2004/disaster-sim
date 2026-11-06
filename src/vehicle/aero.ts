/**
 * Phase 35: vehicle aerodynamics (level B: quadratic drag with body-axis coefficients).
 *
 * Air velocity relative to the body at the centre of pressure v_r = v_body + ω × r − v_wind; in body axes (x forward, z right):
 *   F_x = −½ ρ C_d A_f |v_r| v_r,x      (drag, frontal area A_f = W H fill)
 *   F_z = −½ ρ C_y A_s |v_r| v_r,z      (side force, side area A_s = L H fill)
 * applied at the centre of pressure (above the COM), so a crosswind also gives the roll and yaw moments. Vertical lift is not
 * modelled. In vehicle mode this force REPLACES the legacy wind drag of the car (the wind system skips vehicle-mode cars; the
 * same 'wind' ledger source is claimed once) — the legacy drag uses one silhouette coefficient and no calibration factor here.
 * The part under water gets the water drag instead (the area is scaled by the dry share, as in the wind system).
 */
import type { Vec3 } from '@/core/types';
import { rotate, type Quat } from './dynamics';

export interface AeroInput {
  q: Quat;
  /** Velocity of the centre of pressure (world, m/s), local wind there (world, m/s). */
  vCop: Vec3;
  wind: Vec3;
  rho: number;
  cd: number;
  cy: number;
  frontal: number;
  side: number;
  dryShare: number;
}

export function aeroForce(a: AeroInput, out: Vec3 = [0, 0, 0]): Vec3 {
  const vr: Vec3 = [a.vCop[0] - a.wind[0], a.vCop[1] - a.wind[1], a.vCop[2] - a.wind[2]];
  const s = Math.hypot(vr[0], vr[1], vr[2]);
  out[0] = out[1] = out[2] = 0;
  if (s < 1e-6 || a.dryShare <= 0) return out;
  const x = rotate(a.q, [1, 0, 0]), z = rotate(a.q, [0, 0, 1]);
  const vx = vr[0] * x[0] + vr[1] * x[1] + vr[2] * x[2];
  const vz = vr[0] * z[0] + vr[1] * z[1] + vr[2] * z[2];
  const k = 0.5 * a.rho * s * a.dryShare;
  const fx = -k * a.cd * a.frontal * vx, fz = -k * a.cy * a.side * vz;
  for (let i = 0; i < 3; i++) out[i] = fx * x[i] + fz * z[i];
  return out;
}
