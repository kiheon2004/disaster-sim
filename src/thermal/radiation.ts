/**
 * Thermal radiation (Phase 26). Gray, diffuse surfaces: absorptivity = emissivity (Kirchhoff).
 *
 *  surface ↔ surroundings      q = ε·σ·(T⁴ − T_sur⁴), T_sur = the ambient reference (sky and distant
 *                              surroundings at ambient: no solar input, no night-sky depression — so a
 *                              world at ambient is exactly in equilibrium)
 *  point source → receiver     isotropic emitter: absorbed = ε·P_rad·Ω/(4π), Ω ≈ A_proj/r² (solid angle
 *                              of a small receiver; capped at 2π), A_proj the projected area of the
 *                              receiver's box toward the source (exact for a box: Σ face area·|cos|)
 *  sphere (T_s, R) → receiver  view factor of a small surface facing a sphere F = (R/r)² (capped at 1):
 *                              q = ε_r·σ·(T_s⁴ − T_r⁴)·A_proj·F — the sphere is a black body (ε = 1)
 * Building-to-building exchange (view factors between arbitrary surfaces) is NOT computed; every
 * surface exchanges with the ambient surroundings (documented approximation).
 */
import { SIGMA } from './units';

/** Net radiative flux from a surface at T to surroundings at Tsur (W/m²). */
export const radiativeFlux = (eps: number, T: number, Tsur: number) => eps * SIGMA * (T * T * T * T - Tsur * Tsur * Tsur * Tsur);

/** Tangent radiative coefficient 4εσT³ (W/(m²·K)) — explicit stability bound. */
export const hRadTangent = (eps: number, T: number) => 4 * eps * SIGMA * T * T * T;

/** Projected area of an axis-aligned box (sizes sx, sy, sz) toward the unit direction (dx, dy, dz). */
export function projectedArea(sx: number, sy: number, sz: number, dx: number, dy: number, dz: number): number {
  return sy * sz * Math.abs(dx) + sx * sz * Math.abs(dy) + sx * sy * Math.abs(dz);
}

/**
 * Fraction of an isotropic point source's radiated power that reaches a receiver of projected area
 * A_proj at distance r: Ω/(4π) with Ω = A_proj/r², capped at a hemisphere (2π) for receivers that
 * enclose / touch the source.
 */
export function pointFraction(Aproj: number, r: number): number {
  const omega = Math.min(2 * Math.PI, Aproj / Math.max(1e-6, r * r));
  return omega / (4 * Math.PI);
}

/** View factor of a small surface facing a sphere of radius R at centre distance r. */
export const sphereViewFactor = (R: number, r: number) => (r <= R ? 1 : (R * R) / (r * r));
