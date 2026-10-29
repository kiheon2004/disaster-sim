/**
 * Sinkhole and landslide events (Phase 22). Like every event they only WRITE their channel: on
 * start they add their model to the run's ground-failure channel (creating the shared field on
 * first use). The GroundFailureSystem advances the models; the deformation engine applies the
 * resulting terrain. Their effect persists (the ground does not spring back).
 */
import { createId } from '@/core/id';
import type { I18nMessage } from '@/i18n/i18n';
import type { EventContext, SimulationEvent } from '../SimulationEvent';
import { SinkholeModel } from '@/ground/sinkhole';
import { LandslideModel } from '@/ground/landslide';
import { XI_DEFAULT } from '@/ground/granular';
import type { LandslideSpec, SinkholeSpec } from '@/ground/types';

/** How long the event is shown as running on the timeline (its effects continue afterwards). */
export const groundEventDuration = (s: { duration: number }) => Math.max(1, s.duration);

export class SinkholeEvent implements SimulationEvent<SinkholeSpec> {
  readonly id = createId('evt');
  readonly type = 'sinkhole' as const;
  readonly channel: string;
  readonly startTime: number;
  readonly duration: number;
  model: SinkholeModel | null = null;

  constructor(readonly spec: SinkholeSpec, now: number, private readonly seed: number) {
    this.startTime = spec.startTime ?? now;
    this.duration = groundEventDuration(spec);
    this.channel = `ground:${this.id}`;
  }

  onStart({ env }: EventContext) {
    const ch = env.groundFailure;
    const f = ch.ensure();
    this.model = new SinkholeModel(this.id, this.spec.name ?? this.id, this.spec, this.startTime, f, ch.nextIndex(), this.spec.seed ?? this.seed);
    ch.sinkholes.push(this.model);
    ch.urgent = true;
  }

  update() {}

  intensityAt(t: number): number {
    return this.spec.duration > 0 ? Math.min(1, t / this.spec.duration) : 1;
  }

  describe(): I18nMessage {
    const s = this.spec;
    return { key: `event.sinkhole.describe.${s.initiation}`, params: { a: s.cavityRadius.toFixed(1), h: s.cavityHeight.toFixed(1), H: s.cover.toFixed(1) } };
  }
}

export class LandslideEvent implements SimulationEvent<LandslideSpec> {
  readonly id = createId('evt');
  readonly type = 'landslide' as const;
  readonly channel: string;
  readonly startTime: number;
  readonly duration: number;
  model: LandslideModel | null = null;

  constructor(readonly spec: LandslideSpec, now: number, private readonly seed: number) {
    this.startTime = spec.startTime ?? now;
    this.duration = groundEventDuration(spec);
    this.channel = `ground:${this.id}`;
  }

  onStart({ env }: EventContext) {
    const ch = env.groundFailure;
    const f = ch.ensure();
    this.model = new LandslideModel(this.id, this.spec.name ?? this.id, this.spec, this.startTime, f, ch.nextIndex(), this.spec.seed ?? this.seed);
    ch.landslides.push(this.model);
    if (this.spec.boundary === 'open') ch.boundary = 'open';
    ch.turbulence = Math.min(ch.turbulence, this.spec.turbulence ?? XI_DEFAULT);
    ch.urgent = true;
  }

  update() {}

  intensityAt(t: number): number {
    return this.spec.duration > 0 ? Math.min(1, t / this.spec.duration) : 1;
  }

  describe(): I18nMessage {
    const s = this.spec;
    return { key: `event.landslide.describe.${s.trigger}`, params: { z: s.thickness.toFixed(1), m: Math.round(s.saturation * 100) } };
  }
}
