import * as THREE from 'three';

/**
 * Ground-failure colors (Phase 22, render-only).
 *
 *  - factor of safety: FS < 1 red (fails), 1–1.2 orange (marginal), 1.2–1.5 yellow, ≥ 1.5 green;
 *    failed vertices dark red; not evaluated (flat / rock / outside) stays clear;
 *  - mobile sediment thickness: pale → dark brown, saturated at SEDIMENT_MAX;
 *  - deposits: sand → olive, saturated at DEPOSIT_MAX.
 */
export const FS_STOPS: [number, string][] = [[0.8, '#b0201a'], [1, '#e2452c'], [1.2, '#f08a2c'], [1.5, '#e6d03c'], [2.5, '#45b36a']];
export const SEDIMENT_MAX = 3;
export const DEPOSIT_MAX = 3;

const tmp = new THREE.Color();
const stops = FS_STOPS.map(([v, c]) => [v, new THREE.Color(c)] as const);

export function fsColor(fs: number, out: THREE.Color): THREE.Color {
  if (fs <= stops[0][0]) return out.copy(stops[0][1]);
  for (let k = 1; k < stops.length; k++) {
    const [v, c] = stops[k];
    if (fs <= v) {
      const [v0, c0] = stops[k - 1];
      return out.copy(c0).lerp(c, (fs - v0) / (v - v0));
    }
  }
  return out.copy(stops[stops.length - 1][1]);
}

export const FAILED_COLOR = new THREE.Color('#5a0d0a');

const SED0 = new THREE.Color('#e8cfa0');
const SED1 = new THREE.Color('#5b3514');
export function sedimentColor(h: number, out: THREE.Color): THREE.Color {
  return out.copy(SED0).lerp(SED1, Math.min(1, h / SEDIMENT_MAX));
}

const DEP0 = new THREE.Color('#f1e2b0');
const DEP1 = new THREE.Color('#6d6a2a');
export function depositColor(d: number, out: THREE.Color): THREE.Color {
  return out.copy(DEP0).lerp(DEP1, Math.min(1, d / DEPOSIT_MAX));
}

/** Legend gradients (CSS). */
export const FS_GRADIENT = `linear-gradient(90deg, ${FS_STOPS.map(([v, c]) => `${c} ${((v - 0.8) / 1.7) * 100}%`).join(', ')})`;
export const SEDIMENT_GRADIENT = 'linear-gradient(90deg, #e8cfa0, #5b3514)';
export const DEPOSIT_GRADIENT = 'linear-gradient(90deg, #f1e2b0, #6d6a2a)';

/** Speed color of flow arrows (m/s): slow amber → fast red, saturated at 10 m/s. */
export function flowColor(v: number, out: THREE.Color): THREE.Color {
  return out.set('#ffcf6a').lerp(tmp.set('#d8261c'), Math.min(1, v / 10));
}
