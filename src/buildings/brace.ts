/**
 * Phase 36 (structure 2, spec §37): diagonal braces — an educational AXIAL model, no new degree of freedom.
 *
 * A brace is a box between two joints (its local +x is the axis: yaw ψ in plan, pitch α above the horizontal; Euler
 * [0, ψ, α], three.js 'XYZ'). Its rotated AABB spans a whole bay, so it is NEVER linked by AABB contact like the other
 * members: it connects to the members whose box contains one of its two END POINTS (position ± R·[L/2, 0, 0]) within the
 * contact tolerance — a column / beam joint, a beam midpoint (chevron), a footing.
 *
 *  - Gravity: it carries nothing; its own weight hangs on its two end members (half each — the solver shares a member's
 *    load equally over its supports) through a gusset connection; its mass goes half / half into the storeys it joins
 *    (like a column).
 *  - Lateral (storey model, per brace): k = E·A·cos²α / L / 2 and V = (f_y·A + 0.3·N_cr)·cos α / 2 along its plan
 *    direction (split into building x / z by its yaw like a wall). TENSION-ONLY stiffness: braces of a storey work in pairs
 *    (X or opposite diagonals) and, slender as concentric braces are (EN 1998-1 §6.7.3: λ̄ 1.3–2.0 for X bracing), the
 *    compression diagonal buckles early — EN 1998-1 §6.7.2(2) takes only the tension diagonals into the analysis. In a
 *    symmetric storey spring each brace is in tension half of the cycles, hence the ½ on stiffness; its strength keeps the
 *    buckled partner's post-buckling residual 0.3·N_cr (ASCE 41 / FEMA 356 order) — the pair value (f_y·A + 0.3·N_cr)·cos α,
 *    halved per brace. A brace contributes only when both ends are on supported members and it spans its storey
 *    (vertical extent 0.5–1.25 × the storey height); flat or multi-storey braces are reported, not counted.
 *  - Drift capacity (members' drift failure, Phase 17 path): the axial strain of a brace at storey drift θ is
 *    ε = θ·Δy·cos α / L (Δy its vertical extent). It BUCKLES at ε = N_cr / (E·A) → θ_cr = (N_cr/EA)·L / (Δy·cos α) (a damage
 *    stage: the member is marked buckled, damage ≥ 0.5) and FRACTURES at the low-cycle strain ε_u → θ_u = ε_u·L / (Δy·cos α)
 *    — with ε_u = 1 % for steel this gives the 2–3 % storey drifts at which tested concentric braces fracture.
 * Sections: A and I from the member box (height × thickness) × the material's column fill / inertia fill (a 0.15 m steel
 * box ≈ an HSS 150×150×5).
 */
import type { Vec3 } from '@/core/types';
import { material, type MaterialId } from './materials';
import { rotateEuler } from './geometry';
import type { BuildingMember } from './types';

/** Low-cycle fracture strain of a brace (axial, averaged over its length) by material. */
export const BRACE_FRACTURE_STRAIN: Partial<Record<MaterialId, number>> = { structuralSteel: 0.01, timber: 0.004 };
const DEFAULT_FRACTURE_STRAIN = 0.003;
/** Damage index a brace takes when it buckles (DAMAGED: stiffness × (1 − 0.4·0.5) in the storey model). */
export const BUCKLED_DAMAGE = 0.5;
/** Default brace section (m, square box). */
export const BRACE_SECTION = 0.15;

/** Unit axis of a brace (building-local). */
export function braceAxis(m: Pick<BuildingMember, 'rotation'>): Vec3 {
  return rotateEuler([1, 0, 0], m.rotation);
}

/** End points of a brace (building-local, object scale applied). */
export function braceEnds(m: BuildingMember, k: Vec3 = [1, 1, 1]): [Vec3, Vec3] {
  const a = braceAxis(m), h = m.size[0] / 2;
  const p = (s: number): Vec3 => [(m.position[0] + s * h * a[0]) * k[0], (m.position[1] + s * h * a[1]) * k[1], (m.position[2] + s * h * a[2]) * k[2]];
  return [p(-1), p(1)];
}

/** Rank of a member type as a brace end (the vertical member carries the joint first). */
const END_RANK: Partial<Record<BuildingMember['type'], number>> = { column: 0, wall: 1, beam: 2, foundation: 3, slab: 4 };

/**
 * End members of a brace: at each end the best member whose box contains the end point within `tol` (column > wall >
 * beam > footing > slab; then the smaller index); −1 = dangling. `box(j)` gives a member's [min, max] (or null when it is
 * not a candidate — failed, non-structural, another brace).
 */
export function braceEndMembers(ends: readonly Vec3[], n: number, type: (j: number) => BuildingMember['type'], box: (j: number) => { min: Vec3; max: Vec3 } | null, tol: number): [number, number] {
  const pick = (p: Vec3) => {
    let best = -1, rank = Infinity;
    for (let j = 0; j < n; j++) {
      const r = END_RANK[type(j)];
      if (r === undefined || r >= rank) continue;
      const b = box(j);
      if (!b) continue;
      if (p[0] < b.min[0] - tol || p[0] > b.max[0] + tol || p[1] < b.min[1] - tol || p[1] > b.max[1] + tol || p[2] < b.min[2] - tol || p[2] > b.max[2] + tol) continue;
      best = j; rank = r;
    }
    return best;
  };
  return [pick(ends[0]), pick(ends[1])];
}

export interface BraceProps {
  /** Length, plan length, vertical extent (m), cos α. */
  L: number;
  lh: number;
  dy: number;
  cosA: number;
  /** Axial area (m²), weak-axis inertia (m⁴), E (Pa), Euler load N_cr and yield force f_y·A (N). */
  A: number;
  I: number;
  E: number;
  Ncr: number;
  Ny: number;
  /** Storey stiffness (N/m) and yield shear (N) of the brace along its plan direction (tension-only, see the header). */
  k: number;
  V: number;
  /** Storey drift at buckling and at fracture (rad). */
  thetaCr: number;
  thetaU: number;
}

/** Axial properties of a brace (scaled size). */
export function braceProps(m: BuildingMember, size: Vec3, k: Vec3 = [1, 1, 1]): BraceProps {
  const mat = material(m.material);
  const [p0, p1] = braceEnds(m, k);
  const L = Math.max(0.1, Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]));
  const lh = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
  const dy = Math.abs(p1[1] - p0[1]);
  const cosA = lh / L;
  const E = mat.E * mat.stiffnessFactor;
  const [, sy, sz] = size;
  const A = sy * sz * mat.fill.column;
  const I = (Math.min(sy * sz ** 3, sz * sy ** 3) / 12) * mat.inertiaFill;
  const Ncr = (Math.PI * Math.PI * E * I) / (L * L);
  const Ny = mat.compressive * A;
  const eps = BRACE_FRACTURE_STRAIN[m.material] ?? DEFAULT_FRACTURE_STRAIN;
  const lever = Math.max(1e-6, dy * cosA);
  return {
    L, lh, dy, cosA, A, I, E, Ncr, Ny,
    k: (E * A * cosA * cosA) / L / 2,
    V: ((Ny + 0.3 * Math.min(Ncr, Ny)) * cosA) / 2,
    thetaCr: ((Math.min(Ncr, Ny) / (E * A)) * L) / lever,
    thetaU: (eps * L) / lever,
  };
}

/** A brace member between two joints (building-local); level = the storey of its lower end. */
export function braceBetween(id: string, a: Vec3, b: Vec3, level: number, mat: MaterialId, section = BRACE_SECTION): BuildingMember {
  const v: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const lh = Math.hypot(v[0], v[2]);
  const L = Math.hypot(lh, v[1]);
  // Local +x → (cos α cos ψ, sin α, −cos α sin ψ) with Euler [0, ψ, α] (Rz first, then Ry).
  let yaw = lh > 1e-9 ? Math.atan2(-v[2], v[0]) : 0;
  let pitch = Math.atan2(v[1], lh);
  if (Math.abs(yaw) < 1e-12) yaw = 0;
  if (Math.abs(pitch) < 1e-12) pitch = 0;
  return {
    id, type: 'brace', role: 'primary', level, material: mat,
    position: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
    rotation: [0, yaw, pitch],
    size: [Math.max(0.05, L), section, section],
  };
}
