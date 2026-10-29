/**
 * Energy ledger of one air-blast wave (Phase 24). Every joule of the input is in exactly one entry:
 *
 *   input (energy coupled into the air)
 *     = near-source dissipation  heat left behind by the strong shock near the source (not modelled
 *                                further; part of "unresolved")
 *     + dissipated               lost at the weak shocks while travelling inside the world (σ > 0)
 *     + in transit               still carried by the pulse inside the world
 *     + left the world           carried across the world's boundary (whatever happens to it outside)
 *
 * The pulse is followed along a fixed set of directions over the upper half-space (the ground
 * reflects the lower half up; Fibonacci set, 256 rays): the energy on a ray at radius r is
 * E_p/N·e(r), e(r) = 1/√(1+σ(r)) from the tables; a ray leaves the world at its exit distance.
 * Not subtracted: the work done on objects (the wave is not attenuated by what it loads — a
 * linear-superposition assumption; the transferred energy is orders of magnitude smaller).
 * With the 'positive' waveform half of the pulse energy is in the negative phase, which is not
 * applied to objects (listed, not a separate destination).
 */
import type { BlastWave } from './wave';
import { newSample } from './source';

export interface EnergyLedger {
  input: number;
  pulse: number;
  nearSource: number;
  dissipated: number;
  inTransit: number;
  leftWorld: number;
  /** Energy of the negative phase not applied to objects ('positive' waveform), J. */
  notApplied: number;
  /** input − Σ entries (round-off). */
  residual: number;
}

const RAYS = 256;

export class WaveLedger {
  private readonly exit: Float64Array;
  private readonly sample = newSample();

  constructor(readonly wave: BlastWave) {
    const { position: [sx, sy, sz], world: W } = wave.init;
    this.exit = new Float64Array(RAYS);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let k = 0; k < RAYS; k++) {
      const y = (k + 0.5) / RAYS; // upper hemisphere, uniform in solid angle
      const r = Math.sqrt(1 - y * y), a = k * golden;
      const dx = Math.cos(a) * r, dz = Math.sin(a) * r, dy = y;
      // Distance along the ray to the first face of the world box (x / z walls, top).
      let t = Infinity;
      if (dx > 1e-9) t = Math.min(t, (W.x1 - sx) / dx); else if (dx < -1e-9) t = Math.min(t, (W.x0 - sx) / dx);
      if (dz > 1e-9) t = Math.min(t, (W.z1 - sz) / dz); else if (dz < -1e-9) t = Math.min(t, (W.z0 - sz) / dz);
      t = Math.min(t, (W.top - sy) / dy);
      this.exit[k] = Math.max(0, t);
    }
  }

  /** Ledger at absolute time `time`. */
  at(time: number): EnergyLedger {
    const w = this.wave, E = w.init.energy, Ep = w.pulseEnergy;
    const rFront = w.frontRadius(time);
    let inTransit = 0, left = 0, dissipated = 0;
    for (let k = 0; k < RAYS; k++) {
      const rx = this.exit[k];
      const r = Math.min(rFront, rx);
      const e = r > 0 ? w.main.at(r, this.sample).energyLeft : 1;
      dissipated += 1 - e;
      if (rFront >= rx) left += e;
      else inTransit += e;
    }
    const k = Ep / RAYS;
    const out: EnergyLedger = {
      input: E, pulse: Ep, nearSource: E - Ep, dissipated: dissipated * k, inTransit: inTransit * k, leftWorld: left * k,
      notApplied: w.init.waveform === 'positive' ? 0.5 * inTransit * k : 0, residual: 0,
    };
    // Before the release nothing has happened yet: all of the input is still to come.
    if (time < w.init.time) { out.nearSource = 0; out.dissipated = 0; out.leftWorld = 0; out.inTransit = 0; out.pulse = 0; }
    out.residual = time < w.init.time ? 0 : E - (out.nearSource + out.dissipated + out.inTransit + out.leftWorld);
    return out;
  }
}
