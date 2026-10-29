/**
 * Celestial overlay colors (Phase 32, render-only). FIXED logarithmic SI scales printed by the legends (never
 * rescaled) — a compact source's field spans decades: |g| 0.01 … 10⁴ m/s² (Earth 9.81 marked), |Φ| 1 … 10⁶ J/kg,
 * principal tidal stretch λ₁ 10⁻⁴ … 10³ s⁻², escape speed 0.1 … 10⁴ m/s; model zones as categories.
 */
import * as THREE from 'three';

type Stops = [number, THREE.Color][];
const ramp = (stops: [number, string][]): Stops => stops.map(([v, h]) => [v, new THREE.Color(h)]);
function along(v: number, s: Stops, out: THREE.Color) {
  if (!(v > s[0][0])) return out.copy(s[0][1]);
  for (let k = 1; k < s.length; k++) if (v <= s[k][0]) return out.copy(s[k - 1][1]).lerp(s[k][1], (v - s[k - 1][0]) / (s[k][0] - s[k - 1][0]));
  return out.copy(s[s.length - 1][1]);
}
const grad = (s: [number, string][]) => `linear-gradient(90deg, ${s.map(([v, c]) => `${c} ${v * 100}%`).join(', ')})`;

/** Deep blue → teal → white (≈ Earth) → amber → crimson. */
const LOG: [number, string][] = [[0, '#1d2a6b'], [0.25, '#2f8fa8'], [0.5, '#f2f2ea'], [0.75, '#f5a142'], [1, '#a8182b']];
/** Model zones: Newtonian far field, softened core (inside 3 ε), capture sphere, beyond the substep cap / 0.1 c. */
export const ZONE_COLORS = ['#3c7f5a', '#4f8fd8', '#1a1a1a', '#d24bd8'];

export type CelestialOverlay = 'off' | 'accel' | 'potential' | 'tidal' | 'escape' | 'zones' | 'speed';
export const CELESTIAL_OVERLAYS: readonly CelestialOverlay[] = ['off', 'accel', 'potential', 'tidal', 'escape', 'zones', 'speed'];
/** v / v_esc of a body: 0 … 1 (bound: green → amber) … 2+ (unbound: red). */
const SPEED: [number, string][] = [[0, '#2f9e5a'], [0.45, '#d8c24a'], [0.5, '#ff5a3c'], [1, '#a8182b']];
const SS = ramp(SPEED);
export const speedColor = (ratio: number, out: THREE.Color) => along(Math.min(1, ratio / 2), SS, out);
const R: Record<Exclude<CelestialOverlay, 'off' | 'zones' | 'speed'>, { min: number; max: number; labels: string[] }> = {
  accel: { min: -2, max: 4, labels: ['0.01', '1', '9.81', '100', '10⁴ m/s²'] },
  potential: { min: 0, max: 6, labels: ['1', '10³', '10⁶ J/kg'] },
  tidal: { min: -4, max: 3, labels: ['10⁻⁴', '0.1', '10³ s⁻²'] },
  escape: { min: -1, max: 4, labels: ['0.1', '10', '10⁴ m/s'] },
};
const S = ramp(LOG);

/** Color of a value (linear units) on the overlay's log scale. */
export function celestialColor(o: Exclude<CelestialOverlay, 'off' | 'zones' | 'speed'>, v: number, out: THREE.Color): THREE.Color {
  const r = R[o];
  return along((Math.log10(Math.max(1e-30, v)) - r.min) / (r.max - r.min), S, out);
}
export const celestialGradient = (o: CelestialOverlay) => (o === 'speed' ? grad(SPEED) : o === 'zones' ? `linear-gradient(90deg, ${ZONE_COLORS.map((c, i) => `${c} ${i * 25}%, ${c} ${(i + 1) * 25}%`).join(', ')})` : o === 'off' ? '' : grad(LOG));
export const celestialLabels = (o: CelestialOverlay) => (o === 'speed' ? ['0', '1 (v = v_esc)', '≥ 2'] : o === 'zones' || o === 'off' ? [] : R[o].labels);
