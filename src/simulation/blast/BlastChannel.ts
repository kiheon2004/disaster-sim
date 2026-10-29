/**
 * The pressure channel (Phase 24): air-pressure waves in the world. BlastEvents (virtual releases of
 * energy into the air) and ImpactEvents (airbursts, the air-coupled share of ground impacts) WRITE
 * waves here; the BlastSystem turns them into loads on objects, the water and the structural model;
 * the renderer, HUD and inspector read the same waves.
 *
 * Each wave owns its energy (the event hands over exactly the energy coupled into the air — an
 * impact's blast share comes out of its unresolved energy), so no joule reaches two channels.
 */
import type { BlastWave } from '@/blast/wave';
import { WaveLedger, type EnergyLedger } from '@/blast/ledger';
import type { BlastPlan } from '@/blast/plan';

export type BlastEventKind = 'source' | 'arrival' | 'peak' | 'impulse' | 'passed';

export interface BlastModelEvent {
  wave: string;
  kind: BlastEventKind;
  time: number;
  value: number;
  /** Object it concerns (arrival / peak / impulse), if any. */
  object?: string;
}

export interface WaveRecord {
  wave: BlastWave;
  plan: BlastPlan | null;
  ledger: WaveLedger;
  /** Time the front has left the whole world (absolute s). */
  exit: number;
  /** Largest side-on overpressure / positive impulse felt by an object so far, and where. */
  peak: number;
  peakObject: string | null;
  peakTime: number;
  impulse: number;
  impulseObject: string | null;
  /** Objects reached so far. */
  reached: number;
}

export interface BlastStats {
  /** Last update split (ms) and totals. */
  fieldMs: number;
  forceMs: number;
  structureMs: number;
  partsMs: number;
  totalMs: number;
  /** Totals of the activation (shielding, face loads, parts) and response parts (ms). */
  fieldTotalMs: number;
  forceTotalMs: number;
  updates: number;
  /** Objects / parts evaluated in the last update. */
  objects: number;
  parts: number;
}

export class BlastChannel {
  readonly waves: WaveRecord[] = [];
  readonly events: BlastModelEvent[] = [];
  stats: BlastStats = { fieldMs: 0, forceMs: 0, structureMs: 0, partsMs: 0, totalMs: 0, fieldTotalMs: 0, forceTotalMs: 0, updates: 0, objects: 0, parts: 0 };
  /** Some structure received a blast load in the current step (keeps the structural model running). */
  loading = false;

  add(wave: BlastWave, plan: BlastPlan | null, exit: number) {
    this.waves.push({ wave, plan, ledger: new WaveLedger(wave), exit, peak: 0, peakObject: null, peakTime: 0, impulse: 0, impulseObject: null, reached: 0 });
    this.events.push({ wave: wave.init.id, kind: 'source', time: wave.init.time, value: wave.init.energy });
  }

  get active(): boolean {
    return this.waves.length > 0;
  }

  /** Whether some wave is (or will be) inside the world at `time` or after (s). */
  pending(time: number, settle = 0): boolean {
    return this.waves.some((w) => time <= w.exit + settle);
  }

  /** Whether a wave front is between its release and its world exit at `time`. */
  passing(time: number): boolean {
    return this.waves.some((w) => time >= w.wave.init.time - 0.05 && time <= w.exit);
  }

  ledger(time: number): EnergyLedger[] {
    return this.waves.map((w) => w.ledger.at(time));
  }
}
