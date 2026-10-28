import type { EntityId } from '@/core/types';
import type { EnvironmentState } from '../environment/EnvironmentState';
import type { RuntimeEntity, SimulationRuntime } from '../SimulationRuntime';
import { DamageState } from '../damage/DamageState';
import type { DamageEventInput, DamageEventRecord } from './DamageEvent';
import { SeismicRecorder, type EarthquakeMetrics } from './SeismicRecorder';

export interface SimulationMetrics {
  seed: number;
  duration: number;
  maxWindSpeed: number;
  maxLocalWindSpeed: number;
  maxLocalWindObject: EntityId | null;
  averageWindSpeed: number;
  objectsDamaged: number;
  objectsDestroyed: number;
  buildingsDamaged: number;
  treesFallen: number;
  vehiclesMoved: number;
  humansFallen: number;
  firstDamageTime: number | null;
  peakDamageTime: number | null;
  peakDamageCount: number;
  totalDamageEvents: number;
  /** Damage events per second bucket (index = floor(time)). */
  histogram: number[];
  /** Earthquake analysis (null when no earthquake ran). */
  earthquake: EarthquakeMetrics | null;
}

const MAX_EVENTS = 20000;

/**
 * Accumulates analysis data during a run: wind statistics, structured damage events and
 * derived summary metrics. Pure bookkeeping — it never influences the simulation.
 */
export class MetricsRecorder {
  readonly events: DamageEventRecord[] = [];
  private nextId = 1;
  private maxGlobal = 0;
  private maxLocal = 0;
  private maxLocalId: EntityId | null = null;
  private windSum = 0;
  private windTime = 0;
  private histogram: number[] = [];
  private firstDamage: number | null = null;
  /** step → entity ids that already produced a specific event this step */
  private stepMarks = new Set<EntityId>();
  /** Earthquake peaks and time series (Phase 13). */
  readonly seismic = new SeismicRecorder();

  constructor(readonly seed: number) {}

  beginStep() {
    this.stepMarks.clear();
  }

  record(time: number, e: RuntimeEntity, ev: DamageEventInput) {
    this.stepMarks.add(e.id);
    if (this.events.length >= MAX_EVENTS) return;
    const rec: DamageEventRecord = {
      id: this.nextId++,
      time,
      objectId: e.id,
      objectType: e.source.type,
      globalWindSpeed: e.localWind.global,
      worldPosition: ev.worldPosition ?? [...e.pose.position],
      localWindSpeed: ev.localWindSpeed ?? e.localWind.speed,
      force: ev.force ?? e.windLoad,
      damageBefore: ev.damageBefore ?? 1 - e.health,
      damageAfter: ev.damageAfter ?? 1 - e.health,
      shadowSource: ev.shadowSource ?? e.localWind.shadowSource,
      eventType: ev.eventType,
      cause: ev.cause,
      componentId: ev.componentId,
      componentKind: ev.componentKind,
      hazard: ev.hazard ?? 'wind',
      groundAcceleration: ev.groundAcceleration ?? (ev.hazard === 'earthquake' && e.seismic ? Math.hypot(e.seismic.ground.a[0], e.seismic.ground.a[2]) : 0),
      response: ev.response ?? 0,
    };
    this.events.push(rec);
    if (this.firstDamage === null) this.firstDamage = time;
    const b = Math.floor(time);
    while (this.histogram.length <= b) this.histogram.push(0);
    this.histogram[b]++;
    e.lastCause = ev.cause;
    e.lastHazard = rec.hazard;
  }

  /** Whether a specific event was already recorded for this entity in the current step. */
  recordedThisStep(id: EntityId) {
    return this.stepMarks.has(id);
  }

  sample(env: EnvironmentState, runtime: SimulationRuntime, dt: number) {
    const g = env.wind.baseSpeed;
    if (g > this.maxGlobal) this.maxGlobal = g;
    if (g > 0.1) {
      this.windSum += g * dt;
      this.windTime += dt;
    }
    for (const e of runtime.entities.values()) {
      if (e.localWind.speed > this.maxLocal) {
        this.maxLocal = e.localWind.speed;
        this.maxLocalId = e.id;
      }
    }
    this.seismic.sample(env, runtime, dt);
  }

  summary(runtime: SimulationRuntime, time: number): SimulationMetrics {
    let damaged = 0, destroyed = 0, buildings = 0, trees = 0, cars = 0, humans = 0;
    for (const e of runtime.entities.values()) {
      if (e.def.inert) continue;
      if (e.peakState === DamageState.DESTROYED) destroyed++;
      else if (e.peakState >= DamageState.DAMAGED) damaged++;
      if (e.source.type === 'building' && e.peakState >= DamageState.DAMAGED) buildings++;
      if (e.source.type === 'tree' && (e.flags.snapped || e.flags.uprooted)) trees++;
      if (e.source.type === 'car' && e.displacement > 1) cars++;
      if (e.source.type === 'human' && e.flags.fallen) humans++;
    }
    let peakIdx = -1, peakCount = 0;
    this.histogram.forEach((c, i) => {
      if (c > peakCount) { peakCount = c; peakIdx = i; }
    });
    return {
      seed: this.seed,
      duration: time,
      maxWindSpeed: this.maxGlobal,
      maxLocalWindSpeed: this.maxLocal,
      maxLocalWindObject: this.maxLocalId,
      averageWindSpeed: this.windTime > 0 ? this.windSum / this.windTime : 0,
      objectsDamaged: damaged,
      objectsDestroyed: destroyed,
      buildingsDamaged: buildings,
      treesFallen: trees,
      vehiclesMoved: cars,
      humansFallen: humans,
      firstDamageTime: this.firstDamage,
      peakDamageTime: peakIdx >= 0 ? peakIdx + 0.5 : null,
      peakDamageCount: peakCount,
      totalDamageEvents: this.events.length,
      histogram: this.histogram.slice(),
      earthquake: this.seismic.summary(runtime, this.events),
    };
  }
}
