/**
 * Earthquake analysis (Phase 13): peak values and time series of a run, for the results panel
 * and the timeline seismogram. Pure bookkeeping — never influences the simulation.
 */
import type { EntityId } from '@/core/types';
import { GRAVITY } from '@/core/units';
import type { EnvironmentState } from '../environment/EnvironmentState';
import type { SimulationRuntime } from '../SimulationRuntime';
import { createGroundMotionSample } from '../seismic/GroundMotionField';
import type { DamageEventRecord } from './DamageEvent';

export interface EarthquakeMetrics {
  /** Seconds of active shaking so far. */
  duration: number;
  /** Requested PGA on the reference site (g). */
  inputPga: number;
  magnitude: number;
  /** Peak horizontal ground acceleration observed at any object's base (g) and where. */
  peakGroundAcceleration: number;
  peakGroundObject: EntityId | null;
  /** Peak top displacement of any building relative to the ground (m). */
  maxBuildingDisplacement: number;
  maxDisplacementObject: EntityId | null;
  /** Peak inter-story drift ratio of any building. */
  maxDrift: number;
  maxDriftObject: EntityId | null;
  /** Peak absolute floor acceleration of any building (g). */
  maxFloorAcceleration: number;
  buildingsDamaged: number;
  buildingsCollapsed: number;
  infrastructureFallen: number;
  peopleFallen: number;
  earthquakeEvents: number;
  windEvents: number;
}

/** Time series sampled at 20 Hz while shaking (and during the free vibration afterwards). */
export interface SeismicSeries {
  t: number[];
  /** Principal-axis ground acceleration at the map center, reference site (g, signed). */
  ground: number[];
  /** Max current story drift ratio over all buildings. */
  drift: number[];
}

const SAMPLE_EVERY = 3;
const MAX_SAMPLES = 24000;

export class SeismicRecorder {
  readonly series: SeismicSeries = { t: [], ground: [], drift: [] };
  private steps = 0;
  private active = 0;
  private started = false;
  private ref = createGroundMotionSample();
  private inputPga = 0;
  private magnitude = 0;

  sample(env: EnvironmentState, runtime: SimulationRuntime, dt: number) {
    const gm = env.groundMotion;
    const sr = runtime.seismic;
    // (Minimal environments, e.g. in unit tests, may have no ground-motion field.)
    if (!gm || (!gm.active && !(sr && sr.freeVibration > 0))) return;
    if (gm.active) {
      this.active += dt;
      this.started = true;
      if (gm.scenario) {
        this.inputPga = gm.scenario.pga;
        this.magnitude = gm.scenario.magnitude;
      }
    }
    if (this.steps++ % SAMPLE_EVERY !== 0 || this.series.t.length >= MAX_SAMPLES) return;
    gm.reference(env.time, this.ref);
    const a = this.ref.a;
    const principal = a[0] * gm.h1[0] + a[2] * gm.h1[1];
    let drift = 0;
    if (sr) for (const e of sr.units) if (e.source.type === 'building' && !e.flags.collapsed && e.seismic!.drift > drift) drift = e.seismic!.drift;
    this.series.t.push(env.time);
    this.series.ground.push(principal / GRAVITY);
    this.series.drift.push(drift);
  }

  summary(runtime: SimulationRuntime, events: readonly DamageEventRecord[]): EarthquakeMetrics | null {
    if (!this.started || !runtime.seismic) return null;
    const m: EarthquakeMetrics = {
      duration: this.active, inputPga: this.inputPga, magnitude: this.magnitude,
      peakGroundAcceleration: 0, peakGroundObject: null, maxBuildingDisplacement: 0, maxDisplacementObject: null,
      maxDrift: 0, maxDriftObject: null, maxFloorAcceleration: 0,
      buildingsDamaged: 0, buildingsCollapsed: 0, infrastructureFallen: 0, peopleFallen: 0, earthquakeEvents: 0, windEvents: 0,
    };
    for (const e of runtime.seismic.entities) {
      const st = e.seismic!;
      if (st.pga > m.peakGroundAcceleration * GRAVITY) {
        m.peakGroundAcceleration = st.pga / GRAVITY;
        m.peakGroundObject = e.id;
      }
      if (e.source.type !== 'building') continue;
      if (st.peakTop > m.maxBuildingDisplacement) {
        m.maxBuildingDisplacement = st.peakTop;
        m.maxDisplacementObject = e.id;
      }
      if (st.peakDrift > m.maxDrift) {
        m.maxDrift = st.peakDrift;
        m.maxDriftObject = e.id;
      }
      if (st.peakFloorAcc / GRAVITY > m.maxFloorAcceleration) m.maxFloorAcceleration = st.peakFloorAcc / GRAVITY;
    }
    const damaged = new Set<EntityId>();
    for (const ev of events) {
      if (ev.hazard !== 'earthquake') {
        if (ev.hazard === 'wind') m.windEvents++;
        continue;
      }
      m.earthquakeEvents++;
      if (ev.objectType === 'building') {
        damaged.add(ev.objectId);
        if (ev.eventType === 'COLLAPSED') m.buildingsCollapsed++;
      } else if ((ev.objectType === 'streetLight' || ev.objectType === 'sign' || ev.objectType === 'wall') && (ev.eventType === 'TOPPLED' || ev.eventType === 'COLLAPSED')) {
        m.infrastructureFallen++;
      } else if (ev.objectType === 'human' && ev.eventType === 'FALLEN') m.peopleFallen++;
    }
    m.buildingsDamaged = damaged.size;
    return m;
  }

  /** Series downsampled to at most `n` points (min/max-preserving by taking the larger |value|). */
  downsampled(n = 600): SeismicSeries {
    const s = this.series;
    const len = s.t.length;
    if (len <= n) return { t: s.t.slice(), ground: s.ground.slice(), drift: s.drift.slice() };
    const out: SeismicSeries = { t: [], ground: [], drift: [] };
    for (let k = 0; k < n; k++) {
      const i0 = Math.floor((k * len) / n);
      const i1 = Math.floor(((k + 1) * len) / n);
      let g = 0;
      let d = 0;
      for (let i = i0; i < i1; i++) {
        if (Math.abs(s.ground[i]) > Math.abs(g)) g = s.ground[i];
        if (s.drift[i] > d) d = s.drift[i];
      }
      out.t.push(s.t[i0]);
      out.ground.push(g);
      out.drift.push(d);
    }
    return out;
  }
}
