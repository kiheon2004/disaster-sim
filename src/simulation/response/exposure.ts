/**
 * Environmental exposure state of people (Phase 15) — the extensible "what is this person
 * exposed to" record that future phenomena (pressure, oxygen, temperature, gravity) fill in.
 *
 * Only quantities the simulation computes are measured: local wind, water depth / flow, ground
 * acceleration. Air pressure, O₂ and temperature are the STANDARD-ATMOSPHERE BASELINE constants
 * (no atmosphere or thermal model exists yet) and are labeled as such in the UI.
 * There is no physiology: nothing here estimates injury, survival or safety.
 */
import { GRAVITY } from '@/core/units';
import { BASELINE_ATMOSPHERE, type AtmosphereSample } from '@/phenomena/channels';
import type { RuntimeEntity } from '../SimulationRuntime';
import type { SimulationSystem, SystemContext } from '../systems/SimulationSystem';

export interface ExposureState {
  /** Local wind speed at the body (m/s). */
  wind: number;
  /** Water depth at the feet (m) and flow speed (m/s). */
  waterDepth: number;
  flowSpeed: number;
  /** Horizontal ground acceleration (g). */
  groundAccel: number;
  /** Baseline constants until an atmosphere / thermal channel exists (`measured: false`). */
  atmosphere: Readonly<AtmosphereSample>;
  atmosphereMeasured: false;
  /** Peaks over the run. */
  peak: { wind: number; waterDepth: number; flowSpeed: number; groundAccel: number };
  /**
   * Thermal exposure (Phase 26, only in runs with a heat source): air-layer temperature around the
   * person (K) and the radiant flux of the sources they face (W/m²), current and peak. No physiology.
   */
  thermal?: { airT: number; radiant: number; peakAirT: number; peakRadiant: number };
  /**
   * Fire exposure (Phase 27, only in runs with a fire): soot concentration of the air around the person
   * (kg/m³), the visibility it allows (m, S = 3/K), the O₂ mass fraction; worst values. No physiology.
   */
  fire?: { smoke: number; visibility: number; oxygen: number; minVisibility: number; peakSmoke: number };
  /** Seconds with water ≥ 0.1 m / wind ≥ 20 m/s / shaking ≥ 0.1 g. */
  time: { water: number; wind: number; shaking: number };
}

export function createExposure(): ExposureState {
  return {
    wind: 0, waterDepth: 0, flowSpeed: 0, groundAccel: 0, atmosphere: BASELINE_ATMOSPHERE, atmosphereMeasured: false,
    peak: { wind: 0, waterDepth: 0, flowSpeed: 0, groundAccel: 0 }, time: { water: 0, wind: 0, shaking: 0 },
  };
}

/** 10 Hz exposure bookkeeping for people (never feeds back into physics or damage). */
export class ExposureSystem implements SimulationSystem {
  readonly name = 'exposure';
  readonly phase = 'postPhysics' as const;
  readonly interval = 6;
  readonly reads = ['airflow', 'water', 'groundMotion', 'poses'] as const;
  readonly writes = ['exposure'] as const;

  isActive(ctx: SystemContext) {
    return ctx.env.wind.baseSpeed > 0.01 || ctx.env.flood.field !== null || ctx.env.groundMotion.active;
  }

  update(ctx: SystemContext, dt: number) {
    for (const e of ctx.runtime.entities.values()) {
      if (e.source.type !== 'human') continue;
      update(e, dt);
    }
  }
}

function update(e: RuntimeEntity, dt: number) {
  const x = (e.exposure ??= createExposure());
  x.wind = e.localWind.speed;
  x.waterDepth = e.flood?.depth ?? 0;
  x.flowSpeed = e.flood?.speed ?? 0;
  x.groundAccel = e.seismic ? Math.hypot(e.seismic.ground.a[0], e.seismic.ground.a[2]) / GRAVITY : 0;
  const p = x.peak;
  if (x.wind > p.wind) p.wind = x.wind;
  if (x.waterDepth > p.waterDepth) p.waterDepth = x.waterDepth;
  if (x.flowSpeed > p.flowSpeed) p.flowSpeed = x.flowSpeed;
  if (x.groundAccel > p.groundAccel) p.groundAccel = x.groundAccel;
  if (x.waterDepth >= 0.1) x.time.water += dt;
  if (x.wind >= 20) x.time.wind += dt;
  if (x.groundAccel >= 0.1) x.time.shaking += dt;
}
