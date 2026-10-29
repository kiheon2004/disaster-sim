/**
 * Atmosphere overlay colors (Phase 29, render-only). Every overlay has a FIXED SI scale printed by its
 * legend (never rescaled to the current range). Pressure change uses a fixed symmetric logarithmic scale
 * (1 mPa … 100 kPa) so that the tiny lows of a refilled sink and a whole-world removal are both
 * readable. Blast overpressure (Phase 24) never uses these legends.
 */
import * as THREE from 'three';
import type { AtmosOverlay } from '../viewStore';

type Stops = [number, THREE.Color][];
const ramp = (stops: [number, string][]): Stops => stops.map(([v, h]) => [v, new THREE.Color(h)]);
function along(v: number, s: Stops, out: THREE.Color) {
  if (v <= s[0][0]) return out.copy(s[0][1]);
  for (let k = 1; k < s.length; k++) if (v <= s[k][0]) return out.copy(s[k - 1][1]).lerp(s[k][1], (v - s[k - 1][0]) / (s[k][0] - s[k - 1][0]));
  return out.copy(s[s.length - 1][1]);
}
const grad = (s: [number, string][]) => `linear-gradient(90deg, ${s.map(([v, c]) => `${c} ${v * 100}%`).join(', ')})`;

const SEQ: [number, string][] = [[0, '#f4f1de'], [0.25, '#a8d5ba'], [0.5, '#4aa3b5'], [0.75, '#2c5f9e'], [1, '#22275a']];
const DIV: [number, string][] = [[0, '#2b4fa8'], [0.25, '#6f9fe0'], [0.5, '#f2f2f2'], [0.75, '#f08a5a'], [1, '#b2182b']];
const HEAT: [number, string][] = [[0, '#26305e'], [0.3, '#4a8fd0'], [0.5, '#f4f4ee'], [0.7, '#f6a04d'], [1, '#c2182b']];
const SMOKE: [number, string][] = [[0, '#f5f2ea'], [0.5, '#9a948c'], [1, '#2a2826']];
const GAS: [number, string][] = [[0, '#f6f3df'], [0.5, '#d9c44e'], [1, '#6f5a12']];
const S = { seq: ramp(SEQ), div: ramp(DIV), heat: ramp(HEAT), smoke: ramp(SMOKE), gas: ramp(GAS) };

type Key = Exclude<AtmosOverlay, 'off'>;
/** Fixed scale per overlay: [min, max] in the displayed unit, the unit, and the ramp. */
export const ATMOS_SCALE: Record<Key, { min: number; max: number; unit: string; ramp: keyof typeof S; log?: boolean }> = {
  pressure: { min: 0, max: 110, unit: 'kPa', ramp: 'seq' },
  pressureChange: { min: -1e5, max: 1e5, unit: 'Pa', ramp: 'div', log: true },
  density: { min: 0, max: 1.4, unit: 'kg/m³', ramp: 'seq' },
  temperature: { min: -80, max: 110, unit: '°C', ramp: 'heat' },
  speed: { min: 0, max: 20, unit: 'm/s', ramp: 'seq' },
  mass: { min: 0, max: 12_000, unit: 'kg/m²', ramp: 'seq' },
  oxygen: { min: 0, max: 0.3, unit: 'kg/m³', ramp: 'seq' },
  smoke: { min: 0, max: 500, unit: 'mg/m³', ramp: 'smoke' },
  gas: { min: 0, max: 5, unit: 'g/m³', ramp: 'gas' },
  ash: { min: 0, max: 50, unit: 'g/m²', ramp: 'smoke' },
  updraft: { min: 0, max: 10, unit: 'm/s', ramp: 'seq' },
};

/** Smallest |Δp| on the logarithmic scale (Pa): 1 mPa … 100 kPa = 8 decades. */
export const LOG_FLOOR = 1e-3;
const LOG_DECADES = Math.log10(1e5 / LOG_FLOOR);
const logPos = (v: number) => {
  const a = Math.abs(v);
  if (a <= LOG_FLOOR) return 0.5;
  const f = Math.min(1, Math.log10(a / LOG_FLOOR) / LOG_DECADES);
  return 0.5 + 0.5 * Math.sign(v) * f;
};

/** Position (0–1) of a value on its overlay's fixed scale. */
export function scalePos(k: Key, v: number): number {
  const s = ATMOS_SCALE[k];
  if (s.log) return logPos(v);
  if (k === 'temperature') return Math.max(0, Math.min(1, (v - s.min) / (s.max - s.min)));
  return Math.max(0, Math.min(1, (v - s.min) / (s.max - s.min)));
}

export function atmosColor(k: Key, v: number, out: THREE.Color): THREE.Color {
  return along(scalePos(k, v), S[ATMOS_SCALE[k].ramp], out);
}

export const atmosGradient = (k: Key) => grad(k === 'pressureChange' ? DIV : ATMOS_SCALE[k].ramp === 'heat' ? HEAT : ATMOS_SCALE[k].ramp === 'smoke' ? SMOKE : ATMOS_SCALE[k].ramp === 'gas' ? GAS : SEQ);

/** Legend labels of an overlay (fixed). */
export function atmosLabels(k: Key): string[] {
  const s = ATMOS_SCALE[k];
  if (s.log) return ['−100 kPa', '−1 Pa', '0', '+1 Pa', '+100 kPa'];
  const mid = (s.min + s.max) / 2;
  const f = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2).replace(/\.?0+$/, ''));
  return [`${f(s.min)}`, `${f(mid)}`, `${f(s.max)} ${s.unit}`];
}
