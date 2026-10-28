import type { Vec3 } from '@/core/types';
import type { ShapeSpec } from '@/core/shapes';
import type { WorldDocument, WorldObject } from '@/core/model';
import { quatFromEuler, seededRandom } from '@/core/math';
import { getDefinition } from '@/objects/registry';
import type { BodyHandle, PhysicsEngine } from '@/physics/PhysicsEngine';
import { broadsideArea } from './damage/windLoad';
import { DamageState } from './damage/DamageState';
import { createSampleCache } from './wind/SpatialWindField';
import type { RuntimeEntity, SimulationRuntime } from './SimulationRuntime';
import { groundFrictionFactor } from '@/terrain/GroundMaterials';
import { samplerFor, type TerrainSampler } from '@/terrain/TerrainSampler';
import { foundationPlinth } from '@/terrain/groundPlacement';
import { newForceRecord } from './forces/ForceLedger';

/** Apply a (possibly non-uniform) object scale to a local collision shape. */
export function scaleShape(s: ShapeSpec, k: Vec3): ShapeSpec {
  const offset: Vec3 | undefined = s.offset ? [s.offset[0] * k[0], s.offset[1] * k[1], s.offset[2] * k[2]] : undefined;
  const r = Math.max(k[0], k[2]);
  switch (s.type) {
    case 'box':
      return { ...s, offset, halfExtents: [s.halfExtents[0] * k[0], s.halfExtents[1] * k[1], s.halfExtents[2] * k[2]] };
    case 'capsule':
      return { ...s, offset, halfHeight: s.halfHeight * k[1], radius: s.radius * r };
    case 'cylinder':
      return { ...s, offset, halfHeight: s.halfHeight * k[1], radius: s.radius * r };
    case 'ball':
      return { ...s, offset, radius: s.radius * Math.max(k[0], k[1], k[2]) };
  }
}

/** Contact-force threshold so resting contact is ignored but impacts are reported. */
export const impactThreshold = (mass: number) => Math.max(800, mass * 9.81 * 2.5);

export function createEntityBody(physics: PhysicsEngine, e: Pick<RuntimeEntity, 'source' | 'def' | 'profile' | 'initialPose' | 'groundFriction'>, dynamic: boolean, plinth = 0): BodyHandle {
  const o = e.source;
  const shapes = e.def.colliders(o.params).map((s) => scaleShape(s, o.transform.scale));
  // Slope foundation plinth (buildings on terrain, Phase 13): solid down to the ground.
  if (plinth > 0) {
    const d = e.def.getDimensions(o.params);
    const k = o.transform.scale;
    shapes.push({ type: 'box', halfExtents: [(d[0] * k[0]) / 2 + 0.1, plinth / 2, (d[2] * k[2]) / 2 + 0.1], offset: [0, -plinth / 2, 0] });
  }
  return physics.createBody({
    kind: dynamic ? 'dynamic' : 'fixed',
    position: e.initialPose.position,
    quaternion: e.initialPose.quaternion,
    shapes,
    mass: o.physics.mass,
    // Free-standing bodies grip according to the ground they start on (approximate; ×1 on grass).
    friction: o.physics.friction * e.groundFriction,
    restitution: o.physics.restitution,
    lockRotations: e.profile === 'upright',
    linearDamping: 0.05,
    angularDamping: e.profile === 'upright' ? 0.8 : 0.35,
    contactForceThreshold: dynamic ? impactThreshold(o.physics.mass) : undefined,
    userData: { entityId: o.id },
  });
}

/** Living things vary: ±15 % for trees, ±10 % for people (deterministic per object seed). */
function naturalStrength(o: WorldObject): number {
  const spread = o.type === 'tree' ? 0.15 : o.type === 'human' ? 0.1 : 0;
  return 1 + (seededRandom(o.seed ^ 0x5bd1e995)() * 2 - 1) * spread;
}

function buildEntity(o: WorldObject, physics: PhysicsEngine, terrain: TerrainSampler): RuntimeEntity {
  const def = getDefinition(o.type);
  const k = o.transform.scale;
  const d = def.getDimensions(o.params);
  const cop = def.centerOfPressure(o.params);
  const pose = { position: [...o.transform.position] as Vec3, quaternion: quatFromEuler(o.transform.rotation) };
  const profile = def.physicsProfile;
  // Free-standing profiles start dynamic unless the user anchored them.
  const dynamic = (profile === 'dynamic' || profile === 'upright') && !o.physics.anchored;
  const groundFriction = profile === 'dynamic' || profile === 'upright' ? groundFrictionFactor(terrain.sampleGroundType(pose.position[0], pose.position[2])) : 1;

  const e: RuntimeEntity = {
    id: o.id,
    source: o,
    def,
    profile,
    body: null,
    dynamic,
    pose: { position: [...pose.position] as Vec3, quaternion: [...pose.quaternion] as typeof pose.quaternion },
    initialPose: pose,
    dims: [d[0] * k[0], d[1] * k[1], d[2] * k[2]],
    copLocal: [cop[0] * k[0], cop[1] * k[1], cop[2] * k[2]],
    area: broadsideArea(o),
    areaFactor: def.frontalArea
      ? Math.min(1, def.frontalArea(o.params) / (Math.max(d[0], d[2]) * d[1]))
      : 1,
    strength: naturalStrength(o),
    groundFriction,
    state: DamageState.NORMAL,
    health: 1,
    loadRatio: 0,
    peakLoadRatio: 0,
    windAtCop: 0,
    localWind: { velocity: [0, 0, 0], speed: 0, freeStream: 0, global: 0, shelter: 1, turbulence: 0, shadowSource: null, corner: false },
    windLoad: 0,
    peakState: DamageState.NORMAL,
    lastCause: null,
    lastHazard: null,
    components: o.components.map((spec) => ({
      spec,
      state: DamageState.NORMAL,
      health: 1,
      condition: 'intact' as const,
      loadRatio: 0,
    })),
    visual: { swayAngle: 0, swayAxis: [1, 0, 0], brace: 0, foliageLoss: 0, swayVel: 0 },
    flags: {},
    displacement: 0,
    quietSteps: 0,
    restRef: [0, 0, 0],
    rev: 0,
    windCache: createSampleCache(),
    counters: {},
    // Allocated / declared up front (not added lazily) so every entity keeps one object shape
    // in the hot loops (a property added later changes V8's hidden class for that object).
    forces: newForceRecord(),
    seismic: undefined,
    flood: undefined,
    integrity: undefined,
    exposure: undefined,
  };
  e.body = def.inert || def.colliders(o.params).length === 0 ? null : createEntityBody(physics, e, dynamic, foundationPlinth(o, terrain));
  if (def.inert) e.dynamic = false;
  return e;
}

/** WorldDocument (read-only) → fresh SimulationRuntime with physics bodies. */
export function buildRuntime(doc: Readonly<WorldDocument>, physics: PhysicsEngine, terrain: TerrainSampler = samplerFor(doc.terrain)): SimulationRuntime {
  const entities = new Map<string, RuntimeEntity>();
  for (const o of Object.values(doc.objects)) entities.set(o.id, buildEntity(o, physics, terrain));
  return { entities, debris: [], particles: [], particlesTime: 0, debrisRev: 0, debrisCounter: 0, log: [] };
}
