/**
 * Structural destruction (Phase 25, postPhysics — after every hazard's damage evaluation, before
 * debris housekeeping). Runs only for buildings whose collapse model has work to do:
 *
 *  - advances each model one fixed step (one load-redistribution round, falling blocks, impacts);
 *  - turns the model's events into the run's records — member failures (budgeted per building; the
 *    full sequence stays in the model), connection failures, redistribution, progressive / partial /
 *    global collapse — timeline milestones, logs, dust (visual only);
 *  - hands members leaving the building's plan to the physics engine as fragments (exact mass,
 *    inherited velocity), keeps the rubble piles in the scene's rubble field (colliders, burial,
 *    road blockage);
 *  - keeps the Phase 17 views in sync: failed flags, story stiffness / strength of the lumped
 *    structural model, remaining strength, collider / wind obstacle cut at the stories that no
 *    longer stand, total collapse;
 *  - Phase 36 (structure v2): the collider follows the storey × bay cells still standing (cellCollider.ts).
 * Inactive (free) when nothing structural is happening.
 */
import type { Vec3 } from '@/core/types';
import { GRAVITY } from '@/core/units';
import { memberMaterial, MT_COLUMN, MT_DOOR, MT_WALL, MT_WINDOW } from '@/structure/graph';
import { STRUCTURAL_TYPES, typeOfMaterial } from '@/buildings/structuralType';
import { MS, type FailCause } from '@/structure/types';
import type { CollapseEvent, CollapseModel, CollapseRecord } from '@/structure/collapse';
import { yawOf } from '@/terrain/groundPlacement';
import type { SimulationSystem, SystemContext } from './SimulationSystem';
import type { RuntimeEntity } from '../SimulationRuntime';
import { DamageState } from '../damage/DamageState';
import { spawnParticles } from '../damage/spawn';
import { HAZARDS, type DamageCause, type Hazard } from '../analysis/DamageEvent';
import { EVENT_BUDGET, ORIGINAL_WORLD, syncFailed, syncModel, truncate } from '../buildings/modular';
import { kinematics, structuresOf, toWorld, type StructureState } from '../structure/state';
import { spawnFragment, updateFragments } from '../structure/fragments';
import { rubbleEffects } from '../structure/rubbleEffects';
import { flushCellCollider, updateCellCollider } from '../structure/cellCollider';
import type { RubbleHeap } from '../structure/rubbleField';
import { simProfiler } from '../profiling/SimProfiler';


export function hazardOf(name: string): Hazard {
  if (name === '' || name === ORIGINAL_WORLD) return 'wind';
  return (HAZARDS as readonly string[]).includes(name) ? (name as Hazard) : 'earthquake';
}

export function damageCause(c: FailCause, storyCause?: DamageCause): DamageCause {
  switch (c) {
    case 'drift': return 'drift';
    case 'overpressure': return 'overpressure';
    case 'impact': return 'impact';
    case 'foundation': case 'bearing': return 'foundation';
    case 'thermal': return 'thermal';
    case 'uplift': return 'tidalLoad';
    case 'story': return storyCause ?? 'drift';
    default: return 'gravity';
  }
}

/**
 * Phase 36 (render-only): the dust puffs just spawned (from index n0) carry the mass-weighted `dust` factor of the
 * structural types of the members they came from (Particle.k). Set after spawnParticles: the count, the effects RNG
 * stream and every simulated quantity stay as they were.
 */
function dustLook(ctx: SystemContext, n0: number, m: CollapseModel, members: readonly number[]) {
  const ps = ctx.runtime.particles;
  if (ps.length <= n0) return;
  let w = 0, d = 0;
  for (const i of members) { const mi = m.g.mass[i]; w += mi; d += mi * STRUCTURAL_TYPES[typeOfMaterial(memberMaterial(m.g, i).id)].dust; }
  const k = w > 0 ? d / w : 1;
  for (let q = n0; q < ps.length; q++) ps[q].k = k;
}

export class StructuralCollapseSystem implements SimulationSystem {
  readonly name = 'structuralCollapse';
  readonly phase = 'postPhysics' as const;
  readonly reads = ['structure', 'damage', 'poses', 'debris'] as const;
  readonly writes = ['structure', 'damage', 'debris', 'particles'] as const;
  /** Fragments that left the world are removed by the DebrisSystem after it. */
  readonly lagged = ['debris'] as const;

  isActive(ctx: SystemContext) {
    const S = ctx.runtime.structures;
    return !!S && (S.active.length > 0 || S.fragments.some((f) => !f.structural!.settled));
  }

  update(ctx: SystemContext, dt: number) {
    const S = structuresOf(ctx.runtime);
    const changed: RubbleHeap[] = [];
    const still: RuntimeEntity[] = [];
    for (const e of S.active) {
      const mr = e.modular!;
      const st = mr.structure!;
      const m = st.model;
      const t0 = simProfiler.now();
      // Phase 31: the downward gravity at the building (the project constant while no gravity experiment runs).
      const p = e.pose.position;
      m.step(dt, ctx.time, kinematics(e, ctx), ctx.env.gravity.down(p[0], p[1] + e.dims[1] / 2, p[2], GRAVITY));
      simProfiler.add('struct.model', t0);
      const events = m.events;
      m.events = [];
      const t1 = simProfiler.now();
      let tp = simProfiler.now();
      if (events.length) this.events(ctx, e, st, events, changed);
      simProfiler.add('struct.ev.events', tp);
      tp = simProfiler.now();
      this.piles(ctx, e, st, changed);
      simProfiler.add('struct.ev.piles', tp);
      if (m.rev !== st.syncedRev) {
        st.syncedRev = m.rev;
        // States / resting places changed: the Phase 17 views, the lumped model, the collapse class.
        // (Only falling positions changed: the renderers alone.)
        if (m.structRev !== st.syncedStruct) {
          st.syncedStruct = m.structRev;
          let ts = simProfiler.now();
          syncFailed(mr);
          mr.currentStale = true;
          if (st.lateralDirty) { syncModel(e, ctx); st.lateralDirty = false; }
          simProfiler.add('struct.ev.sync', ts);
          ts = simProfiler.now();
          this.rubbleMass(ctx, e, st);
          this.standing(ctx, e, st);
          simProfiler.add('struct.ev.standing', ts);
        }
        mr.rev++;
        e.rev++;
      }
      if (st.analysisDirty) { st.analysisDirty = false; mr.currentStale = true; mr.weakStale = true; }
      // Phase 36 (v2): a collider change held back by the rebuild throttle; the building stays active until it is applied.
      if (st.cells?.pending) flushCellCollider(ctx, e, st);
      simProfiler.add('struct.events', t1);
      if (m.active || st.cells?.pending) still.push(e);
    }
    S.active = still;
    const t2 = simProfiler.now();
    updateFragments(ctx);
    if (changed.length) rubbleEffects(ctx, changed);
    simProfiler.add('struct.fragments', t2);
  }

  /** Model events → records, milestones, logs, fragments, dust. */
  private events(ctx: SystemContext, e: RuntimeEntity, st: StructureState, events: CollapseEvent[], changed: RubbleHeap[]) {
    const mr = e.modular!;
    const m = st.model;
    const ids = mr.design.members;
    for (const ev of events) {
      switch (ev.kind) {
        case 'fail': {
          const r = ev.rec;
          // Openings (windows / doors) stay in the collapse sequence, not in the damage log (as Phase 17).
          const opening = m.g.type[r.i] === MT_WINDOW || m.g.type[r.i] === MT_DOOR;
          // A story mechanism is one building-level record (STORY_COLLAPSED / COLLAPSED); its members
          // stay in the collapse sequence. Its consequences (lost support, floors crushed) are logged.
          if (r.cause !== 'facade' && r.cause !== 'story' && !opening) {
            const tr = simProfiler.now();
            this.recordFailure(ctx, e, st, r);
            simProfiler.add('struct.ev.record', tr);
            if (m.g.lateral[r.i]) st.lateralDirty = true;
            st.analysisDirty = true;
          }
          break;
        }
        case 'connection': {
          const hz = hazardOf(ev.hazard);
          ctx.milestone?.({ time: ev.time, kind: 'connectionFailure', hazard: hz, subject: 'building', label: { key: 'milestone.p25.connection', params: { hazard: hz } } }, 'p25:connection');
          if (!st.noted.has('connection')) { st.noted.add('connection'); ctx.log(e.id, 'warn', { key: 'log.struct.connection' }); }
          break;
        }
        case 'redistribution':
          if (ev.failed > 0 && ev.round > 1 && !st.noted.has('redistribution')) {
            st.noted.add('redistribution');
            ctx.log(e.id, 'warn', { key: 'log.struct.redistribution', params: { n: ev.failed } });
          }
          break;
        case 'impact': {
          const hz = hazardOf(ev.hazard);
          // Phase 31: the first falling-block impact of a gravity-driven collapse is a gravity milestone.
          if (hz === 'gravity') ctx.milestone?.({ time: ev.time, kind: 'gravityDebrisImpact', hazard: hz, subject: 'gravity', label: { key: 'ms.gravity.debris', params: { id: e.id } } }, 'gravity:debris');
          const c = this.centre(e, st, ev.receivers[0]);
          if (!ev.arrested) {
            ctx.milestone?.({ time: ev.time, kind: 'progressiveCollapse', hazard: hz, subject: 'building', label: { key: 'milestone.p25.progressive', params: { hazard: hz } } }, `p25:progressive:${e.id}`);
            if (!st.noted.has('progressive')) { st.noted.add('progressive'); ctx.log(e.id, 'danger', { key: 'log.struct.progressive', params: { n: ev.receivers.length } }); }
            const n0 = ctx.runtime.particles.length;
            spawnParticles(ctx, 'dust', c, Math.min(24, 4 + Math.round(ev.mass / 20000)), [0, 0.6, 0], 1.6, '#a59c8f');
            dustLook(ctx, n0, m, m.blocks[ev.group]?.members ?? ev.receivers);
          } else if (!st.noted.has('arrested') && ev.mass > 1000) {
            st.noted.add('arrested');
            ctx.log(e.id, 'info', { key: 'log.struct.arrested', params: { pct: Math.round(Math.min(1, ev.outcome.damage) * 100) } });
          }
          break;
        }
        case 'ground': {
          const pile = m.piles[ev.pile];
          const c = toWorld(e, [(pile.x0 + pile.x1) / 2, pile.y + pile.height / 2, (pile.z0 + pile.z1) / 2]);
          const n0 = ctx.runtime.particles.length;
          spawnParticles(ctx, 'dust', c, Math.min(40, 6 + Math.round(ev.mass / 15000)), [0, 0.8, 0], Math.max(1.5, Math.min(6, (pile.x1 - pile.x0) / 3)), '#a8a091');
          dustLook(ctx, n0, m, ev.members);
          break;
        }
        case 'exit': {
          const tf = simProfiler.now();
          spawnFragment(ctx, e, ev.i, ev.velocity, ev.hazard);
          simProfiler.add('struct.ev.spawn', tf);
          break;
        }
        // Phase 36: toppling about a hinge (structure v2 only — v1 never emits these): into the run's log, once per building.
        case 'hinge':
          if (!st.noted.has('hinge')) {
            st.noted.add('hinge');
            ctx.log(e.id, 'warn', { key: 'log.p36.hinge', params: { lever: ev.lever.toFixed(1), deg: Math.round((ev.release * 180) / Math.PI) } });
          }
          break;
        case 'release':
          if (!st.noted.has('release')) {
            st.noted.add('release');
            ctx.log(e.id, 'warn', { key: ev.ground ? 'log.p36.releaseGround' : 'log.p36.release', params: { deg: Math.round((ev.theta * 180) / Math.PI) } });
          }
          break;
        case 'crush':
          if ((ctx.step + ev.i) % 4 === 0) {
            const n0 = ctx.runtime.particles.length;
            spawnParticles(ctx, 'dust', this.centre(e, st, ev.i), 2, [0, 0.4, 0], 0.8, '#aaa196');
            dustLook(ctx, n0, m, [ev.i]);
          }
          break;
        default:
          break;
      }
    }
    void ids;
    void changed;
  }

  private centre(e: RuntimeEntity, st: StructureState, i: number): Vec3 {
    const m = st.model, g = m.g, o = 6 * i;
    return toWorld(e, [(g.box[o] + g.box[o + 3]) / 2 + m.dx[i], (g.box[o + 1] + g.box[o + 4]) / 2 + m.dy[i], (g.box[o + 2] + g.box[o + 5]) / 2 + m.dz[i]]);
  }

  /** A member failure into the damage log (budgeted) and the first-occurrence milestones. */
  private recordFailure(ctx: SystemContext, e: RuntimeEntity, st: StructureState, r: CollapseRecord) {
    const mr = e.modular!;
    const ids = mr.design.members;
    const hz = hazardOf(r.hazard);
    const m = ids[r.i];
    ctx.milestone?.({ time: r.time, kind: 'memberFailure', hazard: hz, subject: 'building', label: { key: 'milestone.p25.member', params: { hazard: hz } } }, `p25:member:${hz}`);
    if (r.trigger >= 0 && (r.cause === 'axial' || r.cause === 'bending' || r.cause === 'shear' || r.cause === 'support')) {
      ctx.milestone?.({ time: r.time, kind: 'loadRedistribution', hazard: hz, subject: 'building', label: { key: 'milestone.p25.redistribution', params: { hazard: hz } } }, 'p25:redistribution');
    }
    if (st.recorded >= EVENT_BUDGET) return;
    st.recorded++;
    if (hz === 'gravity') ctx.env.gravity.rt?.noteFailure(ctx, m.type === 'roof', e.id);
    // Phase 31: a member overloaded by a changed gravity field / a roof panel under snow names that load.
    const base = damageCause(r.cause, st.storyCause);
    const cause: DamageCause = base === 'gravity' && hz === 'gravity' ? 'gravityLoad' : base === 'gravity' && hz === 'climate' && m.type === 'roof' ? 'snowLoad' : base;
    ctx.recordDamage(e, {
      eventType: 'FAILED',
      cause,
      hazard: hz,
      componentId: m.id,
      memberType: m.type,
      worldPosition: this.centre(e, st, r.i),
      response: r.u,
      damageBefore: 0,
      damageAfter: 1,
      localWindSpeed: hz === 'wind' ? e.localWind.speed : 0,
      failure: r.cause,
      chain: { trigger: r.trigger >= 0 ? ids[r.trigger].id : null, root: ids[r.root].id, depth: r.depth, round: r.round },
      ...(r.hazard === ORIGINAL_WORLD ? { source: 'original-world' } : {}),
    });
  }

  /**
   * Rubble resting on a standing floor moves with it: its mass is added to that floor's dof of the
   * lumped structural model (and taken off again if it falls further).
   */
  private rubbleMass(ctx: SystemContext, e: RuntimeEntity, st: StructureState) {
    const mr = e.modular!;
    const sr = ctx.runtime.seismic;
    if (!sr || !mr.unit || mr.unitIndex < 0) return;
    const m = st.model, g = m.g, L = mr.unit.lumps;
    const nd = L.mass.length;
    const want = new Float64Array(nd + 1);
    for (let i = 0; i < g.n; i++) {
      if (m.state[i] !== MS.RESTING || m.external[i]) continue;
      const r = m.restOn[i];
      if (r < 0) continue;
      const lv = Math.max(0, Math.min(mr.floors - 1, g.level[r]));
      if (lv >= mr.collapsedFrom) continue;
      want[L.dof[lv]] += g.mass[i];
    }
    const have = (st.restMass ??= new Float64Array(nd + 1));
    for (let j = 1; j <= nd; j++) {
      const d = want[j] - have[j];
      if (Math.abs(d) < 1) continue;
      sr.model.addMass(mr.unitIndex, j, d, GRAVITY);
      have[j] = want[j];
    }
  }

  /** Model piles → scene rubble heaps (world frame). */
  private piles(ctx: SystemContext, e: RuntimeEntity, st: StructureState, changed: RubbleHeap[]) {
    const m = st.model;
    if (!m.piles.length) return;
    const S = structuresOf(ctx.runtime);
    const yaw = yawOf(e.source.transform.rotation);
    m.piles.forEach((p, k) => {
      if (st.heaps[k] !== undefined && S.rubble.heaps[st.heaps[k]].mass === p.mass) return;
      const c = toWorld(e, [(p.x0 + p.x1) / 2, p.y, (p.z0 + p.z1) / 2]);
      const hazard = m.records.length ? m.records[0].hazard : '';
      const h = S.rubble.upsert({ owner: e.id, pile: k, cx: c[0], cz: c[2], hx: (p.x1 - p.x0) / 2, hz: (p.z1 - p.z0) / 2, yaw, y: c[1], mass: p.mass, volume: p.volume, hazard: hazardOf(hazard) });
      st.heaps[k] = h.id;
      if (!changed.includes(h)) changed.push(h);
    });
  }

  /**
   * Stories that no longer stand: the collider / wind obstacle / lumped model are cut there; with
   * nothing standing above the ground the building has collapsed (recorded once, with the cause and
   * hazard of the chain that brought its last vertical member down); classification logs.
   */
  private standing(ctx: SystemContext, e: RuntimeEntity, st: StructureState) {
    const mr = e.modular!;
    const m = st.model, g = m.g;
    let top = -1;
    let last: CollapseRecord | null = null;
    for (let i = 0; i < g.n; i++) {
      const t = g.type[i];
      if (!g.structural[i] || (t !== MT_COLUMN && t !== MT_WALL) || g.level[i] < 0 || g.level[i] >= mr.floors) continue;
      if (m.state[i] <= MS.SEVERE) top = Math.max(top, g.level[i]);
    }
    const sDead = Math.min(top + 1, mr.floors);
    if ((sDead < mr.floors && sDead < mr.collapsedFrom) || (sDead === 0 && !e.flags.collapsed)) {
      for (let k = m.records.length - 1; k >= 0; k--) { const r = m.records[k]; const tt = g.type[r.i]; if (g.structural[r.i] && (tt === MT_COLUMN || tt === MT_WALL)) { last = r; break; } }
      const hz = hazardOf(last?.hazard ?? '');
      const cause = last ? damageCause(last.cause, st.storyCause) : 'gravity';
      if (sDead <= 0) {
        if (!e.flags.collapsed) {
          e.flags.collapsed = true;
          e.state = DamageState.DESTROYED;
          if (e.body !== null) ctx.physics.removeBody(e.body);
          e.body = null;
          ctx.env.windField.removeObstacle(e.id);
          ctx.env.flood?.removeObstacle(e.id);
          mr.collapsedFrom = 0;
          if (!st.globalRecorded) {
            st.globalRecorded = true;
            ctx.recordDamage(e, { eventType: 'COLLAPSED', cause, hazard: hz, response: last?.u ?? 0, damageAfter: 1 });
            ctx.log(e.id, 'danger', { key: 'log.building.collapsed' });
          }
        }
      } else if (!st.noted.has(`story:${sDead}`)) {
        st.noted.add(`story:${sDead}`);
        ctx.recordDamage(e, { eventType: 'STORY_COLLAPSED', cause, hazard: hz, response: sDead + 1, damageAfter: 1 - e.health });
        truncate(e, ctx, sDead);
      } else truncate(e, ctx, sDead);
    }
    const level = m.collapseLevel();
    if (level !== st.level) {
      st.level = level;
      const pct = Math.round((100 * m.standingMass()) / Math.max(1, m.superMass));
      const hz = hazardOf(m.records[0]?.hazard ?? '');
      if (level === 'partial') {
        ctx.log(e.id, 'danger', { key: 'log.struct.partial', params: { pct: 100 - pct } });
        ctx.milestone?.({ time: ctx.time, kind: 'partialCollapse', hazard: hz, subject: 'building', label: { key: 'milestone.p25.partial', params: { hazard: hz } } });
      } else if (level === 'global') {
        ctx.log(e.id, 'danger', { key: 'log.struct.global', params: { pct } });
        ctx.milestone?.({ time: ctx.time, kind: 'globalCollapse', hazard: hz, subject: 'building', label: { key: 'milestone.p25.global', params: { hazard: hz } } });
      }
      if (level === 'partial' || level === 'global') e.state = Math.max(e.state, level === 'global' ? DamageState.DESTROYED : DamageState.CRITICAL) as DamageState;
    }
    // Phase 36 (v2): the body follows the storey × bay cells that still stand (after this step's truncation / collapse).
    if (ctx.runtime.structureV2) updateCellCollider(ctx, e, st);
  }
}
