import type { Vec3 } from '@/core/types';
import { qRotate, vAdd, vDot, vScale } from '@/core/math';
import type { SystemContext } from '../../systems/SimulationSystem';
import type { RuntimeComponent, RuntimeEntity } from '../../SimulationRuntime';
import { DamageState, worst } from '../DamageState';
import { applyFatigue, healthLevel, loadLevel } from '../fatigue';
import { componentWorldNormal, componentWorldPos, spawnDebris } from '../spawn';

/**
 * Anchored infrastructure (street lights, signs, walls):
 * attachments (lamp head, sign panel) can tear off first; when the main structure fails it
 * either topples as one body (poles, signs) or breaks into sections (walls).
 */
export function updateAnchoredStructure(e: RuntimeEntity, ctx: SystemContext, dt: number) {
  if (e.flags.toppled || e.flags.collapsed) {
    e.state = DamageState.DESTROYED;
    return;
  }
  const wind = ctx.env.wind;
  const flow = wind.flow();
  let failed = 0;

  for (const c of e.components) {
    if (c.spec.kind === 'structure') continue;
    if (c.condition !== 'intact') {
      failed++;
      continue;
    }
    const pos = componentWorldPos(e, c.spec);
    const v = wind.speedAt(pos, ctx.time);
    const n = componentWorldNormal(e, c.spec);
    // Flat panels catch the most wind when facing it; edge-on they are much safer.
    const facing = n ? 0.35 + 0.65 * Math.abs(vDot(n, flow)) : 1;
    c.loadRatio = (facing * v * v) / (c.spec.windResistance * c.spec.windResistance);
    c.health = applyFatigue(c.health, c.loadRatio, c.spec.durability, e.source.physics.breakThreshold, dt);
    c.state = worst(loadLevel(c.loadRatio), healthLevel(c.health));
    if (c.health <= 0) {
      detach(e, c, ctx, pos, n);
      failed++;
    }
  }

  e.health = applyFatigue(e.health, e.loadRatio, e.source.physics.durability, e.source.physics.breakThreshold, dt);
  if (e.health <= 0) {
    if (e.source.type === 'wall') breakWall(e, ctx);
    else topple(e, ctx);
    e.state = DamageState.DESTROYED;
    return;
  }
  let s = worst(loadLevel(e.loadRatio), healthLevel(e.health));
  if (failed > 0) s = worst(s, DamageState.DAMAGED);
  e.state = s;
}

function detach(e: RuntimeEntity, c: RuntimeComponent, ctx: SystemContext, pos: Vec3, n: Vec3 | null) {
  const k = e.source.transform.scale;
  c.condition = 'detached';
  c.health = 0;
  c.state = DamageState.DESTROYED;
  e.rev++;
  spawnDebris(ctx, e, {
    kind: c.spec.kind,
    position: pos,
    size: [c.spec.size[0] * k[0], c.spec.size[1] * k[1], c.spec.size[2] * k[2]],
    mass: c.spec.mass,
    color: c.spec.color ?? '#999',
    push: vAdd(vScale(ctx.env.wind.flow(), 0.8), n ? vScale(n, 0.3) : [0, 0.3, 0]),
  });
  ctx.log(e.id, 'warn', { key: c.spec.kind === 'sign' ? 'log.part.panel' : 'log.part.lamp' });
}

function topple(e: RuntimeEntity, ctx: SystemContext) {
  if (e.body === null) return;
  const { physics, env } = ctx;
  const flow = env.wind.flow();
  if (!e.dynamic) physics.setBodyKind(e.body, 'dynamic');
  e.dynamic = true;
  e.flags.toppled = true;
  const m = e.source.physics.mass;
  physics.applyTorqueImpulse(e.body, vScale([flow[2], 0, -flow[0]], m * 1.2));
  e.rev++;
  ctx.log(e.id, 'warn', { key: 'log.structure.toppled' });
}

/** A free-standing masonry wall fails in sections that tip over downwind. */
function breakWall(e: RuntimeEntity, ctx: SystemContext) {
  const { physics } = ctx;
  const p = e.source.params as { length: number; height: number; thickness: number; color: string };
  const k = e.source.transform.scale;
  if (e.body !== null) physics.removeBody(e.body);
  e.body = null;
  e.flags.collapsed = true;
  const segs = Math.max(1, Math.min(10, Math.round((p.length * k[0]) / 2)));
  const segLen = (p.length * k[0]) / segs;
  const flow = ctx.env.wind.flow();
  for (let i = 0; i < segs; i++) {
    const local: Vec3 = [-(p.length * k[0]) / 2 + segLen * (i + 0.5), (p.height * k[1]) / 2 + 0.01, 0];
    spawnDebris(ctx, e, {
      kind: 'wall',
      position: vAdd(e.pose.position, qRotate(e.pose.quaternion, local)),
      size: [segLen * 0.98, p.height * k[1], p.thickness * k[2]],
      mass: e.source.physics.mass / segs,
      color: p.color,
      push: vScale(flow, 0.6),
    });
  }
  e.rev++;
  ctx.log(e.id, 'danger', { key: 'log.wall.collapsed' });
}
