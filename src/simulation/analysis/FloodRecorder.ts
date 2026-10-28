/**
 * Flood analysis (Phase 14): peak values, the mass budget and time series of a run for the
 * results panel, the HUD and exports. Pure bookkeeping — never influences the simulation.
 */
import type { EntityId } from '@/core/types';
import type { EnvironmentState } from '../environment/EnvironmentState';
import type { SimulationRuntime } from '../SimulationRuntime';
import type { DamageEventRecord } from './DamageEvent';
import { emptyBudget, relativeError, type WaterBudget } from '../water/WaterField';
import { FLOOD_DEPTH } from '../water/waterParams';

export interface FloodMetrics {
  /** Seconds since the water model activated. */
  duration: number;
  /** Area with depth ≥ 0.1 m now / at its peak (m²). */
  floodedArea: number;
  peakFloodedArea: number;
  /** Deepest water anywhere over the run (m) and where; mean depth over the flooded area now. */
  maxDepth: number;
  maxDepthAt: [number, number] | null;
  averageDepth: number;
  /** Fastest flow over the run (m/s, depth ≥ 1 cm). */
  maxFlowSpeed: number;
  /** Water on the map now (m³). */
  totalVolume: number;
  budget: WaterBudget;
  /** |numerical error| / total water that entered. */
  relativeError: number;
  floodedBuildings: number;
  affectedVehicles: number;
  floatedVehicles: number;
  fallenHumans: number;
  roadsInundated: number;
  infrastructureFailed: number;
  floodDamageEvents: number;
  maxObject: EntityId | null;
}

/** Sampled once per simulated second while the water model is active. */
export interface FloodSeries {
  t: number[];
  /** Flooded area (m², depth ≥ 0.1 m). */
  area: number[];
  /** Water volume on the map (m³). */
  volume: number[];
  /** Deepest water at that moment (m). */
  maxDepth: number[];
  /** Rain intensity (mm/h). */
  rain: number[];
}

const SAMPLE_EVERY = 60; // steps (1 s at 60 Hz)
const MAX_SAMPLES = 24000;

export class FloodRecorder {
  readonly series: FloodSeries = { t: [], area: [], volume: [], maxDepth: [], rain: [] };
  private steps = 0;
  private peakArea = 0;
  private peakSpeed = 0;
  private peakDepth = 0;
  private peakAt: [number, number] | null = null;
  private started = false;

  sample(env: EnvironmentState, _runtime: SimulationRuntime, _dt: number) {
    const fl = env.flood;
    const f = fl?.field;
    if (!f) return;
    this.started = true;
    const st = f.stats;
    const area = st.floodedCells * f.cellArea;
    if (area > this.peakArea) this.peakArea = area;
    if (st.maxSpeed > this.peakSpeed) this.peakSpeed = st.maxSpeed;
    if (st.maxDepth > this.peakDepth) {
      this.peakDepth = st.maxDepth;
      // Locate it only when the peak grows (rare).
      let best = -1;
      let bd = -1;
      for (let iz = f.z0; iz <= f.z1; iz++) for (let i = iz * f.nx + f.x0, e = iz * f.nx + f.x1; i <= e; i++) if (f.h[i] > bd) { bd = f.h[i]; best = i; }
      if (best >= 0) this.peakAt = [f.cellX(best % f.nx), f.cellZ((best / f.nx) | 0)];
    }
    if (this.steps++ % SAMPLE_EVERY !== 0 || this.series.t.length >= MAX_SAMPLES) return;
    this.series.t.push(env.time);
    this.series.area.push(area);
    this.series.volume.push(st.volume);
    this.series.maxDepth.push(st.maxDepth);
    this.series.rain.push(fl.rainIntensity());
  }

  downsampled(n: number): FloodSeries {
    const s = this.series;
    if (s.t.length <= n) return { t: s.t.slice(), area: s.area.slice(), volume: s.volume.slice(), maxDepth: s.maxDepth.slice(), rain: s.rain.slice() };
    const out: FloodSeries = { t: [], area: [], volume: [], maxDepth: [], rain: [] };
    for (let k = 0; k < n; k++) {
      const i = Math.round((k / (n - 1)) * (s.t.length - 1));
      out.t.push(s.t[i]);
      out.area.push(s.area[i]);
      out.volume.push(s.volume[i]);
      out.maxDepth.push(s.maxDepth[i]);
      out.rain.push(s.rain[i]);
    }
    return out;
  }

  summary(env: EnvironmentState, runtime: SimulationRuntime, events: readonly DamageEventRecord[], time: number): FloodMetrics | null {
    const fl = env.flood;
    const f = fl?.field;
    if (!this.started || !f) return null;
    const m: FloodMetrics = {
      duration: time - fl.activatedAt,
      floodedArea: f.stats.floodedCells * f.cellArea,
      peakFloodedArea: this.peakArea,
      maxDepth: this.peakDepth,
      maxDepthAt: this.peakAt,
      averageDepth: f.stats.meanFloodDepth,
      maxFlowSpeed: this.peakSpeed,
      totalVolume: f.stats.volume,
      budget: { ...emptyBudget(), ...f.budget },
      relativeError: relativeError(f.budget),
      floodedBuildings: 0, affectedVehicles: 0, floatedVehicles: 0, fallenHumans: 0, roadsInundated: 0, infrastructureFailed: 0,
      floodDamageEvents: 0, maxObject: null,
    };
    let deepest = 0;
    for (const e of runtime.flood?.entities ?? []) {
      const st = e.flood!;
      if (st.peakDepth > deepest && e.source.type === 'building') {
        deepest = st.peakDepth;
        m.maxObject = e.id;
      }
      switch (e.source.type) {
        case 'building':
          if (st.peakDepth >= FLOOD_DEPTH) m.floodedBuildings++;
          break;
        case 'car':
          if (st.peakDepth >= FLOOD_DEPTH) m.affectedVehicles++;
          if (st.floated) m.floatedVehicles++;
          break;
        case 'road':
          if (st.level >= 1) m.roadsInundated++;
          break;
      }
    }
    for (const ev of events) {
      if (ev.hazard !== 'flood') continue;
      m.floodDamageEvents++;
      if (ev.objectType === 'human' && ev.eventType === 'FALLEN') m.fallenHumans++;
      if ((ev.objectType === 'streetLight' || ev.objectType === 'sign' || ev.objectType === 'wall') && (ev.eventType === 'TOPPLED' || ev.eventType === 'COLLAPSED')) m.infrastructureFailed++;
    }
    return m;
  }
}
