/**
 * Secondary damage by fragments of the structural engine (Phase 25).
 *
 * A strike EPISODE is the run of contact-force events between one fragment and one target (gaps
 * shorter than 0.5 s belong to the same episode); it is evaluated as the contact impulse grows and
 * RECORDED ONCE (no duplicate events from a collision spanning several steps).
 *
 *  - energy delivered: E = J² / (2·m), J = Σ F·Δt over the episode — the kinetic energy that stopping
 *    the fragment's normal motion requires (an upper bound of what the contact took);
 *  - modular buildings: the member at the contact (standing members overlapping the fragment)
 *    resists with W = P·δ_u — its load path's reserve static capacity P (solver.reserve, as for a
 *    falling block) over its deformation capacity δ_u; facade members with their design pressure ×
 *    area over their drift capacity × height. E ≥ W → the member fails (cause 'impact', the chain's
 *    primary hazard, the striker recorded as secondary); otherwise its damage index grows by E / W
 *    (plastic work accumulates) and lowers its capacity;
 *  - street lights, signs, walls, trees (anchored): the contact force × the contact height against
 *    the design base moment (as the Phase 23 ejecta check) → topple;
 *  - vehicles and people keep the Phase 0–24 contact-damage model; strikes by fragments add the
 *    secondary attribution, once per episode.
 * Legacy (Phase 0–16) buildings have no member model: strikes on them are not evaluated (documented).
 */
import type { Vec3 } from '@/core/types';
import { FIXED_DT, GRAVITY } from '@/core/units';
import { qRotate } from '@/core/math';
import { membersInRect, memberMaterial, MT_WINDOW } from '@/structure/graph';
import { MS } from '@/structure/types';
import type { DebrisPiece, RuntimeEntity } from '../SimulationRuntime';
import type { SystemContext } from '../systems/SimulationSystem';
import { DamageState } from '../damage/DamageState';
import { AIR } from '../ground/objects';
import { residualStrength } from '../interactions/integrity';
import type { Hazard } from '../analysis/DamageEvent';
import { hazardOf } from '../systems/StructuralCollapseSystem';
import { activate, structureOf, structuresOf } from './state';
import { detachFacadeMember } from './facade';

/** Episodes separated by more than this many steps are distinct strikes. */
const EPISODE_GAP = 30;
/** Energy below which a strike on a building is not evaluated (J). */
const MIN_ENERGY = 50;

interface Episode { J: number; last: number; evaluated: number; recorded: boolean }
const episodes = new WeakMap<object, Map<string, Episode>>();

function episode(ctx: SystemContext, key: string): Episode {
  const S = structuresOf(ctx.runtime);
  let m = episodes.get(S);
  if (!m) episodes.set(S, (m = new Map()));
  let ep = m.get(key);
  if (!ep || ctx.step - ep.last > EPISODE_GAP) {
    ep = { J: 0, last: ctx.step, evaluated: 0, recorded: false };
    m.set(key, ep);
  }
  return ep;
}

/**
 * Contact damage per strike episode (Phase 25 scenes): the episode's peak value counts once — a body
 * pressed against another for many steps is not "struck" again every step. Returns the increase of
 * the peak (0 when the contact is not stronger than before in this episode) and whether this is the
 * episode's first record.
 */
export function episodePeak(ctx: SystemContext, key: string, value: number): { inc: number; first: boolean } {
  const ep = episode(ctx, key) as Episode & { peak?: number };
  ep.last = ctx.step;
  const peak = ep.peak ?? 0;
  if (value <= peak) return { inc: 0, first: false };
  ep.peak = value;
  const first = !ep.recorded;
  return { inc: value - peak, first };
}

export function markRecorded(ctx: SystemContext, key: string) {
  episode(ctx, key).recorded = true;
}

export function strikerInfo(ctx: SystemContext, d: DebrisPiece) {
  const owner = d.structural ? ctx.runtime.entities.get(d.structural.owner) : undefined;
  const member = owner?.modular && d.structural ? owner.modular.design.members[d.structural.member]?.id : undefined;
  return { striker: d.id, source: d.sourceId, ...(member ? { member } : {}) };
}

function primary(d: DebrisPiece): Hazard {
  return hazardOf(d.structural?.hazard ?? d.hazard);
}

const tmp: number[] = [];

/** A fragment struck a modular building. Returns true when handled. */
export function strikeBuilding(ctx: SystemContext, target: RuntimeEntity, d: DebrisPiece, force: number): boolean {
  const mr = target.modular;
  if (!mr || target.flags.collapsed) return false;
  if (d.structural?.owner === target.id) return true; // its own collapse is the engine's business
  const ep = episode(ctx, `${d.id}|${target.id}`);
  ep.J += force * FIXED_DT;
  ep.last = ctx.step;
  const E = (ep.J * ep.J) / (2 * Math.max(1, d.mass));
  if (E < MIN_ENERGY || E < ep.evaluated * 1.2) return true;
  ep.evaluated = E;
  // Member at the contact: fragment centre in the building frame.
  const q = target.pose.quaternion;
  const p = d.pose.position;
  const local = qRotate([-q[0], -q[1], -q[2], q[3]], [p[0] - target.pose.position[0], p[1] - target.pose.position[1], p[2] - target.pose.position[2]]);
  const st = structureOf(target, ctx);
  const m = st.model, g = m.g;
  const r = Math.max(...d.size) / 2 + 0.3;
  membersInRect(g, local[0] - r, local[2] - r, local[0] + r, local[2] + r, tmp);
  let best = -1, bestScore = -Infinity;
  for (const i of tmp) {
    if (m.state[i] > MS.SEVERE) continue;
    const o = 6 * i;
    if (g.box[o + 1] > local[1] + r || g.box[o + 4] < local[1] - r) continue;
    // Prefer structural members, then the one closest to the fragment.
    const cx = (g.box[o] + g.box[o + 3]) / 2, cy = (g.box[o + 1] + g.box[o + 4]) / 2, cz = (g.box[o + 2] + g.box[o + 5]) / 2;
    const score = (g.structural[i] ? 100 : 0) - Math.hypot(cx - local[0], cy - local[1], cz - local[2]);
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best < 0) return true;
  const i = best;
  const hz = primary(d);
  const info = strikerInfo(ctx, d);
  const ids = mr.design.members;
  let W: number;
  if (g.structural[i]) {
    const res = m.s.reserve([i], [1]);
    W = res.P === Infinity ? Infinity : res.P * res.deltaU;
  } else {
    const mat = memberMaterial(g, i);
    const o = 6 * i;
    const h = g.box[o + 4] - g.box[o + 1];
    const area = Math.max(g.box[o + 3] - g.box[o], g.box[o + 5] - g.box[o + 2]) * h;
    W = mat.facadePressure * area * Math.max(0.002, mat.facadeDrift) * h;
  }
  const ratio = W > 0 ? E / W : Infinity;
  const S = structuresOf(ctx.runtime);
  ctx.milestone?.({ time: ctx.time, kind: 'debrisImpact', hazard: hz, subject: 'building', label: { key: 'milestone.p25.debris', params: { hazard: hz } } }, 'p25:debrisImpact');
  const pos: Vec3 = [p[0], p[1], p[2]];
  if (ratio >= 1) {
    if (g.structural[i]) {
      const recs = m.fail([i], 'impact', hz, ctx.time, { u: ratio });
      for (const rec of recs) rec.secondary = info;
      mr.failed[i] = 1;
      mr.failedSet.add(ids[i].id);
      st.lateralDirty = true;
      st.analysisDirty = true;
    } else {
      const ci = mr.comp[i];
      const c = ci >= 0 ? target.components[ci] : null;
      if (c && c.condition === 'intact') {
        c.condition = g.type[i] === MT_WINDOW ? 'broken' : 'detached';
        c.health = 0;
        c.state = DamageState.DESTROYED;
        detachFacadeMember(ctx, target, c, hz, null);
      } else {
        m.detachFacade(i, hz, ctx.time, ratio);
      }
    }
    mr.rev++;
    target.rev++;
    activate(target, ctx);
    if (!ep.recorded) {
      ep.recorded = true;
      S.secondary++;
      ctx.recordDamage(target, {
        eventType: g.structural[i] ? 'FAILED' : g.type[i] === MT_WINDOW ? 'BROKEN' : 'DETACHED', cause: 'impact', hazard: hz, componentId: ids[i].id, memberType: ids[i].type,
        worldPosition: pos, force, response: ratio, damageBefore: m.damage[i], damageAfter: 1, failure: 'impact', secondary: { ...info, energy: E },
      });
      ctx.milestone?.({ time: ctx.time, kind: 'secondaryDamage', hazard: hz, subject: 'building', label: { key: 'milestone.p25.secondary', params: { hazard: hz } } }, 'p25:secondary');
      if (!st.noted.has('debrisFail')) { st.noted.add('debrisFail'); ctx.log(target.id, 'danger', { key: 'log.struct.debrisFail' }); }
    }
    return true;
  }
  // Below capacity: plastic work accumulates as damage (capacity × (1 − 0.3·D)).
  const before = m.damage[i];
  if (m.setDamage(i, Math.min(0.99, before + ratio), hz)) {
    mr.rev++;
    target.rev++;
    activate(target, ctx);
  }
  if (!ep.recorded && ratio > 0.05) {
    ep.recorded = true;
    S.secondary++;
    ctx.recordDamage(target, {
      eventType: 'IMPACT', cause: 'impact', hazard: hz, componentId: ids[i].id, memberType: ids[i].type, worldPosition: pos, force,
      response: ratio, damageBefore: before, damageAfter: m.damage[i], secondary: { ...info, energy: E },
    });
    if (!st.noted.has('debrisHit')) { st.noted.add('debrisHit'); ctx.log(target.id, 'warn', { key: 'log.struct.debrisHit' }); }
  }
  return true;
}

/** A fragment struck an anchored structure (street light, sign, wall, tree): base moment vs its design. */
export function strikeAnchored(ctx: SystemContext, e: RuntimeEntity, d: DebrisPiece, force: number): boolean {
  if (e.dynamic || e.body === null || e.flags.toppled) return false;
  const ep = episode(ctx, `${d.id}|${e.id}`);
  ep.last = ctx.step;
  const h = Math.max(0.2, Math.min(e.dims[1], d.pose.position[1] - e.pose.position[1]));
  const windDesign = e.source.physics.windResistance * e.strength;
  let design = 0.5 * AIR * e.source.physics.dragCoefficient * e.area * e.areaFactor * windDesign * windDesign * Math.max(0.5, e.copLocal[1]);
  if (ctx.interactions) design *= residualStrength(e, primary(d));
  const ratio = design > 0 ? (force * h) / design : 0;
  if (ratio < e.source.physics.breakThreshold || ep.recorded) return true;
  ep.recorded = true;
  ctx.physics.setBodyKind(e.body, 'dynamic');
  e.dynamic = true;
  e.flags.toppled = true;
  e.health = 0;
  e.state = DamageState.DESTROYED;
  const hz = primary(d);
  e.lastHazard = hz;
  e.lastCause = 'impact';
  structuresOf(ctx.runtime).secondary++;
  ctx.recordDamage(e, { eventType: 'TOPPLED', cause: 'impact', hazard: hz, response: ratio, force, secondary: strikerInfo(ctx, d) });
  ctx.milestone?.({ time: ctx.time, kind: 'secondaryDamage', hazard: hz, subject: e.source.type, label: { key: 'milestone.p25.secondary', params: { hazard: hz } } }, 'p25:secondary');
  void GRAVITY;
  return true;
}

/** Vehicles / people: one secondary record per strike episode by a fragment (damage itself: Phase 0–24 model). */
export function noteBodyStrike(ctx: SystemContext, e: RuntimeEntity, d: DebrisPiece, force: number, damage: number) {
  const ep = episode(ctx, `${d.id}|${e.id}`);
  ep.last = ctx.step;
  ep.J += force * FIXED_DT;
  if (ep.recorded || damage <= 0.02) return;
  ep.recorded = true;
  const hz = primary(d);
  structuresOf(ctx.runtime).secondary++;
  ctx.recordDamage(e, {
    eventType: 'IMPACT', cause: 'impact', hazard: hz, force, damageBefore: Math.max(0, 1 - e.health - damage), damageAfter: 1 - e.health,
    secondary: { ...strikerInfo(ctx, d), energy: (ep.J * ep.J) / (2 * Math.max(1, d.mass)) },
  });
  ctx.milestone?.({ time: ctx.time, kind: 'debrisImpact', hazard: hz, subject: e.source.type, label: { key: 'milestone.p25.debris', params: { hazard: hz } } }, 'p25:debrisImpact');
  ctx.milestone?.({ time: ctx.time, kind: 'secondaryDamage', hazard: hz, subject: e.source.type, label: { key: 'milestone.p25.secondary', params: { hazard: hz } } }, 'p25:secondary');
}
