/**
 * Phase 33: tidal load along the body. The field's gradient T (∂g_i/∂x_j, row-major) gives each segment an acceleration
 * relative to the COM of Δg_i ≈ T (r_i − r_c) (linear in the offset — valid while the body is small against the distance to
 * the source and its softening). The rigid single-body model does not deform, so the differential load is reported as the
 * internal axial force across a cut: N(cut) = Σ_{segments beyond the cut} m_i · â·T (r_i − r_c), â = body axis (positive =
 * the parts are pulled apart = tension). The largest |N| over the cuts at the neck, the waist (torso / pelvis) and the hips is
 * the tidal load index in body weights (÷ m g₀). A load index, not a tissue failure criterion.
 */
import type { Vec3 } from '@/core/types';
import type { BodyModel } from './anthropometry';

const G0 = 9.80665;

export interface TidalLoad {
  /** Largest |axial force| over the cuts (N), its sign (+1 tension, −1 compression), and in body weights. */
  force: number;
  sign: number;
  bodyWeights: number;
  /** Axial gradient â·T·â (1/s²; > 0 stretches along the body). */
  axial: number;
}

/** Cuts (m above the soles in the local frame): base of the neck, waist, hips. */
const cuts = (b: BodyModel) => [b.segments[1].y0, b.segments[2].y0, b.segments[3].y0];

/**
 * @param T gradient tensor at the COM (row-major 3×3, 1/s²)
 * @param axis body axis in world space (unit), @param left the local +x (the person's left) in world space (unit)
 */
export function tidalLoad(b: BodyModel, T: ArrayLike<number>, axis: Readonly<Vec3>, left: Readonly<Vec3>): TidalLoad {
  // Acceleration of a segment centre relative to the COM, projected on the axis: â·T(d), d = (y − y_c) â + (x − x_c) l̂.
  const at = (dy: number, dx: number) => {
    const d0 = dy * axis[0] + dx * left[0], d1 = dy * axis[1] + dx * left[1], d2 = dy * axis[2] + dx * left[2];
    const a0 = T[0] * d0 + T[1] * d1 + T[2] * d2;
    const a1 = T[3] * d0 + T[4] * d1 + T[5] * d2;
    const a2 = T[6] * d0 + T[7] * d1 + T[8] * d2;
    return axis[0] * a0 + axis[1] * a1 + axis[2] * a2;
  };
  let best = 0;
  for (const yc of cuts(b)) {
    // Sum over the segments above the cut, with the axial force on the part above = Σ m_i a_i (it is pulled along +â
    // relative to the COM by that much: positive = away from the rest = tension).
    let above = 0, below = 0;
    for (const s of b.segments) {
      const f = s.mass * at(s.centre[1] - b.com[1], s.centre[0] - b.com[0]);
      if (s.centre[1] > yc) above += f;
      else below += f;
    }
    // Tension when the part above is pulled up (+) relative to the part below: N = (above − below) / 2 (both sides see the
    // same internal force; the half difference removes rounding of the COM balance Σ = 0).
    const N = (above - below) / 2;
    if (Math.abs(N) > Math.abs(best)) best = N;
  }
  const sign = best >= 0 ? 1 : -1;
  const axial = at(1, 0);
  return { force: Math.abs(best), sign, bodyWeights: Math.abs(best) / (b.mass * G0), axial };
}
