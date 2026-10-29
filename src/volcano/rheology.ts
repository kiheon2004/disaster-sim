/**
 * Lava flow constitutive relations (Phase 28) — the lava-specific part of the flow model.
 *
 * Steady Bingham plate flow down a slope (no inertia: lava flows are viscous-dominated, Re ≪ 1 for
 * η ≳ 10² Pa·s at metre depths). Flux per unit width (m²/s) for depth h, slope angle θ, bulk density ρ,
 * plastic viscosity η, yield strength τ_y (Dragoni 1986 / MAGFLOW transition rule, Vicari et al. 2007):
 *   h_cr = τ_y / (ρ g sin θ)                      critical depth (no flow at or below it)
 *   q = (τ_y h_cr² / 3η) · (a³ − 3a²/2 + 1/2),    a = h / h_cr > 1
 *   τ_y → 0: q = ρ g sin θ h³ / (3η)             (Newtonian Nusselt film)
 */
import { GRAVITY } from '@/core/units';

export function binghamFlux(h: number, sinT: number, rho: number, eta: number, tau: number): number {
  if (!(h > 0) || !(sinT > 0) || !(eta < Infinity)) return 0;
  const drive = rho * GRAVITY * sinT;
  if (tau <= 0) return (drive * h * h * h) / (3 * eta);
  const hcr = tau / drive;
  if (h <= hcr) return 0;
  const a = h / hcr;
  return ((tau * hcr * hcr) / (3 * eta)) * (a * a * a - 1.5 * a * a + 0.5);
}

/** Critical depth (m) below which the lava does not move on the slope. */
export function criticalDepth(sinT: number, rho: number, tau: number): number {
  return sinT > 0 ? tau / (rho * GRAVITY * sinT) : Infinity;
}

/** Depth-averaged speed (m/s) of the plate flow. */
export const meanSpeed = (q: number, h: number) => (h > 0 ? q / h : 0);
