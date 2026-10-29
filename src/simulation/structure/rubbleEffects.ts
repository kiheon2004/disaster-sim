/**
 * What rubble piles do to the world around them (Phase 25):
 *
 *  - collider: the core of a pile (its footprint at the pile height) becomes a fixed box, so
 *    fragments land on the rubble and vehicles hit it; slopes are not colliders (thin);
 *  - burial: people, vehicles and small structures under a pile deeper than a fraction of their
 *    height (Phase 22 thresholds: people 0.7, vehicles 0.6, small structures 0.8) are BURIED —
 *    secondary damage attributed to the primary hazard of the collapse, cause 'burial'; their body
 *    becomes fixed (they are held by the rubble, and must not be ejected by the new collider);
 *    other free bodies inside a new core collider are lifted onto it;
 *  - roads: a carriageway sample under ≥ 0.3 m of rubble (the Phase 21 impassable step) blocks the
 *    segment — a separate state from sediment deposits (the network itself is never changed).
 *
 * Water: piles are not added to the 1 m water grid as obstacles (the collapsed building's own
 * footprint obstacle is removed as before) — a documented limitation.
 */
import { GRAVITY } from '@/core/units';
import { DamageState, worst } from '../damage/DamageState';
import type { SystemContext } from '../systems/SimulationSystem';
import type { RubbleHeap } from './rubbleField';
import { structuresOf } from './state';
import { ROAD_IMPASSABLE_STEP } from '../deformation/response';
import { quatFromEuler } from '@/core/math';

/** Piles lower than this get no collider (m). */
const COLLIDER_MIN = 0.3;
const BURIAL: Record<string, number> = { human: 0.7, car: 0.6, truck: 0.6, streetLight: 0.8, sign: 0.8, wall: 0.8, tree: 0.8 };

/** Apply the effects of heaps that changed. */
export function rubbleEffects(ctx: SystemContext, heaps: RubbleHeap[]) {
  if (!heaps.length) return;
  const S = structuresOf(ctx.runtime);
  for (const h of heaps) {
    bury(ctx, h);
    collider(ctx, h);
  }
  roads(ctx);
  void S;
}

/** Objects (not the owner) buried by a heap. */
function bury(ctx: SystemContext, h: RubbleHeap) {
  const S = structuresOf(ctx.runtime);
  const reach = S.rubble.reach(h);
  for (const e of ctx.runtime.entities.values()) {
    if (e.def.inert || e.id === h.owner) continue;
    const f = BURIAL[e.source.type];
    if (f === undefined) continue;
    const p = e.pose.position;
    if (Math.abs(p[0] - h.cx) > reach || Math.abs(p[2] - h.cz) > reach) continue;
    const { height } = S.rubble.heightAt(p[0], p[2]);
    if (height < f * e.dims[1]) continue;
    if (e.counters.rubbleBuried) continue;
    e.counters.rubbleBuried = 1;
    if (e.body !== null && e.dynamic) {
      ctx.physics.setBodyKind(e.body, 'fixed');
      e.dynamic = false;
    }
    e.state = worst(e.state, e.source.type === 'human' ? DamageState.CRITICAL : DamageState.DESTROYED);
    if (e.source.type !== 'human') e.health = 0;
    const hazard = (h.hazard || 'earthquake') as import('../analysis/DamageEvent').Hazard;
    e.lastHazard = hazard;
    e.lastCause = 'burial';
    ctx.recordDamage(e, {
      eventType: 'BURIED', cause: 'burial', hazard, response: height,
      secondary: { striker: `rubble-${h.id}`, source: h.owner ?? 'rubble' },
    });
    ctx.log(e.id, 'danger', { key: 'log.struct.buried', params: { m: height.toFixed(2) } });
    S.secondary++;
    ctx.milestone?.({ time: ctx.time, kind: 'secondaryDamage', hazard, subject: e.source.type, label: { key: 'milestone.p25.secondary', params: { hazard } } }, 'p25:secondary');
  }
}

/** (Re)build the fixed collider of a heap's core when its height changed by more than 10 cm. */
function collider(ctx: SystemContext, h: RubbleHeap) {
  const H = h.height;
  if (H < COLLIDER_MIN || Math.abs(H - h.bodyHeight) < 0.1) return;
  const { physics } = ctx;
  if (h.body !== null) physics.removeBody(h.body);
  const q = quatFromEuler([0, h.yaw, 0]);
  const top = h.y + H;
  const c = Math.cos(h.yaw), s = Math.sin(h.yaw);
  const inside = (x: number, z: number, r: number) => {
    const dx = x - h.cx, dz = z - h.cz;
    return Math.abs(dx * c - dz * s) <= h.hx + r && Math.abs(dx * s + dz * c) <= h.hz + r;
  };
  // Free bodies inside the new core are lifted onto it (never ejected by the solver).
  for (const e of ctx.runtime.entities.values()) {
    if (!e.dynamic || e.body === null || e.id === h.owner) continue;
    const p = e.pose.position;
    if (!inside(p[0], p[2], Math.hypot(e.dims[0], e.dims[2]) / 2) || p[1] > top + e.dims[1]) continue;
    e.pose = { position: [p[0], top + e.dims[1] / 2 + 0.02, p[2]], quaternion: e.pose.quaternion };
    physics.setBodyPose(e.body, e.pose.position, e.pose.quaternion);
  }
  for (const d of ctx.runtime.debris) {
    if (d.structural?.settled && d.structural.owner === h.owner) continue;
    const p = d.pose.position;
    if (!inside(p[0], p[2], Math.max(...d.size) / 2) || p[1] > top + Math.max(...d.size)) continue;
    d.pose = { position: [p[0], top + Math.max(...d.size) / 2 + 0.02, p[2]], quaternion: d.pose.quaternion };
    physics.setBodyPose(d.body, d.pose.position, d.pose.quaternion);
  }
  h.body = physics.createBody({
    kind: 'fixed', position: [h.cx, h.y + H / 2, h.cz], quaternion: q,
    shapes: [{ type: 'box', halfExtents: [Math.max(0.1, h.hx), H / 2, Math.max(0.1, h.hz)] }],
    mass: Math.max(1, h.mass), friction: 0.9, restitution: 0.02,
    // Not an entity: contacts with rubble are never "strikes" (burial is evaluated separately).
    userData: { entityId: `rubble:${h.id}` },
  });
  h.bodyHeight = H;
  void GRAVITY;
}

/** Road segments under rubble (thickest point over the centreline and gutters). */
function roads(ctx: SystemContext) {
  const roads = ctx.runtime.roads;
  if (!roads) return;
  const S = structuresOf(ctx.runtime);
  for (const st of roads.segments) {
    let best = 0;
    let src: string | null = null;
    for (const p of st.samples) { const r = S.rubble.heightAt(p.x, p.z); if (r.height > best) { best = r.height; src = r.heap?.owner ?? null; } }
    for (const p of st.gutters) { const r = S.rubble.heightAt(p.x, p.z); if (r.height > best) { best = r.height; src = r.heap?.owner ?? null; } }
    if (best <= 0.01 && !st.rubble) continue;
    const blocked = best >= ROAD_IMPASSABLE_STEP;
    const prev = st.rubble;
    st.rubble = { height: Math.max(prev?.height ?? 0, best), blocked: (prev?.blocked ?? false) || blocked, source: prev?.source ?? src };
    roads.rev++;
    if (blocked && roads.mark(st, 'blocked', ctx.time, best)) {
      ctx.log(null, 'danger', { key: 'log.struct.roadBlocked', params: { id: st.id, m: best.toFixed(2) } });
      ctx.milestone?.({ time: ctx.time, kind: 'roadBlocked', subject: 'road', label: { key: 'milestone.p25.roadBlocked', params: { id: st.id } } });
    }
  }
}
