/**
 * Structural destruction engine (Phase 25) — shared types.
 *
 * Member states are explicit; every transition goes through `canTransition` (no silent jumps):
 *
 *   INTACT ─▶ DAMAGED ─▶ SEVERE              (damage index 0.3 / 0.7, still carrying load)
 *     │         │          │
 *     └─────────┴──────────┴─▶ FAILED        (capacity exceeded, support / connection lost, struck)
 *                               ▶ DETACHED   (released from the structure — carries nothing)
 *                               ▶ FALLING    (inside the building: a falling block of the engine;
 *                                             outside: a Rapier fragment or aggregated rubble)
 *                               ▶ RESTING    (came to rest ON a lower part of the building: its
 *                                             weight is now a load on the members under it)
 *                               ▶ SETTLED    (on the ground: rubble pile / settled fragment)
 *   ABSENT: broken in the ORIGINAL world (initial damage 1) — never part of the structure.
 */
export const MS = {
  INTACT: 0,
  DAMAGED: 1,
  SEVERE: 2,
  FAILED: 3,
  DETACHED: 4,
  FALLING: 5,
  RESTING: 6,
  SETTLED: 7,
  ABSENT: 8,
} as const;
export type MemberState = (typeof MS)[keyof typeof MS];
export const MEMBER_STATE_KEYS = ['intact', 'damaged', 'severe', 'failed', 'detached', 'falling', 'resting', 'settled', 'absent'] as const;

/** Still part of the load-carrying structure. */
export const inStructure = (s: number) => s <= MS.SEVERE;

const ALLOWED: Record<number, readonly number[]> = {
  [MS.INTACT]: [MS.DAMAGED, MS.SEVERE, MS.FAILED],
  [MS.DAMAGED]: [MS.SEVERE, MS.FAILED],
  [MS.SEVERE]: [MS.FAILED],
  [MS.FAILED]: [MS.DETACHED],
  [MS.DETACHED]: [MS.FALLING, MS.SETTLED],
  [MS.FALLING]: [MS.RESTING, MS.SETTLED],
  // Rubble resting on a floor falls again when that floor gives way.
  [MS.RESTING]: [MS.FALLING, MS.SETTLED],
  [MS.SETTLED]: [],
  [MS.ABSENT]: [],
};

export function canTransition(from: number, to: number): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

/** Damage index thresholds of the damaged / severe states. */
export const DAMAGED_AT = 0.3;
export const SEVERE_AT = 0.7;

/**
 * Connection (load-transfer edge) kinds. Only connections that transfer gravity load between
 * members exist in the graph; lateral (drift) behavior stays in the Phase 13/17 story model.
 */
export const CK = {
  /** beam end → column / wall (seat, shear tab, monolithic joint) */
  BEAM_SEAT: 0,
  /** secondary beam → primary beam */
  BEAM_BEAM: 1,
  /** column / wall → the column / wall below (vertical continuity, compression) */
  SPLICE: 2,
  /** column / wall → foundation */
  BASE: 3,
  /** column / wall standing on a beam / slab (transfer) */
  TRANSFER: 4,
  /** slab → beam / wall / column */
  SLAB: 5,
  /** roof covering → what is under it */
  ROOF: 6,
  /** window / door → host wall */
  HOSTED: 7,
  /** non-structural wall / cladding hanging from the frame or stacked on a wall */
  ANCHOR: 8,
} as const;
export type ConnectionKind = (typeof CK)[keyof typeof CK];
export const CONNECTION_KEYS = ['beamSeat', 'beamBeam', 'splice', 'base', 'transfer', 'slab', 'roof', 'hosted', 'anchor'] as const;

/**
 * Immediate cause of a member failure. The hazard behind it is kept separately (attribution).
 *  - drift:        story drift beyond the member's drift capacity (earthquake, blast, impact shock)
 *  - axial:        compression / buckling capacity exceeded (redistributed gravity load)
 *  - bending:      flexural capacity exceeded (beams, slabs)
 *  - shear:        shear capacity exceeded (beams)
 *  - connection:   a load-transfer connection failed and nothing else held it
 *  - support:      lost its load path (everything it rested on is gone)
 *  - impact:       arrested a falling block / was struck by debris beyond its energy capacity
 *  - foundation:   the ground under a foundation member gave way (gap, explicit support loss)
 *  - bearing:      soil bearing pressure under a foundation member beyond its ultimate value
 *  - story:        sidesway collapse of its story decided by the lumped story model (lateral
 *                  mechanism: earthquake damage index, wind fatigue, flood / sediment load)
 *  - overpressure: out-of-plane wall failure under an air-pressure wave (Phase 24 SDOF)
 *  - facade:       a facade part (cladding, window, door, roof covering) detached by its own model
 *  - removed:      taken out by the user's removal preview in the building editor (alternate-path check)
 */
export type FailCause = 'drift' | 'axial' | 'bending' | 'shear' | 'connection' | 'support' | 'impact' | 'foundation' | 'bearing' | 'story' | 'overpressure' | 'facade' | 'removed' | 'thermal';
/** 'thermal' (Phase 26): axial capacity exceeded by restrained thermal expansion (thermal buckling of a beam) — appended last. */
export const FAIL_CAUSES: readonly FailCause[] = ['drift', 'axial', 'bending', 'shear', 'connection', 'support', 'impact', 'foundation', 'bearing', 'story', 'overpressure', 'facade', 'removed', 'thermal'];

/** Ratio of expected (mean) to characteristic strength: a member fails at u ≥ OVERLOAD. */
export const OVERLOAD = 1.25;
