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

/** Live terrain deformation status for HUDs (null until a deformation starts). Phase 21. */
export interface DeformLive {
  /** Sources (deformations) started so far and how many are still changing. */
  sources: number;
  changing: number;
  /** Largest |W| now (m) and the net volume change Σ W·A (m³). */
  maxAbs: number;
  volume: number;
  updates: number;
  /** Cost of the last update (ms): field + heights, collider, water bed, responses. */
  fieldMs: number;
  colliderMs: number;
  waterMs: number;
  responseMs: number;
  /** Water moved with the bed (m³) and the largest bed rise / drop under water (m). */
  bedVolume: number;
  bedRise: number;
  bedDrop: number;
}

/** Live ground-failure summary (Phase 22) for the HUD / inspector. */
export interface GroundLive {
  sinkholes: { id: string; name: string; phase: string; radius: number; fs: number; pitDepth: number }[];
  landslides: { id: string; name: string; minFS: number; failed: number; cells: number; newmark: number }[];
  /** Sediment budget (m³ bulked / kg): released, moving, deposited, out of the world, into cavities, residual. */
  released: number;
  mobile: number;
  deposited: number;
  outflow: number;
  intoCavity: number;
  residual: number;
  residualMass: number;
  peakMobile: number;
  maxSpeed: number;
  /** Cost of the last update (ms) and the runout substeps. */
  ms: number;
  flowMs: number;
  substeps: number;
  blockedRoads: number;
}

/** Live impact summary (Phase 23) for the HUD / inspector. */
export interface ImpactLive {
  id: string;
  name: string;
  phase: 'entry' | 'impact' | 'forming' | 'ejecta' | 'done' | 'airburst';
  /** Seconds to impact (< 0 after), entry altitude (m) and speed (m/s) now (entry stage samples). */
  toImpact: number;
  altitude: number;
  speed: number;
  energy: number;
  tnt: number;
  craterD: number;
  depth: number;
  regime: string;
  launched: number;
  landed: number;
  parcels: number;
  ejectaMass: number;
  outflowMass: number;
  airburstAltitude: number;
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
  deform: DeformLive | null;
  ground: GroundLive | null;
  impacts: ImpactLive[] | null;
  /** Recorded flood time series (downsampled). */
  floodSeries: FloodSeries | null;
  /** Experiment timeline milestones (Phase 15). */
  milestones: Milestone[];
  /** Time of the loaded water state the next run starts from (null = none). */
  initialWaterTime: number | null;
  /**
   * The original world this run started from (Phase 16): its content fingerprint and object
   * count. The document itself is never modified by the simulation.
   */
  baseline: { hash: string; objects: number } | null;
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
  deform: null,
  ground: null,
  impacts: null,
  floodSeries: null,
  initialWaterTime: null,
  baseline: null,
  milestones: [],
  set: (patch) => set(patch),
}));
