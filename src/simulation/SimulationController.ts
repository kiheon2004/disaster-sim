import type { WorldDocument } from '@/core/model';
import type { EntityId } from '@/core/types';
import { FIXED_DT, type SimSpeed } from '@/core/units';
import type { I18nMessage } from '@/i18n/i18n';
import type { PhysicsEngine } from '@/physics/PhysicsEngine';
import { EventScheduler } from '@/events/EventScheduler';
import { createEvent } from '@/events/eventRegistry';
import type { EventSpec } from '@/events/specs';
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
import { floodFeatures } from './water/floodFeatures';
import { captureWaterState, type WaterStateSnapshot } from './water/waterStateCodec';
import type { FloodLive } from './simStore';

const MAX_STEPS_PER_FRAME = 16;
/** Wall-clock budget for physics per frame; beyond it the simulation slows instead of the UI freezing. */
const STEP_BUDGET_MS = 12;
const PUBLISH_INTERVAL = 0.1; // s (real time)
const SETTLE_TIME = 8; // s after the last event before the run is "finished"
/** Water keeps running off after the last water event: give it longer before "finished". */
const SETTLE_TIME_WATER = 60;
const MIN_TIMELINE = 30; // s
const LOG_LIMIT = 300;

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

  // ── Lifecycle ─────────────────────────────────────────────

  /** Build a runtime from a snapshot of the document. Leaves the simulation paused at t = 0. */
  async load(doc: WorldDocument): Promise<void> {
    const token = ++this.loadToken;
    this.disposeRuntime();
    this.snapshot = structuredClone(doc);
    this.scenario = [];
    this.setStatus('loading');
    await this.rebuild(token);
  }

  private async rebuild(token = ++this.loadToken) {
    this.disposeRuntime();
    if (!this.snapshot) return;
    // Rapier (WASM) is loaded on demand so the editor starts fast.
    const { RapierEngine } = await import('@/physics/RapierEngine');
    const physics = new RapierEngine();
    // The terrain is frozen while simulating: its collider is built once per (re)load.
    const t0 = performance.now();
    await physics.init(this.snapshot.settings.gravity, terrainColliderDesc(this.snapshot.terrain));
    this.terrainBuildMs = performance.now() - t0;
    if (token !== this.loadToken) {
      physics.dispose(); // a newer load/reset superseded this one
      return;
    }
    this.physics = physics;
    const sim = this.snapshot.settings.simulation ?? defaultSimulationSettings();
    const terrain = new TerrainSampler(this.snapshot.terrain);
    this.runtime = buildRuntime(this.snapshot, physics, terrain);
    this.env = createEnvironment(this.snapshot.settings.airDensity, sim.wind, sim.seed, terrain, sim.water ?? defaultWaterSettings());
    const obstacles = [];
    for (const e of this.runtime.entities.values()) {
      const o = obstacleFromEntity(e);
      if (o) obstacles.push(o);
    }
    this.env.windField.setObstacles(obstacles);
    // Water model inputs (used only if a water event starts): solid footprints + road surfaces.
    const features = floodFeatures(this.runtime);
    this.env.flood.setFeatures(features.obstacles, features.roads);
    this.env.flood.initialState = this.initialWater;
    this.rng = new Rng(sim.seed).fork('core');
    this.fxRng = new Rng(sim.seed).fork('fx');
    this.metrics = new MetricsRecorder(sim.seed);
    this.lastEventCount = -1;
    this.scheduler = new EventScheduler();
    this.systems = [...createDefaultSystems(), new MetricsSystem(this.metrics)];
    this.time = 0;
    this.stepIndex = 0;
    this.accumulator = 0;
    this.lastStates = null;
    this.lastLogLength = -1;
    this.lastEventsRev = -1;
    this.quakePeak = 0;
    this.lastSeriesLength = -1;
    this.lastFloodSeriesLength = -1;
    for (const spec of this.scenario) this.scheduler.add(createEvent(spec, 0, this.eventDefaults()));
    this.status = 'paused';
    useSimStore.getState().set({ runtimeVersion: useSimStore.getState().runtimeVersion + 1 });
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
      floodSeries: null,
    });
  }

  private disposeRuntime() {
    this.physics?.dispose();
    this.physics = null;
    this.runtime = null;
  }

  // ── Controls ──────────────────────────────────────────────

  /** Schedule an event. Without an explicit start time it begins now. */
  addEvent(spec: EventSpec) {
    const absolute: EventSpec = { ...spec, startTime: spec.startTime ?? this.time };
    this.scenario.push(absolute);
    this.scheduler.add(createEvent(absolute, this.time, this.eventDefaults()));
    if (this.status === 'finished') this.status = 'paused';
    this.publish(true);
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

  private endTime(): number {
    const planned = this.scheduler.plannedEnd();
    const settle = this.scenario.some(isWaterEvent) ? SETTLE_TIME_WATER : SETTLE_TIME;
    return Math.max(MIN_TIMELINE, planned > 0 ? planned + settle : 0, this.extendEnd);
  }

  private setStatus(s: SimStatus) {
    this.status = s;
    useSimStore.getState().set({ status: s });
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
    this.scheduler.update({ env: this.env, time: this.time }, dt, (ev) =>
      this.log(null, 'info', { key: 'log.event.started', params: { label: '', eventKey: ev.describe().key, ...ev.describe().params } }),
    );

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
    for (const s of this.systems) {
      if (s.phase !== phase) continue;
      const every = s.interval ?? 1;
      if (every > 1 && this.stepIndex % every !== 0) continue;
      const t0 = simProfiler.now();
      s.update(ctx, dt * every);
      simProfiler.add(`sys.${s.name}`, t0);
    }
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
    patch.flood = this.floodLive();
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
