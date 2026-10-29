/**
 * Thermal colors (Phase 26, render-only). Temperature uses ONE fixed, absolute scale in °C chosen by
 * the user (0 … 100 / 300 / 600 / 1200 °C) — never rescaled to the current min / max, so a color
 * always means the same temperature; below 0 °C a blue ramp (cold). The legend prints the range.
 * Strength factor and thermal-stress utilization have their own fixed ramps.
 */
import * as THREE from 'three';

export const THERMAL_SCALES = [100, 300, 600, 1200] as const;
export type ThermalScale = (typeof THERMAL_SCALES)[number];

/** Inferno-like ramp over [0, 1] (perceptually ordered, readable on terrain). */
export const HOT_STOPS: [number, string][] = [[0, '#2b1450'], [0.15, '#5a1a7a'], [0.35, '#a52c60'], [0.55, '#e0503a'], [0.75, '#f89a1c'], [0.9, '#f5d74a'], [1, '#fdfcd2']];
const COLD_STOPS: [number, string][] = [[0, '#e8f3ff'], [1, '#2a5fb0']];

const cache = new Map<string, [number, THREE.Color][]>();
function stops(s: [number, string][]) {
  const k = s.map((x) => x.join()).join('|');
  let c = cache.get(k);
  if (!c) cache.set(k, (c = s.map(([v, col]) => [v, new THREE.Color(col)])));
  return c;
}
function ramp(v: number, s: [number, THREE.Color][], out: THREE.Color): THREE.Color {
  if (v <= s[0][0]) return out.copy(s[0][1]);
  for (let k = 1; k < s.length; k++) if (v <= s[k][0]) return out.copy(s[k - 1][1]).lerp(s[k][1], (v - s[k - 1][0]) / (s[k][0] - s[k - 1][0]));
  return out.copy(s[s.length - 1][1]);
}

/** Color of a temperature (°C) on the fixed scale 0 … max; cold (< 0 °C) in blue down to −40 °C. */
export function temperatureColor(C: number, max: number, out: THREE.Color): THREE.Color {
  if (C < 0) return ramp(Math.min(1, -C / 40), stops(COLD_STOPS), out);
  return ramp(Math.min(1, C / max), stops(HOT_STOPS), out);
}

export const TEMPERATURE_GRADIENT = `linear-gradient(90deg, ${HOT_STOPS.map(([v, c]) => `${c} ${v * 100}%`).join(', ')})`;

/** Strength factor 1 (unaffected) → 0 (no strength left). */
const FACTOR_STOPS: [number, string][] = [[0, '#b0174f'], [0.5, '#f2c230'], [0.9, '#9fd36a'], [1, '#d7e8d0']];
export const factorColor = (f: number, out: THREE.Color) => ramp(Math.max(0, Math.min(1, f)), stops(FACTOR_STOPS), out);
export const FACTOR_GRADIENT = `linear-gradient(90deg, ${FACTOR_STOPS.map(([v, c]) => `${c} ${v * 100}%`).join(', ')})`;

/** Thermal-stress utilization 0 → OVERLOAD (1.25, failure). */
const UTIL_STOPS: [number, string][] = [[0, '#dfe7ef'], [0.4, '#7cc4d8'], [0.8, '#f2c230'], [1, '#b0174f']];
export const utilColor = (u: number, out: THREE.Color) => ramp(Math.max(0, Math.min(1, u / 1.25)), stops(UTIL_STOPS), out);
export const UTIL_GRADIENT = `linear-gradient(90deg, ${UTIL_STOPS.map(([v, c]) => `${c} ${v * 100}%`).join(', ')})`;

/** Heat-flux magnitude (W/m², log 50 … 100 000) for arrows and the source preview. */
export const FLUX_RANGE = [50, 1e5] as const;
export function fluxColor(q: number, out: THREE.Color): THREE.Color {
  const v = (Math.log10(Math.max(FLUX_RANGE[0], q)) - Math.log10(FLUX_RANGE[0])) / (Math.log10(FLUX_RANGE[1]) - Math.log10(FLUX_RANGE[0]));
  return ramp(Math.min(1, v), stops(HOT_STOPS), out);
}
