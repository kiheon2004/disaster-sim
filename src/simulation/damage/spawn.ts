import { blastGovernsStructure } from '../seismic/SeismicState';
import type { Vec3 } from '@/core/types';
import { qRotate, vAdd, vScale } from '@/core/math';
import type { ComponentSpec } from '@/core/model';
import type { SystemContext } from '../systems/SimulationSystem';
import type { DebrisPiece, RuntimeEntity } from '../SimulationRuntime';
import type { Hazard } from '../analysis/DamageEvent';
import { newForceRecord } from '../forces/ForceLedger';

export const MAX_DEBRIS = 320;
export const MAX_PARTICLES = 1600;

/** World-space center of a component (scaled, rotated, translated by the entity's pose). */
export function componentWorldPos(e: RuntimeEntity, c: ComponentSpec): Vec3 {
  const k = e.source.transform.scale;
  const local: Vec3 = [c.position[0] * k[0], c.position[1] * k[1], c.position[2] * k[2]];
  return vAdd(e.pose.position, qRotate(e.pose.quaternion, local));
}

export function componentWorldNormal(e: RuntimeEntity, c: ComponentSpec): Vec3 | null {
  return c.normal ? qRotate(e.pose.quaternion, c.normal) : null;
}

/** Turn a failed component into a free rigid body that the wind can carry away. */
export function spawnDebris(
  ctx: SystemContext,
  e: RuntimeEntity,
  opts: { kind: ComponentSpec['kind']; position: Vec3; size: Vec3; mass: number; color: string; push?: Vec3; hazard?: Hazard },
): DebrisPiece | null {
  const { runtime, physics } = ctx;
  // The cap applies to the Phase 0–24 pieces; fragments of the structural engine (Phase 25) have
  // their own budget and aggregation (simulation/structure/fragments.ts) and are never recycled here.
  const own = runtime.structures ? runtime.structures.fragments.length : 0;
  if (runtime.debris.length - own >= MAX_DEBRIS) {
    // Recycle the oldest piece that has come to rest.
    const idx = runtime.debris.findIndex((d) => !d.structural && physics.isSleeping(d.body));
    if (idx < 0) return null;
    if (runtime.structures) runtime.structures.legacyRecycled += runtime.debris[idx].mass;
    physics.removeBody(runtime.debris[idx].body);
    runtime.debris.splice(idx, 1);
  }
  const [sx, sy, sz] = opts.size;
  const minDim = Math.min(sx, sy, sz);
  const maxDim = Math.max(sx, sy, sz);
  const body = physics.createBody({
    kind: 'dynamic',
    position: opts.position,
    quaternion: e.pose.quaternion,
    shapes: [{ type: 'box', halfExtents: [Math.max(0.03, sx / 2), Math.max(0.03, sy / 2), Math.max(0.03, sz / 2)] }],
    mass: Math.max(1, opts.mass),
    friction: 0.6,
    restitution: 0.15,
    linearDamping: 0.08,
    angularDamping: 0.25,
    ccd: true,
    contactForceThreshold: Math.max(600, opts.mass * 9.81 * 4),
    userData: { entityId: e.id, debrisId: `deb-${runtime.debrisCounter}` },
  });
  if (opts.push) physics.applyImpulse(body, vScale(opts.push, Math.max(1, opts.mass)));
  const piece: DebrisPiece = {
    id: `deb-${runtime.debrisCounter++}`,
    sourceId: e.id,
    kind: opts.kind,
    body,
    size: opts.size,
    color: opts.color,
    mass: opts.mass,
    plate: minDim / maxDim < 0.18,
    pose: { position: opts.position, quaternion: e.pose.quaternion },
    spawnTime: ctx.time,
    // Pieces shaken off by the structural model while an air-pressure load governed it are the blast's (Phase 24).
    hazard: opts.hazard === 'earthquake' && blastGovernsStructure(e.seismic) ? 'blast' : opts.hazard ?? 'wind',
    forces: newForceRecord(),
  };
  runtime.debris.push(piece);
  runtime.debrisRev++;
  return piece;
}

export function spawnParticles(
  ctx: SystemContext,
  kind: 'glass' | 'leaf' | 'dust',
  at: Vec3,
  count: number,
  baseVel: Vec3,
  spread: number,
  color: string,
) {
  const ps = ctx.runtime.particles;
  const room = MAX_PARTICLES - ps.length;
  const n = Math.min(count, room);
  const rng = ctx.fxRng;
  for (let i = 0; i < n; i++) {
    const r = () => rng.spread(spread);
    ps.push({
      kind,
      position: [at[0] + r() * 0.3, at[1] + r() * 0.3, at[2] + r() * 0.3],
      velocity: [baseVel[0] + r(), baseVel[1] + Math.abs(r()) * 0.5, baseVel[2] + r()],
      rotation: [rng.next(), rng.next(), rng.next(), 1],
      spin: [r() * 6, r() * 6, r() * 6],
      life: kind === 'leaf' ? rng.range(6, 12) : kind === 'dust' ? rng.range(4, 9) : rng.range(3, 6),
      maxLife: 12,
      color,
      size: kind === 'leaf' ? rng.range(0.12, 0.22) : kind === 'dust' ? rng.range(0.5, 1.2) : rng.range(0.06, 0.16),
    });
  }
}
