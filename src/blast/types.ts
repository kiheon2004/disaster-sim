/**
 * Atmospheric pressure wave ("air blast", Phase 24). SI units (m, s, J, Pa, kg/m³).
 *
 * The source is a VIRTUAL release of energy into the air at a point — the experiment's input is the
 * energy coupled to the air, never an explosive: there is no charge mass, composition, TNT
 * equivalence or placement optimization anywhere in this module (by design). Impact airbursts and
 * the air-coupled share of surface impacts (Phase 23) create the same kind of source.
 */

/**
 * Propagation model of the pulse beyond the near field:
 *  - 'weakShock': weak-shock theory of a spherical N-wave (Whitham 1974 §9; Landau & Lifshitz §102):
 *    the positive phase lengthens as √(1 + σ(r)) and the peak decays faster than 1/r — energy is
 *    dissipated at the shocks; the shock travels at the Rankine–Hugoniot speed (> c₀)
 *  - 'acoustic': linear acoustics — the pulse keeps its shape, decays as 1/r, travels at c₀ and
 *    loses no energy (an upper bound on the far-field amplitude; useful for comparison)
 */
export type BlastModel = 'weakShock' | 'acoustic';
export const BLAST_MODELS: readonly BlastModel[] = ['weakShock', 'acoustic'];

/**
 * Pressure-time shape used for loads:
 *  - 'nWave':    positive phase then an equal negative (suction) phase — the far-field waveform of
 *                weak-shock theory (zero net impulse)
 *  - 'positive': positive phase only (the negative phase is neglected — a common simplified
 *                triangular-pulse load idealization; its energy is listed as "not applied")
 */
export type BlastWaveform = 'nWave' | 'positive';
export const BLAST_WAVEFORMS: readonly BlastWaveform[] = ['nWave', 'positive'];

export interface BlastSpec {
  event: 'blast';
  /** Source position on the map (x, z), m. */
  position: [number, number];
  /** Height of the source above the ground at (x, z), m. */
  height: number;
  /** Energy coupled into the air, J (a virtual energy release — see the module note). */
  energy: number;
  model: BlastModel;
  waveform: BlastWaveform;
  /** Ambient (ground-level) pressure, Pa — default the standard atmosphere 101 325 Pa. */
  ambientPressure?: number;
  /** Ambient (ground-level) air density, kg/m³ — default the project's air density. */
  ambientDensity?: number;
  /** Deterministic seed (recorded with the event; the wave model itself has no random element). */
  seed?: number;
  startTime?: number;
  name?: string;
}

export const BLAST_LIMITS = {
  energy: [1e3, 1e12],
  height: [0, 200],
  ambientPressure: [30_000, 110_000],
  ambientDensity: [0.4, 1.5],
} as const;

export const STANDARD_PRESSURE = 101_325;
