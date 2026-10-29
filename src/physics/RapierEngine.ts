import RAPIER from '@dimforge/rapier3d-compat';
import type { Quat, Vec3 } from '@/core/types';
import type { ShapeSpec } from '@/core/shapes';
import type {
  TerrainColliderDesc,
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
  initPromise ??= RAPIER.init().then(warmUp);
  return initPromise;
}

/**
 * Exercise the solver's code paths once on a THROWAWAY world (boxes / a ball resting and colliding
 * on a heightfield and a slab), so the browser compiles them while the simulation is still loading
 * (Phase 22: the first real step took ~50 ms in Chrome, 0.5 ms in Node). The simulation's own
 * world is not touched — nothing is skipped or pre-computed for it.
 */
function warmUp() {
  const t0 = performance.now();
  const w = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const ground = w.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const n = 9;
  const h = new Float32Array(n * n).map((_, i) => 0.1 * Math.sin(i));
  w.createCollider(RAPIER.ColliderDesc.heightfield(n - 1, n - 1, h, { x: 8, y: 1, z: 8 }, RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES), ground);
  w.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.5, 20).setTranslation(30, -0.5, 0), ground);
  for (let k = 0; k < 8; k++) {
    const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation((k % 4) - 2, 0.6 + Math.floor(k / 4) * 1.1, (k % 3) - 1));
    w.createCollider(k % 2 ? RAPIER.ColliderDesc.cuboid(0.4, 0.4, 0.4) : RAPIER.ColliderDesc.ball(0.4), b);
  }
  const q = new RAPIER.EventQueue(true);
  for (let i = 0; i < 30; i++) w.step(q);
  q.free();
  w.free();
  warmUpMs = performance.now() - t0;
}
/** Cost of the solver warm-up at initialization (ms; first-frame analysis). */
export let warmUpMs = 0;

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

/** Rapier worlds alive (created − freed) — resource-lifecycle checks (Phase 23 stress test). */
export const rapierWorlds = { live: 0, created: 0 };

/** Rapier implementation of the PhysicsEngine interface. */
export class RapierEngine implements PhysicsEngine {
  private world: RAPIER.World | null = null;
  private events: RAPIER.EventQueue | null = null;
  private bodies = new Map<BodyHandle, RAPIER.RigidBody>();
  private userData = new Map<BodyHandle, BodyUserData>();
  private forced = new Set<BodyHandle>();
  private ground: RAPIER.RigidBody | null = null;
  /**
   * Contact state from Rapier's collision events (Phase 32.1): every body collider carries COLLISION_EVENTS, so the
   * narrow phase reports each collider pair when it starts / stops having solver contacts (removals included). Pairs
   * with contacts (key "c1:c2" → the two bodies, whether one collider is the terrain heightfield) and, per body, how
   * many of them it is in. `touching` reads the counts — the same predicate as asking the narrow phase pair by pair
   * (touchingQuery), without a WASM callback per pair. Exception: a heightfield pair starts with contact points inside
   * the prediction distance even when the heightfield produced no solver contact (measured, Rapier 0.21), so a body
   * whose only pairs are with the heightfield is asked directly.
   */
  private activePairs = new Map<string, [BodyHandle, BodyHandle, boolean]>();
  private touchCount = new Map<BodyHandle, number>();
  private hfCount = new Map<BodyHandle, number>();
  private heightfields = new Set<number>();
  private colliderBody = new Map<number, BodyHandle>();
  /** Bodies whose type changed: the narrow phase may drop or revive their pairs without an event (a pair of two fixed
   *  bodies is no longer computed) — after the next step their pairs are taken from the narrow phase directly. */
  private resync = new Set<BodyHandle>();

  async init(gravity: number, terrain: TerrainColliderDesc | null = null) {
    await ensureRapier();
    this.world = new RAPIER.World({ x: 0, y: -gravity, z: 0 });
    rapierWorlds.live++;
    rapierWorlds.created++;
    this.events = new RAPIER.EventQueue(true);
    this.setTerrain(terrain);
  }

  /**
   * Flat ground: one infinite-ish slab whose top face is y = 0 (unchanged since Phase 1).
   * Terrain: a Rapier heightfield over the grid (the exact triangles the renderer draws) plus
   * four slabs around it carrying the y = 0 surroundings.
   */
  setTerrain(terrain: TerrainColliderDesc | null) {
    const world = this.w();
    if (this.ground) world.removeRigidBody(this.ground);
    const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    this.ground = ground;
    if (!terrain) {
      world.createCollider(RAPIER.ColliderDesc.cuboid(GROUND_HALF, 0.5, GROUND_HALF).setFriction(0.9).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), ground);
      return;
    }
    const { nx, nz, cellSize, originX, originZ, heights, friction } = terrain;
    const sx = (nx - 1) * cellSize;
    const sz = (nz - 1) * cellSize;
    // Rapier: (nrows+1)×(ncols+1) heights, column-major, rows along z and columns along x,
    // centered on the collider origin.
    const cm = new Float32Array(nx * nz);
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) cm[ix * nz + iz] = heights[iz * nx + ix];
    const hf = world.createCollider(
      RAPIER.ColliderDesc.heightfield(nz - 1, nx - 1, cm, { x: sx, y: 1, z: sz }, RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES)
        .setTranslation(originX + sx / 2, 0.5, originZ + sz / 2)
        .setFriction(friction)
        // Contact state (Phase 32.1): a removed collider reports the end of its contacts only when it carries the flag.
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      ground,
    );
    this.heightfields.add(hf.handle);
    // Surroundings (top at y = 0): north/south strips span the full width, east/west fill the rest.
    const x0 = originX;
    const x1 = originX + sx;
    const z0 = originZ;
    const z1 = originZ + sz;
    const slab = (cx: number, cz: number, hx: number, hz: number) =>
      world.createCollider(RAPIER.ColliderDesc.cuboid(hx, 0.5, hz).setTranslation(cx, 0, cz).setFriction(0.9).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), ground);
    const northDepth = (z0 + GROUND_HALF) / 2;
    const southDepth = (GROUND_HALF - z1) / 2;
    slab(0, z0 - northDepth, GROUND_HALF, northDepth);
    slab(0, z1 + southDepth, GROUND_HALF, southDepth);
    const westW = (x0 + GROUND_HALF) / 2;
    const eastW = (GROUND_HALF - x1) / 2;
    slab(x0 - westW, (z0 + z1) / 2, westW, sz / 2);
    slab(x1 + eastW, (z0 + z1) / 2, eastW, sz / 2);
  }

  castGroundRay(origin: Vec3, dir: Vec3, maxDist: number): number | null {
    const g = this.ground;
    if (!g) return null;
    const ray = new RAPIER.Ray({ x: origin[0], y: origin[1], z: origin[2] }, { x: dir[0], y: dir[1], z: dir[2] });
    let best: number | null = null;
    for (let i = 0; i < g.numColliders(); i++) {
      const toi = g.collider(i).castRay(ray, maxDist, true);
      if (toi >= 0 && (best === null || toi < best)) best = toi;
    }
    return best;
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
        cd.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS | RAPIER.ActiveEvents.COLLISION_EVENTS);
        cd.setContactForceEventThreshold(desc.contactForceThreshold);
      } else cd.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      const c = world.createCollider(cd, body);
      this.colliderBody.set(c.handle, body.handle);
    });
    if (desc.lockRotations) body.lockRotations(true, true);

    this.bodies.set(body.handle, body);
    this.userData.set(body.handle, desc.userData);
    return body.handle;
  }

  removeBody(h: BodyHandle) {
    const b = this.bodies.get(h);
    if (!b || !this.world) return;
    for (let i = 0; i < b.numColliders(); i++) this.colliderBody.delete(b.collider(i).handle);
    this.world.removeRigidBody(b);
    this.bodies.delete(h);
    this.userData.delete(h);
    this.forced.delete(h);
  }

  setBodyKind(h: BodyHandle, kind: BodyKind) {
    const b = this.bodies.get(h);
    b?.setBodyType(kind === 'fixed' ? RAPIER.RigidBodyType.Fixed : RAPIER.RigidBodyType.Dynamic, true);
    if (b) this.resync.add(h);
  }

  setRotationsLocked(h: BodyHandle, locked: boolean) {
    this.bodies.get(h)?.lockRotations(locked, true);
  }

  addForceAtPoint(h: BodyHandle, f: Vec3, p: Vec3, wake = true) {
    const b = this.bodies.get(h);
    if (!b) return;
    b.addForceAtPoint({ x: f[0], y: f[1], z: f[2] }, { x: p[0], y: p[1], z: p[2] }, wake);
    this.forced.add(h);
  }

  setFriction(h: BodyHandle, friction: number) {
    const b = this.bodies.get(h);
    if (!b) return;
    for (let i = 0; i < b.numColliders(); i++) b.collider(i).setFriction(friction);
  }

  setContactForceThreshold(h: BodyHandle, threshold: number) {
    const b = this.bodies.get(h);
    if (!b) return;
    for (let i = 0; i < b.numColliders(); i++) {
      const c = b.collider(i);
      if (c.activeEvents() & RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS) c.setContactForceEventThreshold(threshold);
    }
  }

  addForce(h: BodyHandle, f: Vec3, wake = true) {
    const b = this.bodies.get(h);
    if (!b) return;
    b.addForce({ x: f[0], y: f[1], z: f[2] }, wake);
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

  setBodyPose(h: BodyHandle, position: Vec3, quaternion: Quat) {
    const b = this.bodies.get(h);
    if (!b) return;
    b.setTranslation({ x: position[0], y: position[1], z: position[2] }, true);
    b.setRotation({ x: quaternion[0], y: quaternion[1], z: quaternion[2], w: quaternion[3] }, true);
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

  getMass(h: BodyHandle) {
    return this.bodies.get(h)?.mass() ?? 0;
  }

  hasBody(h: BodyHandle) {
    return this.bodies.has(h);
  }

  isSleeping(h: BodyHandle) {
    return this.bodies.get(h)?.isSleeping() ?? true;
  }

  wake(h: BodyHandle) {
    this.bodies.get(h)?.wakeUp();
  }

  sleep(h: BodyHandle) {
    this.bodies.get(h)?.sleep();
  }

  setGravity(g: Readonly<Vec3>) {
    const w = this.w();
    w.gravity = { x: g[0], y: g[1], z: g[2] };
  }

  getGravity(): Vec3 {
    const v = this.w().gravity;
    return [v.x, v.y, v.z];
  }

  readMotion(h: BodyHandle, pos: Float64Array, vel: Float64Array, o: number) {
    const b = this.bodies.get(h);
    if (!b) { pos[o] = pos[o + 1] = pos[o + 2] = 0; vel[o] = vel[o + 1] = vel[o + 2] = 0; return; }
    const t = b.translation(), v = b.linvel();
    pos[o] = t.x; pos[o + 1] = t.y; pos[o + 2] = t.z;
    vel[o] = v.x; vel[o + 1] = v.y; vel[o + 2] = v.z;
  }

  writeMotion(h: BodyHandle, pos: ArrayLike<number>, vel: ArrayLike<number>) {
    const b = this.bodies.get(h);
    if (!b) return;
    b.setTranslation({ x: pos[0], y: pos[1], z: pos[2] }, false);
    b.setLinvel({ x: vel[0], y: vel[1], z: vel[2] }, false);
  }

  touching(h: BodyHandle) {
    if ((this.touchCount.get(h) ?? 0) > 0) return true;
    return (this.hfCount.get(h) ?? 0) > 0 && this.touchingQuery(h);
  }

  isDynamic(h: BodyHandle) {
    return this.bodies.get(h)?.isDynamic() ?? false;
  }

  /** The narrow phase asked pair by pair: a collider pair of the body with at least one solver contact (reference of `touching`). */
  touchingQuery(h: BodyHandle) {
    const b = this.bodies.get(h);
    const world = this.world;
    if (!b || !world) return false;
    let hit = false;
    for (let i = 0; i < b.numColliders() && !hit; i++) {
      const c = b.collider(i);
      world.contactPairsWith(c, (other) => {
        if (hit) return;
        world.contactPair(c, other, (m) => { if (m.numSolverContacts() > 0) hit = true; });
      });
    }
    return hit;
  }

  linearDamping(h: BodyHandle) {
    return this.bodies.get(h)?.linearDamping() ?? 0;
  }

  freeKappa() {
    const n = this.w().integrationParameters.numSolverIterations;
    return (n + 1) / (2 * n);
  }

  step(dt: number) {
    const world = this.w();
    world.timestep = dt;
    world.step(this.events ?? undefined);
    this.events?.drainCollisionEvents((c1, c2, started) => {
      const key = c1 < c2 ? `${c1}:${c2}` : `${c2}:${c1}`;
      if (started) {
        if (this.activePairs.has(key)) return;
        const b1 = this.colliderBody.get(c1), b2 = this.colliderBody.get(c2);
        this.hold([b1 ?? -1, b2 ?? -1, this.heightfields.has(c1) || this.heightfields.has(c2)], key);
      } else {
        const pair = this.activePairs.get(key);
        if (!pair) return;
        this.activePairs.delete(key);
        this.release(pair);
      }
    });
    if (this.resync.size) {
      for (const h of this.resync) this.resyncBody(world, h);
      this.resync.clear();
    }
  }

  private hold(pair: [BodyHandle, BodyHandle, boolean], key: string) {
    this.activePairs.set(key, pair);
    const count = pair[2] ? this.hfCount : this.touchCount;
    for (let i = 0; i < 2; i++) {
      const b = pair[i] as BodyHandle;
      if (b >= 0) count.set(b, (count.get(b) ?? 0) + 1);
    }
  }

  private release(pair: [BodyHandle, BodyHandle, boolean]) {
    const count = pair[2] ? this.hfCount : this.touchCount;
    for (let i = 0; i < 2; i++) {
      const b = pair[i] as BodyHandle;
      if (b < 0) continue;
      const n = (count.get(b) ?? 0) - 1;
      if (n > 0) count.set(b, n); else count.delete(b);
    }
  }

  /** The pairs of one body as the narrow phase has them now (pairs with at least one solver contact). */
  private resyncBody(world: RAPIER.World, h: BodyHandle) {
    for (const [key, pair] of this.activePairs) if (pair[0] === h || pair[1] === h) { this.activePairs.delete(key); this.release(pair); }
    const b = this.bodies.get(h);
    if (!b) return;
    for (let i = 0; i < b.numColliders(); i++) {
      const c = b.collider(i);
      world.contactPairsWith(c, (other) => {
        let hit = false;
        world.contactPair(c, other, (m) => { if (m.numSolverContacts() > 0) hit = true; });
        if (!hit) return;
        const c1 = c.handle, c2 = other.handle;
        const key = c1 < c2 ? `${c1}:${c2}` : `${c2}:${c1}`;
        if (this.activePairs.has(key)) return;
        this.hold([h, this.colliderBody.get(c2) ?? -1, this.heightfields.has(c2)], key);
      });
    }
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
    if (this.world) rapierWorlds.live--;
    this.world?.free();
    this.events = null;
    this.world = null;
    this.ground = null;
    this.bodies.clear();
    this.activePairs.clear();
    this.touchCount.clear();
    this.hfCount.clear();
    this.heightfields.clear();
    this.colliderBody.clear();
    this.resync.clear();
    this.userData.clear();
    this.forced.clear();
  }
}
