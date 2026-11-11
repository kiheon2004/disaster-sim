/**
 * Fragments of the structural engine as rigid bodies (Phase 25).
 *
 * Members that leave a building's plan (thrown by its motion, blown out by a wave, facade parts
 * shaken / torn off) become Rapier bodies with EXACTLY the member's mass and the velocity they had
 * (inherited from the structure's motion or the impulse a wave gave them — nothing is added). They
 * collide with the ground, vehicles, people, other buildings and each other; contact forces drive
 * the secondary damage (secondary.ts).
 *
 * Budget (Physics LOD): at most FRAGMENT_LIMITS.active moving fragments; a fragment at rest for 0.5 s becomes a
 * FIXED body (no solver cost, still collides); beyond FRAGMENT_LIMITS.total bodies the oldest resting fragment
 * is merged into the rubble field at its place. A fragment that cannot get a body (over the active
 * budget) lands as aggregated rubble at its ballistic landing point. Nothing is dropped silently:
 * every kilogram moves between the building's ledger accounts (bodies → rubble / left).
 */
import type { Vec3 } from '@/core/types';
import { GRAVITY } from '@/core/units';
import { memberMaterial } from '@/structure/graph';
import { bulkVolume } from '@/structure/rubble';
import { FALL_MIN } from '@/structure/collapse';
import { MATERIALS } from '@/buildings/materials';
import { newForceRecord } from '../forces/ForceLedger';
import type { DebrisPiece, RuntimeEntity } from '../SimulationRuntime';
import type { SystemContext } from '../systems/SimulationSystem';
import { structuresOf, structureOf, toWorld, dirToWorld } from './state';
import { memberColor } from '@/buildings/memberColor';
import { hazardOf } from '../systems/StructuralCollapseSystem';
import { nudgeOutOfBoxes } from './colliders';

/** Fragment body budget (Physics LOD): moving bodies, all bodies. Mutable for tests / benchmarks. */
export const FRAGMENT_LIMITS = { active: 160, total: 600 };
/** Steps at rest before a fragment becomes a fixed body. */
const REST_STEPS = 30;

/** Number of fragments still simulated (not fixed). */
function moving(ctx: SystemContext): number {
  let n = 0;
  for (const d of structuresOf(ctx.runtime).fragments) if (!d.structural!.settled) n++;
  return n;
}

/** Current local centre of a member (fallen members displaced). */
function localCentre(e: RuntimeEntity, i: number): Vec3 {
  const m = e.modular!.structure!.model, g = m.g, o = 6 * i;
  return [(g.box[o] + g.box[o + 3]) / 2 + m.dx[i], (g.box[o + 1] + g.box[o + 4]) / 2 + m.dy[i], (g.box[o + 2] + g.box[o + 5]) / 2 + m.dz[i]];
}

/**
 * Hand a member to the physics engine (or aggregate it). `vLocal`: its velocity in the building's
 * frame (m/s). The member must already be FALLING + external in the model (exit / facade).
 */
export function spawnFragment(ctx: SystemContext, e: RuntimeEntity, i: number, vLocal: Vec3, hazard: string) {
  const st = structureOf(e, ctx);
  const m = st.model, g = m.g, o = 6 * i;
  const S = structuresOf(ctx.runtime);
  const mass = g.mass[i];
  const local = localCentre(e, i);
  const size: Vec3 = [g.box[o + 3] - g.box[o], (g.box[o + 4] - g.box[o + 1]) * m.sy[i], g.box[o + 5] - g.box[o + 2]];
  // Out of the building's own collider (the standing part): nudge across the nearest face of the plan.
  // Phase 36 (structure v2): once the body follows the structural cells, only out of the live cell box the fragment
  // overlaps (a fragment in a removed cell stays where it is — no jump across the whole plan). Until the first cell is
  // removed the body is the original single box and the original rule applies unchanged.
  const B = m.bounds;
  const live = ctx.runtime.structureV2 ? st.cells?.boxes : null;
  const moved = live ? nudgeOutOfBoxes(local, [size[0] / 2, size[1] / 2, size[2] / 2], live) : null;
  const inside = local[0] > B.x0 && local[0] < B.x1 && local[2] > B.z0 && local[2] < B.z1;
  if (moved === null && inside && !e.flags.collapsed) {
    const dx0 = local[0] - B.x0, dx1 = B.x1 - local[0], dz0 = local[2] - B.z0, dz1 = B.z1 - local[2];
    const dm = Math.min(dx0, dx1, dz0, dz1);
    if (dm === dx0) local[0] = B.x0 - size[0] / 2 - 0.02;
    else if (dm === dx1) local[0] = B.x1 + size[0] / 2 + 0.02;
    else if (dm === dz0) local[2] = B.z0 - size[2] / 2 - 0.02;
    else local[2] = B.z1 + size[2] / 2 + 0.02;
  }
  const pos = toWorld(e, local);
  const vel = dirToWorld(e, vLocal);
  if (moving(ctx) >= FRAGMENT_LIMITS.active || S.fragments.length >= FRAGMENT_LIMITS.total + 64) {
    aggregate(ctx, e, i, pos, vel, hazard);
    return null;
  }
  const body = ctx.physics.createBody({
    kind: 'dynamic',
    position: pos,
    quaternion: e.pose.quaternion,
    shapes: [{ type: 'box', halfExtents: [Math.max(0.03, size[0] / 2), Math.max(0.03, size[1] / 2), Math.max(0.03, size[2] / 2)] }],
    mass: Math.max(1, mass),
    friction: 0.7,
    restitution: 0.05,
    linearDamping: 0.05,
    angularDamping: 0.3,
    ccd: true,
    contactForceThreshold: Math.max(600, mass * GRAVITY * 4),
    userData: { entityId: e.id, debrisId: `frag-${ctx.runtime.debrisCounter}` },
  });
  // Momentum exactly m·v (no extra push).
  if (vel[0] !== 0 || vel[1] !== 0 || vel[2] !== 0) ctx.physics.applyImpulse(body, [vel[0] * mass, vel[1] * mass, vel[2] * mass]);
  const mem = e.modular!.design.members[i];
  const minDim = Math.min(size[0], size[1], size[2]), maxDim = Math.max(size[0], size[1], size[2]);
  const piece: DebrisPiece = {
    id: `frag-${ctx.runtime.debrisCounter++}`,
    sourceId: e.id,
    kind: mem.type === 'roof' ? 'roof' : mem.role === 'cladding' ? 'cladding' : 'structure',
    body,
    size,
    color: memberColor(mem, e.modular!.design),
    mass,
    plate: minDim / maxDim < 0.18,
    pose: { position: pos, quaternion: e.pose.quaternion },
    spawnTime: ctx.time,
    hazard: hazardOf(hazard),
    forces: newForceRecord(),
    structural: { owner: e.id, member: i, root: m.root[i], hazard, settled: false, quiet: 0 },
  };
  ctx.runtime.debris.push(piece);
  S.fragments.push(piece);
  S.fragmentById.set(piece.id, piece);
  ctx.runtime.debrisRev++;
  return piece;
}

/** Aggregate a fragment without a body: rubble at its ballistic landing point. */
export function aggregate(ctx: SystemContext, e: RuntimeEntity, i: number, pos: Vec3, vel: Vec3, hazard: string) {
  const m = e.modular!.structure!.model;
  const g = m.g, o = 6 * i;
  const ground = ctx.env.terrain.sampleHeight(pos[0], pos[2]);
  const h = Math.max(0, pos[1] - ground);
  // Landing time under gravity from its vertical speed (exact), then where it lands. Phase 31: the downward gravity at
  // the piece; with (almost) none it is laid down where it is (no ballistic landing exists — documented approximation).
  const vy = vel[1];
  const gd = ctx.env.gravity.down(pos[0], pos[1], pos[2], GRAVITY);
  const t = gd >= FALL_MIN ? (vy + Math.sqrt(vy * vy + 2 * gd * h)) / gd : 0;
  const x = pos[0] + vel[0] * t, z = pos[2] + vel[2] * t;
  const mass = g.mass[i];
  const size = Math.max(0.3, Math.sqrt((g.box[o + 3] - g.box[o]) * (g.box[o + 5] - g.box[o + 2])));
  const S = structuresOf(ctx.runtime);
  S.rubble.addPoint(x, z, ctx.env.terrain.sampleHeight(x, z), size, mass, bulkVolume(mass / Math.max(100, memberMaterial(g, i).density)), hazard);
  S.aggregated += mass;
  m.ledger.move('bodies', 'rubble', mass);
  m.settleExternal(i);
}

/** Fragments at rest become fixed bodies; the oldest resting ones merge into rubble over the budget. */
export function updateFragments(ctx: SystemContext) {
  const S = structuresOf(ctx.runtime);
  const { physics, runtime } = ctx;
  for (const d of S.fragments) {
    const s = d.structural!;
    if (s.settled) continue;
    if (physics.isSleeping(d.body)) {
      if (++s.quiet >= REST_STEPS) {
        physics.setBodyKind(d.body, 'fixed');
        s.settled = true;
        const owner = runtime.entities.get(s.owner);
        owner?.modular?.structure?.model.settleExternal(s.member);
      }
    } else s.quiet = 0;
  }
  if (S.fragments.length <= FRAGMENT_LIMITS.total) return;
  let excess = S.fragments.length - FRAGMENT_LIMITS.total;
  const keep: DebrisPiece[] = [];
  for (const d of S.fragments) {
    if (excess > 0 && d.structural!.settled) {
      excess--;
      const owner = runtime.entities.get(d.structural!.owner);
      const model = owner?.modular?.structure?.model;
      const p = d.pose.position;
      const vol = bulkVolume(d.mass / Math.max(100, model ? memberMaterial(model.g, d.structural!.member).density : MATERIALS.reinforcedConcrete.density));
      S.rubble.addPoint(p[0], p[2], ctx.env.terrain.sampleHeight(p[0], p[2]), Math.sqrt(d.size[0] * d.size[2]), d.mass, vol, d.structural!.hazard);
      S.aggregated += d.mass;
      model?.ledger.move('bodies', 'rubble', d.mass);
      physics.removeBody(d.body);
      S.fragmentById.delete(d.id);
      const k = runtime.debris.indexOf(d);
      if (k >= 0) runtime.debris.splice(k, 1);
      continue;
    }
    keep.push(d);
  }
  S.fragments.length = 0;
  S.fragments.push(...keep);
  runtime.debrisRev++;
}

/** A fragment left the world (DebrisSystem): its mass is recorded as gone, not lost. */
export function fragmentLeft(ctx: SystemContext, d: DebrisPiece) {
  const S = ctx.runtime.structures;
  if (!S || !d.structural) return;
  const k = S.fragments.indexOf(d);
  if (k >= 0) S.fragments.splice(k, 1);
  S.fragmentById.delete(d.id);
  ctx.runtime.entities.get(d.structural.owner)?.modular?.structure?.model.ledger.move('bodies', 'left', d.mass);
}
