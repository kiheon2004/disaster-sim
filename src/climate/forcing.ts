/**
 * Climate forcing of an experiment (Phase 30): the background (free-atmosphere) air state, the precipitation
 * and the sun at an instance-local time — a pure function of the spec, so a run, the editor preview and the
 * tests read the same values.
 */
import type { ClimateSpec } from './types';
import { endValue, precipIntegral, precipShape, shapeOf, valueAt, type PrecipProfile, type ValueProfile } from './profiles';
import { humidityFromRH, vapourPressure, wetBulb } from './psychro';
import { irradiance, skyTemperature, sunPosition, type SunState } from './solar';

export interface BackgroundState {
  /** Air temperature (K), relative humidity (over water), specific humidity (kg/kg), vapour pressure (Pa). */
  T: number;
  RH: number;
  q: number;
  e: number;
  /** Wet-bulb temperature (K) and effective sky temperature (K). */
  Tw: number;
  Tsky: number;
}

export class ClimateForcing {
  readonly vp: ValueProfile;
  readonly pp: PrecipProfile | null;
  /** Precipitation rate at shape 1 (kg/(m²·s) = mm/s). */
  readonly rate: number;

  constructor(readonly spec: ClimateSpec, readonly p: number) {
    this.vp = { profile: spec.profile, duration: spec.duration, ramp: spec.ramp, stages: spec.stages, period: spec.period, windows: spec.windows };
    const P = spec.precipitation ?? 0;
    this.rate = P / 3600;
    if (P > 0) {
      const st = spec.precipStart ?? 0;
      this.pp = { profile: spec.precipProfile ?? 'constant', start: st, duration: spec.precipDuration ?? spec.duration - st, ramp: spec.precipRamp, windows: spec.precipWindows };
    } else this.pp = null;
  }

  temperature(t: number): number {
    return valueAt(this.vp, this.spec.temperature, this.spec.target, t);
  }

  humidity(t: number): number {
    const s = this.spec;
    const h1 = s.humidityTarget ?? s.humidity;
    return Math.min(1, s.humidity + (h1 - s.humidity) * shapeOf(this.vp, s.temperature, s.target, t));
  }

  /** Background state at local time t (pressure p, cloud cover from the spec). */
  background(t: number, p = this.p): BackgroundState {
    const T = this.temperature(t);
    const RH = this.humidity(t);
    const q = humidityFromRH(RH, T, p);
    const e = vapourPressure(q, p);
    return { T, RH, q, e, Tw: wetBulb(T, q, p), Tsky: skyTemperature(T, e, this.cloud()) };
  }

  cloud(): number {
    return this.spec.solar === 'off' ? 0 : this.spec.cloud ?? 0;
  }

  /** Precipitation (kg/m², water) over local [a, b). */
  precipitation(a: number, b: number): number {
    return this.pp ? this.rate * precipIntegral(this.pp, a, b) : 0;
  }

  /** Precipitation rate now (mm/h). */
  precipRate(t: number): number {
    return this.pp ? this.rate * 3600 * precipShape(this.pp, t) : 0;
  }

  /** Sun at local time t (zero irradiance when off / below the horizon). */
  sun(t: number): SunState {
    const s = this.spec;
    if (s.solar === 'off') return { elevation: -1, dir: [0, -1, 0], direct: 0, diffuse: 0 };
    const hour0 = s.hour ?? 12;
    const hour = s.solar === 'constant' ? hour0 : hour0 + t / 3600;
    const pos = sunPosition(s.latitude ?? 37.5, s.dayOfYear ?? 172, ((hour % 24) + 24) % 24);
    if (s.solar === 'constant') {
      // Prescribed global horizontal irradiance: split as a clear sky would at the start's sun height.
      const G = s.irradiance ?? 0;
      const sinB = Math.max(0.05, Math.sin(pos.elevation));
      const clear = irradiance(Math.max(0.05, pos.elevation), 0);
      const share = clear.direct * sinB / Math.max(1e-9, clear.direct * sinB + clear.diffuse);
      return { elevation: Math.max(0.05, pos.elevation), dir: pos.elevation > 0.05 ? pos.dir : [0, 1, 0], direct: (G * share) / sinB, diffuse: G * (1 - share) };
    }
    const ir = irradiance(pos.elevation, this.cloud());
    return { elevation: pos.elevation, dir: pos.dir, direct: ir.direct, diffuse: ir.diffuse };
  }

  /** Temperature the path holds after the duration (K). */
  endTemperature(): number {
    return endValue(this.vp, this.spec.temperature, this.spec.target);
  }
}
