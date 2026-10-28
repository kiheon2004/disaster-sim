/**
 * Synthetic ground-motion waveform (NOT a recorded or predicted earthquake).
 *
 * Per axis (H1 = principal horizontal, H2 = orthogonal horizontal, V = vertical):
 *
 *   d(τ) = E(τ) · S(τ),     S(τ) = Σₖ Dₖ · sin(ωₖ τ + φₖ)
 *
 * a sum of K seeded sinusoids whose frequencies are spread log-normally around the dominant
 * frequency (a band-limited "Kanai–Tajimi-like" spectrum), modulated by a smooth envelope E
 * (gamma / Saragoni–Hart shape: 0 at onset, builds up, decays, then tapers to exactly 0).
 * Velocity and acceleration are the ANALYTIC derivatives (product rule), so displacement never
 * drifts and the three are mutually consistent. Dₖ = Aₖ / ωₖ², where Aₖ is the acceleration
 * amplitude of component k on a given soil: spectral weight × seeded scatter × siteTransfer(f).
 *
 * The vertical axis starts at the P arrival (τ = 0), the horizontals at the S arrival
 * (τ = S−P time) and carry most energy. The whole motion is normalized so that the peak
 * horizontal resultant acceleration on the REFERENCE soil equals the requested PGA; other
 * soils use the same scale factor, so their peaks differ by the site transfer (amplification).
 *
 * Tables are precomputed at RATE Hz per soil (lazily, the first time a soil is sampled) and
 * read with linear interpolation — deterministic, allocation-free hot path.
 */
import { clamp } from '@/core/math';
import { Rng } from '@/core/random';
import { GRAVITY } from '@/core/units';
import { DEFAULT_SOIL, SOIL_COUNT, siteTransfer, soilProfile } from '@/terrain/SoilProfiles';

export const WAVE_RATE = 200; // samples / s
const COMPONENTS = 24;
const ENVELOPE_ALPHA = 3;
/** Fraction of the event at the end over which the motion tapers to exactly zero. */
const TAPER = 0.12;
const F_MIN = 0.15;
const F_MAX = 25;
/** Re-evaluate the phasors directly every N samples (bounds round-off of the recurrence). */
const RESYNC = 512;

export const AXIS_H1 = 0;
export const AXIS_H2 = 1;
export const AXIS_V = 2;

export interface WaveformParams {
  duration: number;
  dominantFrequency: number;
  seed: number;
  /** S−P time (s): horizontal onset after the vertical (P) onset. */
  sMinusP: number;
  /** Target peak horizontal acceleration on the reference soil (g). */
  pga: number;
  verticalRatio: number;
}

interface AxisSpectrum {
  freq: Float64Array;
  /** Acceleration weight before site transfer. */
  weight: Float64Array;
  phase: Float64Array;
  /** Onset (s) and envelope peak time (s) relative to the event start. */
  onset: number;
  peak: number;
}

/** One soil's tables: [axis][d | v | a] → samples. */
interface SoilTables {
  d: Float64Array[];
  v: Float64Array[];
  a: Float64Array[];
}

/** Smootherstep taper (C2) and its first two derivatives. */
function taper(t: number, end: number, width: number): [number, number, number] {
  const t0 = end - width;
  if (t <= t0) return [1, 0, 0];
  if (t >= end) return [0, 0, 0];
  const x = (end - t) / width; // 1 → 0
  const s = x * x * x * (x * (x * 6 - 15) + 10);
  const ds = 30 * x * x * (x - 1) * (x - 1); // d/dx
  const dds = 60 * x * (2 * x * x - 3 * x + 1); // d²/dx²
  // dx/dt = −1/width
  return [s, -ds / width, dds / (width * width)];
}

export class SyntheticWaveform {
  readonly samples: number;
  readonly params: WaveformParams;
  private axes: AxisSpectrum[];
  private tables: (SoilTables | null)[] = new Array(SOIL_COUNT).fill(null);
  /** Normalization scale per axis (horizontal shared). */
  private scaleH = 1;
  private scaleV = 1;

  constructor(params: WaveformParams) {
    this.params = { ...params, duration: Math.max(1, params.duration), sMinusP: clamp(params.sMinusP, 0, params.duration * 0.4) };
    this.samples = Math.ceil(this.params.duration * WAVE_RATE) + 2;
    const rng = new Rng(params.seed).fork('earthquake.waveform');
    const f0 = params.dominantFrequency;
    const dur = this.params.duration;
    const hOnset = this.params.sMinusP;
    const hLen = dur - hOnset;
    this.axes = [
      this.spectrum(rng.fork('h1'), f0, 1, hOnset, hOnset + 0.28 * hLen),
      this.spectrum(rng.fork('h2'), f0 * 1.08, 0.78, hOnset, hOnset + 0.3 * hLen),
      // Vertical: higher frequencies, onset at the P arrival, peak shortly after the S arrival.
      this.spectrum(rng.fork('v'), f0 * 1.7, 1, 0, hOnset + 0.24 * hLen),
    ];
    // Normalize on the reference soil.
    const ref = this.build(DEFAULT_SOIL, 1, 1);
    let peakH = 0;
    let peakV = 0;
    for (let i = 0; i < this.samples; i++) {
      const h = Math.hypot(ref.a[AXIS_H1][i], ref.a[AXIS_H2][i]);
      if (h > peakH) peakH = h;
      const v = Math.abs(ref.a[AXIS_V][i]);
      if (v > peakV) peakV = v;
    }
    this.scaleH = peakH > 0 ? (params.pga * GRAVITY) / peakH : 0;
    this.scaleV = peakV > 0 ? (params.pga * params.verticalRatio * GRAVITY) / peakV : 0;
    this.applyScale(ref);
    this.tables[DEFAULT_SOIL] = ref;
  }

  private spectrum(rng: Rng, f0: number, gain: number, onset: number, peak: number): AxisSpectrum {
    const freq = new Float64Array(COMPONENTS);
    const weight = new Float64Array(COMPONENTS);
    const phase = new Float64Array(COMPONENTS);
    for (let k = 0; k < COMPONENTS; k++) {
      // Stratified log-spread over f0/3.2 … f0·3.2, jittered inside each stratum.
      const u = -1 + (2 * (k + rng.next())) / COMPONENTS;
      const f = clamp(f0 * Math.exp(u * Math.log(3.2)), F_MIN, F_MAX);
      const shape = Math.exp(-0.5 * (Math.log(f / f0) / 0.5) ** 2);
      freq[k] = f;
      weight[k] = gain * shape * (0.6 + 0.8 * rng.next());
      phase[k] = rng.next() * Math.PI * 2;
    }
    return { freq, weight, phase, onset, peak };
  }

  /** Envelope E (gamma shape × end taper) and derivatives at event time t. */
  private envelope(ax: AxisSpectrum, t: number, out: [number, number, number]) {
    const tau = t - ax.onset;
    if (tau <= 1e-6) {
      out[0] = out[1] = out[2] = 0;
      return out;
    }
    const tm = Math.max(0.2, ax.peak - ax.onset);
    const a = ENVELOPE_ALPHA;
    const g = Math.pow(tau / tm, a) * Math.exp(a * (1 - tau / tm));
    const k = a / tau - a / tm;
    const g1 = g * k;
    const g2 = g1 * k - (g * a) / (tau * tau);
    const [s, s1, s2] = taper(t, this.params.duration, TAPER * this.params.duration);
    out[0] = g * s;
    out[1] = g1 * s + g * s1;
    out[2] = g2 * s + 2 * g1 * s1 + g * s2;
    return out;
  }

  /** Raw (unscaled) tables of one soil. */
  private build(soil: number, scaleH: number, scaleV: number): SoilTables {
    const n = this.samples;
    const prof = soilProfile(soil);
    const out: SoilTables = { d: [], v: [], a: [] };
    const env: [number, number, number] = [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
      const ax = this.axes[axis];
      const d = new Float64Array(n);
      const v = new Float64Array(n);
      const a = new Float64Array(n);
      const K = COMPONENTS;
      const amp = new Float64Array(K);
      const w = new Float64Array(K);
      const sn = new Float64Array(K);
      const cs = new Float64Array(K);
      const rs = new Float64Array(K);
      const rc = new Float64Array(K);
      for (let k = 0; k < K; k++) {
        w[k] = 2 * Math.PI * ax.freq[k];
        // Acceleration amplitude on this soil → displacement amplitude.
        amp[k] = (ax.weight[k] * siteTransfer(prof, ax.freq[k])) / (w[k] * w[k]);
        rs[k] = Math.sin(w[k] / WAVE_RATE);
        rc[k] = Math.cos(w[k] / WAVE_RATE);
      }
      const scale = axis === AXIS_V ? scaleV : scaleH;
      for (let i = 0; i < n; i++) {
        const t = i / WAVE_RATE;
        const tau = t - ax.onset;
        if (tau <= 0) continue;
        // Phasors sin/cos(ω τ + φ): direct evaluation at the first sample and every RESYNC
        // samples, rotation recurrence in between (deterministic, cheap).
        const direct = i % RESYNC === 0 || t - 1 / WAVE_RATE - ax.onset <= 0;
        let S = 0;
        let S1 = 0;
        let S2 = 0;
        for (let k = 0; k < K; k++) {
          if (direct) {
            const p = w[k] * tau + ax.phase[k];
            sn[k] = Math.sin(p);
            cs[k] = Math.cos(p);
          } else {
            const s0 = sn[k];
            sn[k] = s0 * rc[k] + cs[k] * rs[k];
            cs[k] = cs[k] * rc[k] - s0 * rs[k];
          }
          const A = amp[k];
          S += A * sn[k];
          S1 += A * w[k] * cs[k];
          S2 -= A * w[k] * w[k] * sn[k];
        }
        this.envelope(ax, t, env);
        d[i] = scale * env[0] * S;
        v[i] = scale * (env[1] * S + env[0] * S1);
        a[i] = scale * (env[2] * S + 2 * env[1] * S1 + env[0] * S2);
      }
      out.d.push(d);
      out.v.push(v);
      out.a.push(a);
    }
    return out;
  }

  private applyScale(t: SoilTables) {
    for (let axis = 0; axis < 3; axis++) {
      const s = axis === AXIS_V ? this.scaleV : this.scaleH;
      for (const arr of [t.d[axis], t.v[axis], t.a[axis]]) for (let i = 0; i < arr.length; i++) arr[i] *= s;
    }
  }

  /** Tables of a soil profile (built on first use). */
  soil(id: number): SoilTables {
    let t = this.tables[id];
    if (!t) t = this.tables[id] = this.build(id, this.scaleH, this.scaleV);
    return t;
  }

  /** Whether the tables of a soil exist already (perf / tests). */
  hasSoil(id: number) {
    return this.tables[id] !== null;
  }

  /** Planned envelope (0–1) of the horizontal motion at event time t (timeline drawing). */
  envelopeAt(t: number): number {
    const e: [number, number, number] = [0, 0, 0];
    return this.envelope(this.axes[AXIS_H1], t, e)[0];
  }

  /** Index + fraction for linear interpolation at event time t (−1 outside). */
  static locate(t: number, samples: number, out: { i: number; f: number }) {
    const x = t * WAVE_RATE;
    if (!(x >= 0) || x >= samples - 1) {
      out.i = -1;
      out.f = 0;
      return out;
    }
    out.i = Math.floor(x);
    out.f = x - out.i;
    return out;
  }
}
