/**
 * Mapping of the earthquake response onto the shared damage states (NORMAL … DESTROYED).
 * Used by the per-type behaviors so wind and earthquake damage combine with worst().
 */
import type { SeismicEntityState } from '../seismic/SeismicState';
import { DamageState } from './DamageState';

/** Structural damage index including foundation tilt (≥ 1 = failure). */
export function seismicDamageIndex(st: SeismicEntityState): number {
  const tilt = st.failureTilt < Infinity ? st.tiltMag / (3 * st.failureTilt) : 0;
  return Math.max(st.damage, tilt);
}

/**
 * Structural health from the earthquake (1 = intact); never exactly 0 (collapse is explicit).
 * Slender infrastructure (poles, signs, walls) has an elastic margin: small damage indices
 * come from large but recoverable sway, so they only count beyond 0.2.
 */
export function seismicHealth(st: SeismicEntityState): number {
  const D = seismicDamageIndex(st);
  const d = st.thresholds ? D : Math.max(0, (D - 0.2) / 0.8);
  return Math.max(0.001, 1 - d);
}

/** State floor from the current response: stressed while it sways hard, damaged once cracked. */
export function seismicLevel(st: SeismicEntityState): DamageState {
  if (st.foundationFailed) return DamageState.CRITICAL;
  if (st.crack > 0) return DamageState.DAMAGED;
  if (st.stress >= 0.5) return DamageState.STRESSED;
  return DamageState.NORMAL;
}
