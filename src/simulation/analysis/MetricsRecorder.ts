import type { EntityId } from '@/core/types';
import type { EnvironmentState } from '../environment/EnvironmentState';
import type { RuntimeEntity, SimulationRuntime } from '../SimulationRuntime';
import { DamageState } from '../damage/DamageState';
import { HAZARDS, type DamageEventInput, type DamageEventRecord } from './DamageEvent';
import { hazardDamage } from '../interactions/integrity';
import { blastGovernsStructure, gravityGovernsStructure, impactGovernsShaking } from '../seismic/SeismicState';
import { peakAcceleration } from '@/impact/shock';
import { sourceAt } from '../ground/objects';
import { footprint } from '../deformation/response';
import { SeismicRecorder, type EarthquakeMetrics } from './SeismicRecorder';
import { FloodRecorder, type FloodMetrics } from './FloodRecorder';
import { MilestoneRecorder } from './MilestoneRecorder';

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
  /** Flood analysis (null when the water model never activated). Phase 14. */
  flood: FloodMetrics | null;
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
  /** Water time series and peaks (Phase 14). */
  readonly flood = new FloodRecorder();
  /** Experiment timeline milestones (Phase 15). */
  readonly milestones = new MilestoneRecorder();
  private env: EnvironmentState | null = null;

  constructor(readonly seed: number) {}

  beginStep() {
    this.stepMarks.clear();
  }

  record(time: number, e: RuntimeEntity, evIn: DamageEventInput) {
    const ev = this.attribute(e, evIn);
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
      memberType: ev.memberType,
      hazard: ev.hazard ?? 'wind',
      groundAcceleration: ev.groundAcceleration ?? (ev.hazard === 'earthquake' && e.seismic ? Math.hypot(e.seismic.ground.a[0], e.seismic.ground.a[2]) : 0),
      response: ev.response ?? 0,
      waterDepth: ev.waterDepth ?? (ev.hazard === 'flood' && e.flood ? e.flood.depth : 0),
      flowSpeed: ev.flowSpeed ?? (ev.hazard === 'flood' && e.flood ? e.flood.speed : 0),
      exposure: ev.exposure ?? (ev.hazard === 'flood' && e.flood ? e.flood.exposure : 0),
      state: ev.state ?? e.state,
      contributors: hazardDamage(e),
      origin: ev.hazard ?? 'wind',
      source: ev.source,
      ...(ev.failure ? { failure: ev.failure } : {}),
      ...(ev.chain ? { chain: ev.chain } : {}),
      ...(ev.secondary ? { secondary: ev.secondary } : {}),
      ...(ev.human ? { human: ev.human } : {}),
    };
    // The origin: the channel that had done the most damage (ties and undamaged → the trigger).
    let best = rec.contributors[rec.hazard];
    for (const h of HAZARDS) if (rec.contributors[h] > best + 1e-12) { best = rec.contributors[h]; rec.origin = h; }
    if (best <= 0) rec.origin = rec.hazard;
    this.events.push(rec);
    this.noteMilestone(rec);
    if (this.firstDamage === null) this.firstDamage = time;
    const b = Math.floor(time);
    while (this.histogram.length <= b) this.histogram.push(0);
    this.histogram[b]++;
    e.lastCause = ev.cause;
    e.lastHazard = rec.hazard;
  }

  /**
   * Phase 23 attribution: shaking damage (recorded by the seismic paths as 'earthquake') belongs to
   * an impact where the impact's peak ground acceleration governed at the object; ground damage
   * (foundations, burial, sediment) whose source is an impact belongs to the impact.
   */
  private attribute(e: RuntimeEntity, ev: DamageEventInput): DamageEventInput {
    // Phase 24: structural damage recorded by the seismic paths (drift, members, collapse) is the
    // air-pressure wave's where its lateral load governed the structure's response.
    // Phase 32: …and the gravity field's where a celestial source's lateral field governed it.
    if (ev.hazard === 'earthquake' && gravityGovernsStructure(e.seismic)) return { ...ev, hazard: 'gravity', cause: ev.cause === 'shaking' ? 'tidalLoad' : ev.cause };
    if (ev.hazard === 'earthquake' && blastGovernsStructure(e.seismic)) return { ...ev, hazard: 'blast', cause: ev.cause === 'shaking' ? 'blast' : ev.cause, source: ev.source ?? e.blast?.source };
    if (ev.hazard === 'blast' && !ev.source) return { ...ev, source: e.blast?.source };
    if (ev.hazard === 'earthquake' && impactGovernsShaking(e.seismic)) return { ...ev, hazard: 'impact', source: ev.source ?? this.shockSource(e) };
    if (ev.hazard === 'ground') {
      // Ground responses of the Phase 21 path carry no source: the phenomenon that owns the field
      // under the object (a sinkhole, a landslide, an impact crater / rim / deposit).
      const source = ev.source ?? e.ground?.source ?? this.fieldSource(e);
      if (source && e.ground && !e.ground.source) e.ground.source = source;
      if (source?.startsWith('impact:')) return { ...ev, hazard: 'impact', source };
      return source ? { ...ev, source } : ev;
    }
    if (ev.hazard === 'impact' && !ev.source) return { ...ev, source: e.impact?.source ?? this.shockSource(e) };
    return ev;
  }

  /** Phenomenon owning the ground-failure field at the object's footprint centre ('impact:p1' …). */
  private fieldSource(e: RuntimeEntity): string | undefined {
    const ch = this.env?.groundFailure;
    if (!ch?.field) return undefined;
    const p = e.initialPose.position;
    const { hx, hz, yaw } = footprint(e);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    for (const [u, v] of [[0, 0], [-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const src = sourceAt(ch, p[0] + u * hx * c + v * hz * s, p[2] - u * hx * s + v * hz * c);
      if (src) return src;
    }
    return undefined;
  }

  /** The impact whose shock is strongest at the object. */
  private shockSource(e: RuntimeEntity): string | undefined {
    const shocks = this.env?.groundMotion.shocks ?? [];
    let best: string | undefined, max = -1;
    for (const s of shocks) {
      const a = peakAcceleration(s, Math.hypot(e.pose.position[0] - s.center[0], e.pose.position[2] - s.center[1]), true);
      if (a > max) { max = a; best = s.source; }
    }
    return best;
  }

  private noteMilestone(r: DamageEventRecord) {
    const ms = this.milestones;
    const hz = r.hazard;
    ms.once(`dmg:${hz}`, { time: r.time, kind: 'firstDamage', hazard: hz, subject: r.objectType, label: { key: 'milestone.firstDamage', params: { hazard: hz, event: r.eventType } } });
    if ((r.eventType === 'COLLAPSED' || r.eventType === 'STORY_COLLAPSED') && r.objectType === 'building') ms.add({ time: r.time, kind: 'collapse', hazard: hz, subject: r.objectType, label: { key: 'milestone.collapse', params: { hazard: hz } } });
    if (r.eventType === 'FALLEN') ms.once(`fall:${hz}`, { time: r.time, kind: 'firstFall', hazard: hz, subject: r.objectType, label: { key: 'milestone.firstFall', params: { hazard: hz } } });
    if (r.eventType === 'FLOATED') ms.once('floated', { time: r.time, kind: 'floated', hazard: hz, subject: r.objectType, label: { key: 'milestone.floated' } });
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
    this.env = env;
    this.flood.sample(env, runtime, dt);
    const f = env.flood?.field;
    if (f) this.milestones.floodArea(env.time, f.stats.floodedCells * f.cellArea);
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
      flood: this.env ? this.flood.summary(this.env, runtime, this.events, time) : null,
    };
  }
}
