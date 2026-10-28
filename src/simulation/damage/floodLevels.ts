import { DamageState, worst } from './DamageState';
import { healthLevel } from './fatigue';
import type { FloodEntityState } from '../flood/FloodState';
import { FLOOD_DEPTH } from '../water/waterParams';

/**
 * Flood contribution to the shared NORMAL … DESTROYED states (Phase 14), combined with the wind
 * and earthquake contributions by worst(): standing in ≥ 0.1 m of water or a flood load above
 * 30 % of capacity → STRESSED; the flood damage channel (health) → DAMAGED / CRITICAL /
 * DESTROYED with the same thresholds as fatigue.
 */
export function floodLevel(st: FloodEntityState): DamageState {
  let s = healthLevel(st.health);
  if (st.depth >= FLOOD_DEPTH || st.loadRatio >= 0.3) s = worst(s, DamageState.STRESSED);
  return s;
}
