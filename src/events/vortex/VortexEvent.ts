/**
 * Placed vortex wind (Phase 35.5). Like every event it only WRITES its channel: while it runs it keeps a VortexState in
 * env.wind.vortices (centre moved along its track, amplitude ramped); the spatial wind field adds its wind to every
 * sample, so wind forces, damage and people react through the existing wind systems.
 */
import { createId } from '@/core/id';
import type { I18nMessage } from '@/i18n/i18n';
import type { EventContext, SimulationEvent } from '../SimulationEvent';
import type { TornadoSpec } from '@/vortex/types';
import { rampAt, trackVelocity, vortexState, type VortexState } from '@/vortex/model';

export class VortexEvent implements SimulationEvent<TornadoSpec> {
  readonly id = createId('evt');
  readonly type = 'tornado' as const;
  readonly channel: string;
  readonly startTime: number;
  readonly duration: number;
  private state: VortexState | null = null;

  constructor(readonly spec: TornadoSpec, now: number) {
    this.startTime = spec.startTime ?? now;
    this.duration = Math.max(1, spec.duration);
    // Independent instances: several vortices coexist and add their winds.
    this.channel = `vortex:${this.id}`;
  }

  private attach(env: EventContext['env']) {
    if (!this.state) this.state = vortexState(this.spec.name ?? this.id, this.spec);
    if (!env.wind.vortices.includes(this.state)) env.wind.vortices.push(this.state);
  }

  private detach(env: EventContext['env']) {
    const k = this.state ? env.wind.vortices.indexOf(this.state) : -1;
    if (k >= 0) env.wind.vortices.splice(k, 1);
  }

  onStart({ env }: EventContext) {
    this.attach(env);
  }

  update(_ctx: EventContext, local: number) {
    const v = this.state;
    if (!v) return;
    const [ux, uz] = trackVelocity(this.spec);
    v.cx = this.spec.position[0] + ux * local;
    v.cz = this.spec.position[1] + uz * local;
    v.amp = rampAt(this.spec, local);
  }

  onEnd({ env }: EventContext) {
    this.detach(env);
  }

  /** Phase 35.5 controls: the vortex vanishes now / pauses (its wind is off, its centre holds) and resumes. */
  stop(ctx: EventContext) {
    this.detach(ctx.env);
  }

  pause(ctx: EventContext) {
    this.detach(ctx.env);
  }

  resume(ctx: EventContext) {
    this.attach(ctx.env);
  }

  intensityAt(t: number): number {
    return rampAt(this.spec, t) * Math.min(1, this.spec.maxSpeed / 90);
  }

  describe(): I18nMessage {
    return describeVortex(this.spec);
  }
}

export function describeVortex(s: TornadoSpec): I18nMessage {
  return { key: 'vortex.describe', params: { v: Math.round(s.maxSpeed), r: Math.round(s.coreRadius), x: Math.round(s.position[0]), z: Math.round(s.position[1]), d: Math.round(s.duration) } };
}
