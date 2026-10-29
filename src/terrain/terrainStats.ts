/**
 * Terrain cost counters for the developer performance HUD (accumulated, drained by the HUD).
 * Timing is always on: it costs two performance.now() calls per brush dab / mesh update.
 */
export const terrainStats = {
  /** Brush dabs applied to the data and their total cost (ms). */
  dabs: 0,
  dabMs: 0,
  /** Render mesh updates (partial or full) and their total cost (ms). */
  meshUpdates: 0,
  meshMs: 0,
  /** Simulation-mode mesh refreshes after terrain deformation updates (Phase 21). */
  deformUpdates: 0,
  reset() {
    this.deformUpdates = 0;
    this.dabs = 0;
    this.dabMs = 0;
    this.meshUpdates = 0;
    this.meshMs = 0;
  },
};
