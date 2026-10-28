import { createId } from '@/core/id';
import type { I18nMessage } from '@/i18n/i18n';
import type { EventContext, SimulationEvent } from '../SimulationEvent';
import type { EarthquakeEventSpec } from '../specs';
import { resolveEarthquake, type ResolvedEarthquake } from './resolveEarthquake';
import { createWaveform } from '@/simulation/seismic/GroundMotionField';
import { AXIS_H1, WAVE_RATE, type SyntheticWaveform } from '@/simulation/seismic/SyntheticWaveform';
import { GRAVITY } from '@/core/units';

/**
 * Earthquake: drives env.groundMotion with a synthetic waveform for `duration` seconds.
 * Like every event it only writes the environment — structures, people and objects react
 * through their own systems. A new earthquake supersedes a running one (channel).
 */
export class EarthquakeEvent implements SimulationEvent<EarthquakeEventSpec> {
  readonly id = createId('evt');
  readonly type = 'earthquake' as const;
  readonly channel = 'earthquake';
  readonly startTime: number;
  readonly duration: number;
  readonly resolved: ResolvedEarthquake;
  /** Built eagerly (deterministic): the timeline can draw the planned waveform before it starts. */
  readonly wave: SyntheticWaveform;

  constructor(readonly spec: EarthquakeEventSpec, now: number, defaultSeed = 1) {
    this.startTime = spec.startTime ?? now;
    this.resolved = resolveEarthquake(spec, defaultSeed);
    this.duration = this.resolved.duration;
    this.wave = createWaveform(this.resolved);
  }

  onStart({ env }: EventContext) {
    env.groundMotion.start(this.resolved, this.wave, this.startTime);
  }

  update() {
    // The field is a function of time; nothing to integrate here.
  }

  onEnd({ env }: EventContext) {
    env.groundMotion.stop();
  }

  intensityAt(t: number): number {
    if (t < 0 || t > this.duration) return 0;
    return Math.min(1, this.wave.envelopeAt(t) * Math.min(1, this.resolved.pga / 0.6));
  }

  /** Planned principal-axis acceleration at the map center, `n` samples over the event (g). */
  waveform(n: number): number[] {
    const a = this.wave.soil(1).a[AXIS_H1];
    const out: number[] = [];
    for (let k = 0; k < n; k++) {
      // Peak of |a| within each bucket keeps the envelope visible at low resolution.
      const i0 = Math.floor((k / n) * this.duration * WAVE_RATE);
      const i1 = Math.min(a.length - 1, Math.floor(((k + 1) / n) * this.duration * WAVE_RATE));
      let best = 0;
      for (let i = i0; i <= i1; i++) if (Math.abs(a[i]) > Math.abs(best)) best = a[i];
      out.push(best / GRAVITY);
    }
    return out;
  }

  describe(): I18nMessage {
    const q = this.resolved;
    return {
      key: 'event.earthquake.describe',
      params: { magnitude: q.magnitude.toFixed(1), pga: q.pga.toFixed(2), duration: Math.round(q.duration) },
    };
  }
}
