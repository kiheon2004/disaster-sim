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

export interface PhysicsEngine {
  init(gravity: number): Promise<void>;
  createBody(desc: BodyDesc): BodyHandle;
  removeBody(h: BodyHandle): void;
  setBodyKind(h: BodyHandle, kind: BodyKind): void;
  setRotationsLocked(h: BodyHandle, locked: boolean): void;
  /** Persistent force for the next step (cleared by clearForces). */
  addForceAtPoint(h: BodyHandle, force: Vec3, worldPoint: Vec3): void;
  applyImpulse(h: BodyHandle, impulse: Vec3, worldPoint?: Vec3): void;
  applyTorqueImpulse(h: BodyHandle, torque: Vec3): void;
  clearForces(): void;
  getPose(h: BodyHandle): Pose;
  getLinearVelocity(h: BodyHandle): Vec3;
  getAngularVelocity(h: BodyHandle): Vec3;
  isSleeping(h: BodyHandle): boolean;
  wake(h: BodyHandle): void;
  step(dt: number): void;
  drainContactEvents(): ContactEvent[];
  bodyCount(): number;
  dispose(): void;
}
