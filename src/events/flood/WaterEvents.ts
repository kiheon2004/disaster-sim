/**
 * Water events (Phase 14). Like every event they only WRITE the environment (the water
 * forcing); the WaterSolverSystem moves the water and objects react through their systems.
 * The first water event to start activates the water model (builds the grid).
 *
 * Channels: a new rain replaces a running rain; a rising-water event replaces another on the
 * same edge; water sources are independent (several can run at once).
 */
import { createId } from '@/core/id';
import type { TerrainData, WaterSettings } from '@/core/model';
import type { I18nMessage } from '@/i18n/i18n';
import type { EventContext, SimulationEvent } from '../SimulationEvent';
import type { RainEventSpec, RisingWaterEventSpec, WaterSourceEventSpec } from '../specs';
import { mmPerHour } from '@/simulation/water/waterParams';
import { DEFAULT_SOURCE_RADIUS, resolveRisingWater, type ResolvedRisingWater } from './resolveFlood';

export class RainEvent implements SimulationEvent<RainEventSpec> {
  readonly id = createId('evt');
  readonly type = 'rain' as const;
  readonly channel = 'rain';
  readonly startTime: number;
  readonly duration: number;

  constructor(readonly spec: RainEventSpec, now: number) {
    this.startTime = spec.startTime ?? now;
    this.duration = spec.duration;
  }

  onStart({ env, time }: EventContext) {
    const field = env.flood.activate(time);
    env.flood.forcing!.addRain(field, this.id, mmPerHour(this.spec.intensity), this.spec.area ?? null);
  }

  update() {
    // Constant intensity; the solver integrates it.
  }

  onEnd({ env }: EventContext) {
    env.flood.forcing?.removeRain(this.id);
  }

  intensityAt(t: number): number {
    return t < 0 || t > this.duration ? 0 : Math.min(1, this.spec.intensity / 100);
  }

  describe(): I18nMessage {
    return { key: 'event.rain.describe', params: { mm: this.spec.intensity, min: +(this.duration / 60).toFixed(1) } };
  }
}

export class RisingWaterEvent implements SimulationEvent<RisingWaterEventSpec> {
  readonly id = createId('evt');
  readonly type = 'risingWater' as const;
  readonly channel: string;
  readonly startTime: number;
  readonly duration: number;
  readonly resolved: ResolvedRisingWater;
  /** Actual level at the edge when the event started (set in onStart). */
  private from = 0;

  constructor(readonly spec: RisingWaterEventSpec, now: number, terrain: TerrainData | null, water?: WaterSettings) {
    this.startTime = spec.startTime ?? now;
    this.resolved = resolveRisingWater(spec, terrain, water);
    this.duration = this.resolved.duration;
    this.channel = `water.${spec.boundary}`;
    this.from = this.resolved.startLevel;
  }

  /** Planned edge level at an event-local time (m). */
  levelAt(local: number): number {
    const { level, riseRate } = this.resolved;
    const dir = level >= this.from ? 1 : -1;
    const l = this.from + (dir * riseRate * local) / 60;
    return dir > 0 ? Math.min(level, l) : Math.max(level, l);
  }

  onStart({ env, time }: EventContext) {
    env.flood.activate(time);
    const b = env.flood.forcing!.boundary(this.spec.boundary);
    // Start from the water already at the edge (a fixed level) or from its lowest ground.
    this.from = b.type === 'fixedLevel' ? Math.max(b.level, this.resolved.edgeGround[0]) : this.resolved.edgeGround[0];
    env.flood.setBoundaryLevel(this.spec.boundary, this.id, this.from);
  }

  update({ env }: EventContext, local: number) {
    env.flood.setBoundaryLevel(this.spec.boundary, this.id, this.levelAt(local));
  }

  onEnd({ env }: EventContext) {
    env.flood.clearBoundary(this.spec.boundary, this.id);
  }

  intensityAt(t: number): number {
    if (t < 0 || t > this.duration) return 0;
    const r = this.resolved;
    const span = Math.abs(r.level - this.from);
    return span > 1e-6 ? Math.min(1, Math.abs(this.levelAt(t) - this.from) / span) : 1;
  }

  describe(): I18nMessage {
    return { key: `event.risingWater.describe.${this.spec.boundary}`, params: { level: this.spec.level.toFixed(1), rate: this.resolved.riseRate } };
  }
}

export class WaterSourceEvent implements SimulationEvent<WaterSourceEventSpec> {
  readonly id = createId('evt');
  readonly type = 'waterSource' as const;
  readonly channel: string;
  readonly startTime: number;
  readonly duration: number;

  constructor(readonly spec: WaterSourceEventSpec, now: number) {
    this.startTime = spec.startTime ?? now;
    this.duration = spec.duration;
    this.channel = `source.${this.id}`;
  }

  onStart({ env, time }: EventContext) {
    const field = env.flood.activate(time);
    env.flood.forcing!.addSource(field, this.id, this.spec.rate, this.spec.position, this.spec.radius ?? DEFAULT_SOURCE_RADIUS);
  }

  update() {
    // Constant inflow.
  }

  onEnd({ env }: EventContext) {
    env.flood.forcing?.removeSource(this.id);
  }

  intensityAt(t: number): number {
    return t < 0 || t > this.duration ? 0 : Math.min(1, 0.3 + this.spec.rate / 10);
  }

  describe(): I18nMessage {
    const [x, z] = this.spec.position;
    return { key: 'event.waterSource.describe', params: { rate: this.spec.rate, x: Math.round(x), z: Math.round(z), min: +(this.duration / 60).toFixed(1) } };
  }
}
