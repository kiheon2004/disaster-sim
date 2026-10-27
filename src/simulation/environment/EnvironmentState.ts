import type { Vec3 } from '@/core/types';
import { AIR_DENSITY } from '@/core/units';
import { WindField } from './WindField';

/**
 * Shared environmental fields. Events WRITE here; systems READ from here.
 * New hazards add their own field (ground motion, water level, …) without touching objects.
 */
export interface EnvironmentState {
  time: number;
  airDensity: number;
  wind: WindField;
  // Future: groundMotion?: GroundMotionField; waterLevel?: number; precipitation?: number; fire?: FireField;
}

export function createEnvironment(airDensity = AIR_DENSITY): EnvironmentState {
  return { time: 0, airDensity, wind: new WindField() };
}

export type { Vec3 };
