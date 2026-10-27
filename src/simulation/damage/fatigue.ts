import { clamp } from '@/core/math';
import { DamageState } from './DamageState';

/** Load ratio above which material fatigue accumulates. */
export const FATIGUE_ONSET = 0.7;
/** Load ratio at which an element is considered "stressed" (visible strain). */
export const STRESS_ONSET = 0.3;
const FATIGUE_RATE = 0.0417;

/**
 * Health loss per step. At load ratio 1.0 and durability 50 an element fails after ~40 s;
 * higher loads or lower durability fail faster. Above `breakThreshold` failure is instant.
 */
export function applyFatigue(health: number, ratio: number, durability: number, breakThreshold: number, dt: number): number {
  if (ratio >= breakThreshold) return 0;
  if (ratio <= FATIGUE_ONSET) return health;
  const rate = FATIGUE_RATE * (ratio - FATIGUE_ONSET) * (100 / Math.max(5, durability));
  return clamp(health - rate * dt, 0, 1);
}

export function loadLevel(ratio: number): DamageState {
  return ratio >= STRESS_ONSET ? DamageState.STRESSED : DamageState.NORMAL;
}

export function healthLevel(health: number): DamageState {
  if (health <= 0) return DamageState.DESTROYED;
  if (health < 0.5) return DamageState.CRITICAL;
  if (health < 0.88) return DamageState.DAMAGED;
  return DamageState.NORMAL;
}
