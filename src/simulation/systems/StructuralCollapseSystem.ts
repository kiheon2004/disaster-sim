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
 *    longer stand, total collapse.
 * Inactive (free) when nothing structural is happening.
 */
import type { Vec3 } from '@/core/types';
import { GRAVITY } from '@/core/units';
import { analyzeBuilding } from '@/buildings/analysis';
import { MT_COLUMN, MT_DOOR, MT_WALL, MT_WINDOW } from '@/structure/graph';
import { MS, type FailCause } from '@/structure/types';
import type { CollapseEvent, CollapseRecord } from '@/structure/collapse';
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
import type { RubbleHeap } from '../structure/rubbleField';
import { simProfiler } from '../profiling/SimProfiler';

/** Full Phase 17 re-analyses (inspector / weakest story) per step over all buildings, and per building per second. */
const ANALYSES_PER_STEP = 1;
const ANALYSIS_INTERVAL = 0.5;

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
    case 'story': return storyCause ?? 'drift';
    default: return 'gravity';
  }
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
    let analyses = ANALYSES_PER_STEP;
    const still: RuntimeEntity[] = [];
    for (const e of S.active) {
      const mr = e.modular!;
      const st = mr.structure!;
      const m = st.model;
      const t0 = simProfiler.now();
      m.step(dt, ctx.time, kinematics(e, ctx), GRAVITY);
      simProfiler.add('struct.model', t0);
      const events = m.events;
      m.events = [];
      const t1 = simProfiler.now();
      if (events.length) this.events(ctx, e, st, events, changed);
      this.piles(ctx, e, st, changed);
      if (m.rev !== st.syncedRev) {
        st.syncedRev = m.rev;
        syncFailed(mr);
        if (st.lateralDirty) { syncModel(e, ctx); st.lateralDirty = false; }
        this.rubbleMass(ctx, e, st);
        this.standing(ctx, e, st);
        mr.rev++;
        e.rev++;
      }
      if (st.analysisDirty && analyses > 0 && ctx.time - st.lastAnalysis >= ANALYSIS_INTERVAL && !m.blocks.some((b) => b.active)) {
        analyses--;
        st.analysisDirty = false;
        st.lastAnalysis = ctx.time;
        mr.current = analyzeBuilding(mr.design, { scale: mr.scale, failed: mr.failedSet });
      }
      simProfiler.add('struct.events', t1);
      if (m.active || st.analysisDirty) still.push(e);
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
            this.recordFailure(ctx, e, st, r);
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
          const c = this.centre(e, st, ev.receivers[0]);
          if (!ev.arrested) {
            ctx.milestone?.({ time: ev.time, kind: 'progressiveCollapse', hazard: hz, subject: 'building', label: { key: 'milestone.p25.progressive', params: { hazard: hz } } }, `p25:progressive:${e.id}`);
            if (!st.noted.has('progressive')) { st.noted.add('progressive'); ctx.log(e.id, 'danger', { key: 'log.struct.progressive', params: { n: ev.receivers.length } }); }
            spawnParticles(ctx, 'dust', c, Math.min(24, 4 + Math.round(ev.mass / 20000)), [0, 0.6, 0], 1.6, '#a59c8f');
          } else if (!st.noted.has('arrested') && ev.mass > 1000) {
            st.noted.add('arrested');
            ctx.log(e.id, 'info', { key: 'log.struct.arrested', params: { pct: Math.round(Math.min(1, ev.outcome.damage) * 100) } });
          }
          break;
        }
        case 'ground': {
          const pile = m.piles[ev.pile];
          const c = toWorld(e, [(pile.x0 + pile.x1) / 2, pile.y + pile.height / 2, (pile.z0 + pile.z1) / 2]);
          spawnParticles(ctx, 'dust', c, Math.min(40, 6 + Math.round(ev.mass / 15000)), [0, 0.8, 0], Math.max(1.5, Math.min(6, (pile.x1 - pile.x0) / 3)), '#a8a091');
          break;
        }
        case 'exit':
          spawnFragment(ctx, e, ev.i, ev.velocity, ev.hazard);
          break;
        case 'crush':
          if ((ctx.step + ev.i) % 4 === 0) spawnParticles(ctx, 'dust', this.centre(e, st, ev.i), 2, [0, 0.4, 0], 0.8, '#aaa196');
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
    ctx.recordDamage(e, {
      eventType: 'FAILED',
      cause: damageCause(r.cause, st.storyCause),
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
  }
}
