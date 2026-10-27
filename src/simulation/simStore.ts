import { create } from 'zustand';
import type { EntityId } from '@/core/types';
import type { SimSpeed } from '@/core/units';
import type { DamageState } from './damage/DamageState';

export type SimStatus = 'idle' | 'loading' | 'running' | 'paused' | 'finished';

/**
 * UI-facing summary of the simulation, updated at a throttled rate (~10 Hz).
 * The authoritative runtime lives in SimulationController, outside React.
 */
export interface SimState {
  status: SimStatus;
  speed: SimSpeed;
  time: number;
  /** Planned end of the timeline (s). */
  endTime: number;
  /** Bumped when a new runtime is built, so the scene remounts. */
  runtimeVersion: number;
  /** Per-entity damage state, null when no simulation is loaded. */
  entityStates: Record<EntityId, DamageState> | null;
  set: (patch: Partial<Omit<SimState, 'set'>>) => void;
}

export const useSimStore = create<SimState>((set) => ({
  status: 'idle',
  speed: 1,
  time: 0,
  endTime: 0,
  runtimeVersion: 0,
  entityStates: null,
  set: (patch) => set(patch),
}));
