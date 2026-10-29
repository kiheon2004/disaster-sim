/**
 * Air-blast colors (Phase 24, render-only): overpressure on a log scale (100 Pa … 100 kPa), arrival
 * time, positive impulse (1 … 1000 Pa·s, log), model-validity zones.
 */
import * as THREE from 'three';

export const PRESSURE_STOPS: [number, string][] = [[100, '#2a4d8f'], [1000, '#2fb2c4'], [3000, '#8bd35a'], [10000, '#f2c230'], [30000, '#ec6b23'], [100000, '#b0174f']];
export const IMPULSE_STOPS: [number, string][] = [[1, '#2a4d8f'], [10, '#2fb2c4'], [30, '#8bd35a'], [100, '#f2c230'], [300, '#ec6b23'], [1000, '#b0174f']];
export const ARRIVAL_STOPS: [number, string][] = [[0, '#fff3b0'], [0.15, '#ffb347'], [0.3, '#e0603a'], [0.6, '#7b2d8b'], [1, '#2a2f6b']];
export const ZONE_COLORS = ['#8bd35a', '#f2c230', '#ec6b23', '#b0174f'] as const;

const cache = new Map<string, [number, THREE.Color][]>();
function stopsOf(s: [number, string][], log: boolean) {
  const key = s.map((x) => x.join()).join('|') + log;
  let c = cache.get(key);
  if (!c) cache.set(key, (c = s.map(([v, col]) => [log ? Math.log10(v) : v, new THREE.Color(col)])));
  return c;
}

function ramp(v: number, s: [number, THREE.Color][], out: THREE.Color): THREE.Color {
  if (v <= s[0][0]) return out.copy(s[0][1]);
  for (let k = 1; k < s.length; k++) if (v <= s[k][0]) return out.copy(s[k - 1][1]).lerp(s[k][1], (v - s[k - 1][0]) / (s[k][0] - s[k - 1][0]));
  return out.copy(s[s.length - 1][1]);
}

export const pressureColor = (p: number, out: THREE.Color) => ramp(Math.log10(Math.max(1, p)), stopsOf(PRESSURE_STOPS, true), out);
export const impulseColor = (i: number, out: THREE.Color) => ramp(Math.log10(Math.max(0.01, i)), stopsOf(IMPULSE_STOPS, true), out);
/** Arrival relative to the release, normalized by the time to cross the world. */
export const arrivalColor = (f: number, out: THREE.Color) => ramp(f, stopsOf(ARRIVAL_STOPS, false), out);

export function cssLogGradient(s: [number, string][]): string {
  const l0 = Math.log10(s[0][0]), l1 = Math.log10(s[s.length - 1][0]);
  return `linear-gradient(90deg, ${s.map(([v, c]) => `${c} ${((Math.log10(v) - l0) / (l1 - l0)) * 100}%`).join(', ')})`;
}
export const ARRIVAL_GRADIENT = `linear-gradient(90deg, ${ARRIVAL_STOPS.map(([v, c]) => `${c} ${v * 100}%`).join(', ')})`;
