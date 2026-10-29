/**
 * Climate overlay colors (Phase 30, render-only). Every overlay has a FIXED SI scale printed by its legend (never
 * rescaled to the current range).
 */
import * as THREE from 'three';
import type { ClimateOverlay } from '../viewStore';

type Stops = [number, THREE.Color][];
const ramp = (stops: [number, string][]): Stops => stops.map(([v, h]) => [v, new THREE.Color(h)]);
function along(v: number, s: Stops, out: THREE.Color) {
  if (v <= s[0][0]) return out.copy(s[0][1]);
  for (let k = 1; k < s.length; k++) if (v <= s[k][0]) return out.copy(s[k - 1][1]).lerp(s[k][1], (v - s[k - 1][0]) / (s[k][0] - s[k - 1][0]));
  return out.copy(s[s.length - 1][1]);
}
const grad = (s: [number, string][]) => `linear-gradient(90deg, ${s.map(([v, c]) => `${c} ${v * 100}%`).join(', ')})`;

const HEAT: [number, string][] = [[0, '#26305e'], [0.3, '#4a8fd0'], [0.5, '#f4f4ee'], [0.7, '#f6a04d'], [1, '#c2182b']];
const WET: [number, string][] = [[0, '#f6efd8'], [0.35, '#a8d5ba'], [0.7, '#3f8fc0'], [1, '#1f3f8a']];
const SNOW: [number, string][] = [[0, '#3a4a5c'], [0.25, '#7f9ab8'], [0.6, '#cfe1f2'], [1, '#ffffff']];
const ICE: [number, string][] = [[0, '#2c4a66'], [0.5, '#7ec8e8'], [1, '#e8fbff']];
const SUN: [number, string][] = [[0, '#1d1d2b'], [0.4, '#8a5a1e'], [0.75, '#f2a93b'], [1, '#fff3b0']];
const LOAD: [number, string][] = [[0, '#2f6b3a'], [0.3, '#c9c94a'], [0.6, '#f08a3a'], [1, '#b2182b']];
const R = { heat: ramp(HEAT), wet: ramp(WET), snow: ramp(SNOW), ice: ramp(ICE), sun: ramp(SUN), load: ramp(LOAD) };
const G = { heat: HEAT, wet: WET, snow: SNOW, ice: ICE, sun: SUN, load: LOAD };

type Key = Exclude<ClimateOverlay, 'off'>;
export const CLIMATE_SCALE: Record<Key, { min: number; max: number; unit: string; ramp: keyof typeof R }> = {
  airT: { min: -40, max: 50, unit: '°C', ramp: 'heat' },
  surfaceT: { min: -40, max: 70, unit: '°C', ramp: 'heat' },
  rh: { min: 0, max: 100, unit: '%', ramp: 'wet' },
  vapour: { min: 0, max: 30, unit: 'g/m³', ramp: 'wet' },
  snowDepth: { min: 0, max: 1, unit: 'm', ramp: 'snow' },
  swe: { min: 0, max: 200, unit: 'kg/m²', ramp: 'snow' },
  ice: { min: 0, max: 0.3, unit: 'm', ramp: 'ice' },
  water: { min: 0, max: 0.5, unit: 'm', ramp: 'wet' },
  soil: { min: 0, max: 0.45, unit: 'm³/m³', ramp: 'wet' },
  solar: { min: 0, max: 1000, unit: 'W/m²', ramp: 'sun' },
  roofLoad: { min: 0, max: 5, unit: 'kPa', ramp: 'load' },
};

export const climatePos = (k: Key, v: number) => Math.max(0, Math.min(1, (v - CLIMATE_SCALE[k].min) / (CLIMATE_SCALE[k].max - CLIMATE_SCALE[k].min)));
export const climateColor = (k: Key, v: number, out: THREE.Color) => along(climatePos(k, v), R[CLIMATE_SCALE[k].ramp], out);
export const climateGradient = (k: Key) => grad(G[CLIMATE_SCALE[k].ramp]);
export function climateLabels(k: Key): string[] {
  const s = CLIMATE_SCALE[k];
  const f = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2).replace(/\.?0+$/, ''));
  return [`${f(s.min)}`, `${f((s.min + s.max) / 2)}`, `${f(s.max)} ${s.unit}`];
}
