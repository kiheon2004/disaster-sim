import type { EntityId, Quat, Vec3 } from '@/core/types';
import type { ShapeSpec } from '@/core/shapes';

/**
 * Engine-agnostic physics interface. The simulation only talks to this,
 * so Rapier can be swapped (or mocked in tests) without touching simulation code.
 */
export type BodyHandle = number;
export type BodyKind = 'fixed' | 'dynamic';

export interface BodyUserData {
  entityId: EntityId;
  /** Set for detached component debris. */
  debrisId?: string;
  /** Phase 33: report contact events of this body with their force vector and contact point (ContactEvent.detail). */
  detail?: boolean;
}

/** Phase 35: a world ray hit (PhysicsEngine.castRay). */
export interface RayHit {
  toi: number;
  normal: Vec3;
  point: Vec3;
  /** Hit body (null = the ground body). */
  body: BodyHandle | null;
  user: BodyUserData | null;
}

export interface BodyDesc {
  kind: BodyKind;
  position: Vec3;
  quaternion: Quat;
  /** Shapes in body local space (already scaled). */
  shapes: ShapeSpec[];
  /** Total mass, distributed over shapes by massFraction (or equally). */
  mass: number;
  friction: number;
  restitution: number;
  lockRotations?: boolean;
  linearDamping?: number;
  angularDamping?: number;
  ccd?: boolean;
  /** Report contact forces above this magnitude (N) via drainContactEvents. */
  contactForceThreshold?: number;
  /**
   * Phase 33: explicit mass properties (local COM, principal moments along the local axes) instead of the colliders'
   * uniform density — `mass` is then the whole mass, the colliders carry none.
   * Phase 35: `frame` = rotation of the principal axes in the body frame (identity when absent; passive objects with an
   * asymmetric part model, e.g. a sofa).
   */
  massProps?: { com: Vec3; inertia: Vec3; frame?: Quat };
  userData: BodyUserData;
}

export interface ContactEvent {
  a: BodyUserData | null;
  b: BodyUserData | null;
  /** Total contact force magnitude (N). */
  force: number;
  /**
   * Phase 33 (only when a or b asked for `detail`): the step's total contact force ON a (N, world; Rapier reports the solver
   * impulse of the step / dt, so J = F·dt), the impulse-weighted world contact point, the unit normal from a to b, and the
   * solver contact points themselves as (x, y, z, normal impulse) quadruples (a contact spread along a body).
   */
  detail?: { F: Vec3; P: Vec3; n: Vec3; pts: number[] };
}

export interface Pose {
  position: Vec3;
  quaternion: Quat;
}

/**
 * Static ground collider built from the terrain grid (see terrain/TerrainPhysicsAdapter).
 * Heights are row-major (index = iz·nx + ix); cells split along their (x1,z0)–(x0,z1) diagonal.
 * Outside the grid the ground continues as the y = 0 plane.
 */
export interface TerrainColliderDesc {
  nx: number;
  nz: number;
  cellSize: number;
  originX: number;
  originZ: number;
  heights: Float32Array;
  friction: number;
}

export interface PhysicsEngine {
  /** `terrain` null → infinite flat ground at y = 0. */
  init(gravity: number, terrain?: TerrainColliderDesc | null): Promise<void>;
  /** Replace the ground collider (one rebuild — call once per finished edit, not per frame). */
  setTerrain(terrain: TerrainColliderDesc | null): void;
  /** Distance along a unit ray to the ground collider (null = no hit within maxDist). */
  castGroundRay(origin: Vec3, dir: Vec3, maxDist: number): number | null;
  /**
   * Phase 35: closest hit of a unit ray against every collider of the world (ground, buildings, rubble, other bodies) except the
   * colliders of `exclude` and of bodies whose user data `skip` rejects. Returns the distance, the surface normal (unit, facing
   * the ray origin), the hit point and the hit body (null = the ground) — null when nothing is within maxDist.
   */
  castRay(origin: Vec3, dir: Vec3, maxDist: number, exclude: BodyHandle | null, skip?: (u: BodyUserData) => boolean): RayHit | null;
  createBody(desc: BodyDesc): BodyHandle;
  removeBody(h: BodyHandle): void;
  setBodyKind(h: BodyHandle, kind: BodyKind): void;
  /**
   * Move a body to a pose (Phase 21: fixed bodies following deforming ground; dynamic bodies
   * lifted by uplifting ground). Wakes the body; velocities are kept.
   */
  setBodyPose(h: BodyHandle, position: Vec3, quaternion: Quat): void;
  setRotationsLocked(h: BodyHandle, locked: boolean): void;
  /**
   * Change the contact friction of every collider of a body in place (no collider rebuild;
   * Phase 14 ground-contact friction). The engine combines it with the ground's friction.
   */
  setFriction(h: BodyHandle, friction: number): void;
  /**
   * Persistent force for the next step (cleared by clearForces). `wake` = false leaves a sleeping
   * body asleep (static loads such as buoyancy in still water, Phase 14).
   */
  addForceAtPoint(h: BodyHandle, force: Vec3, worldPoint: Vec3, wake?: boolean): void;
  /** Force through the center of mass for the next step (no torque; cleared by clearForces). `wake` as addForceAtPoint. */
  addForce(h: BodyHandle, force: Vec3, wake?: boolean): void;
  /** Contact-force event threshold (N) of every collider of a body (Phase 31: resting weight changes with gravity). */
  setContactForceThreshold(h: BodyHandle, threshold: number): void;
  applyImpulse(h: BodyHandle, impulse: Vec3, worldPoint?: Vec3): void;
  applyTorqueImpulse(h: BodyHandle, torque: Vec3): void;
  clearForces(): void;
  getPose(h: BodyHandle): Pose;
  getLinearVelocity(h: BodyHandle): Vec3;
  getAngularVelocity(h: BodyHandle): Vec3;
  isSleeping(h: BodyHandle): boolean;
  /** Total mass of a body (kg). */
  getMass(h: BodyHandle): number;
  /** The body exists (not removed). */
  hasBody(h: BodyHandle): boolean;
  wake(h: BodyHandle): void;
  /** Put a body to sleep (it wakes on the next applied force or contact change). */
  sleep(h: BodyHandle): void;
  step(dt: number): void;
  /**
   * Uniform gravity of the world (m/s², Phase 31 — the gravity experiment's global part; per-body differences of a
   * spatial field go through the ForceLedger). Sleeping bodies are NOT woken (the caller decides, see GravityRuntime).
   */
  setGravity(g: Readonly<Vec3>): void;
  getGravity(): Vec3;
  /** Position and linear velocity of a body into flat arrays at `o` (no Pose objects; ledgers over many bodies). */
  readMotion(h: BodyHandle, pos: Float64Array, vel: Float64Array, o: number): void;
  /**
   * Phase 32 (celestial orbit integrator): set a body's position and linear velocity (rotation and angular velocity
   * kept; the body is not woken or put to sleep).
   */
  writeMotion(h: BodyHandle, pos: ArrayLike<number>, vel: ArrayLike<number>): void;
  /** Phase 33: set a body's linear and angular velocity (world; wakes it) — the release of a standing person's lean. */
  setVelocity(h: BodyHandle, v: Readonly<Vec3>, w: Readonly<Vec3>): void;
  /** Phase 35: take a body out of the simulation (no collisions, no motion) or put it back (a seated vehicle occupant). */
  setBodyEnabled(h: BodyHandle, enabled: boolean): void;
  /** The body had a solver contact in the last step (any collider, ground included). */
  touching(h: BodyHandle): boolean;
  /** The body is dynamic (not fixed / kinematic) — Phase 32.1: only dynamic bodies take the orbit integrator. */
  isDynamic(h: BodyHandle): boolean;
  /** Linear damping coefficient of a body (1/s; v ← v/(1 + d·dt) per step). */
  linearDamping(h: BodyHandle): number;
  /**
   * Position response of the integrator to a constant acceleration a over one step: x₁ = x₀ + v₀·dt + κ·a·dt²
   * (κ = ½ for an exact constant-acceleration step, 1 for semi-implicit Euler; Rapier's n solver substeps give
   * (n + 1)/(2n)). The velocity response is v₁ = (v₀ + a·dt)/(1 + d·dt).
   */
  freeKappa(): number;
  drainContactEvents(): ContactEvent[];
  bodyCount(): number;
  dispose(): void;
}
