/**
 * Terrain deformation (Phase 21, prePhysics — FIRST system of the step).
 *
 * When the deformation channel has work (a source's time factor changed), one ATOMIC update is
 * applied before anything else reads the ground in this step:
 *
 *   1. engine.update(t)       W(t) and H = H₀ + W in the changed rectangle
 *   2. sampler.sync()         every system's TerrainSampler sees the new heights (flat flag, range)
 *   3. collider               the Rapier heightfield is REPLACED (Rapier 0.21 has no partial
 *                             heightfield update — measured cost: see docs §8)
 *   4. water bed              cells over the rectangle re-derive their bed; depth preserved
 *   5. responses              dynamic bodies woken / lifted, fixed objects follow the ground,
 *                             foundations, roads (only what overlaps the rectangle)
 *
 * Rate: continuous profiles update every DEFORM_INTERVAL steps (10 Hz, the same steps as the
 * water solver, which runs after this system and so always sees the current bed); a source that
 * just started (instant / first stage) is applied in the very step it starts. Deterministic:
 * depends only on the step counter and the specs.
 */
import type { SimulationSystem, SystemContext } from './SimulationSystem';
import { WATER_SOLVER_INTERVAL } from './WaterSolverSystem';
import { heightfieldDesc } from '@/terrain/TerrainPhysicsAdapter';
import { PrescribedSource } from '@/deformation/engine';
import { respond, primeFoundation } from '../deformation/response';

export const DEFORM_INTERVAL = WATER_SOLVER_INTERVAL;

export interface DeformationStats {
  updates: number;
  /** Last update: field + heights, collider rebuild, water bed, responses (ms). */
  fieldMs: number;
  colliderMs: number;
  waterMs: number;
  responseMs: number;
  /** Totals (ms). */
  totalMs: number;
  colliderTotalMs: number;
  /** Vertices / water cells / objects touched by the last update. */
  vertices: number;
  cells: number;
  objects: number;
  roads: number;
  /** The FIRST applied update of the run, split (first-frame analysis, Phase 22): foundation priming + the parts above. */
  first: { primeMs: number; fieldMs: number; colliderMs: number; waterMs: number; responseMs: number } | null;
}

export class DeformationSystem implements SimulationSystem {
  readonly name = 'deformation';
  readonly phase = 'prePhysics' as const;
  readonly reads = ['terrain'] as const;
  readonly writes = ['terrain', 'water', 'poses', 'damage'] as const;
  readonly stats: DeformationStats = { updates: 0, fieldMs: 0, colliderMs: 0, waterMs: 0, responseMs: 0, totalMs: 0, colliderTotalMs: 0, vertices: 0, cells: 0, objects: 0, roads: 0, first: null };
  private peak = 0;
  private primed = new Set<string>();
  private started = new Set<string>();

  isActive(ctx: SystemContext) {
    return ctx.env.deformation.active;
  }

  update(ctx: SystemContext) {
    const engine = ctx.env.deformation.engine;
    if (!engine) return;
    if (!engine.urgent && ctx.step % DEFORM_INTERVAL !== 0) return;
    if (!engine.wants(ctx.time)) {
      engine.update(ctx.time); // clears the urgent flag (no change)
      return;
    }
    // Foundations' static bearing on the ORIGINAL ground, once per building, before it moves.
    const p0 = performance.now();
    for (const s of engine.sources) {
      if (this.primed.has(s.id)) continue;
      this.primed.add(s.id);
      // Prescribed sources: prime the buildings of their rectangle. The ground-failure field
      // covers the whole grid — its buildings get their initial bearing lazily, on the original
      // ground, when the ground under them first changes (Phase 22).
      if (s instanceof PrescribedSource) primeFoundation(ctx, engine, s.rect);
      // (Ground-failure sources log their own events — Phase 22.)
      if (s instanceof PrescribedSource && !this.started.has(s.phenomenon)) {
        this.started.add(s.phenomenon);
        const amount = s instanceof PrescribedSource ? (s.spec.kind === 'prescribed' ? Math.max(...s.spec.field!.values.map(Math.abs)) : s.spec.amount) : 0;
        ctx.log(null, 'warn', { key: `log.deform.started.${s.kind}` as 'log.deform.started.subsidence', params: { m: amount.toFixed(2) } });
      }
    }
    const a = performance.now();
    const primeMs = a - p0;
    const u = engine.update(ctx.time);
    if (!u) return;
    const terrain = ctx.env.terrain;
    terrain.syncHeights(); // ground types / soil are never changed by a deformation
    const b = performance.now();
    ctx.physics.setTerrain(heightfieldDesc(engine.terrain));
    const c = performance.now();
    const field = ctx.env.flood.field;
    const cells = field ? field.applyBedChange(u.rect) : 0;
    const d = performance.now();
    const t = engine.terrain;
    const rw = u.rect.x1 - u.rect.x0 + 1;
    const delta = (x: number, z: number) => {
      const ix = Math.round((x - t.originX) / t.cellSize) - u.rect.x0, iz = Math.round((z - t.originZ) / t.cellSize) - u.rect.z0;
      if (ix < 0 || iz < 0 || ix >= rw || iz > u.rect.z1 - u.rect.z0) return 0;
      return u.delta[iz * rw + ix];
    };
    const before = (x: number, z: number) => terrain.sampleHeight(x, z) - delta(x, z);
    const r = respond(ctx, engine, u.rect, delta, before);
    const e = performance.now();
    const st = this.stats;
    st.updates++;
    st.fieldMs = b - a;
    st.colliderMs = c - b;
    st.waterMs = d - c;
    st.responseMs = e - d;
    st.totalMs += e - a;
    st.colliderTotalMs += c - b;
    st.vertices = rw * (u.rect.z1 - u.rect.z0 + 1);
    st.cells = cells;
    st.objects = r.followed + r.dynamicWoken;
    st.roads = r.roads;
    if (!st.first) st.first = { primeMs, fieldMs: st.fieldMs, colliderMs: st.colliderMs, waterMs: st.waterMs, responseMs: st.responseMs };
    ctx.env.deformation.stats = st;
    if (engine.maxAbs > this.peak + 1e-6) this.peak = engine.maxAbs;
    // Timeline: a source reaching its final state = peak displacement of that deformation.
    for (const s of engine.sources) {
      if (!(s instanceof PrescribedSource) || s.version(ctx.time - s.startTime) < 1) continue;
      ctx.milestone?.({ time: ctx.time, kind: 'deformPeak', hazard: 'ground', subject: s.kind, label: { key: 'milestone.deformPeak', params: { m: engine.maxAbs.toFixed(2) } } }, `peak:${s.id}`);
    }
    for (const ent of ctx.runtime.entities.values()) {
      if (ent.ground && ent.ground.minContact < 0.75) {
        ctx.milestone?.({ time: ctx.time, kind: 'supportLoss', hazard: 'ground', subject: ent.source.type, label: { key: 'milestone.supportLoss' } }, 'supportLoss');
        break;
      }
    }
    if (ctx.runtime.roads?.segments.some((rs) => rs.deform && !rs.deform.passable)) ctx.milestone?.({ time: ctx.time, kind: 'roadCut', hazard: 'ground', label: { key: 'milestone.roadCut' } }, 'roadCut');
  }

  /** Largest |W| reached so far (m). */
  get peakDisplacement() {
    return this.peak;
  }
}
