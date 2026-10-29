/**
 * Member and connection capacities of the structural destruction engine (Phase 25).
 *
 * APPROXIMATE, representative values built ONLY from the Phase 17 material table
 * (buildings/materials.ts) and the member box — no code check, no detailing:
 *
 *  member      check                       capacity
 *  column      crushing / Euler buckling    min(f_c·A_eff, π²·E·k·I/h²)              (= Phase 17 analysis)
 *  bearing wall compression × slenderness   f_c·t·L·fill·(1−openings)·max(0.3, 1−(h/t/40)²) (= Phase 17)
 *  beam        bending                      f_m·S·inertiaFill   (S = b·h²/6)           (= Phase 17)
 *              shear                        v_m·A_v (below)
 *  slab        one-way plate bending        f_m·t²/6·fill per metre                     (= Phase 17)
 *  connection  end shear transfer           η·V_u of the supported beam / slab edge shear
 *
 *  shear strength v_m and shear area A_v per material (member shear, NEW in Phase 25):
 *    reinforced concrete  1.5 MPa on b·0.9h       (same value as the Phase 17 RC wall shear)
 *    structural steel     f_y/√3 = 205 MPa on the web ≈ 40 % of the section area (fill × box)
 *    timber               f_v,k = 4.0 MPa (EN 338 C24) on 2/3 of the section
 *    masonry              0.3 MPa on the section (Phase 17 masonry shear)
 *  connection efficiency η (end connection / member shear — judgment values, documented):
 *    reinforced concrete 1.0 (monolithic joint), steel 0.5 (simple shear tab), timber 0.4
 *    (bolted / nailed), masonry: bearing seat 0.4·f_k on b × 0.2 m
 *  slab edge shear: 0.6 MPa (≈ EC2 v_Rd,c of thin slabs without shear reinforcement) on t × contact
 *    length (line supports) or the punching perimeter 2·(a + b) (column supports); timber floors
 *    0.3 MPa (joist hangers), masonry 0.2 MPa
 *  compression transfer (splices, bases, transfer onto beams) is governed by the members on both
 *  sides and is not checked separately; roof coverings, hosted openings and cladding anchors fail
 *  through their own facade models (wind / blast / earthquake), not under gravity.
 *
 * Dynamic increase for sudden member loss (GSA 2016 Alternate Path guidelines, nonlinear static
 * procedure): Ω_N = 1.04 + 0.45 / (θ_pra/θ_y + 0.48), with the plastic / yield rotation ratio taken
 * from the material's failure behaviour: ductile 4 (Ω ≈ 1.14), semi-ductile 1.5 (≈ 1.27), brittle 0
 * (≈ 1.98, the elastic limit 2). Applied only to the INCREASE of load caused by a sudden loss.
 *
 * Deformation capacity for energy absorption (falling-block impacts, debris strikes): chord rotation
 * θ_u = the material's Phase 17 column drift capacity (RC 0.04, steel 0.05, timber 0.06, masonry
 * 0.008) → midspan deflection δ_u = θ_u·L/2 (beams, slabs); axial members δ_u = 0.002·h (crushing
 * shortening, ≈ ε_cu-order strain — they absorb almost nothing).
 */
import { MATERIALS, type MaterialProps } from '@/buildings/materials';
import type { MaterialId } from '@/buildings/materials';

const SHEAR: Record<MaterialId, { v: number; area: (A: number, b: number, h: number, fill: number) => number; eta: number }> = {
  reinforcedConcrete: { v: 1.5e6, area: (_A, b, h) => b * 0.9 * h, eta: 1 },
  structuralSteel: { v: 205e6, area: (A, _b, _h, fill) => 0.4 * A * fill, eta: 0.5 },
  timber: { v: 4.0e6, area: (A, _b, _h, fill) => (2 / 3) * A * fill, eta: 0.4 },
  masonry: { v: 0.3e6, area: (A, _b, _h, fill) => A * fill, eta: 0.4 },
  glass: { v: 0, area: () => 0, eta: 0 },
  lightCladding: { v: 0, area: () => 0, eta: 0 },
};

const SLAB_SHEAR: Record<MaterialId, number> = {
  reinforcedConcrete: 0.6e6, structuralSteel: 0.6e6, timber: 0.3e6, masonry: 0.2e6, glass: 0, lightCladding: 0,
};

const ROTATION_RATIO = { ductile: 4, semiDuctile: 1.5, brittle: 0 } as const;

/** GSA (2016) dynamic increase factor for a sudden loss, from the material's failure behaviour. */
export function dynamicFactor(mat: MaterialProps): number {
  return 1.04 + 0.45 / (ROTATION_RATIO[mat.failure] + 0.48);
}

/** Column axial capacity (N) — same formula as the Phase 17 gravity check. */
export function columnCapacity(mat: MaterialProps, sx: number, sy: number, sz: number): number {
  const A = sx * sz * mat.fill.column;
  const I = (Math.min(sx, sz) ** 3 * Math.max(sx, sz)) / 12 * mat.inertiaFill;
  const crush = mat.compressive * A;
  const buckle = (Math.PI ** 2 * mat.E * mat.stiffnessFactor * I) / (sy * sy);
  return Math.max(1, Math.min(crush, buckle));
}

/** Bearing wall axial capacity (N) — Phase 17. */
export function wallCapacity(mat: MaterialProps, sx: number, sy: number, sz: number, openingRatio: number): number {
  const slender = Math.max(0.3, 1 - (sy / Math.max(0.05, sz) / 40) ** 2);
  return Math.max(1, mat.compressive * sz * sx * mat.fill.wall * (1 - openingRatio) * slender);
}

/** Beam flexural (N·m) and shear (N) capacity; size = [length, depth, width]. */
export function beamCapacity(id: MaterialId, _length: number, sy: number, sz: number): { M: number; V: number } {
  const mat = MATERIALS[id];
  const S = (sz * sy * sy) / 6 * mat.inertiaFill;
  const s = SHEAR[id];
  return { M: Math.max(1, mat.flexural * S), V: Math.max(1, s.v * s.area(sy * sz, sz, sy, mat.fill.beam)) };
}

/** Slab flexural capacity per metre width (N·m/m) — Phase 17. */
export function slabMomentPerM(mat: MaterialProps, t: number): number {
  return Math.max(1, mat.flexural * (t * t) / 6 * mat.fill.slab);
}

/** End-connection capacity (N) of a beam (its shear × the material's connection efficiency). */
export function beamSeatCapacity(id: MaterialId, _sx: number, sy: number, sz: number): number {
  const s = SHEAR[id];
  const mat = MATERIALS[id];
  if (id === 'masonry') return Math.max(1, Math.min(beamCapacity(id, _sx, sy, sz).V, 0.4 * mat.compressive * sz * 0.2));
  return Math.max(1, s.eta * beamCapacity(id, _sx, sy, sz).V);
}

/** Slab edge / punching shear capacity (N) over a contact length (m). */
export function slabEdgeCapacity(id: MaterialId, t: number, contact: number): number {
  return Math.max(1, SLAB_SHEAR[id] * t * contact);
}

/** Chord rotation capacity used for energy absorption (rad). */
export function rotationCapacity(mat: MaterialProps): number {
  return Math.max(0.002, mat.driftCapacity.column);
}

export { SHEAR as MEMBER_SHEAR, SLAB_SHEAR };
