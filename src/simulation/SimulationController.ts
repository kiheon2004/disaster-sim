import type { BlastLive, DeformLive, GroundLive, ImpactLive, StructureLive, ThermalLive, FireLive, VolcanoLive } from './simStore';
import { activeIn, amplitude, intervalTemperature } from '@/thermal/sources';
import { shapeAt } from '@/thermal/profiles';
import { runtimeStateManifest } from './runtimeState';
import type { WorldDocument } from '@/core/model';
import type { EntityId } from '@/core/types';
import { FIXED_DT, type SimSpeed } from '@/core/units';
import type { I18nMessage } from '@/i18n/i18n';
import type { PhysicsEngine } from '@/physics/PhysicsEngine';
import { EventScheduler } from '@/events/EventScheduler';
import { createEvent } from '@/events/eventRegistry';
import type { EventSpec } from '@/events/specs';
import type { SimulationEvent } from '@/events/SimulationEvent';
import { createEnvironment, type EnvironmentState } from './environment/EnvironmentState';
import { buildRuntime } from './RuntimeBuilder';
import type { SimulationRuntime } from './SimulationRuntime';
import type { SimulationSystem, SystemContext } from './systems/SimulationSystem';
import { createDefaultSystems } from './systems';
import { MetricsSystem } from './systems/MetricsSystem';
import { MetricsRecorder, type SimulationMetrics } from './analysis/MetricsRecorder';
import type { DamageEventRecord } from './analysis/DamageEvent';
import { obstacleFromEntity } from './wind/obstacles';
import { Rng } from '@/core/random';
import { defaultSimulationSettings } from '@/core/model';
import { DamageState } from './damage/DamageState';
import { simProfiler } from './profiling/SimProfiler';
import { TerrainSampler } from '@/terrain/TerrainSampler';
import { terrainColliderDesc } from '@/terrain/TerrainPhysicsAdapter';
import { EMPTY_STATS, useSimStore, type QuakeLive, type SimStats, type SimStatus, type TimelineEventView } from './simStore';
import { createGroundMotionSample, sMinusP } from './seismic/GroundMotionField';
import { EarthquakeEvent } from '@/events/earthquake/EarthquakeEvent';
import { GRAVITY } from '@/core/units';
import { BOUNDARY_SIDES, defaultWaterSettings } from '@/core/model';
import { isWaterEvent } from '@/events/specs';
import { RoadRuntime } from './roads/RoadRuntime';
import { hydrologyPlan } from '@/landscape/hydrology';
import { computeCanopy } from './vegetation/vegetation';
import { floodFeatures } from './water/floodFeatures';
import { captureWaterState, type WaterStateSnapshot } from './water/waterStateCodec';
import type { FloodLive } from './simStore';
import { ForceLedger } from './forces/ForceLedger';
import { prepareSeismicRuntime } from './seismic/SeismicState';
import { capacities } from './damage/behaviors/seismic';
import { validatePipeline } from './systems/pipeline';
import { defaultThermalSettings } from '@/thermal/ThermalWorld';
import { defaultFireSettings } from '@/fire/types';

const MAX_STEPS_PER_FRAME = 16;
/** Wall-clock budget for physics per frame; beyond it the simulation slows instead of the UI freezing. */
const STEP_BUDGET_MS = 12;
const PUBLISH_INTERVAL = 0.1; // s (real time)
const SETTLE_TIME = 8; // s after the last event before the run is "finished"
/** Water keeps running off after the last water event: give it longer before "finished". */
const SETTLE_TIME_WATER = 60;
const MIN_TIMELINE = 30; // s
/** Longest extension of a run past its planned end while sediment is still moving (s). */
const RUNOUT_EXTENSION = 300;
const LOG_LIMIT = 300;
/** Phenomena that load structures through the structural model (ground motion, air pressure). */
const STRUCTURAL_EVENTS = new Set<string>(['earthquake', 'impact', 'blast']);

/**
 * Owns the simulation lifecycle: snapshot → runtime/physics → fixed-step loop → reset.
 * Lives outside React; the render loop only calls tick().
 */
export class SimulationController {
  private physics: PhysicsEngine | null = null;
  private runtime: SimulationRuntime | null = null;
  private env: EnvironmentState = createEnvironment();
  private scheduler = new EventScheduler();
  private systems: SimulationSystem[] = [];
  /** Immutable copy of the world at simulation start (Reset target). */
  private snapshot: WorldDocument | null = null;
  /** Every event spec with an absolute start time — replayed after a reset. */
  private scenario: EventSpec[] = [];
  private time = 0;
  /** Fixed steps taken since the runtime was built (drives deterministic scheduling). */
  private stepIndex = 0;
  private accumulator = 0;
  private status: SimStatus = 'idle';
  private speed: SimSpeed = 1;
  private sincePublish = Infinity;
  private lastStates: Record<EntityId, DamageState> | null = null;
  private lastLogLength = -1;
  private lastEventsRev = -1;
  private loadToken = 0;
  private rng = new Rng(1);
  private fxRng = new Rng(2);
  private metrics = new MetricsRecorder(1);
  private lastEventCount = -1;
  /** Time spent creating the physics ground (incl. terrain collider) on the last load (ms). */
  terrainBuildMs = 0;
  private quakeRef = createGroundMotionSample();
  private quakePeak = 0;
  private lastSeriesLength = -1;
  private lastFloodSeriesLength = -1;
  /** Water state to start the next (re)load from (mid-simulation snapshot), or null. */
  private initialWater: WaterStateSnapshot | null = null;
  private forces: ForceLedger | null = null;
  /** Multi-hazard interaction models on (from the snapshot's settings). */
  private interactions = true;
  /** Headless controllers (experiment comparison) never touch the UI store. */
  private readonly headless: boolean;

  constructor(opts: { headless?: boolean } = {}) {
    this.headless = opts.headless ?? false;
  }

  // ── Lifecycle ─────────────────────────────────────────────

  /** Build a runtime from a snapshot of the document. Leaves the simulation paused at t = 0. */
  async load(doc: WorldDocument): Promise<void> {
    const token = ++this.loadToken;
    this.disposeRuntime();
    this.snapshot = snapshotDocument(doc);
    this.scenario = [];
    this.setStatus('loading');
    await this.rebuild(token);
  }

  private async rebuild(token = ++this.loadToken) {
    this.disposeRuntime();
    this.extendEnd = 0;
    if (!this.snapshot) return;
    // Rapier (WASM) is loaded on demand so the editor starts fast.
    const { RapierEngine } = await import('@/physics/RapierEngine');
    const physics = new RapierEngine();
    // The run's OWN terrain (Phase 21): runtime deformation writes this copy, never the snapshot,
    // so a reset rebuilds the original ground exactly. Without deformation it stays as loaded.
    const runTerrain = runtimeTerrain(this.snapshot.terrain);
    const t0 = performance.now();
    await physics.init(this.snapshot.settings.gravity, terrainColliderDesc(runTerrain));
    this.terrainBuildMs = performance.now() - t0;
    if (token !== this.loadToken) {
      physics.dispose(); // a newer load/reset superseded this one
      return;
    }
    this.physics = physics;
    const sim = this.snapshot.settings.simulation ?? defaultSimulationSettings();
    const terrain = new TerrainSampler(runTerrain);
    this.runtime = buildRuntime(this.snapshot, physics, terrain);
    // Phase 19 vegetation options (opt-in per project).
    if (sim.vegetation?.canopyShelter) computeCanopy(this.runtime);
    if (sim.vegetation?.floodResponse) this.runtime.vegetation = { flood: true };
    // Phase 19: water of the natural features (initial depth, river inflows, outlets). Edge
    // overrides apply to this run only — the document's settings are never written.
    const water = sim.water ?? defaultWaterSettings();
    const hydro = this.snapshot.landscape ? hydrologyPlan(this.snapshot.landscape, this.snapshot.terrain, water) : null;
    const runWater = hydro && Object.keys(hydro.boundaries).length ? { ...water, boundaries: { ...water.boundaries, ...hydro.boundaries } } : water;
    this.env = createEnvironment(this.snapshot.settings.airDensity, sim.wind, sim.seed, terrain, runWater, { ...defaultThermalSettings(), ...(sim.thermal ?? {}) }, { ...defaultFireSettings(), ...(sim.fire ?? {}) });
    const obstacles = [];
    for (const e of this.runtime.entities.values()) {
      const o = obstacleFromEntity(e);
      if (o) obstacles.push(o);
    }
    this.env.windField.setObstacles(obstacles);
    // Water model inputs (used only if a water event starts): solid footprints + road surfaces.
    const features = floodFeatures(this.runtime);
    // Network roads (Phase 18): their surface is in the terrain; the runtime adds damage state
    // and the storm-drain inlets the water model uses as sub-grid sinks.
    if (this.snapshot.roads && Object.keys(this.snapshot.roads.segments).length) this.runtime.roads = new RoadRuntime(this.snapshot.roads);
    this.env.flood.setFeatures(features.obstacles, features.roads, this.runtime.roads?.inlets ?? []);
    this.env.flood.initialState = this.initialWater;
    this.rng = new Rng(sim.seed).fork('core');
    this.fxRng = new Rng(sim.seed).fork('fx');
    this.metrics = new MetricsRecorder(sim.seed);
    this.lastEventCount = -1;
    this.scheduler = new EventScheduler();
    this.systems = [...createDefaultSystems(), new MetricsSystem(this.metrics)];
    if (import.meta.env?.DEV) {
      const issues = validatePipeline(this.systems);
      if (issues.length) console.warn('simulation pipeline order issues', issues);
    }
    this.forces = new ForceLedger(physics);
    this.interactions = sim.interactions?.enabled ?? true;
    this.time = 0;
    this.stepIndex = 0;
    this.accumulator = 0;
    this.lastStates = null;
    this.lastLogLength = -1;
    this.lastEventsRev = -1;
    this.quakePeak = 0;
    this.lastSeriesLength = -1;
    this.lastFloodSeriesLength = -1;
    this.endSeenRev = -1;
    this.ended = new Set();
    this.lastMilestones = -1;
    for (const spec of this.scenario) this.schedule(createEvent(spec, 0, this.eventDefaults()));
    if (hydro) {
      for (const src of hydro.sources) this.scheduler.add(createEvent(src, 0, this.eventDefaults()));
      for (const issue of hydro.issues) this.log(null, 'warn', { key: `nature.hydro.${issue.code}`, params: { id: issue.feature, v: (issue.value ?? 0).toFixed(2) } });
      // Water already in lakes / rivers: the water model runs from t = 0 (a saved mid-run water
      // state, if one was loaded, takes precedence over the features' initial water).
      if (hydro.initial || hydro.sources.length) {
        this.env.flood.landscapeWater = this.initialWater ? null : hydro.initial;
        this.env.flood.activate(0);
      }
    }
    this.status = 'paused';
    if (!this.headless) useSimStore.getState().set({ runtimeVersion: useSimStore.getState().runtimeVersion + 1 });
    this.publish(true);
  }

  /** Restore the pre-simulation world (same scenario, t = 0, paused). */
  async reset(): Promise<void> {
    if (!this.snapshot) return;
    this.setStatus('loading');
    await this.rebuild();
  }

  /** Tear everything down (leaving simulation mode). */
  unload() {
    this.loadToken++;
    this.disposeRuntime();
    this.snapshot = null;
    this.scenario = [];
    this.status = 'idle';
    if (this.headless) return;
    useSimStore.getState().set({
      status: 'idle',
      time: 0,
      endTime: 0,
      entityStates: null,
      events: [],
      log: [],
      stats: EMPTY_STATS,
      wind: { speed: 0, bearing: 90, gust: 0 },
      metrics: null,
      damageEvents: [],
      quake: null,
      seismicSeries: null,
      flood: null,
      deform: null,
      ground: null,
      impacts: null,
      blasts: null,
      structure: null,
      thermal: null,
      volcano: null,
      floodSeries: null,
      milestones: [],
    });
  }

  private disposeRuntime() {
    this.physics?.dispose();
    this.physics = null;
    this.runtime = null;
  }

  // ── Controls ──────────────────────────────────────────────

  /**
   * Prepare the runtime ground layer before a run that will deform the terrain (Phase 22): the
   * (empty) deformation engine exists from now on, so renderers switch to the runtime terrain
   * and build their meshes / shaders BEFORE the clock starts. No source is added, nothing moves,
   * the collider is not touched — the simulation itself is unchanged.
   */
  prepareGround(field = false) {
    this.env.deformation.ensure();
    // Ground-failure runs (Phase 23 pre-warm): the empty field exists before the clock starts, so
    // its overlay mounts and compiles now. It holds no model: terrain, collider and results are
    // unchanged (the field's source publishes no change until something fails).
    if (field) this.env.groundFailure.ensure();
  }

  /** Schedule an event. Without an explicit start time it begins now. */
  addEvent(spec: EventSpec) {
    const absolute: EventSpec = { ...spec, startTime: spec.startTime ?? this.time };
    this.scenario.push(absolute);
    this.schedule(createEvent(absolute, this.time, this.eventDefaults()));
    if (this.status === 'finished') this.status = 'paused';
    this.publish(true);
  }

  /**
   * Schedule an event, letting it precompute on the run's terrain first (outside the clock; Phase 24
   * residual 2.1). Skipped once the ground has changed — the event then computes at its start.
   */
  private schedule(ev: SimulationEvent) {
    if (ev.prepare && (this.env.deformation.engine?.rev ?? 0) === 0) ev.prepare(this.env.terrain.data);
    if (STRUCTURAL_EVENTS.has(ev.type)) this.prepareStructures();
    this.scheduler.add(ev);
  }

  /**
   * Build the structural model and the facade capacities of every structure ahead of the clock
   * (Phase 24 residual 2.1) for runs whose phenomena load structures; activation (residual strength)
   * still happens at the first load, so results are identical to the lazy build.
   */
  prepareStructures() {
    const rt = this.runtime;
    if (!rt || rt.seismic) return;
    const sr = prepareSeismicRuntime(rt, this.env.terrain, GRAVITY);
    for (const e of sr.units) if (e.source.type === 'building') capacities(e);
  }

  private seed() {
    return this.snapshot?.settings.simulation?.seed ?? defaultSimulationSettings().seed;
  }

  private eventDefaults() {
    return { seed: this.seed(), terrain: this.snapshot?.terrain ?? null, water: this.snapshot?.settings.simulation?.water ?? defaultWaterSettings() };
  }

  /**
   * Start the next (re)load from a saved water state instead of a dry map (null = dry / the
   * reference level). Applied when the water model activates. Takes effect on the next reset.
   */
  setInitialWaterState(state: WaterStateSnapshot | null) {
    this.initialWater = state;
    this.env.flood.initialState = state;
  }

  getInitialWaterState() {
    return this.initialWater;
  }

  /** Snapshot of the current water (null while the water model is dormant). */
  captureWaterState(): WaterStateSnapshot | null {
    const f = this.env.flood.field;
    return f ? captureWaterState(f, this.time) : null;
  }

  clearScenario() {
    this.scenario = [];
    void this.reset();
  }

  play() {
    if (!this.runtime) return;
    if (this.status === 'finished') this.extendEnd = this.time + MIN_TIMELINE;
    this.setStatus('running');
  }

  pause() {
    if (this.status === 'running') this.setStatus('paused');
  }

  togglePlay() {
    if (this.status === 'running') this.pause();
    else this.play();
  }

  setSpeed(speed: SimSpeed) {
    this.speed = speed;
    useSimStore.getState().set({ speed });
  }

  private extendEnd = 0;

  /** Mobile sediment above 1 % of what was released (and 0.5 m³) — the runout is still going. */
  private sedimentMoving(): boolean {
    const b = this.env.groundFailure.field?.budget;
    return !!b && b.mobile > Math.max(0.5, 0.01 * b.released);
  }

  /** End of the run from the plan alone (events + settling time). */
  private plannedEnd(): number {
    const planned = this.scheduler.plannedEnd();
    const settle = this.scenario.some(isWaterEvent) ? SETTLE_TIME_WATER : SETTLE_TIME;
    return Math.max(MIN_TIMELINE, planned > 0 ? planned + settle : 0);
  }

  private endTime(): number {
    return Math.max(this.plannedEnd(), this.extendEnd);
  }

  private setStatus(s: SimStatus) {
    this.status = s;
    if (!this.headless) useSimStore.getState().set({ status: s });
  }

  // ── Loop ──────────────────────────────────────────────────

  tick(realDt: number) {
    if (this.status !== 'running' || !this.runtime || !this.physics) return;
    const tickStart = simProfiler.now();
    this.accumulator += Math.min(realDt, 0.1) * this.speed;
    let steps = 0;
    const start = performance.now();
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      this.step(FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps++;
      // Always at least one step; stop early when over budget (fixed steps keep results deterministic).
      if (performance.now() - start > STEP_BUDGET_MS) break;
    }
    // Overloaded: drop the backlog (slow motion) rather than spiral into ever-longer frames.
    if (this.accumulator >= FIXED_DT) this.accumulator = Math.min(this.accumulator, FIXED_DT);
    simProfiler.endTick(tickStart);

    if (this.time >= this.endTime() && !this.scheduler.hasPendingOrActive()) {
      // Sediment still running out (Phase 22): the run is not over until it comes to rest
      // (at most RUNOUT_EXTENSION s past the planned end; the timeline grows with it).
      // An air-pressure wave still on its way or crossing (Phase 24: an airburst kilometres up arrives
      // long after its event) — the structures then ring down for the settling time.
      if (this.env.blast.pending(this.time, SETTLE_TIME) && this.time < this.plannedEnd() + RUNOUT_EXTENSION) {
        this.extendEnd = this.time + 2;
        this.publish(true);
        return;
      }
      if (this.sedimentMoving() && this.time < this.plannedEnd() + RUNOUT_EXTENSION) {
        this.extendEnd = this.time + 2;
        this.publish(true);
        return;
      }
      this.status = 'finished';
      this.publish(true);
      return;
    }
    this.sincePublish += realDt;
    if (this.sincePublish >= PUBLISH_INTERVAL) this.publish();
  }

  /** Step synchronously by `seconds` of simulated time (tests, fast-forward). */
  advance(seconds: number) {
    if (!this.runtime || !this.physics) return;
    const n = Math.round(seconds / FIXED_DT);
    for (let i = 0; i < n; i++) this.step(FIXED_DT);
    this.publish(true);
  }

  private step(dt: number) {
    const runtime = this.runtime!;
    const physics = this.physics!;
    this.env.time = this.time;
    this.scheduler.update({ env: this.env, time: this.time }, dt, (ev) => {
      this.log(null, 'info', { key: 'log.event.started', params: { label: '', eventKey: ev.describe().key, ...ev.describe().params } });
      this.metrics.milestones.add({ time: this.time, kind: 'start', subject: ev.type, label: ev.describe() });
    });
    if (this.scheduler.rev !== this.endSeenRev) this.noteEnds();

    const forces = this.forces!;
    forces.beginStep(this.stepIndex);
    const ctx: SystemContext = {
      env: this.env,
      runtime,
      physics,
      time: this.time,
      step: this.stepIndex,
      rng: this.rng,
      fxRng: this.fxRng,
      log: (entityId, severity, message) => this.log(entityId, severity, message),
      recordDamage: (e, ev) => this.metrics.record(this.time, e, ev),
      forces,
      interactions: this.interactions,
      milestone: (m, key) => (key ? this.metrics.milestones.once(key, m) : this.metrics.milestones.add(m)),
    };
    this.metrics.beginStep();
    physics.clearForces();
    this.runPhase('prePhysics', ctx, dt);
    const t0 = simProfiler.now();
    physics.step(dt);
    simProfiler.add('physics', t0);
    this.runPhase('postPhysics', ctx, dt);
    this.time += dt;
    this.stepIndex++;
    simProfiler.endStep(dt);
  }

  /** Runs the systems of one phase that are due on this step (fixed-step schedule). */
  private runPhase(phase: SimulationSystem['phase'], ctx: SystemContext, dt: number) {
    const td = simProfiler.now();
    for (const s of this.systems) {
      if (s.phase !== phase) continue;
      const every = s.interval ?? 1;
      if (every > 1 && this.stepIndex % every !== 0) continue;
      // Phase 15: systems whose phenomena are not running are skipped (never changes a result).
      if (s.isActive && !s.isActive(ctx)) continue;
      const t0 = simProfiler.now();
      s.update(ctx, dt * every);
      simProfiler.add(`sys.${s.name}`, t0);
    }
    simProfiler.add('dispatch', td);
  }

  private endSeenRev = -1;
  private lastMilestones = -1;
  private ended = new Set<string>();

  /** Phenomenon ends (finished or superseded) → experiment milestones. */
  private noteEnds() {
    this.endSeenRev = this.scheduler.rev;
    for (const i of this.scheduler.list()) {
      if ((i.status === 'done' || i.status === 'superseded') && !this.ended.has(i.event.id)) {
        this.ended.add(i.event.id);
        this.metrics.milestones.add({ time: i.endedAt ?? this.time, kind: 'end', subject: i.event.type, label: i.event.describe() });
      }
    }
  }

  /**
   * Seconds from now to the start / end of the latest scheduled event of a type (null = none).
   * Used to resolve "10 s after the typhoon begins" against what is already scheduled.
   */
  scheduledTime(type: string, anchor: 'start' | 'end'): number | null {
    let best: number | null = null;
    for (const i of this.scheduler.list()) {
      if (i.event.type !== type || i.status === 'superseded') continue;
      const t = anchor === 'start' ? i.event.startTime : i.endedAt ?? i.event.startTime + i.event.duration;
      if (best === null || t > best) best = t;
    }
    return best === null ? null : best - this.time;
  }

  getMilestones() {
    return this.metrics.milestones.list;
  }

  /** Rejected duplicate force applications in this run (should stay 0). */
  duplicateForces(): number {
    return this.forces?.duplicates ?? 0;
  }

  getSystems(): readonly SimulationSystem[] {
    return this.systems;
  }

  getStep(): number {
    return this.stepIndex;
  }

  private log(entityId: EntityId | null, severity: 'info' | 'warn' | 'danger', message: I18nMessage) {
    const log = this.runtime?.log;
    if (!log) return;
    log.push({ time: this.time, entityId, severity, message });
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
  }

  // ── Publishing to the UI store ────────────────────────────

  private publish(force = false) {
    this.sincePublish = 0;
    if (this.headless) return;
    const rt = this.runtime;
    const store = useSimStore.getState();
    if (!rt) return;

    // Entity states: only publish a new object when something changed.
    let changed = !this.lastStates;
    const states: Record<EntityId, DamageState> = {};
    const stats: SimStats = { ...EMPTY_STATS, byState: [0, 0, 0, 0, 0] };
    for (const e of rt.entities.values()) {
      if (e.def.inert) continue;
      states[e.id] = e.state;
      if (!changed && this.lastStates![e.id] !== e.state) changed = true;
      stats.byState[e.state]++;
      for (const c of e.components) {
        if (c.spec.kind === 'window' && c.condition !== 'intact') stats.brokenWindows++;
        if (c.condition === 'detached') stats.detachedParts++;
      }
      if (e.flags.fallen && e.source.type === 'human') stats.fallenPeople++;
      if ((e.flags.snapped || e.flags.uprooted) && e.source.type === 'tree') stats.fallenTrees++;
      if (e.source.type === 'car' && e.displacement > 0.5) stats.movedCars++;
    }
    stats.debris = rt.debris.length;

    const patch: Partial<Parameters<typeof store.set>[0]> = {
      time: this.time,
      endTime: this.endTime(),
      status: this.status,
      wind: { speed: this.env.wind.baseSpeed, bearing: this.env.wind.fromBearing, gust: this.env.wind.gustStrength },
      stats,
    };
    if (changed || force) {
      this.lastStates = states;
      patch.entityStates = states;
    }
    if (rt.log.length !== this.lastLogLength || force) {
      this.lastLogLength = rt.log.length;
      patch.log = rt.log.slice();
    }
    if (this.scheduler.rev !== this.lastEventsRev || force) {
      this.lastEventsRev = this.scheduler.rev;
      patch.events = this.scheduler.list().map<TimelineEventView>((i) => ({
        id: i.event.id,
        type: i.event.type,
        start: i.event.startTime,
        duration: i.event.duration,
        status: i.status,
        label: i.event.describe(),
        profile: Array.from({ length: 48 }, (_, k) => i.event.intensityAt((k / 47) * i.event.duration)),
        waveform: i.event.waveform?.(240),
      }));
    }
    patch.quake = this.quakeLive();
    const series = this.metrics.seismic.series;
    if (series.t.length !== this.lastSeriesLength || force) {
      this.lastSeriesLength = series.t.length;
      patch.seismicSeries = series.t.length ? this.metrics.seismic.downsampled(600) : null;
    }
    const ms = this.metrics.milestones.list;
    if (ms.length !== this.lastMilestones || force) {
      this.lastMilestones = ms.length;
      patch.milestones = ms.slice();
    }
    patch.flood = this.floodLive();
    patch.deform = this.deformLive();
    patch.ground = this.groundLive();
    patch.impacts = this.impactLive();
    patch.blasts = this.blastLive();
    patch.structure = this.structureLive();
    patch.thermal = this.thermalLive();
    patch.fire = this.fireLive();
    patch.volcano = this.volcanoLive();
    const fs = this.metrics.flood.series;
    if (fs.t.length !== this.lastFloodSeriesLength || force) {
      this.lastFloodSeriesLength = fs.t.length;
      patch.floodSeries = fs.t.length ? this.metrics.flood.downsampled(600) : null;
    }
    patch.metrics = this.metrics.summary(rt, this.time);
    if (this.metrics.events.length !== this.lastEventCount || force) {
      this.lastEventCount = this.metrics.events.length;
      patch.damageEvents = this.metrics.events.slice();
    }
    store.set(patch);
  }

  /** Live earthquake summary for HUDs: the current or the most recent earthquake event. */
  private quakeLive(): QuakeLive | null {
    let item = null;
    for (const i of this.scheduler.list()) if (i.event instanceof EarthquakeEvent && (i.status !== 'pending' || !item)) item = i;
    if (!item) return null;
    const ev = item.event as EarthquakeEvent;
    const q = ev.resolved;
    const gm = this.env.groundMotion;
    const active = item.status === 'active' && gm.active;
    const local = this.time - ev.startTime;
    let accel = 0;
    let accelH = 0;
    if (active) {
      gm.reference(this.time, this.quakeRef);
      const a = this.quakeRef.a;
      accel = (a[0] * gm.h1[0] + a[2] * gm.h1[1]) / GRAVITY;
      accelH = Math.hypot(a[0], a[2]) / GRAVITY;
      if (accelH > this.quakePeak) this.quakePeak = accelH;
    }
    const sp = sMinusP(Math.hypot(q.epicenter[0] / 1000, q.epicenter[1] / 1000, q.depth));
    const phase: QuakeLive['phase'] = !active ? 'end' : local < sp ? 'p' : local < q.duration * 0.6 ? 's' : 'coda';
    return {
      active, accel, accelH, peak: this.quakePeak, phase, magnitude: q.magnitude, pga: q.pga, pgaAssumed: q.pgaAssumed,
      epicenter: q.epicenter, depth: q.depth, direction: q.direction, local, duration: q.duration, sMinusP: sp,
    };
  }

  /** Live terrain deformation status (null until the first deformation starts). Phase 21. */
  private deformLive(): DeformLive | null {
    const e = this.env.deformation.engine;
    // Prescribed deformations only: the ground-failure field has its own summary (groundLive).
    const prescribed = e?.sources.filter((s) => s.kind !== 'groundFailure') ?? [];
    if (!e || !prescribed.length) return null;
    const st = this.env.deformation.stats;
    const bm = this.env.flood.field?.bedMotion;
    const last = e.history[e.history.length - 1];
    return {
      sources: prescribed.length,
      changing: prescribed.filter((s) => s.version(this.time - s.startTime) < 1 || s.duration === Infinity).length,
      maxAbs: e.maxAbs,
      volume: last?.volume ?? 0,
      updates: e.updates,
      fieldMs: st?.fieldMs ?? 0,
      colliderMs: st?.colliderMs ?? 0,
      waterMs: st?.waterMs ?? 0,
      responseMs: st?.responseMs ?? 0,
      bedVolume: bm?.displacedVolume ?? 0,
      bedRise: bm?.maxRise ?? 0,
      bedDrop: bm?.maxDrop ?? 0,
    };
  }

  /** Height of the physics collider surface under (x, z), or null (verification: collider = render). */
  colliderHeight(x: number, z: number): number | null {
    const d = this.physics?.castGroundRay([x, 500, z], [0, -1, 0], 2000);
    return d === undefined || d === null ? null : 500 - d;
  }

  /** What the runtime state of this run consists of (mid-run saving is not supported; see runtimeState.ts). */
  runtimeState() {
    return runtimeStateManifest(this.env, this.runtime, this.time);
  }

  /** Live impact summary (Phase 23): phase, countdown, entry state, energy, crater, ejecta. */
  private impactLive(): ImpactLive[] | null {
    const models = this.env.impact.models;
    if (!models.length) return null;
    return models.map((m) => {
      const p = m.plan, st = m.status();
      const toImpact = m.impactTime - this.time;
      let altitude = 0, speed = p.speed;
      const e = p.entry;
      if (e && toImpact > 0) {
        const tl = this.time - m.startTime;
        const s = e.samples.find((q) => q.t >= tl) ?? e.samples[e.samples.length - 1];
        if (s) { altitude = s.z; speed = s.v; }
      }
      const phase: ImpactLive['phase'] = p.airburst ? 'airburst' : toImpact > 0 ? 'entry' : !st.formed ? 'forming' : st.landed < st.parcels ? 'ejecta' : 'done';
      return {
        id: m.id, name: m.name, phase, toImpact, altitude, speed, energy: p.energy, tnt: p.energy / 4.184e9,
        craterD: 2 * (p.crater?.radius ?? 0), depth: p.crater?.depth ?? 0, regime: p.crater?.regime ?? '',
        launched: st.launched, landed: st.landed, parcels: st.parcels, ejectaMass: p.ejectaMass, outflowMass: p.ejectaOut,
        airburstAltitude: e?.airburst?.altitude ?? 0,
      };
    });
  }

  /** Live air-pressure wave summary (Phase 24): front, peaks felt, energy ledger. */
  private blastLive(): BlastLive[] | null {
    const ch = this.env.blast;
    if (!ch.waves.length) return null;
    return ch.waves.map((r) => {
      const w = r.wave, i = w.init, L = r.ledger.at(this.time);
      const local = this.time - i.time;
      return {
        id: i.id, name: i.name, source: i.source, kind: i.kind, phase: local < 0 ? 'pending' : this.time <= r.exit ? 'propagating' : 'passed',
        local, front: local > 0 ? w.frontRadius(this.time) : 0, energy: i.energy, pulseEnergy: w.pulseEnergy, height: w.height,
        validRadius: r.plan?.validRadius ?? w.main.validRadius(), peak: r.peak, impulse: r.impulse, reached: r.reached,
        nearSource: L.nearSource, dissipated: L.dissipated, inTransit: L.inTransit, leftWorld: L.leftWorld, notApplied: L.notApplied, residual: L.residual,
        model: i.model, waveform: i.waveform,
      };
    });
  }

  /** Live structural destruction summary (Phase 25; null without modular buildings). */
  private structureLive(): StructureLive | null {
    const rt = this.runtime;
    if (!rt?.hasModular) return null;
    const S = rt.structures;
    const out: StructureLive = {
      modular: 0, models: S?.all.length ?? 0, active: S?.active.length ?? 0, fallingBlocks: 0, damaged: 0, local: 0, partial: 0, global: 0, failedMembers: 0, connectionsFailed: 0,
      mass: { structure: 0, falling: 0, resting: 0, bodies: 0, rubble: 0, fines: 0, left: 0, unresolved: 0 }, residual: 0,
      fragments: S?.fragments.length ?? 0, fragmentsMoving: S ? S.fragments.filter((f) => !f.structural!.settled).length : 0, aggregated: S?.aggregated ?? 0,
      heaps: S?.rubble.heaps.length ?? 0, rubbleMass: S?.rubble.totalMass() ?? 0, roadsBlocked: rt.roads?.summary().rubble ?? 0, secondary: S?.secondary ?? 0,
    };
    for (const e of rt.entities.values()) if (e.modular) out.modular++;
    for (const e of S?.all ?? []) {
      const m = e.modular!.structure!.model;
      for (const b of m.blocks) if (b.active) out.fallingBlocks++;
      const lvl = e.modular!.structure!.level ?? m.collapseLevel();
      if (lvl === 'damaged') out.damaged++;
      else if (lvl === 'local') out.local++;
      else if (lvl === 'partial') out.partial++;
      else if (lvl === 'global') out.global++;
      out.failedMembers += m.structuralFailures;
      out.connectionsFailed += m.s.edgesFailed;
      const M = m.ledger.mass, o = out.mass;
      o.structure += M.structure; o.falling += M.falling; o.resting += M.resting; o.bodies += M.bodies;
      o.rubble += M.rubble; o.fines += M.fines; o.left += M.left; o.unresolved += M.unresolved;
      out.residual += m.ledger.residual();
    }
    return out;
  }

  /** Live thermal summary (Phase 26; null until heat enters the run). */
  thermalLive(): ThermalLive | null {
    const ch = this.env.thermal;
    const rt = ch.rt;
    if (!rt) return null;
    const w = rt.world, L = w.ledger, s = rt.stats;
    return {
      ambient: w.Tref,
      sources: ch.sources.map((r) => {
        const local = this.time - r.start, sp = r.spec;
        const on = activeIn(sp, local, local + 1e-6) || (sp.profile !== 'instant' && local >= 0 && local < sp.duration);
        return {
          id: r.id, name: r.name, kind: sp.kind, on, power: sp.kind === 'temperature' || sp.profile === 'instant' ? 0 : amplitude(sp) * shapeAt(sp, local),
          temperature: sp.kind === 'temperature' ? intervalTemperature(sp, local, local + 0.1, w.Tref) : null, added: L.bySource.get(r.id) ?? 0,
        };
      }),
      maxT: s.maxT, maxWhere: s.maxWhere, meanHeatedT: s.meanHeatedT, heatedArea: s.heatedArea, maxAirT: s.maxAirT, maxWaterT: s.maxWaterT, maxRoomT: s.maxRoomT, maxFlux: s.maxFlux,
      added: L.added, boundarySupply: L.boundarySupply, impactDeposit: L.impactDeposit, combustion: L.combustion, lost: L.totalLost(), losses: { ...L.lost }, transfers: { ...L.transfers },
      internal: L.final, residual: L.residual(), relativeResidual: L.relativeResidual(),
      bodies: s.bodies, buildings: s.buildings, activeTiles: s.activeTiles, substeps: w.last.substeps, maxSubsteps: w.maxSubsteps, ms: rt.ms, msTotal: rt.msTotal,
      damagedStructures: s.damagedStructures, failedMembers: s.failedMembers, minFactor: s.minFactor, maxUtil: s.maxUtil, restraint: w.settings.restraint,
    };
  }

  /** Live volcano summary (Phase 28; null until the first eruption is due). */
  volcanoLive(): VolcanoLive | null {
    const ch = this.env.volcano;
    const vr = ch.rt;
    if (!vr) return null;
    const vw = vr.world, f = vw.field, s = vr.stats;
    let vol = 0, area = 0, dArea = 0, dMax = 0, aArea = 0, aMax = 0;
    for (const i of f.mobile) { const h = f.depth(i); vol += h * f.area; if (h > 0.01) area += f.area; }
    for (let i = 0; i < f.n; i++) {
      const dl = (f.depM[i] + f.depB[i]) / (f.rho * f.area), da = f.depA[i] / (1000 * f.area);
      if (dl > 0.01) { dArea += f.area; if (dl > dMax) dMax = dl; }
      if (da > 0.001) { aArea += f.area; if (da > aMax) aMax = da; }
    }
    const o = { contact: 0, buried: 0, held: 0, toppled: 0, damaged: 0, roofAsh: 0, maxAshLoad: 0, bombs: 0 };
    for (const e of this.runtime?.entities.values() ?? []) {
      const v = e.volcano;
      if (!v) continue;
      if (v.contact > 0) o.contact++;
      if (v.noted.has('buried')) o.buried++;
      if (v.held) o.held++;
      if (e.flags.toppled && e.lastHazard === 'volcano') o.toppled++;
      if (v.damage >= 0.3) o.damaged++;
      if (v.ash > 0) o.roofAsh++;
      if (v.ashLoad > o.maxAshLoad) o.maxAshLoad = v.ashLoad;
      o.bombs += v.bombs;
    }
    let blocked = 0, impassable = 0;
    for (const sg of this.runtime?.roads?.segments ?? []) { if (sg.volcanic?.blocked) blocked++; if (sg.volcanic?.impassable) impassable++; }
    const byId = new Map(vw.eruptions.map((e) => [e.id, e]));
    return {
      material: vw.mat.id,
      eruptions: ch.eruptions.map((r) => { const e = byId.get(r.id); return { id: r.id, name: r.name, start: r.start, phase: e?.phase ?? (r.done ? 'stopped' : 'dormant'), rate: e ? e.spec.rate : 0, supplied: e ? e.lava + e.bombs + e.ash : 0, reason: r.reason, done: r.done, vents: r.spec.vents.length }; }),
      supplyRate: s.supplyRate, ledger: vw.ledger(), thermalVolcanic: vr.trt.world.ledger.volcanic,
      mobileVolume: vol, activeLava: s.activeLava, hotDeposits: s.hotDeposits, maxDepth: s.maxDepth, maxT: s.maxT, maxSpeed: s.maxSpeed, area, depositArea: dArea, maxDeposit: dMax, ashArea: aArea, maxAsh: aMax,
      bombsAir: vw.bombs.filter((b) => !b.landed).length, puffs: vw.puffs.length, substeps: s.substeps, faces: s.faces, limited: f.ledger.limited, contacts: s.contacts, receivers: s.receivers, waterAbove100: s.waterAbove100,
      objects: o, roads: { blocked, impassable }, ms: vr.ms, msTotal: vr.msTotal, cost: { ...s.ms },
    };
  }

  /** Live fire summary (Phase 27; null until the combustion model runs). */
  fireLive(): FireLive | null {
    const ch = this.env.fire;
    const fr = ch.rt;
    if (!fr) return null;
    const fw = fr.fw, w = fr.trt.world, s = fr.stats;
    const hist = fr.history();
    const step = Math.max(1, Math.ceil(hist.length / 120));
    const history: number[] = [];
    for (let i = 0; i < hist.length; i += step) history.push(hist[i]);
    return {
      hrr: s.hrr, peakHrr: s.peakHrr, peakTime: s.peakHrrTime, items: s.items, burningItems: s.burningItems, burningObjects: s.burningObjects, ignitedObjects: s.ignitedObjects,
      burnedOutObjects: s.burnedOutObjects, extinguishedItems: s.extinguishedItems, rooms: s.rooms, roomsBurning: s.roomsBurning, flashovers: s.flashovers, ventLimited: s.ventLimited,
      maxRoomT: s.maxRoomT, maxFlame: s.maxFlame, ledger: fw.ledger.snapshot(), smokeAir: s.smokeAir, minVisibility: s.minVisibility, charredMembers: s.charredMembers,
      fireFailures: s.fireFailures, windowsBroken: s.windowsBroken, treesBurned: s.treesBurned,
      ignitions: ch.ignitions.map((g) => ({ id: g.id, name: g.name, start: g.start, done: g.done, lit: g.lit, reason: g.reason })),
      roomList: fr.rooms.slice(0, 200).map((R) => {
        const F = fw.rooms[R.r], cp = w.comps[F.tc];
        return { building: R.bt.e.id, story: R.story, T: w.compT(F.tc), o2: F.gas > 0 ? F.o2 / F.gas : 0, soot: F.soot / F.V, eps: F.eps, Ao: F.Ao, hrr: F.hrr, hrrExt: F.hrrExt, flashover: F.flashover, burning: F.burning, ventLimited: F.ventLimited, open: !cp.alive };
      }),
      history, settings: { ...ch.settings }, ms: fr.ms, msTotal: fr.msTotal,
    };
  }

  /** Live ground-failure summary (Phase 22): model states, sediment budget, cost. */
  private groundLive(): GroundLive | null {
    const ch = this.env.groundFailure;
    const f = ch.field;
    if (!f) return null;
    const b = f.budget;
    let blocked = 0;
    const roads = this.runtime?.roads;
    if (roads) for (const s of roads.segments) if (s.deform?.debris && !s.deform.passable) blocked++;
    return {
      sinkholes: ch.sinkholes.map((m) => {
        let low = 0;
        for (const i of m.cells) low = Math.min(low, f.bed[i] + f.h[i]);
        return { id: m.id, name: m.name, phase: m.phase, radius: m.a, fs: m.fs, pitDepth: -low };
      }),
      landslides: ch.landslides.map((m) => ({ id: m.id, name: m.name, minFS: m.minFS, failed: m.failedCells, cells: m.cells.length, newmark: m.maxNewmark })),
      released: b.released, mobile: b.mobile, deposited: b.deposited, outflow: b.outflow, intoCavity: b.intoCavity,
      residual: b.residual, residualMass: b.residualMass, peakMobile: b.peakMobile,
      maxSpeed: ch.stats.maxSpeed, ms: ch.stats.totalMs, flowMs: ch.stats.flowMs, substeps: ch.stats.flowSubsteps, blockedRoads: blocked,
    };
  }

  /** Live water status for HUDs (null while the water model is dormant). */
  private floodLive(): FloodLive | null {
    const fl = this.env.flood;
    const f = fl.field;
    if (!f) return null;
    const levels: FloodLive['boundaries'] = { N: null, E: null, S: null, W: null };
    for (const side of BOUNDARY_SIDES) {
      const b = fl.forcing!.boundary(side);
      levels[side] = { type: b.type, level: b.type === 'fixedLevel' ? b.level : null, event: fl.forcing!.override[side] !== undefined };
    }
    const st = f.stats;
    return {
      rain: fl.rainIntensity(),
      sources: fl.forcing!.sources.reduce((a, s) => a + s.rate, 0),
      volume: st.volume,
      floodedArea: st.floodedCells * f.cellArea,
      wetArea: st.wetCells * f.cellArea,
      maxDepth: st.maxDepth,
      meanDepth: st.meanFloodDepth,
      maxSpeed: st.maxSpeed,
      boundaries: levels,
      relativeError: Math.abs(f.budget.error) / Math.max(1e-9, f.budget.initial + f.budget.rain + f.budget.sources + f.budget.boundaryIn),
      substeps: st.substeps,
    };
  }

  // ── Accessors for renderers / inspectors ──────────────────

  getRuntime(): SimulationRuntime | null {
    return this.runtime;
  }
  getMetrics(): SimulationMetrics | null {
    return this.runtime ? this.metrics.summary(this.runtime, this.time) : null;
  }
  getDamageEvents(): readonly DamageEventRecord[] {
    return this.metrics.events;
  }
  getEnvironment(): EnvironmentState {
    return this.env;
  }
  getTime() {
    return this.time;
  }
  getStatus() {
    return this.status;
  }
  isLoaded() {
    return this.runtime !== null;
  }
}

export const simulationController = new SimulationController();

/** The simulation's own copy of the terrain arrays (Phase 21: deformation writes it in place). */
export function runtimeTerrain(t: WorldDocument['terrain']): WorldDocument['terrain'] {
  return { ...t, heights: t.heights.slice(), ground: t.ground.slice(), soil: t.soil.slice(), settings: { ...t.settings }, revision: 0 };
}

/**
 * The simulation's private copy of the document. Modular building designs (Phase 17) are
 * immutable values — every edit creates a new design object and the simulation keeps its own
 * member state in typed arrays — so the snapshot REFERENCES them instead of deep-cloning
 * hundreds of members per building (they were the bulk of the snapshot's memory).
 */
export function snapshotDocument(doc: WorldDocument): WorldDocument {
  const designs = new Map<string, NonNullable<WorldDocument['objects'][string]['building']>>();
  const objects: WorldDocument['objects'] = {};
  for (const [id, o] of Object.entries(doc.objects)) {
    if (o.building) {
      designs.set(id, o.building);
      const { building: _shared, ...rest } = o;
      objects[id] = rest as WorldDocument['objects'][string];
    } else objects[id] = o;
  }
  // The road network is an immutable value too (edits create new networks): referenced.
  const { roads, ...rest } = doc;
  const copy = structuredClone({ ...rest, objects }) as WorldDocument;
  copy.roads = roads;
  for (const [id, d] of designs) copy.objects[id].building = d;
  return copy;
}

