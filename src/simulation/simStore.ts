import { create } from 'zustand';
import type { EntityId } from '@/core/types';
import type { SimSpeed } from '@/core/units';
import type { I18nMessage } from '@/i18n/i18n';
import type { EventStatus } from '@/events/EventScheduler';
import type { EventType } from '@/events/specs';
import type { DamageState } from './damage/DamageState';
import type { SimulationLogEntry } from './SimulationRuntime';
import type { SimulationMetrics } from './analysis/MetricsRecorder';
import type { DamageEventRecord } from './analysis/DamageEvent';
import type { SeismicSeries } from './analysis/SeismicRecorder';
import type { FloodSeries } from './analysis/FloodRecorder';
import type { Milestone } from './analysis/MilestoneRecorder';
import type { BoundarySide } from '@/core/model';
import type { ResolvedBoundaryType } from './water/WaterForcing';

export type SimStatus = 'idle' | 'loading' | 'running' | 'paused' | 'finished';

export interface TimelineEventView {
  id: string;
  type: EventType;
  start: number;
  duration: number;
  status: EventStatus;
  label: I18nMessage;
  /** Planned intensity samples (0–1) across the duration, for the timeline sparkline. */
  profile: number[];
  /** Planned signal (earthquakes: principal ground acceleration in g) across the duration. */
  waveform?: number[];
}

/** Live earthquake status for HUDs (null when no earthquake was scheduled). */
export interface QuakeLive {
  active: boolean;
  /** Principal-axis ground acceleration at the map center on the reference site (g, signed). */
  accel: number;
  /** Horizontal magnitude of it (g) and the largest so far (g). */
  accelH: number;
  peak: number;
  phase: 'p' | 's' | 'coda' | 'end';
  magnitude: number;
  pga: number;
  pgaAssumed: boolean;
  epicenter: [number, number];
  depth: number;
  direction: number;
  /** Event-local time (s) and duration. */
  local: number;
  duration: number;
  sMinusP: number;
}

/** Live water status for HUDs (null while the water model is dormant). Phase 14. */
export interface FloodLive {
  /** Rain falling now (mm/h) and total point inflow (m³/s). */
  rain: number;
  sources: number;
  /** Water on the map (m³), area ≥ 0.1 m / ≥ 1 cm deep (m²). */
  volume: number;
  floodedArea: number;
  wetArea: number;
  maxDepth: number;
  meanDepth: number;
  maxSpeed: number;
  /** Per edge: effective boundary type, its level (fixed level) and whether an event drives it. */
  boundaries: Record<BoundarySide, { type: ResolvedBoundaryType; level: number | null; event: boolean } | null>;
  /** Mass-budget relative error so far. */
  relativeError: number;
  substeps: number;
}

export interface SimStats {
  byState: [number, number, number, number, number];
  debris: number;
  brokenWindows: number;
  detachedParts: number;
  fallenPeople: number;
  fallenTrees: number;
  movedCars: number;
}

export const EMPTY_STATS: SimStats = {
  byState: [0, 0, 0, 0, 0],
  debris: 0,
  brokenWindows: 0,
  detachedParts: 0,
  fallenPeople: 0,
  fallenTrees: 0,
  movedCars: 0,
};

/**
 * UI-facing summary of the simulation, published at a throttled rate (~10 Hz).
 * The authoritative runtime lives in SimulationController, outside React.
 */
export interface SimState {
  status: SimStatus;
  speed: SimSpeed;
  time: number;
  /** End of the timeline (s). */
  endTime: number;
  /** Bumped when a new runtime is built, so the 3D scene remounts. */
  runtimeVersion: number;
  /** Per-entity damage state, null when no simulation is loaded. */
  entityStates: Record<EntityId, DamageState> | null;
  wind: { speed: number; bearing: number; gust: number };
  events: TimelineEventView[];
  log: SimulationLogEntry[];
  stats: SimStats;
  metrics: SimulationMetrics | null;
  /** Full damage history (replaced only when new events arrive). */
  damageEvents: DamageEventRecord[];
  quake: QuakeLive | null;
  /** Recorded earthquake time series (downsampled). */
  seismicSeries: SeismicSeries | null;
  flood: FloodLive | null;
  /** Recorded flood time series (downsampled). */
  floodSeries: FloodSeries | null;
  /** Experiment timeline milestones (Phase 15). */
  milestones: Milestone[];
  /** Time of the loaded water state the next run starts from (null = none). */
  initialWaterTime: number | null;
  set: (patch: Partial<Omit<SimState, 'set'>>) => void;
}

export const useSimStore = create<SimState>((set) => ({
  status: 'idle',
  speed: 1,
  time: 0,
  endTime: 0,
  runtimeVersion: 0,
  entityStates: null,
  wind: { speed: 0, bearing: 90, gust: 0 },
  events: [],
  log: [],
  stats: EMPTY_STATS,
  metrics: null,
  damageEvents: [],
  quake: null,
  seismicSeries: null,
  flood: null,
  floodSeries: null,
  initialWaterTime: null,
  milestones: [],
  set: (patch) => set(patch),
}));
