/**
 * TerrainPhysicsAdapter: TerrainData → engine-agnostic ground collider description.
 *
 * Update strategy: the physics world only exists in Simulation mode and the terrain is frozen
 * there, so the collider is built once per simulation (re)load from the snapshot. While editing,
 * brush dabs only touch the data and the render mesh; nothing physical is rebuilt per mouse
 * event. `PhysicsEngine.setTerrain()` replaces the collider in one call when a system needs to
 * change the ground mid-run (future erosion / landslides).
 */
import type { TerrainData } from '@/core/model';
import type { TerrainColliderDesc } from '@/physics/PhysicsEngine';
import { isFlat } from './TerrainData';

/** Ground contact friction of the terrain collider (same as the flat ground slab). */
export const TERRAIN_FRICTION = 0.9;

/** Heightfield description regardless of flatness (Phase 21: a deformed flat world needs one). */
export function heightfieldDesc(t: TerrainData): TerrainColliderDesc {
  return { nx: t.nx, nz: t.nz, cellSize: t.cellSize, originX: t.originX, originZ: t.originZ, heights: t.heights, friction: TERRAIN_FRICTION };
}

/** null for a flat terrain → the engine keeps its exact flat ground plane. */
export function terrainColliderDesc(t: TerrainData): TerrainColliderDesc | null {
  if (isFlat(t)) return null;
  return {
    nx: t.nx,
    nz: t.nz,
    cellSize: t.cellSize,
    originX: t.originX,
    originZ: t.originZ,
    heights: t.heights,
    friction: TERRAIN_FRICTION,
  };
}
