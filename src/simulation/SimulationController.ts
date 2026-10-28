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
import { EMPTY_STATS, useSimStore, type SimStats, type SimStatus, type TimelineEventView } from './simStore';

const MAX_STEPS_PER_FRAME = 16;
const PUBLISH_INTERVAL = 0.1; // s (real time)
const SETTLE_TIME = 8; // s after the last event before the run is "finished"
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
    await physics.init(this.snapshot.settings.gravity);
    if (token !== this.loadToken) {
      physics.dispose(); // a newer load/reset superseded this one
      return;
    }
    this.physics = physics;
    const sim = this.snapshot.settings.simulation ?? defaultSimulationSettings();
    this.runtime = buildRuntime(this.snapshot, physics);
    this.env = createEnvironment(this.snapshot.settings.airDensity, sim.wind, sim.seed);
    const obstacles = [];
    for (const e of this.runtime.entities.values()) {
      const o = obstacleFromEntity(e);
      if (o) obstacles.push(o);
    }
    this.env.windField.setObstacles(obstacles);
    this.rng = new Rng(sim.seed).fork('core');
    this.fxRng = new Rng(sim.seed).fork('fx');
    this.metrics = new MetricsRecorder(sim.seed);
    this.lastEventCount = -1;
    this.scheduler = new EventScheduler();
    this.systems = [...createDefaultSystems(), new MetricsSystem(this.metrics)];
    this.time = 0;
    this.accumulator = 0;
    this.lastStates = null;
    this.lastLogLength = -1;
    this.lastEventsRev = -1;
    for (const spec of this.scenario) this.scheduler.add(createEvent(spec, 0));
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
    this.scheduler.add(createEvent(absolute, this.time));
    if (this.status === 'finished') this.status = 'paused';
    this.publish(true);
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
    return Math.max(MIN_TIMELINE, planned > 0 ? planned + SETTLE_TIME : 0, this.extendEnd);
  }

  private setStatus(s: SimStatus) {
    this.status = s;
    useSimStore.getState().set({ status: s });
  }

  // ── Loop ──────────────────────────────────────────────────

  tick(realDt: number) {
    if (this.status !== 'running' || !this.runtime || !this.physics) return;
    this.accumulator += Math.min(realDt, 0.1) * this.speed;
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      this.step(FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0; // too slow: drop time rather than spiral

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
      rng: this.rng,
      fxRng: this.fxRng,
      log: (entityId, severity, message) => this.log(entityId, severity, message),
      recordDamage: (e, ev) => this.metrics.record(this.time, e, ev),
    };
    this.metrics.beginStep();
    physics.clearForces();
    for (const s of this.systems) if (s.phase === 'prePhysics') s.update(ctx, dt);
    physics.step(dt);
    for (const s of this.systems) if (s.phase === 'postPhysics') s.update(ctx, dt);
    this.time += dt;
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
      }));
    }
    patch.metrics = this.metrics.summary(rt, this.time);
    if (this.metrics.events.length !== this.lastEventCount || force) {
      this.lastEventCount = this.metrics.events.length;
      patch.damageEvents = this.metrics.events.slice();
    }
    store.set(patch);
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
