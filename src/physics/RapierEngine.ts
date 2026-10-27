import RAPIER from '@dimforge/rapier3d-compat';
import type { Vec3 } from '@/core/types';
import type { ShapeSpec } from '@/core/shapes';
import type {
  BodyDesc,
  BodyHandle,
  BodyKind,
  BodyUserData,
  ContactEvent,
  PhysicsEngine,
  Pose,
} from './PhysicsEngine';

let initPromise: Promise<void> | null = null;
/** WASM init is global and must only happen once. */
function ensureRapier() {
  initPromise ??= RAPIER.init();
  return initPromise;
}

const GROUND_HALF = 1500;

function colliderFor(shape: ShapeSpec): RAPIER.ColliderDesc {
  let d: RAPIER.ColliderDesc;
  switch (shape.type) {
    case 'box':
      d = RAPIER.ColliderDesc.cuboid(shape.halfExtents[0], shape.halfExtents[1], shape.halfExtents[2]);
      break;
    case 'capsule':
      d = RAPIER.ColliderDesc.capsule(shape.halfHeight, shape.radius);
      break;
    case 'cylinder':
      d = RAPIER.ColliderDesc.cylinder(shape.halfHeight, shape.radius);
      break;
    case 'ball':
      d = RAPIER.ColliderDesc.ball(shape.radius);
      break;
  }
  if (shape.offset) d.setTranslation(shape.offset[0], shape.offset[1], shape.offset[2]);
  return d;
}

/** Rapier implementation of the PhysicsEngine interface. */
export class RapierEngine implements PhysicsEngine {
  private world: RAPIER.World | null = null;
  private events: RAPIER.EventQueue | null = null;
  private bodies = new Map<BodyHandle, RAPIER.RigidBody>();
  private userData = new Map<BodyHandle, BodyUserData>();
  private forced = new Set<BodyHandle>();

  async init(gravity: number) {
    await ensureRapier();
    this.world = new RAPIER.World({ x: 0, y: -gravity, z: 0 });
    this.events = new RAPIER.EventQueue(true);
    // Infinite-ish ground slab whose top face is y = 0.
    const ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(GROUND_HALF, 0.5, GROUND_HALF).setFriction(0.9), ground);
  }

  private w(): RAPIER.World {
    if (!this.world) throw new Error('PhysicsEngine not initialized');
    return this.world;
  }

  createBody(desc: BodyDesc): BodyHandle {
    const world = this.w();
    const bd = (desc.kind === 'fixed' ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic())
      .setTranslation(desc.position[0], desc.position[1], desc.position[2])
      .setRotation({ x: desc.quaternion[0], y: desc.quaternion[1], z: desc.quaternion[2], w: desc.quaternion[3] })
      .setLinearDamping(desc.linearDamping ?? 0.05)
      .setAngularDamping(desc.angularDamping ?? 0.3)
      .setCcdEnabled(desc.ccd ?? false);
    const body = world.createRigidBody(bd);

    const fractions = desc.shapes.map((s) => s.massFraction ?? 1 / desc.shapes.length);
    const total = fractions.reduce((a, b) => a + b, 0) || 1;
    desc.shapes.forEach((shape, i) => {
      const cd = colliderFor(shape)
        .setFriction(desc.friction)
        .setRestitution(desc.restitution)
        .setMass(Math.max(0.1, (desc.mass * fractions[i]) / total));
      if (desc.contactForceThreshold !== undefined) {
        cd.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
        cd.setContactForceEventThreshold(desc.contactForceThreshold);
      }
      world.createCollider(cd, body);
    });
    if (desc.lockRotations) body.lockRotations(true, true);

    this.bodies.set(body.handle, body);
    this.userData.set(body.handle, desc.userData);
    return body.handle;
  }

  removeBody(h: BodyHandle) {
    const b = this.bodies.get(h);
    if (!b || !this.world) return;
    this.world.removeRigidBody(b);
    this.bodies.delete(h);
    this.userData.delete(h);
    this.forced.delete(h);
  }

  setBodyKind(h: BodyHandle, kind: BodyKind) {
    const b = this.bodies.get(h);
    b?.setBodyType(kind === 'fixed' ? RAPIER.RigidBodyType.Fixed : RAPIER.RigidBodyType.Dynamic, true);
  }

  setRotationsLocked(h: BodyHandle, locked: boolean) {
    this.bodies.get(h)?.lockRotations(locked, true);
  }

  addForceAtPoint(h: BodyHandle, f: Vec3, p: Vec3) {
    const b = this.bodies.get(h);
    if (!b) return;
    b.addForceAtPoint({ x: f[0], y: f[1], z: f[2] }, { x: p[0], y: p[1], z: p[2] }, true);
    this.forced.add(h);
  }

  applyImpulse(h: BodyHandle, i: Vec3, p?: Vec3) {
    const b = this.bodies.get(h);
    if (!b) return;
    if (p) b.applyImpulseAtPoint({ x: i[0], y: i[1], z: i[2] }, { x: p[0], y: p[1], z: p[2] }, true);
    else b.applyImpulse({ x: i[0], y: i[1], z: i[2] }, true);
  }

  applyTorqueImpulse(h: BodyHandle, t: Vec3) {
    this.bodies.get(h)?.applyTorqueImpulse({ x: t[0], y: t[1], z: t[2] }, true);
  }

  /** Rapier keeps user forces between steps; clear them so each step starts fresh. */
  clearForces() {
    for (const h of this.forced) {
      const b = this.bodies.get(h);
      // addForceAtPoint feeds both accumulators; both must be cleared.
      b?.resetForces(false);
      b?.resetTorques(false);
    }
    this.forced.clear();
  }

  getPose(h: BodyHandle): Pose {
    const b = this.bodies.get(h);
    if (!b) return { position: [0, 0, 0], quaternion: [0, 0, 0, 1] };
    const t = b.translation();
    const r = b.rotation();
    return { position: [t.x, t.y, t.z], quaternion: [r.x, r.y, r.z, r.w] };
  }

  getLinearVelocity(h: BodyHandle): Vec3 {
    const v = this.bodies.get(h)?.linvel();
    return v ? [v.x, v.y, v.z] : [0, 0, 0];
  }

  getAngularVelocity(h: BodyHandle): Vec3 {
    const v = this.bodies.get(h)?.angvel();
    return v ? [v.x, v.y, v.z] : [0, 0, 0];
  }

  isSleeping(h: BodyHandle) {
    return this.bodies.get(h)?.isSleeping() ?? true;
  }

  wake(h: BodyHandle) {
    this.bodies.get(h)?.wakeUp();
  }

  step(dt: number) {
    const world = this.w();
    world.timestep = dt;
    world.step(this.events ?? undefined);
  }

  drainContactEvents(): ContactEvent[] {
    const out: ContactEvent[] = [];
    const world = this.world;
    if (!world || !this.events) return out;
    this.events.drainContactForceEvents((e) => {
      const b1 = world.getCollider(e.collider1())?.parent();
      const b2 = world.getCollider(e.collider2())?.parent();
      out.push({
        a: b1 ? this.userData.get(b1.handle) ?? null : null,
        b: b2 ? this.userData.get(b2.handle) ?? null : null,
        force: e.totalForceMagnitude(),
      });
    });
    return out;
  }

  bodyCount() {
    return this.bodies.size;
  }

  dispose() {
    this.events?.free();
    this.world?.free();
    this.events = null;
    this.world = null;
    this.bodies.clear();
    this.userData.clear();
    this.forced.clear();
  }
}
