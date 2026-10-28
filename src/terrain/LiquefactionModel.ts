/**
 * Extension point for a future Liquefaction System — intentionally NOT implemented in Phase 13.
 *
 * Liquefaction depends on groundwater depth, fines content, relative density and cyclic stress
 * history; a simplified rule (“reclaimed land + strong shaking = liquefied”) would look
 * authoritative while being unvalidated. This interface marks where such a model would plug in:
 * it would read the soil profile (liquefactionSusceptibility), the static water level and the
 * ground-motion history at a point, and return a state the foundation/structural systems apply
 * (loss of bearing capacity, settlement, lateral spreading).
 */
import type { SoilProfile } from './SoilProfiles';

export interface LiquefactionInput {
  soil: SoilProfile;
  /** Depth of the static water level below the surface (m); Infinity when dry. */
  waterTableDepth: number;
  /** Peak horizontal ground acceleration so far at the point (m/s²). */
  peakGroundAcceleration: number;
  /** Number of significant load cycles so far. */
  cycles: number;
}

export interface LiquefactionState {
  /** 0 = intact … 1 = fully liquefied (excess pore pressure ratio). */
  poreRatio: number;
  /** Multiplier on bearing capacity (1 = unchanged). */
  bearingFactor: number;
  /** Vertical settlement (m). */
  settlement: number;
}

export interface LiquefactionModel {
  readonly id: string;
  evaluate(input: LiquefactionInput): LiquefactionState;
}

/** The only model shipped: no liquefaction. Foundations keep their full bearing capacity. */
export const NO_LIQUEFACTION: LiquefactionModel = {
  id: 'none',
  evaluate: () => ({ poreRatio: 0, bearingFactor: 1, settlement: 0 }),
};
