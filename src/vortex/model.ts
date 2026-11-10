/**
 * Vortex wind model (Phase 35.5, educational reduced model).
 *
 *   tangential  V_t(r) = V_max · √( (R/r)^B · exp(1 − (R/r)^B) )   (Holland 1980 shape, peak V_max at r = R)
 *   radial      V_r(r) = −tan(α) · V_t(r)                           (surface inflow, α = inflow angle)
 *   translation u_tr (whole vortex moves along its track; the ground-relative wind adds it)
 *   taper       1 inside 0.8·R_out → 0 at R_out (smoothstep), so the vortex has a finite footprint
 *   height      × heightFactor(h) (the same power-law boundary layer as the global wind; V_max is at 10 m)
 *   ramp        amplitude 0 → 1 over the spin-up, 1 → 0 over the last ramp
 *
 * No pressure drop, no updraft, no debris cloud and no multiple-vortex structure are modelled (docs §26).
 */
import { TORNADO_DEFAULTS, type TornadoSpec } from './types';

/** A vortex in the world at the current step (written by its event, read by the wind field). */
export interface VortexState {
  id: string;
  /** Current centre (m). */
  cx: number;
  cz: number;
  /** Amplitude 0–1 (ramps). */
  amp: number;
  vmax: number;
  R: number;
  Rout: number;
  B: number;
  /** tan(inflow angle). */
  tanA: number;
  /** +1 counter-clockwise seen from above, −1 clockwise. */
  sense: number;
  /** Translation velocity (m/s) in world x / z. */
  ux: number;
  uz: number;
}

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Tangential speed profile shape 0–1 (1 at r = R). */
export function hollandShape(r: number, R: number, B: number): number {
  if (r <= 1e-9) return 0;
  const x = Math.pow(R / r, B);
  return Math.sqrt(x * Math.exp(1 - x));
}

/** Footprint taper 0–1. */
export function taper(r: number, Rout: number): number {
  return 1 - smooth((r - 0.8 * Rout) / (0.2 * Rout));
}

/** Translation velocity of a spec: bearing toward (0 = N = −z, 90 = E = +x). */
export function trackVelocity(s: TornadoSpec): [number, number] {
  const u = s.trackSpeed ?? TORNADO_DEFAULTS.trackSpeed;
  const b = ((s.trackBearing ?? TORNADO_DEFAULTS.trackBearing) * Math.PI) / 180;
  return [u * Math.sin(b), -u * Math.cos(b)];
}

/** Amplitude at an event-local time (spin-up, hold, die-down). */
export function rampAt(s: TornadoSpec, local: number): number {
  const r = Math.max(0.1, Math.min(s.rampDuration ?? TORNADO_DEFAULTS.rampDuration, s.duration / 2));
  if (local < 0 || local > s.duration) return 0;
  return Math.min(smooth(local / r), smooth((s.duration - local) / r));
}

export function vortexState(id: string, s: TornadoSpec): VortexState {
  const [ux, uz] = trackVelocity(s);
  return {
    id, cx: s.position[0], cz: s.position[1], amp: 0, vmax: s.maxSpeed, R: s.coreRadius, Rout: Math.max(s.outerRadius, 1.25 * s.coreRadius),
    B: s.shape ?? TORNADO_DEFAULTS.shape, tanA: Math.tan(((s.inflowAngle ?? TORNADO_DEFAULTS.inflowAngle) * Math.PI) / 180),
    sense: (s.rotation ?? TORNADO_DEFAULTS.rotation) === 'cw' ? -1 : 1, ux, uz,
  };
}

/**
 * Add the vortex's ground-relative wind at (x, z) at 10 m height (× `hf` = height factor) to out[0] / out[2].
 * World axes: x = east, z = south; seen from above (north up) counter-clockwise turns east → north (−z).
 */
export function addVortexWind(v: VortexState, x: number, z: number, hf: number, out: [number, number, number] | Float64Array | number[]): void {
  const dx = x - v.cx, dz = z - v.cz;
  const r = Math.sqrt(dx * dx + dz * dz);
  if (r >= v.Rout || v.amp <= 0) return;
  const k = v.amp * taper(r, v.Rout) * hf;
  if (r > 1e-6) {
    const vt = v.vmax * hollandShape(r, v.R, v.B) * k;
    const ex = dx / r, ez = dz / r;
    // Tangential unit (ccw seen from above): (ez, −ex); radial inflow: −(ex, ez).
    out[0] += v.sense * vt * ez - v.tanA * vt * ex;
    out[2] += -v.sense * vt * ex - v.tanA * vt * ez;
  }
  out[0] += v.ux * k;
  out[2] += v.uz * k;
}
