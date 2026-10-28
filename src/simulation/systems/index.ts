import type { SimulationSystem } from './SimulationSystem';
import { WindForceSystem } from './WindForceSystem';
import { PoseSyncSystem } from './PoseSyncSystem';
import { SwaySystem } from './SwaySystem';
import { DamageSystem } from './DamageSystem';
import { DebrisSystem } from './DebrisSystem';
import { ParticleSystem } from './ParticleSystem';
import { SeismicForceSystem } from './SeismicForceSystem';
import { StructuralResponseSystem } from './StructuralResponseSystem';
import { SeismicDamageSystem } from './SeismicDamageSystem';

/**
 * Ordered system pipeline. prePhysics systems run before the physics step, postPhysics after.
 * Earthquake systems (Phase 13) are idle until an earthquake starts, so wind-only runs are
 * unchanged. Future hazards plug in here (e.g. BuoyancySystem, FireSpreadSystem).
 */
export function createDefaultSystems(): SimulationSystem[] {
  return [
    new WindForceSystem(),
    new SeismicForceSystem(),
    new PoseSyncSystem(),
    new StructuralResponseSystem(),
    new SeismicDamageSystem(),
    new SwaySystem(),
    new DamageSystem(),
    new DebrisSystem(),
    new ParticleSystem(),
  ];
}
