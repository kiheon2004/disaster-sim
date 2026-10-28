import type { Vec3 } from '@/core/types';
import { windFlowVector } from '@/core/compass';
import { heightFactor } from '../damage/windLoad';

/**
 * Spatially and temporally varying wind.
 *   v(p, t) = base · heightFactor(y) · (1 + gust · g(p, t))
 * g is a sum of sinusoids whose phase travels downwind, so gust fronts sweep through the scene.
 */
export class WindField {
  /** Mean speed at 10 m (m/s). */
  baseSpeed = 0;
  /** Bearing the wind blows FROM (deg, clockwise from north). */
  fromBearing = 90;
  /** 0–1 */
  gustStrength = 0;

  private flowBearing = NaN;
  private flowVec: Vec3 = [0, 0, 0];

  /**
   * Unit vector of air movement (horizontal). Cached per bearing — this is called several
   * times per wind sample. Treat the returned array as read-only.
   */
  flow(): Vec3 {
    if (this.fromBearing !== this.flowBearing) {
      this.flowVec = windFlowVector(this.fromBearing);
      this.flowBearing = this.fromBearing;
    }
    return this.flowVec;
  }

  /** Gust fluctuation in roughly [-0.6, 1]. */
  gustFactor(p: Vec3, t: number): number {
    if (this.gustStrength <= 0) return 0;
    const f = this.flow();
    // Distance along the flow; gusts are advected at ~mean speed.
    const along = p[0] * f[0] + p[2] * f[2];
    const across = p[0] * -f[2] + p[2] * f[0];
    const adv = Math.max(this.baseSpeed, 5);
    const s = along - adv * t;
    const g =
      0.55 * Math.sin(s * 0.045 + across * 0.01) +
      0.3 * Math.sin(s * 0.11 + 1.7 + across * 0.035) +
      0.15 * Math.sin(t * 2.3 + across * 0.08 + s * 0.2);
    // Skew toward positive peaks (gusts) rather than symmetric lulls.
    return g > 0 ? g * 1.15 : g * 0.6;
  }

  /** Effective scalar speed at a point. */
  speedAt(p: Vec3, t: number): number {
    if (this.baseSpeed <= 0) return 0;
    return Math.max(0, this.baseSpeed * heightFactor(p[1]) * (1 + this.gustStrength * this.gustFactor(p, t)));
  }

  /** Wind velocity vector at a point (with a slight directional wobble in gusts). */
  sample(p: Vec3, t: number): Vec3 {
    const s = this.speedAt(p, t);
    if (s === 0) return [0, 0, 0];
    const wobble = this.gustStrength * 0.12 * Math.sin(t * 0.7 + p[0] * 0.02 + p[2] * 0.017);
    const f = this.flow();
    const c = Math.cos(wobble);
    const sn = Math.sin(wobble);
    return [(f[0] * c - f[2] * sn) * s, 0, (f[0] * sn + f[2] * c) * s];
  }
}
