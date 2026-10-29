/**
 * Damage composition policy shared by the unified damage system (Phase 15) and the structural
 * destruction engine (Phase 25): strength degrades with the damage index D as F·(1 − 0.3·D)
 * (the StructuralModel's own law). Damage indices of different hazards measure the same physical
 * degradation and are combined as an ENVELOPE (max), never summed.
 */
export const STRENGTH_LOSS = 0.3;
