/**
 * Closed-form fire relations used by the reduced model (Phase 27). Each is a published correlation
 * applied inside its stated range; none is a CFD result.
 */
import { GRAVITY } from '@/core/units';
import { gravityDown } from '@/thermal/gravityScope';
import { DOWN_MIN } from '@/gravity/outlook';
import { SIGMA } from '@/thermal/units';
import { CD_OPENING, SOOT_DENSITY, SOOT_EXTINCTION, SOOT_KAPPA, VISIBILITY_C } from './materials';

/**
 * Air drawn in through a vertical opening of a hot room (kg/s) — Rockett (1976) with the neutral
 * plane eliminated (Karlsson & Quintiere, Enclosure Fire Dynamics eq. 5.27):
 *   ṁ = (2/3)·C_d·ρ∞·A·√H·√(2g(1 − T∞/T_g)) / (1 + (T_g/T∞)^{1/3})^{3/2}
 * → 0 as T_g → T∞; ≈ 0.5·A√H (Kawagoe) for T_g ≳ 2.5·T∞ (fully developed fires).
 */
export function ventInflow(A: number, H: number, Tg: number, Tinf: number, rhoInf: number): number {
  if (A <= 0 || H <= 0 || Tg <= Tinf) return 0;
  const r = Tg / Tinf;
  return ((2 / 3) * CD_OPENING * rhoInf * A * Math.sqrt(H) * Math.sqrt(2 * GRAVITY * gravityDown() * (1 - 1 / r))) / Math.pow(1 + Math.cbrt(r), 1.5);
}

/** Mean flame height of a fire of Q (W) over a source of diameter D (m) — Heskestad (1983): L = 0.235·Q^{2/5} − 1.02·D (Q in kW). */
export function flameHeight(Q: number, D: number): number {
  if (Q <= 0) return 0;
  // Phase 31: the dimensional form hides g^(−1/5) (Q* = Q/(ρ·c_p·T·√g·D^{5/2})): L ∝ (g/g₀)^(−1/5) for a downward g;
  // below DOWN_MIN of g₀ there is no buoyant flame to correlate — held at that limit (outlook: fire 'limited').
  const gd = gravityDown();
  const k = gd === 1 ? 1 : Math.pow(Math.max(DOWN_MIN, gd), -0.2);
  return Math.max(0, 0.235 * Math.pow(Q / 1000, 0.4) * k - 1.02 * D);
}

/**
 * Flame tilt from the vertical in a cross-wind (rad) — Thomas (1963) / AGA correlation:
 *   cos θ = 1 for u* < 1, cos θ = u*^{−1/2} otherwise, u* = u / (g·ṁ″·D/ρ_a)^{1/3}
 * written with the heat release per area: ṁ″ = Q″/ΔH_c.
 */
export function flameTilt(u: number, Q: number, D: number, dHc: number, rhoA = 1.2): number {
  if (u <= 0 || Q <= 0 || D <= 0) return 0;
  const mpp = Q / (dHc * Math.PI * D * D / 4);
  const uc = Math.cbrt((GRAVITY * Math.max(DOWN_MIN, gravityDown()) * mpp * D) / rhoA);
  const us = u / Math.max(1e-6, uc);
  return us <= 1 ? 0 : Math.acos(1 / Math.sqrt(us));
}

/** Gray absorption coefficient of a sooty gas (1/m): Tien, κ = 1862·f_v·T with f_v = C_s/ρ_soot. */
export function sootKappa(Cs: number, T: number): number {
  return SOOT_KAPPA * (Math.max(0, Cs) / SOOT_DENSITY) * T;
}

/** Emissivity of a gas volume with mean beam length L = 3.6·V/A: ε = 1 − exp(−κ·L). */
export function gasEmissivity(Cs: number, T: number, V: number, Aenc: number): number {
  if (Cs <= 0 || V <= 0 || Aenc <= 0) return 0;
  return 1 - Math.exp(-sootKappa(Cs, T) * ((3.6 * V) / Aenc));
}

/** Visibility of a reflecting sign through smoke of soot concentration C_s (kg/m³), m (Jin: S = 3/K). */
export function visibility(Cs: number): number {
  const K = SOOT_EXTINCTION * Math.max(0, Cs);
  return K > 0 ? VISIBILITY_C / K : Infinity;
}

/** Black-body emissive power above the ambient (W/m²). */
export const emissive = (T: number, Tinf: number) => SIGMA * (T ** 4 - Tinf ** 4);

/** Buoyant exchange velocity of a hot volume over a height h (m/s, the AirLayer scale √(g·h·ΔT/T)). */
export function buoyantVelocity(h: number, dT: number, Tinf: number): number {
  return dT > 0 ? Math.sqrt((GRAVITY * gravityDown() * h * dT) / Tinf) : 0;
}
