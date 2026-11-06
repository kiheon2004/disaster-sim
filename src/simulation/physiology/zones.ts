/**
 * Phase 34: experimental boundary-condition zones of the physiology (settings.physiology.zones). A zone holds given values
 * inside a box / sphere from `start` to `end`, ramping in from the surrounding values over `ramp` s; the last zone in the
 * list wins where zones overlap (deterministic). Zones are inputs of the physiology only: no force, no heat or mass in
 * the world.
 *
 * A `confined` zone is a well-mixed air volume V with an air-change rate λ (1/h) to the reference air. Its O₂ / CO₂ amounts
 * (mol) change with the occupants' uptake / output and the exchange:
 *   dn_i/dt = −Σ uptake_i + λ/3600 (n_i,ref − n_i),   n_i,ref = x_i,ref p V / (R T)
 * advanced exactly per step for the exchange (exponential), with the occupants' amounts taken first (clamped ≥ 0, the
 * clamp is recorded). Ledger: Δn = −consumed + exchanged, checked by the tests.
 */
import type { Vec3 } from '@/core/types';
import { R_GAS } from '@/physiology/gas';
import type { PhysiologyZone } from '@/physiology/settings';

export function inZone(z: PhysiologyZone, p: Readonly<Vec3>): boolean {
  const dx = p[0] - z.center[0], dy = p[1] - z.center[1], dz = p[2] - z.center[2];
  if (z.shape === 'sphere') return dx * dx + dy * dy + dz * dz <= z.size[0] * z.size[0];
  return Math.abs(dx) <= z.size[0] / 2 && Math.abs(dy) <= z.size[1] / 2 && Math.abs(dz) <= z.size[2] / 2;
}

/** Ramp weight of a zone at time t: 0 outside [start, end], linear over `ramp` s after the start. */
export function zoneWeight(z: PhysiologyZone, t: number): number {
  const s = z.start ?? 0;
  if (t < s || (z.end !== undefined && t > z.end)) return 0;
  const r = z.ramp ?? 0;
  return r > 0 ? Math.min(1, (t - s) / r) : 1;
}

/** The zone (last wins) holding p at t, with its weight; null when none. */
export function zoneAt(zones: readonly PhysiologyZone[] | undefined, p: Readonly<Vec3>, t: number): { zone: PhysiologyZone; index: number; w: number } | null {
  if (!zones) return null;
  for (let i = zones.length - 1; i >= 0; i--) {
    const z = zones[i];
    const w = zoneWeight(z, t);
    if (w > 0 && inZone(z, p)) return { zone: z, index: i, w };
  }
  return null;
}

/** Blend a zone value over a base: base + (zone − base) w; a missing base takes the zone value at weight > 0. */
export const blend = (base: number | undefined, value: number | undefined, w: number): number | undefined =>
  value === undefined ? base : base === undefined ? value : base + (value - base) * w;

/** Water surface of a zone's physiology-only water at time t (m). */
export function zoneWaterLevel(z: PhysiologyZone, t: number): number | undefined {
  if (!z.water) return undefined;
  const a = z.water.amplitude ?? 0, T = z.water.period ?? 0;
  return z.water.level + (a > 0 && T > 0 ? a * Math.sin((2 * Math.PI * (t - (z.start ?? 0))) / T) : 0);
}

export interface Compartment {
  zone: number;
  V: number;
  lambda: number;
  /** Amounts (mol) and the total gas amount (mol) at the reference state. */
  o2: number;
  co2: number;
  total: number;
  ref: { o2: number; co2: number };
  /** Ledger (mol): taken by occupants (O₂) / given by occupants (CO₂), net exchange in, clamps. */
  ledger: { o2Taken: number; co2Given: number; o2Exchange: number; co2Exchange: number; clamped: number };
}

export function createCompartment(zone: number, z: PhysiologyZone, xO2: number, xCO2: number, p: number, T: number): Compartment {
  const total = (p * z.confined!.volume) / (R_GAS * T);
  return { zone, V: z.confined!.volume, lambda: z.confined!.exchange, o2: xO2 * total, co2: xCO2 * total, total, ref: { o2: xO2 * total, co2: xCO2 * total }, ledger: { o2Taken: 0, co2Given: 0, o2Exchange: 0, co2Exchange: 0, clamped: 0 } };
}

/** Occupant uptake (mol) taken from the compartment, then the exchange over dt (exact exponential relaxation). */
export function stepCompartment(c: Compartment, o2Taken: number, co2Given: number, dt: number) {
  let take = o2Taken;
  if (take > c.o2) {
    c.ledger.clamped += take - c.o2;
    take = c.o2;
  }
  c.o2 -= take;
  c.co2 += co2Given;
  c.ledger.o2Taken += take;
  c.ledger.co2Given += co2Given;
  const k = 1 - Math.exp((-c.lambda / 3600) * dt);
  const e1 = (c.ref.o2 - c.o2) * k, e2 = (c.ref.co2 - c.co2) * k;
  c.o2 += e1;
  c.co2 += e2;
  c.ledger.o2Exchange += e1;
  c.ledger.co2Exchange += e2;
}

export const compartmentFractions = (c: Compartment) => ({ o2: c.o2 / c.total, co2: c.co2 / c.total });
