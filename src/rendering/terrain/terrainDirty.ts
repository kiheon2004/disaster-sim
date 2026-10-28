import { unionRect, type GridRect } from '@/terrain/TerrainData';

/**
 * Regions changed by brush dabs since the renderer last looked (render-side bookkeeping only).
 * A change without a recorded region (undo, preset, load) makes the renderer refresh everything.
 */
let pending: GridRect | null = null;

export function markTerrainDirty(rect: GridRect | null) {
  pending = unionRect(pending, rect);
}

export function takeTerrainDirty(): GridRect | null {
  const r = pending;
  pending = null;
  return r;
}
