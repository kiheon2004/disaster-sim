/**
 * Impact energy, momentum and the energy partition (Phase 23).
 *
 *   kinetic energy  E = ½·m·v²   (J)        momentum  p = m·v   (kg·m/s, a vector along the path)
 *   TNT equivalent  E / 4.184e9 J per tonne (the conventional definition of 1 t TNT = 4.184 GJ)
 *
 * Energy and momentum are different quantities: crater SIZE comes from the point-source scaling of
 * mass and velocity (crater.ts), not from a fraction of E; the momentum is reported (and handed to
 * Phase 24) but is mostly absorbed by the Earth.
 *
 * Partition — only what is actually computed is attributed:
 *   seismic          k_s·E (shock.ts)
 *   ejecta kinetic   Σ ½·m·v² of the launched parcels (ejecta.ts)
 *   atmosphere       energy deposited in the air during entry (drag / airburst) — computed by the
 *                    entry stage, NOT simulated as a blast in Phase 23 (Phase 24 interface)
 *   unresolved       the rest: heating, melting / vaporization, comminution, plastic work of the
 *                    target — not modelled, never relabelled as "vaporized"
 * Each consumer claims its share from one ledger, so no energy is applied twice (e.g. a future
 * atmospheric blast cannot also take the seismic share).
 */
export const TNT_J_PER_TONNE = 4.184e9;

export interface EnergyPartition {
  /** Kinetic energy at the top of the atmosphere / start (J). */
  initial: number;
  /** Lost in the atmosphere during entry (drag, ablation) or released in an airburst (J). */
  atmosphere: number;
  /** At the ground (J). */
  impact: number;
  seismic: number;
  ejectaKinetic: number;
  unresolved: number;
  /** Reserved for Phase 24 (atmospheric blast of a surface impact): 0 in Phase 23. */
  blast: number;
}

export function partition(initial: number, impact: number, seismic: number, ejectaKinetic: number): EnergyPartition {
  const atmosphere = Math.max(0, initial - impact);
  const unresolved = Math.max(0, impact - seismic - ejectaKinetic);
  return { initial, atmosphere, impact, seismic, ejectaKinetic, unresolved, blast: 0 };
}

export const tntTonnes = (E: number) => E / TNT_J_PER_TONNE;
