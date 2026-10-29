/**
 * Snow and ice relations (Phase 30) — pure functions, SI.
 *
 *  new-snow density      Anderson (1976) as in CLM 4.5 (Oleson et al. 2013, §8.6):
 *                        ρ = 50 + 1.7·(T − T_f + 15)^1.5 for T_f − 15 < T ≤ T_f + 2; 50 below; 169 above
 *  compaction            CLM 4.5 §8.6 (after Anderson 1976): CR = CR₁ + CR₂ (1/s, ≤ 0),
 *                          destructive metamorphism CR₁ = −c₃·c₁·c₂·exp(−c₄·(T_f − T)),
 *                            c₃ = 2.777·10⁻⁶ s⁻¹, c₄ = 0.04 K⁻¹, c₁ = 1 (ρ ≤ 100) or exp(−0.046(ρ − 100)),
 *                            c₂ = 2 with liquid water, else 1
 *                          overburden CR₂ = −P_s/η, η = η₀·exp(c₅(T_f − T))·exp(c₆ρ), η₀ = 9·10⁵ kg·s/m²,
 *                            c₅ = 0.08 K⁻¹, c₆ = 0.023 m³/kg, P_s = half the pack's own mass per area (kg/m² — CLM's unit)
 *                        melt compaction is the mass that melts at constant density (depth = mass/ρ)
 *                        ρ' = ρ·exp(−CR·Δt) (exact for the step's rates; the mass never changes); ρ ≤ 550
 *  conductivity          Calonne et al. (2011): k = 2.5·10⁻⁶ρ² − 1.23·10⁻⁴ρ + 0.024 W/(m·K)
 *  albedo                Douville, Royer & Mahfouf (1995): dry snow −0.008 per day, melting snow relaxes to
 *                        0.50 with 0.24 per day, fresh snow raises it by (0.85 − α)·min(1, new SWE / 10 kg·m⁻²), 0.50–0.85;
 *                        volcanic ash darkens it toward 0.1 (exponential mixing with an ash load of 0.5 kg/m²)
 *  enthalpy node         U (J) relative to liquid water at 0 °C, mass M (kg):
 *                          U < −L_f·M       all frozen, T = T_f + (U + L_f·M)/(c_i·M)
 *                          −L_f·M ≤ U ≤ 0   T = T_f, liquid = M + U/L_f
 *                          U > 0            all liquid above 0 °C (the cover is gone — it drains)
 *  interception          Hedstrom & Pomeroy (1998): I_max = S̄·(0.27 + 46/ρ_new)·LAI, S̄ = 6.6 kg/m²,
 *                        ΔI = (I_max − I)·(1 − exp(−P/I_max)) per crown projected area
 */
import { gravityDown } from '@/thermal/gravityScope';
import { C_ICE, L_F, SNOW_ALBEDO_MAX, SNOW_ALBEDO_MIN, ASH_ALBEDO, RHO_SNOW_MAX, RHO_SNOW_MIN, T_MELT } from './constants';

/** Density of new snow (kg/m³) falling through air at T (K). */
export function freshSnowDensity(T: number): number {
  const x = T - T_MELT;
  if (x > 2) return 50 + 1.7 * Math.pow(17, 1.5);
  if (x > -15) return 50 + 1.7 * Math.pow(x + 15, 1.5);
  return RHO_SNOW_MIN;
}

/** Thermal conductivity of snow (W/(m·K)), Calonne et al. 2011 (ρ in kg/m³). */
export function snowConductivity(rho: number): number {
  const r = Math.max(RHO_SNOW_MIN, Math.min(917, rho));
  return Math.max(0.025, 2.5e-6 * r * r - 1.23e-4 * r + 0.024);
}

/** Compaction rate CR (1/s, ≤ 0) of a single-layer pack: density ρ, temperature T, mass per area W (kg/m²), liquid present. */
export function compactionRate(rho: number, T: number, W: number, liquid: boolean): number {
  const dT = Math.max(0, T_MELT - T);
  const c1 = rho <= 100 ? 1 : Math.exp(-0.046 * (rho - 100));
  const c2 = liquid ? 2 : 1;
  const cr1 = -2.777e-6 * c1 * c2 * Math.exp(-0.04 * dT);
  const eta = 9e5 * Math.exp(0.08 * dT) * Math.exp(0.023 * rho);
  // Overburden: the stress is g·W — W (kg/m²) was fitted at Earth g, so it enters as the weight ratio (Phase 31).
  const gd = gravityDown();
  const cr2 = -(0.5 * (gd === 1 ? W : W * gd)) / eta;
  return cr1 + cr2;
}

/** Density after compaction over dt (mass unchanged): ρ·exp(−CR·dt), capped at the firn transition. */
export function compact(rho: number, T: number, W: number, liquid: boolean, dt: number): number {
  if (rho >= RHO_SNOW_MAX) return rho;
  return Math.min(RHO_SNOW_MAX, rho * Math.exp(-compactionRate(rho, T, W, liquid) * dt));
}

/** Snow albedo after dt (s): dry ageing / melting relaxation, then the refresh by new snow (kg/m² SWE). */
export function snowAlbedo(a: number, dt: number, melting: boolean, newSwe: number): number {
  const days = dt / 86400;
  let x = melting ? (a - SNOW_ALBEDO_MIN) * Math.exp(-0.24 * days) + SNOW_ALBEDO_MIN : a - 0.008 * days;
  // Douville et al. (1995): the fresh snow restores a share min(1, P/10 kg·m⁻²) of the gap to the maximum.
  if (newSwe > 0) x += (SNOW_ALBEDO_MAX - x) * Math.min(1, newSwe / 10);
  return Math.max(SNOW_ALBEDO_MIN, Math.min(SNOW_ALBEDO_MAX, x));
}

/** Albedo of snow darkened by volcanic ash (kg/m² on the snow). */
export function ashyAlbedo(a: number, ash: number): number {
  if (!(ash > 0)) return a;
  const f = 1 - Math.exp(-ash / 0.5);
  return a * (1 - f) + ASH_ALBEDO * f;
}

/** Phase state of an enthalpy node: temperature (K) and liquid mass (kg). */
export function phaseState(U: number, M: number): { T: number; liquid: number } {
  if (!(M > 0)) return { T: T_MELT, liquid: 0 };
  const Lm = L_F * M;
  if (U < -Lm) return { T: T_MELT + (U + Lm) / (C_ICE * M), liquid: 0 };
  if (U <= 0) return { T: T_MELT, liquid: M + U / L_F };
  return { T: T_MELT + U / (4186 * M), liquid: M };
}

/** Enthalpy (J, relative to liquid at 0 °C) of `frozen` kg of ice at T ≤ T_f (liquid at 0 °C adds nothing). */
export const enthalpyOf = (frozen: number, T: number) => frozen * (C_ICE * (Math.min(T, T_MELT) - T_MELT) - L_F);

/** Apparent heat capacity (J/K) of a node for the stability / implicit update: c_i·M when frozen, "infinite" while melting. */
export function nodeCapacity(U: number, M: number): number {
  if (!(M > 0)) return 0;
  return U < -L_F * M ? C_ICE * M : Infinity;
}

/** Maximum interception load (kg/m² of crown projection), Hedstrom & Pomeroy 1998. */
export const interceptionMax = (rhoNew: number, lai: number) => 6.6 * (0.27 + 46 / Math.max(RHO_SNOW_MIN, rhoNew)) * lai;

/** Interception increment (kg/m²) of snowfall P (kg/m²) on a crown holding I. */
export function intercept(I: number, P: number, Imax: number): number {
  if (!(P > 0) || !(Imax > I)) return 0;
  return (Imax - I) * (1 - Math.exp(-P / Imax));
}

/**
 * Albedo of a pack that exists at the start: its density stands in for its age (fresh 100 kg/m³ → 0.85, settled
 * 400 kg/m³ → ≈ 0.62, the old-snow values of Douville et al. 1995 / Gray & Male 1981).
 */
export function initialSnowAlbedo(rho: number): number {
  const f = Math.max(0, Math.min(1, (rho - 100) / 450));
  return SNOW_ALBEDO_MAX - f * (SNOW_ALBEDO_MAX - SNOW_ALBEDO_MIN);
}
