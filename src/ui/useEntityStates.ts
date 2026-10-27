import { useSimStore } from '@/simulation/simStore';

/** Damage state per entity while a simulation is loaded (null in the editor). */
export function useEntityStates() {
  return useSimStore((s) => s.entityStates);
}
