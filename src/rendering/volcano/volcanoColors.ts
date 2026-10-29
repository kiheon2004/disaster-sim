/**
 * Volcano colors (Phase 28, render-only). The lava's look is driven by its COMPUTED surface temperature:
 * incandescent above the Draper point (525 °C, the onset of visible glow), dark crust below — a black
 * surface is a colder crust in the energy balance, never a solidified flow by itself. Overlays use fixed
 * absolute scales (the legend prints them), never rescaled to the current range.
 */
import * as THREE from 'three';
import { temperatureColor, TEMPERATURE_GRADIENT } from '../thermal/thermalColors';

/** Incandescence by surface temperature (°C): approximate perceived colors of hot basalt. */
const GLOW: [number, string][] = [[300, '#221d1b'], [525, '#2f1a14'], [600, '#5e1608'], [700, '#a81e0a'], [800, '#e0380c'], [900, '#ff6410'], [1000, '#ff962a'], [1100, '#ffc65a'], [1200, '#ffe9a8']];
const glowStops = GLOW.map(([c, h]) => [c, new THREE.Color(h)] as [number, THREE.Color]);

export function lavaColor(C: number, out: THREE.Color): THREE.Color {
  const s = glowStops;
  if (C <= s[0][0]) return out.copy(s[0][1]);
  for (let k = 1; k < s.length; k++) if (C <= s[k][0]) return out.copy(s[k - 1][1]).lerp(s[k][1], (C - s[k - 1][0]) / (s[k][0] - s[k - 1][0]));
  return out.copy(s[s.length - 1][1]);
}

export const DEPOSIT_COLOR = new THREE.Color('#34302d');
export const ASH_COLOR = new THREE.Color('#8f8981');

const ramp = (stops: [number, string][]) => stops.map(([v, h]) => [v, new THREE.Color(h)] as [number, THREE.Color]);
function along(v: number, s: [number, THREE.Color][], out: THREE.Color) {
  if (v <= s[0][0]) return out.copy(s[0][1]);
  for (let k = 1; k < s.length; k++) if (v <= s[k][0]) return out.copy(s[k - 1][1]).lerp(s[k][1], (v - s[k - 1][0]) / (s[k][0] - s[k - 1][0]));
  return out.copy(s[s.length - 1][1]);
}
const SEQ: [number, string][] = [[0, '#f1f6d8'], [0.25, '#a7d8b0'], [0.5, '#46a6a8'], [0.75, '#2a6b9a'], [1, '#26305e']];
const SEQ_STOPS = ramp(SEQ);
const SOLID: [number, string][] = [[0, '#ffd27a'], [0.3, '#e86a2a'], [0.55, '#8a2a3a'], [1, '#2a2440']];
const SOLID_STOPS = ramp(SOLID);
const grad = (s: [number, string][]) => `linear-gradient(90deg, ${s.map(([v, c]) => `${c} ${v * 100}%`).join(', ')})`;

/** Fixed overlay scales: max value of the legend and its unit. */
export const OVERLAY_SCALE = { depth: { max: 3, unit: 'm' }, temperature: { max: 1200, unit: '°C' }, speed: { max: 2, unit: 'm/s' }, solid: { max: 1, unit: '' }, ash: { max: 0.2, unit: 'm' }, exposure: { max: 600, unit: '°C' } } as const;

export const overlayGradient = (k: keyof typeof OVERLAY_SCALE) => (k === 'temperature' || k === 'exposure' ? TEMPERATURE_GRADIENT : k === 'solid' ? grad(SOLID) : grad(SEQ));

export function overlayColor(k: keyof typeof OVERLAY_SCALE, v: number, out: THREE.Color): THREE.Color {
  const max = OVERLAY_SCALE[k].max;
  if (k === 'temperature' || k === 'exposure') return temperatureColor(v, max, out);
  if (k === 'solid') return along(Math.max(0, Math.min(1, v)), SOLID_STOPS, out);
  return along(Math.max(0, Math.min(1, v / max)), SEQ_STOPS, out);
}

export const GLOW_GRADIENT = `linear-gradient(90deg, ${GLOW.map(([c, h]) => `${h} ${((c - 300) / 900) * 100}%`).join(', ')})`;
