/**
 * Ground shock of an impact (Phase 23) — waves travelling through the GROUND, distinct from the
 * atmospheric blast (pressure waves in the air: Phase 24, not simulated here).
 *
 * Energy: a fraction k_s of the impact kinetic energy becomes seismic (elastic) wave energy,
 * k_s = 1e-4 (Schultz & Gault 1975; the value used by Collins et al. 2005; range 1e-5–1e-3).
 * Collins et al.'s magnitude / distance relations are fits for tens–hundreds of km and are not used
 * inside a 200 m world. Instead the near field is estimated from energy flux:
 *   a velocity pulse of one sine cycle v(t) = V·sin(2πt/τ) (net displacement zero), spreading over a
 *   hemisphere of radius r in ground of density ρ and shear-wave speed c carries
 *     E_s = 2π·r²·ρ·c·∫v²dt = π·r²·ρ·c·V²·τ
 *   so  V(r) = √(E_s / (π·r²·ρ·c·τ)) · exp(−π·r / (Q·c·τ))      (geometric spreading 1/r of body
 *   waves; anelastic attenuation with Q = 1/(2ξ) from the Phase 13 soil damping ξ),
 *   peak acceleration A = 2π·V/τ, arrival at t = r/c, r ≥ crater radius.
 * Source duration τ = 2·R/c (time for the crater-size source region to unload: the corner period of
 * explosion sources scales with cavity radius / wave speed) — an order-of-magnitude choice, labelled.
 * Resolution: the simulation steps at 60 Hz, so a pulse shorter than 4 steps (67 ms) cannot be
 * applied faithfully; the APPLIED pulse is broadened to τ_app = max(τ, 4·dt) with the same peak
 * velocity V (structural response to short pulses is governed by their velocity / impulse), and its
 * peak acceleration is 2πV/τ_app. Both the physical and the applied PGA are reported.
 * Components: radial horizontal V, vertical 2/3·V (a common V/H ratio, as Phase 13's default).
 * Not modelled: wave types and reflections, near-field permanent displacement, topography effects.
 */
import { GRAVITY } from '@/core/units';
import type { Vec3 } from '@/core/types';

export const SEISMIC_EFFICIENCY = 1e-4;
export const SIM_DT = 1 / 60;
export const MIN_PULSE = 4 * SIM_DT;
export const VERTICAL_RATIO = 2 / 3;

export interface ShockInput {
  energy: number;
  /** Ground density (kg/m³), shear-wave speed (m/s), damping ratio ξ, crater radius (m). */
  rho: number;
  c: number;
  damping: number;
  radius: number;
}

export interface GroundShock {
  center: [number, number];
  time: number;
  seismicEnergy: number;
  c: number;
  Q: number;
  tau: number;
  tauApplied: number;
  rho: number;
  radius: number;
}

export function createShock(i: ShockInput, center: [number, number], time: number): GroundShock {
  const Es = SEISMIC_EFFICIENCY * i.energy;
  const tau = (2 * i.radius) / i.c;
  return { center, time, seismicEnergy: Es, c: i.c, Q: 1 / (2 * Math.max(0.005, i.damping)), tau, tauApplied: Math.max(tau, MIN_PULSE), rho: i.rho, radius: i.radius };
}

/** Peak horizontal ground velocity at distance r (m/s), physical pulse. */
export function peakVelocity(s: GroundShock, r: number): number {
  const rr = Math.max(s.radius, r, 0.5);
  if (s.seismicEnergy <= 0 || s.tau <= 0) return 0;
  return Math.sqrt(s.seismicEnergy / (Math.PI * rr * rr * s.rho * s.c * s.tau)) * Math.exp((-Math.PI * rr) / (s.Q * s.c * s.tau));
}

/** Peak horizontal ground acceleration (m/s²): physical and as applied in the simulation. */
export function peakAcceleration(s: GroundShock, r: number, applied = false): number {
  return (2 * Math.PI * peakVelocity(s, r)) / (applied ? s.tauApplied : s.tau);
}

/** Add the shock's ground motion at (x, z, time) to d / v / a (applied pulse). Returns |a_h|. */
export function addShock(s: GroundShock, x: number, z: number, time: number, d: Vec3, v: Vec3, a: Vec3): number {
  const dx = x - s.center[0], dz = z - s.center[1];
  const r = Math.hypot(dx, dz);
  const t = time - s.time - Math.max(s.radius, r) / s.c;
  const T = s.tauApplied;
  if (t < 0 || t > T) return 0;
  const V = peakVelocity(s, r);
  const w = (2 * Math.PI) / T;
  const vel = V * Math.sin(w * t), acc = V * w * Math.cos(w * t), disp = (V / w) * (1 - Math.cos(w * t));
  const ux = r > 1e-6 ? dx / r : 1, uz = r > 1e-6 ? dz / r : 0;
  d[0] += disp * ux; d[2] += disp * uz; d[1] += disp * VERTICAL_RATIO;
  v[0] += vel * ux; v[2] += vel * uz; v[1] += vel * VERTICAL_RATIO;
  a[0] += acc * ux; a[2] += acc * uz; a[1] += acc * VERTICAL_RATIO;
  return Math.abs(acc);
}

/** Time window during which the shock moves the ground somewhere in a world of half-size `half` (m). */
export function shockWindow(s: GroundShock, half: number): [number, number] {
  return [s.time, s.time + (Math.SQRT2 * half + s.radius) / s.c + s.tauApplied];
}

export const toG = (a: number) => a / GRAVITY;
