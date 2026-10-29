/**
 * The `terrainDeformation` effect channel (Phase 21): what deformation events write. Holds the
 * runtime deformation engine over the simulation's OWN terrain copy (created on the first
 * deformation — runs without one never copy the original heights). The DeformationSystem reads
 * it and refreshes collider, water bed, objects and roads.
 */
import type { TerrainData } from '@/core/model';
import { DeformationEngine } from '@/deformation/engine';

export class DeformationChannel {
  engine: DeformationEngine | null = null;
  /** Cost of the last / all updates (written by the DeformationSystem; HUD, benchmarks). */
  stats: import('../systems/DeformationSystem').DeformationStats | null = null;

  constructor(readonly terrain: TerrainData, readonly seed = 1) {}

  ensure(): DeformationEngine {
    return (this.engine ??= new DeformationEngine(this.terrain));
  }

  get active(): boolean {
    return this.engine !== null && this.engine.active;
  }
}
