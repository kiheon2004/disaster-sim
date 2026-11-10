import { bearingOf, nearestCompass } from '@/core/compass';
import { clamp, lerp, smoothstep } from '@/core/math';
import { createId } from '@/core/id';
import type { I18nMessage } from '@/i18n/i18n';
import type { EventContext, SimulationEvent } from '../SimulationEvent';
import type { WindEventSpec } from '../specs';

const FADE_OUT = 4; // s
const DIRECTION_TURN = 3; // s to rotate to a new direction
export const DEFAULT_GUST = 0.25;
export const DEFAULT_RAMP = 3;

function shortestAngleLerp(a: number, b: number, t: number) {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return (a + d * t + 360) % 360;
}

/** Wind / typhoon: ramps to a target speed, holds with gusts, then fades out. */
export class WindEvent implements SimulationEvent<WindEventSpec> {
  readonly id = createId('evt');
  readonly type = 'wind' as const;
  readonly channel = 'wind';
  readonly startTime: number;
  readonly duration: number;
  private fromSpeed = 0;
  private fromBearing = 0;
  private fromGust = 0;
  private superseded = false;

  constructor(readonly spec: WindEventSpec, now: number) {
    this.startTime = spec.startTime ?? now;
    this.duration = Math.max(1, spec.duration);
  }

  private get ramp() {
    return clamp(this.spec.rampDuration ?? DEFAULT_RAMP, 0.1, this.duration);
  }
  private get target() {
    return clamp(this.spec.speed, 0, 150);
  }
  private get gust() {
    return clamp(this.spec.gustStrength ?? DEFAULT_GUST, 0, 1);
  }

  onStart({ env }: EventContext) {
    const w = env.wind;
    const target = bearingOf(this.spec.direction);
    this.fromSpeed = this.spec.rampFrom ?? w.baseSpeed;
    this.fromBearing = w.baseSpeed > 0.5 ? w.fromBearing : target;
    this.fromGust = w.baseSpeed > 0.5 ? w.gustStrength : this.gust;
  }

  /** Planned speed profile (uses rampFrom or 0 when unknown). */
  private speedAt(t: number, from: number): number {
    const fadeStart = this.duration - FADE_OUT;
    let s = t < this.ramp ? lerp(from, this.target, smoothstep(0, 1, t / this.ramp)) : this.target;
    if (t > fadeStart && this.duration > FADE_OUT * 1.5) s *= clamp((this.duration - t) / FADE_OUT, 0, 1);
    return s;
  }

  update({ env }: EventContext, t: number) {
    const w = env.wind;
    w.baseSpeed = this.speedAt(t, this.fromSpeed);
    const k = smoothstep(0, 1, t / Math.min(DIRECTION_TURN, this.duration));
    w.fromBearing = shortestAngleLerp(this.fromBearing, bearingOf(this.spec.direction), k);
    w.gustStrength = lerp(this.fromGust, this.gust, k);
  }

  onEnd({ env }: EventContext, reason: 'finished' | 'superseded') {
    this.superseded = reason === 'superseded';
    if (reason === 'finished') env.wind.baseSpeed = 0;
  }

  /** Phase 35.5 control: the wind dies down now (the global wind is one weather state — no pause). */
  stop(ctx: EventContext) {
    this.onEnd(ctx, 'finished');
  }

  intensityAt(t: number): number {
    if (t < 0 || t > this.duration) return 0;
    return this.speedAt(t, this.spec.rampFrom ?? 0) / 100;
  }

  describe(): I18nMessage {
    return {
      key: 'event.wind.describe',
      params: {
        speed: Math.round(this.target),
        dir: typeof this.spec.direction === 'number' ? nearestCompass(this.spec.direction) : this.spec.direction,
        duration: Math.round(this.duration),
      },
    };
  }

  get wasSuperseded() {
    return this.superseded;
  }
}
