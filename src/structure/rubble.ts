/**
 * Rubble pile geometry (Phase 25): what a collapsed part of a building leaves on the ground.
 *
 * Volume: the fallen members' solid volume (mass / material density) × a bulking factor of 1.6
 * (broken concrete / masonry rubble occupies ≈ 1.4–1.7 × its solid volume — porosity ≈ 0.3–0.4).
 * Shape: a flat-topped mound over the footprint the block fell on, its sides at the angle of
 * repose of rubble, 37° (crushed concrete / masonry rubble ≈ 35–40°). Over a W × D rectangle with
 * side slope run s = 1/tan(37°):
 *     V(H) = W·D·H + (W + D)·s·H² + (π/3)·s²·H³     (top + edge prisms + corner cones)
 * solved for the height H (Newton, monotonic). The mass is exact; the shape is an APPROXIMATION
 * (real piles are irregular; larger pieces may roll farther — those are separate rigid fragments).
 */
export const BULKING = 1.6;
export const REPOSE = (37 * Math.PI) / 180;
const S = 1 / Math.tan(REPOSE);

/** Bulk volume of rubble from a solid volume (m³). */
export const bulkVolume = (solid: number) => solid * BULKING;

/** Volume of the mound of height H over a W × D rectangle (m³). */
export function moundVolume(W: number, D: number, H: number): number {
  return W * D * H + (W + D) * S * H * H + (Math.PI / 3) * S * S * H * H * H;
}

/** Height of a mound of volume V over W × D (m). */
export function moundHeight(W: number, D: number, V: number): number {
  if (V <= 0) return 0;
  // Bracket: flat-top only gives an upper bound.
  let H = Math.min(V / Math.max(1e-6, W * D), Math.cbrt((3 * V) / (Math.PI * S * S)));
  for (let k = 0; k < 40; k++) {
    const f = moundVolume(W, D, H) - V;
    const df = W * D + 2 * (W + D) * S * H + Math.PI * S * S * H * H;
    const next = H - f / df;
    if (!(next > 0)) { H /= 2; continue; }
    if (Math.abs(next - H) < 1e-10 * Math.max(1, H)) { H = next; break; }
    H = next;
  }
  return H;
}

/** Height of the mound at a point at distance `d` (m) outside its footprint rectangle (0 inside → H). */
export function moundHeightAt(H: number, d: number): number {
  return d <= 0 ? H : Math.max(0, H - d / S);
}

/** Horizontal reach of the slopes beyond the footprint (m). */
export const moundReach = (H: number) => H * S;

/** Fraction of the mound volume outside its footprint. */
export function outsideFraction(W: number, D: number, H: number): number {
  const V = moundVolume(W, D, H);
  return V > 0 ? 1 - (W * D * H) / V : 0;
}

/** A rubble pile on the ground (building-local or world frame, as the owner decides). */
export interface RubblePile {
  x0: number; z0: number; x1: number; z1: number;
  /** Ground level under it (m). */
  y: number;
  mass: number;
  /** Bulk volume (m³) and resulting height (m). */
  volume: number;
  height: number;
}

/** Recompute the height of a pile from its volume and footprint. */
export function settlePile(p: RubblePile): RubblePile {
  p.height = moundHeight(Math.max(0.1, p.x1 - p.x0), Math.max(0.1, p.z1 - p.z0), p.volume);
  return p;
}

/** Height of a pile at a point (same frame as the pile). */
export function pileHeightAt(p: RubblePile, x: number, z: number): number {
  const dx = Math.max(p.x0 - x, 0, x - p.x1), dz = Math.max(p.z0 - z, 0, z - p.z1);
  const d = dx > 0 && dz > 0 ? Math.hypot(dx, dz) : Math.max(dx, dz);
  return moundHeightAt(p.height, d);
}
