import type { Vec3 } from '@/core/types';
import { qRotate, quatFromAxisAngle, qMul, vAdd, vScale } from '@/core/math';
import { SNAP_FRACTION, trunkHeight, type TreeParams } from '@/objects/definitions/tree';
import type { SystemContext } from '../../systems/SimulationSystem';
import type { RuntimeEntity } from '../../SimulationRuntime';
import { DamageState, worst } from '../DamageState';
import { applyFatigue, healthLevel, loadLevel } from '../fatigue';
import { loadRatio } from '../windLoad';
import { spawnParticles } from '../spawn';

const LEAF_COLORS = ['#4f8f3a', '#5f9e45', '#3f7a2f', '#7aa83e'];

function canopyCenter(e: RuntimeEntity): Vec3 {
  return vAdd(e.pose.position, qRotate(e.pose.quaternion, e.copLocal));
}

function shedLeaves(e: RuntimeEntity, ctx: SystemContext, count: number) {
  const v = e.localWind.velocity;
  const speed = e.localWind.speed;
  const flow: Vec3 = speed > 0.1 ? [v[0] / speed, 0, v[2] / speed] : ctx.env.wind.flow();
  const r = (e.source.params as TreeParams).canopyRadius * e.source.transform.scale[0];
  const c = canopyCenter(e);
  const fx = ctx.fxRng;
  const at: Vec3 = [c[0] + fx.spread(0.5) * r, c[1] + fx.range(-0.3, 0.7) * r, c[2] + fx.spread(0.5) * r];
  const color = e.source.params.species === 'conifer' ? '#2f6b3a' : fx.pick(LEAF_COLORS);
  spawnParticles(ctx, 'leaf', at, count, vScale(flow, speed * 0.4), 1.5, color);
}

/** Trunk failure: either snaps above the stump or is uprooted, then falls as a rigid body. */
function fail(e: RuntimeEntity, ctx: SystemContext, healthBefore: number) {
  const { physics, env } = ctx;
  const p = e.source.params as TreeParams;
  const k = e.source.transform.scale;
  const flow = env.wind.flow();
  const uproot = e.loadRatio > 2.4 || ctx.rng.chance(0.3);
  const swayQ = qMul(quatFromAxisAngle(e.visual.swayAxis, e.visual.swayAngle), e.initialPose.quaternion);

  if (e.body !== null) physics.removeBody(e.body);
  const h = p.height * k[1];
  const r = p.trunkRadius * Math.max(k[0], k[2]);
  const cr = p.canopyRadius * Math.max(k[0], k[2]) * 0.8;
  const th = trunkHeight(p) * k[1];

  if (uproot) {
    e.body = physics.createBody({
      kind: 'dynamic',
      position: e.initialPose.position,
      quaternion: swayQ,
      shapes: [
        { type: 'box', halfExtents: [r, h / 2, r], offset: [0, h / 2 + 0.02, 0], massFraction: 0.75 },
        { type: 'box', halfExtents: [cr, (h - th) / 2, cr], offset: [0, th + (h - th) / 2 + 0.02, 0], massFraction: 0.25 },
      ],
      mass: e.source.physics.mass,
      friction: 0.8,
      restitution: 0.05,
      linearDamping: 0.3,
      angularDamping: 0.8,
      userData: { entityId: e.id },
    });
    e.flags.uprooted = true;
  } else {
    const snapH = p.height * SNAP_FRACTION * k[1];
    // Stump stays as a fixed collider for the falling part to pivot on.
    physics.createBody({
      kind: 'fixed',
      position: e.initialPose.position,
      quaternion: e.initialPose.quaternion,
      shapes: [{ type: 'box', halfExtents: [r, snapH / 2, r], offset: [0, snapH / 2, 0] }],
      mass: 1,
      friction: 0.9,
      restitution: 0,
      userData: { entityId: e.id },
    });
    const len = h - snapH;
    e.body = physics.createBody({
      kind: 'dynamic',
      position: e.initialPose.position,
      quaternion: swayQ,
      shapes: [
        { type: 'box', halfExtents: [r * 0.92, len / 2, r * 0.92], offset: [0, snapH + len / 2 + 0.03, 0], massFraction: 0.7 },
        { type: 'box', halfExtents: [cr, (h - th) / 2, cr], offset: [0, th + (h - th) / 2 + 0.03, 0], massFraction: 0.3 },
      ],
      mass: e.source.physics.mass * 0.8,
      friction: 0.8,
      restitution: 0.05,
      linearDamping: 0.3,
      angularDamping: 0.8,
      userData: { entityId: e.id },
    });
    e.flags.snapped = true;
  }
  e.dynamic = true;
  e.pose = { position: e.initialPose.position, quaternion: swayQ };
  // A downed canopy is crushed and porous: far less wind catch than a standing crown.
  e.areaFactor *= 0.3;
  // Kick it over downwind.
  const m = e.source.physics.mass;
  physics.applyTorqueImpulse(e.body, vScale([flow[2], 0, -flow[0]], m * 1.4));
  physics.applyImpulse(e.body, vScale(flow, m * 0.4), canopyCenter(e));
  shedLeaves(e, ctx, 40);
  e.rev++;
  ctx.recordDamage(e, {
    eventType: uproot ? 'UPROOTED' : 'SNAPPED',
    cause: e.loadRatio >= e.source.physics.breakThreshold ? 'overload' : 'fatigue',
    worldPosition: [...e.initialPose.position],
    damageBefore: 1 - healthBefore,
    damageAfter: 1,
  });
  ctx.log(e.id, 'warn', { key: uproot ? 'log.tree.uprooted' : 'log.tree.snapped' });
}

export function updateTree(e: RuntimeEntity, ctx: SystemContext, dt: number) {
  // Foliage is weaker than the trunk: leaves strip off first.
  const canopy = e.components.find((c) => c.spec.kind === 'canopy');
  if (canopy) {
    canopy.loadRatio = loadRatio(e.windAtCop, canopy.spec.windResistance);
    canopy.health = applyFatigue(canopy.health, canopy.loadRatio, canopy.spec.durability, Infinity, dt);
    e.visual.foliageLoss = Math.min(0.85, 1 - canopy.health);
    const rate = Math.max(0, canopy.loadRatio - 0.45) * 7; // leaves per second
    if (ctx.fxRng.chance(rate * dt)) shedLeaves(e, ctx, 1 + ctx.fxRng.int(3));
  }

  // Toppled by another hazard (impact ejecta, pressure wave — recorded there): already down, the
  // wind fatigue path must not fail it a second time (Phase 24 fix: it was re-recorded as wind).
  if (e.flags.snapped || e.flags.uprooted || e.flags.toppled) {
    e.state = DamageState.DESTROYED;
    return;
  }
  const p = e.source.physics;
  // Anchored-off trees are already dynamic; still evaluate the trunk.
  const before = e.health;
  e.health = applyFatigue(e.health, e.loadRatio, p.durability, p.breakThreshold, dt);
  if (e.health <= 0) {
    fail(e, ctx, before);
    e.state = DamageState.DESTROYED;
    return;
  }
  e.state = worst(loadLevel(e.loadRatio), healthLevel(e.health));
}
