import { HumanSystem } from '../human/HumanSystem';
import { PhysiologySystem } from '../physiology/PhysiologySystem';
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
import { DeformationSystem } from './DeformationSystem';
import { GroundFailureSystem } from './GroundFailureSystem';
import { SedimentForceSystem } from './SedimentForceSystem';
import { ImpactSystem } from './ImpactSystem';
import { BlastSystem } from './BlastSystem';
import { StructuralCollapseSystem } from './StructuralCollapseSystem';
import { ThermalSystem } from './ThermalSystem';
import { GravitySystem, GravityLedgerSystem } from './GravitySystem';

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
    // Phase 31: the gravity field is prepared first (every system of the step samples the same g(x, t)).
    new GravitySystem(),
    // Phase 22: sinkholes / landslides advance the shared ground field, then (Phase 21) the
    // ground moves; every later system of the step sees the new surface.
    // Phase 23: impacts cut craters / land ejecta on the same field and pass their ground shock
    // through the ground-motion field (felt by every later system).
    new ImpactSystem(),
    new GroundFailureSystem(),
    new DeformationSystem(),
    new WindForceSystem(),
    new SeismicForceSystem(),
    // Phase 24: air-pressure waves load structures (lateral force into the structural model),
    // facade parts, bodies (ForceLedger 'blast') and the water (pressure gradient, next solver call).
    new BlastSystem(),
    new WaterSolverSystem(),
    new WaterForceSystem(),
    new SedimentForceSystem(),
    new GroundContactSystem(),
    // Phase 31: the gravity ledger is the first postPhysics system (the integrated step, before any body is spawned or removed).
    new GravityLedgerSystem(),
    new PoseSyncSystem(),
    new StructuralResponseSystem(),
    new SeismicDamageSystem(),
    new FloodDamageSystem(),
    new RoadSystem(),
    new SwaySystem(),
    new DamageSystem(),
    // Phase 33: extended people (balance, release, contact episodes, injury index) — after the contacts were drained.
    new HumanSystem(),
    // Phase 26: heat sources → heat transfer → temperatures → material factors / thermal forces, read
    // by the collapse engine right after (idle without a heat source).
    new ThermalSystem(),
    // Phase 25: member failures of this step are resolved by the collapse engine (redistribution
    // round, falling blocks, fragments, rubble) after every hazard has evaluated its damage.
    new StructuralCollapseSystem(),
    new DebrisSystem(),
    new ParticleSystem(),
    new ExposureSystem(),
    // Phase 34: physiology of extended people — after every environment system of the step (reads them, writes none).
    new PhysiologySystem(),
  ];
}
