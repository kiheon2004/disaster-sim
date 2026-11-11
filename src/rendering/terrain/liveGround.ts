import { useWorldStore } from '@/world/worldStore';
import { samplerFor, type TerrainSampler } from '@/terrain/TerrainSampler';
import { currentDeformation } from './runtimeGround';

/**
 * The ground as it is drawn right now: the running simulation's deformed terrain while one exists, the document's
 * terrain otherwise (the same choice the disaster placement layer makes for its pins).
 */
export function liveGround(): TerrainSampler {
  return samplerFor(currentDeformation()?.terrain ?? useWorldStore.getState().doc.terrain);
}

/** Half size of the map (m). */
export function liveMapHalf(): number {
  const t = useWorldStore.getState().doc.terrain;
  return ((t.nx - 1) * t.cellSize) / 2;
}
