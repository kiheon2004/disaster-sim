/**
 * Structural type profiles (Phase 35.5, structure model v2) — how a member of each structural material behaves past its
 * capacity, how its joints behave, how it fails and what debris it leaves. Read only by the v2 collapse behaviour; the v1
 * engine (every building of an older file) never reads it.
 *
 * Member law (reduced, educational — not a nonlinear section analysis): a member's utilization u = demand / capacity (the
 * solver's dynamic utilization, the drift / drift capacity of a lateral member, …) is mapped to a damage index and a residual
 * capacity factor:
 *
 *      u ≤ 1                    elastic        D = 0,                      capacity × 1
 *      1 < u ≤ uPlastic         yielding/plastic D grows linearly to Dp,   capacity × 1 (hardening neglected)
 *      uPlastic < u ≤ uFracture softening      D → 1 − residual,           capacity × (1 → residual)
 *      u > uFracture            fracture       FAILED
 *
 * so a ductile steel frame member keeps carrying load far past first yield, an RC member softens, an unreinforced masonry
 * wall goes from cracking to failure almost at once and a timber member is limited by its connections. The v1 engine fails
 * a member at u ≥ 1.25 directly (structure/types.ts OVERLOAD) — the v2 law is anchored so that uFracture of RC is the same 1.25.
 *
 * Joints: `hingeRelease` is the rotation (rad) a connection along a hinge line accommodates while a detached part of the
 * building rotates about it (ductile steel bends far, masonry tears almost at once) — falling blocks lean / topple about it
 * before they fall free (structure/collapse.ts v2).
 *
 * Values are order-of-magnitude, chosen from the materials' ductility classes (Eurocode 8 behaviour factors q: steel MRF ≈ 4–6,
 * RC frames ≈ 3–4.5, timber ≈ 2–3, unreinforced masonry ≈ 1.5) — not design values.
 */
import type { MaterialId } from './materials';

export type StructuralType = 'steel' | 'rc' | 'masonry' | 'timber' | 'light';

export interface StructuralTypeProfile {
  type: StructuralType;
  /** Utilization at the end of the plastic plateau and at fracture (u = demand / capacity). */
  uPlastic: number;
  uFracture: number;
  /** Damage index at the end of the plateau. */
  Dp: number;
  /** Capacity left just before fracture (fraction). */
  residual: number;
  /** Rotation (rad) the connections of a hinge line take before a rotating part tears off. */
  hingeRelease: number;
  /** Joint behaviour (documentation / inspector). */
  joint: 'rigid' | 'semiRigid' | 'pinned';
  /** Typical failure modes, most likely first (i18n keys structType.mode.*). */
  modes: string[];
  /**
   * Debris: fragment size factor (× member size) and dust factor (relative). Phase 36: read by the renderer only — a
   * fragment body is drawn as round(1 / debrisSize) pieces inside its box, dust puffs are scaled by `dust`
   * (rendering/sim/debrisVisual.ts); the physics bodies, their masses and the particle counts do not depend on them.
   */
  debrisSize: number;
  dust: number;
}

export const STRUCTURAL_TYPES: Record<StructuralType, StructuralTypeProfile> = {
  steel: { type: 'steel', uPlastic: 1.35, uFracture: 1.8, Dp: 0.35, residual: 0.5, hingeRelease: 0.6, joint: 'rigid', modes: ['yield', 'buckling', 'connection'], debrisSize: 1, dust: 0.2 },
  rc: { type: 'rc', uPlastic: 1.1, uFracture: 1.25, Dp: 0.3, residual: 0.35, hingeRelease: 0.25, joint: 'rigid', modes: ['flexure', 'shear', 'punching'], debrisSize: 0.5, dust: 1 },
  masonry: { type: 'masonry', uPlastic: 1.0, uFracture: 1.08, Dp: 0.5, residual: 0.15, hingeRelease: 0.06, joint: 'pinned', modes: ['inPlaneShear', 'outOfPlane', 'crushing'], debrisSize: 0.25, dust: 1.4 },
  timber: { type: 'timber', uPlastic: 1.15, uFracture: 1.45, Dp: 0.3, residual: 0.4, hingeRelease: 0.35, joint: 'semiRigid', modes: ['connection', 'splitting', 'bending'], debrisSize: 0.8, dust: 0.3 },
  light: { type: 'light', uPlastic: 1.0, uFracture: 1.1, Dp: 0.5, residual: 0.2, hingeRelease: 0.15, joint: 'pinned', modes: ['cladding', 'connection'], debrisSize: 1, dust: 0.1 },
};

/** Structural type of a member material. */
export function typeOfMaterial(m: MaterialId): StructuralType {
  return m === 'structuralSteel' ? 'steel' : m === 'reinforcedConcrete' ? 'rc' : m === 'masonry' ? 'masonry' : m === 'timber' ? 'timber' : 'light';
}

export type MemberStage = 'elastic' | 'plastic' | 'softening' | 'fracture';

/** Member law: damage index, residual capacity factor and stage for a utilization u. */
export function memberLaw(p: StructuralTypeProfile, u: number): { D: number; cap: number; stage: MemberStage } {
  if (!(u > 1)) return { D: 0, cap: 1, stage: 'elastic' };
  if (u <= p.uPlastic) return { D: (p.Dp * (u - 1)) / Math.max(1e-9, p.uPlastic - 1), cap: 1, stage: 'plastic' };
  if (u <= p.uFracture) {
    const f = (u - p.uPlastic) / Math.max(1e-9, p.uFracture - p.uPlastic);
    return { D: p.Dp + (1 - p.Dp) * f * 0.99, cap: 1 - (1 - p.residual) * f, stage: 'softening' };
  }
  return { D: 1, cap: 0, stage: 'fracture' };
}
