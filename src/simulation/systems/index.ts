import type { SimulationSystem } from './SimulationSystem';
import { WindForceSystem } from './WindForceSystem';
import { PoseSyncSystem } from './PoseSyncSystem';
import { SwaySystem } from './SwaySystem';
import { DamageSystem } from './DamageSystem';
import { DebrisSystem } from './DebrisSystem';
import { ParticleSystem } from './ParticleSystem';

/**
 * Ordered system pipeline. prePhysics systems run before the physics step, postPhysics after.
 * Future hazards plug in here (e.g. GroundShakeSystem, BuoyancySystem, FireSpreadSystem).
 */
export function createDefaultSystems(): SimulationSystem[] {
  return [
    new WindForceSystem(),
    new PoseSyncSystem(),
    new SwaySystem(),
    new DamageSystem(),
    new DebrisSystem(),
    new ParticleSystem(),
  ];
}
