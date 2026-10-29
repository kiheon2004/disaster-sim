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
import { WaterSolverSystem } from './WaterSolverSystem';
import { WaterForceSystem } from './WaterForceSystem';
import { GroundContactSystem } from './GroundContactSystem';
import { FloodDamageSystem } from './FloodDamageSystem';
import { RoadSystem } from './RoadSystem';
import { ExposureSystem } from '../response/exposure';

/**
 * Ordered system pipeline. prePhysics systems run before the physics step, postPhysics after.
 * Earthquake systems (Phase 13) are idle until an earthquake starts, flood systems (Phase 14)
 * until a water event starts, so wind-only runs are unchanged. Every hazard only ADDS forces
 * (wind drag + inertial ground force + buoyancy/water drag sum on the same bodies) and its own
 * damage channel (folded with worst()), so hazards combine without conflicts.
 * Future hazards plug in here (e.g. FireSpreadSystem).
 */
export function createDefaultSystems(): SimulationSystem[] {
  return [
    new WindForceSystem(),
    new SeismicForceSystem(),
    new WaterSolverSystem(),
    new WaterForceSystem(),
    new GroundContactSystem(),
    new PoseSyncSystem(),
    new StructuralResponseSystem(),
    new SeismicDamageSystem(),
    new FloodDamageSystem(),
    new RoadSystem(),
    new SwaySystem(),
    new DamageSystem(),
    new DebrisSystem(),
    new ParticleSystem(),
    new ExposureSystem(),
  ];
}
