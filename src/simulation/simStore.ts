import { create } from 'zustand';
import type { EntityId } from '@/core/types';
import type { SimSpeed } from '@/core/units';
import type { I18nMessage } from '@/i18n/i18n';
import type { EventStatus } from '@/events/EventScheduler';
import type { EventType } from '@/events/specs';
import type { DamageState } from './damage/DamageState';
import type { SimulationLogEntry } from './SimulationRuntime';

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
  set: (patch) => set(patch),
}));
