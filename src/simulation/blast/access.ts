import type { BlastWave } from '@/blast/wave';
import type { SystemContext } from '../systems/SimulationSystem';

/** Wave `i` of the run's pressure channel. */
export const blastWave = (ctx: SystemContext, i: number): BlastWave => ctx.env.blast.waves[i].wave;
