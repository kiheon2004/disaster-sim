/**
 * Lava crust (Phase 28) — a REDUCED two-temperature model of a lava column, not a resolved profile.
 *
 * The column's mean (interior) temperature T_i comes from its enthalpy (Phase 26 tables). A conductive
 * thermal boundary layer grows at the top (and the base) from the time the surface was last renewed
 * (`age`, carried with the lava):
 *     δ(age) = 2·√(κ·(age + AGE0)),   clamped to [δ_min, h/2]
 * (the penetration depth of a conducting half-space after a sudden surface cooling, Turcotte & Schubert
 * ch. 4). The surface temperature T_s satisfies the energy balance of the boundary layer
 *     k·(T_i − T_s)/δ = ε·σ·(T_s⁴ − T_sky⁴) + h_c·(T_s − T_air)          (in air)
 *     k·(T_i − T_s)/δ = h_w·(T_s − T_w)                                (under water)
 * and the heat the column loses through its top is that flux. A black surface (low T_s) is thus a
 * result of the energy balance, not of the colour; the column solidifies only when its enthalpy says so.
 *
 * Mobility: the part of each boundary layer colder than the lock-up temperature is rigid crust, so the
 * flowing depth is h − crust_top − crust_base (linear profile inside the layer, assumed).
 *
 * Under water the coefficient h_w = 500 W/(m²·K) stands for the film / transition boiling regime
 * (100–1000 W/(m²·K) on hot surfaces, Incropera ch. 10) — WEAK, an order-of-magnitude choice.
 * Boiling and steam are NOT modelled: the heat goes into the water's sensible heat (Phase 26 has no
 * phase change of water), and water warmer than 100 °C is reported as such.
 */
import { SIGMA } from '@/thermal/units';

/** Age offset so the boundary layer never starts at zero thickness (s). */
export const AGE0 = 1;
export const DELTA_MIN = 1e-3;
export const H_WATER = 500;

export function boundaryLayer(kappa: number, age: number, h: number): number {
  const d = 2 * Math.sqrt(kappa * (age + AGE0));
  return Math.max(DELTA_MIN, Math.min(h > 0 ? 0.5 * h : DELTA_MIN, d));
}

/** Surface temperature in air (K): Newton on the concave balance from above (monotone convergence). */
export function surfaceTemperature(Ti: number, delta: number, k: number, eps: number, Tsky: number, hc: number, Tair: number): number {
  const G = k / delta;
  const lo = Math.min(Tsky, Tair);
  if (Ti <= lo) return Ti;
  let Ts = Ti;
  for (let it = 0; it < 12; it++) {
    const T3 = Ts * Ts * Ts;
    const f = G * (Ti - Ts) - eps * SIGMA * (T3 * Ts - Tsky ** 4) - hc * (Ts - Tair);
    const df = -G - 4 * eps * SIGMA * T3 - hc;
    const next = Ts - f / df;
    if (Math.abs(next - Ts) < 1e-4) { Ts = next; break; }
    Ts = next;
  }
  return Math.max(lo, Math.min(Ti, Ts));
}

/** Surface temperature under water (K), closed form. */
export const surfaceUnderWater = (Ti: number, delta: number, k: number, Tw: number, hw = H_WATER) => (k * Ti / delta + hw * Tw) / (k / delta + hw);

/** Rigid thickness of a boundary layer of thickness δ between T_far (surface / ground) and T_i, for a lock-up temperature. */
export function rigidPart(delta: number, Ti: number, Tfar: number, Tlock: number): number {
  if (Ti <= Tlock) return delta;
  if (Tfar >= Tlock) return 0;
  return delta * Math.min(1, (Tlock - Tfar) / (Ti - Tfar));
}
