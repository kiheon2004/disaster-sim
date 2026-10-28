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
  userData: BodyUserData;
}

export interface ContactEvent {
  a: BodyUserData | null;
  b: BodyUserData | null;
  /** Total contact force magnitude (N). */
  force: number;
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
  createBody(desc: BodyDesc): BodyHandle;
  removeBody(h: BodyHandle): void;
  setBodyKind(h: BodyHandle, kind: BodyKind): void;
  setRotationsLocked(h: BodyHandle, locked: boolean): void;
  /** Persistent force for the next step (cleared by clearForces). */
  addForceAtPoint(h: BodyHandle, force: Vec3, worldPoint: Vec3): void;
  /** Force through the center of mass for the next step (no torque; cleared by clearForces). */
  addForce(h: BodyHandle, force: Vec3): void;
  applyImpulse(h: BodyHandle, impulse: Vec3, worldPoint?: Vec3): void;
  applyTorqueImpulse(h: BodyHandle, torque: Vec3): void;
  clearForces(): void;
  getPose(h: BodyHandle): Pose;
  getLinearVelocity(h: BodyHandle): Vec3;
  getAngularVelocity(h: BodyHandle): Vec3;
  isSleeping(h: BodyHandle): boolean;
  /** Total mass of a body (kg). */
  getMass(h: BodyHandle): number;
  wake(h: BodyHandle): void;
  /** Put a body to sleep (it wakes on the next applied force or contact change). */
  sleep(h: BodyHandle): void;
  step(dt: number): void;
  drainContactEvents(): ContactEvent[];
  bodyCount(): number;
  dispose(): void;
}
