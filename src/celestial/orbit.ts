/**
 * Orbit quantities of a single softened point mass (Phase 32): initial-condition speeds, specific energy, angular
 * momentum and — for an unsoftened source (or a body staying well outside ε) — the Kepler elements.
 *
 * With softening, a uniform background or more than one source, the conic elements are NOT the body's exact orbit:
 * `elements` returns them flagged `exact: false` and the inspector shows energy / angular momentum only.
 */
import type { Vec3 } from '@/core/types';

/** Circular speed at radius r of a Plummer source: v² = r·|g| = μ·r²/(r² + ε²)^{3/2}. */
export const circularSpeed = (mu: number, r: number, eps = 0) => Math.sqrt((mu * r * r) / (r * r + eps * eps) ** 1.5);
/** Escape speed at r: v² = 2|Φ| = 2μ/√(r² + ε²). */
export const escapeSpeed = (mu: number, r: number, eps = 0) => Math.sqrt((2 * mu) / Math.sqrt(r * r + eps * eps));
/** Period of the circular orbit at r (s). */
export const circularPeriod = (mu: number, r: number, eps = 0) => (2 * Math.PI * r) / circularSpeed(mu, r, eps);

export interface OrbitElements {
  /** Specific orbital energy (J/kg) and angular momentum vector (m²/s) relative to the source. */
  energy: number;
  h: Vec3;
  /** Semi-major axis (m; negative for hyperbolic, Infinity for parabolic), eccentricity, periapsis / apoapsis (m;
   *  apoapsis Infinity when unbound), period (s; Infinity when unbound). */
  a: number;
  e: number;
  periapsis: number;
  apoapsis: number;
  period: number;
  kind: 'circular' | 'elliptic' | 'parabolic' | 'hyperbolic' | 'radial';
  /** The conic is the exact orbit (single unsoftened source, no other field). */
  exact: boolean;
}

/**
 * Kepler elements of a body at r⃗ (relative to the source) with velocity v⃗ (relative to the source), Φ = −μ/√(r² + ε²).
 * `exact` is false when ε > 0 (the conic is an approximation outside the core) — the caller adds other conditions
 * (several sources, a uniform field).
 */
export function elements(mu: number, r: Readonly<Vec3>, v: Readonly<Vec3>, eps = 0): OrbitElements {
  const rm = Math.hypot(r[0], r[1], r[2]);
  const v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  const energy = 0.5 * v2 - mu / Math.sqrt(rm * rm + eps * eps);
  const h: Vec3 = [r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]];
  const hm = Math.hypot(h[0], h[1], h[2]);
  // Eccentricity vector e⃗ = (v × h)/μ − r̂ (Kepler, ε = 0 form).
  const ex = (v[1] * h[2] - v[2] * h[1]) / mu - r[0] / rm;
  const ey = (v[2] * h[0] - v[0] * h[2]) / mu - r[1] / rm;
  const ez = (v[0] * h[1] - v[1] * h[0]) / mu - r[2] / rm;
  const e = Math.hypot(ex, ey, ez);
  const p = (hm * hm) / mu;
  const a = Math.abs(energy) < 1e-12 * (mu / rm) ? Infinity : -mu / (2 * energy);
  const periapsis = p / (1 + e);
  const bound = energy < 0;
  const apoapsis = bound && e < 1 ? p / (1 - e) : Infinity;
  const period = bound ? 2 * Math.PI * Math.sqrt(a ** 3 / mu) : Infinity;
  const kind: OrbitElements['kind'] = hm < 1e-9 * rm * Math.sqrt(v2 + 1e-30) ? 'radial' : e < 1e-3 && bound ? 'circular' : bound ? 'elliptic' : a === Infinity ? 'parabolic' : 'hyperbolic';
  return { energy, h, a, e, periapsis, apoapsis, period, kind, exact: eps === 0 };
}

/**
 * Initial velocity of a probe: `speed` along `dir` with its radial component removed for a circular start (the
 * orbit plane is the plane of the radius and the direction). Returns [0, 0, 0] for a degenerate direction.
 */
export function launchVelocity(r: Readonly<Vec3>, dir: Readonly<Vec3>, speed: number, perpendicular: boolean): Vec3 {
  let dx = dir[0], dy = dir[1], dz = dir[2];
  if (perpendicular) {
    const rm2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
    if (rm2 > 0) {
      const k = (dx * r[0] + dy * r[1] + dz * r[2]) / rm2;
      dx -= k * r[0]; dy -= k * r[1]; dz -= k * r[2];
    }
  }
  const n = Math.hypot(dx, dy, dz);
  if (!(n > 1e-12)) return [0, 0, 0];
  return [(speed * dx) / n, (speed * dy) / n, (speed * dz) / n];
}
