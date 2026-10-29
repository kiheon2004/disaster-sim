/**
 * The impact channel (Phase 23): what ImpactEvents write besides the shared ground field —
 * statistics for the HUD / benchmarks and the ATMOSPHERIC-BLAST interface for Phase 24.
 *
 * Energy bookkeeping: an impact's energy partition (impact/energy.ts) assigns the seismic share to
 * the ground shock (in env.groundMotion) and reserves `blast` for a future atmospheric-blast model.
 * Phase 23 records airbursts and surface impacts here as BlastSource entries with the energy that
 * is available to the air — nothing consumes them yet (no pressure wave is simulated), and a
 * consumer must take its energy from this entry only, so no energy is applied twice.
 */
import type { ImpactModel } from '@/impact/ImpactModel';

export interface BlastSource {
  source: string;
  /** Burst point (world x, altitude above ground m, z) and time (s). */
  position: [number, number, number];
  time: number;
  /** Energy available to the air (J): an airburst's kinetic energy; 0 for ground impacts in Phase 23. */
  energy: number;
  kind: 'airburst' | 'surface';
}

export interface ImpactStats {
  /** Last update cost (ms) and totals. */
  modelMs: number;
  objectsMs: number;
  totalMs: number;
  updates: number;
  landings: number;
}

export class ImpactChannel {
  readonly models: ImpactModel[] = [];
  readonly blasts: BlastSource[] = [];
  stats: ImpactStats = { modelMs: 0, objectsMs: 0, totalMs: 0, updates: 0, landings: 0 };

  get active(): boolean {
    return this.models.length > 0;
  }
}
