/**
 * Gravity overlay colors (Phase 31, render-only). FIXED SI scales printed by the legends (never rescaled): |g| and the
 * downward component in m/s² (Earth 9.81 marked), the structural gravity ratio g/g₀. Distinct ramps from the
 * atmosphere / blast pressure overlays (no kPa here).
 */
import * as THREE from 'three';

type Stops = [number, THREE.Color][];
const ramp = (stops: [number, string][]): Stops => stops.map(([v, h]) => [v, new THREE.Color(h)]);
function along(v: number, s: Stops, out: THREE.Color) {
  if (v <= s[0][0]) return out.copy(s[0][1]);
  for (let k = 1; k < s.length; k++) if (v <= s[k][0]) return out.copy(s[k - 1][1]).lerp(s[k][1], (v - s[k - 1][0]) / (s[k][0] - s[k - 1][0]));
  return out.copy(s[s.length - 1][1]);
}
const grad = (s: [number, string][]) => `linear-gradient(90deg, ${s.map(([v, c]) => `${c} ${v * 100}%`).join(', ')})`;

/** 0 (violet) … 9.81 (white) … 30+ m/s² (deep orange): weaker / Earth / stronger. */
const MAG: [number, string][] = [[0, '#5b2a86'], [0.164, '#4f7fd8'], [0.327, '#f2f2ea'], [0.6, '#f5a142'], [1, '#b8321a']];
/** Downward component −10 (up, magenta) … 0 (grey) … +30 m/s². */
const DOWN: [number, string][] = [[0, '#c03a9a'], [0.25, '#8a8a8a'], [0.5, '#f2f2ea'], [0.75, '#f5a142'], [1, '#b8321a']];
/** Structural gravity ratio 0 … 4 × g₀ (1 = white). */
const RATIO: [number, string][] = [[0, '#3a6fc4'], [0.25, '#f2f2ea'], [0.5, '#f2c14a'], [1, '#b8321a']];

export type GravityOverlay = 'off' | 'magnitude' | 'down' | 'structLoad' | 'contactLoad';
export const GRAVITY_OVERLAYS: readonly GravityOverlay[] = ['off', 'magnitude', 'down', 'structLoad', 'contactLoad'];
const R: Record<Exclude<GravityOverlay, 'off'>, { s: Stops; css: [number, string][]; min: number; max: number; labels: string[] }> = {
  magnitude: { s: ramp(MAG), css: MAG, min: 0, max: 30, labels: ['0', '9.81', '30 m/s²'] },
  down: { s: ramp(DOWN), css: DOWN, min: -10, max: 30, labels: ['−10', '0', '9.81', '30 m/s²'] },
  structLoad: { s: ramp(RATIO), css: RATIO, min: 0, max: 4, labels: ['0', '1', '2', '4 × g₀'] },
  /** Resting normal load of a body: its weight along the downward component, log₁₀ of kN (0.1 … 100 kN). */
  contactLoad: { s: ramp(MAG), css: MAG, min: -1, max: 2, labels: ['0.1', '1', '10', '100 kN'] },
};

export function gravityColor(o: Exclude<GravityOverlay, 'off'>, v: number, out: THREE.Color): THREE.Color {
  const r = R[o];
  return along((v - r.min) / (r.max - r.min), r.s, out);
}
export const gravityGradient = (o: Exclude<GravityOverlay, 'off'>) => grad(R[o].css);
export const gravityLabels = (o: Exclude<GravityOverlay, 'off'>) => R[o].labels;
/** |g| color for arrows (same ramp as the magnitude overlay). */
export const arrowColor = (g: number, out: THREE.Color) => gravityColor('magnitude', g, out);
