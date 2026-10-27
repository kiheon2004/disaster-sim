import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CompassDir } from '@/core/compass';
import type { WindEventSpec } from '@/events/specs';

interface WindFormState {
  speed: number;
  direction: CompassDir;
  duration: number;
  gust: number;
  ramp: number;
  set: (patch: Partial<Omit<WindFormState, 'set' | 'toSpec'>>) => void;
  toSpec: () => WindEventSpec;
}

/** Wind settings form state (persisted per browser). Produces the same spec the command parser does. */
export const useWindForm = create<WindFormState>()(
  persist(
    (set, get) => ({
      speed: 30,
      direction: 'E',
      duration: 60,
      gust: 0.25,
      ramp: 4,
      set: (patch) => set(patch),
      toSpec: () => {
        const s = get();
        return {
          event: 'wind',
          speed: s.speed,
          direction: s.direction,
          duration: s.duration,
          gustStrength: s.gust,
          rampDuration: s.ramp,
        };
      },
    }),
    { name: 'ds.windForm', partialize: ({ speed, direction, duration, gust, ramp }) => ({ speed, direction, duration, gust, ramp }) },
  ),
);
