/**
 * Fire colors (Phase 27, render-only): fire state of fuel items, remaining fuel, heat release (log
 * scale) and smoke visibility — fixed scales, printed in the legends.
 */
import * as THREE from 'three';
import { FS } from '@/fire/FireWorld';

export const STATE_COLORS: Record<number, string> = {
  [FS.unheated]: '#9aa1a8', [FS.heating]: '#f2c230', [FS.pyrolysis]: '#f08a24', [FS.ignited]: '#ff4d1a', [FS.burning]: '#ff2a00',
  [FS.decaying]: '#b8431f', [FS.extinguished]: '#5f7f9a', [FS.burnedOut]: '#2a2420',
};
const cache = new Map<number, THREE.Color>();
export function stateColor(s: number, out: THREE.Color): THREE.Color {
  let c = cache.get(s);
  if (!c) cache.set(s, (c = new THREE.Color(STATE_COLORS[s] ?? '#ffffff')));
  return out.copy(c);
}

const FUEL_LO = new THREE.Color('#2a2420'), FUEL_MID = new THREE.Color('#e0a030'), FUEL_HI = new THREE.Color('#4caf50');
/** Remaining fuel share 0 (all consumed) → 1 (untouched). */
export function fuelColor(f: number, out: THREE.Color): THREE.Color {
  const v = Math.max(0, Math.min(1, f));
  return v < 0.5 ? out.copy(FUEL_LO).lerp(FUEL_MID, v * 2) : out.copy(FUEL_MID).lerp(FUEL_HI, (v - 0.5) * 2);
}
export const FUEL_GRADIENT = 'linear-gradient(90deg, #2a2420 0%, #e0a030 50%, #4caf50 100%)';

/** Heat release 10 kW … 100 MW (log). */
export const HRR_RANGE = [1e4, 1e8] as const;
const H0 = new THREE.Color('#f5d74a'), H1 = new THREE.Color('#e0503a'), H2 = new THREE.Color('#5a1a7a');
export function hrrColor(Q: number, out: THREE.Color): THREE.Color {
  const v = Math.max(0, Math.min(1, (Math.log10(Math.max(HRR_RANGE[0], Q)) - 4) / 4));
  return v < 0.5 ? out.copy(H0).lerp(H1, v * 2) : out.copy(H1).lerp(H2, (v - 0.5) * 2);
}
export const HRR_GRADIENT = 'linear-gradient(90deg, #f5d74a 0%, #e0503a 50%, #5a1a7a 100%)';

/** Visibility (m): ≥ 30 m clear … ≤ 1 m (dense smoke). */
const V0 = new THREE.Color('#d9e4ec'), V1 = new THREE.Color('#7d8790'), V2 = new THREE.Color('#1f2326');
export function visibilityColor(S: number, out: THREE.Color): THREE.Color {
  const v = 1 - Math.max(0, Math.min(1, Math.log10(Math.max(1, Math.min(30, S))) / Math.log10(30)));
  return v < 0.5 ? out.copy(V0).lerp(V1, v * 2) : out.copy(V1).lerp(V2, (v - 0.5) * 2);
}
export const VISIBILITY_GRADIENT = 'linear-gradient(90deg, #1f2326 0%, #7d8790 50%, #d9e4ec 100%)';

/** Room fire state colors: normal, warm, burning, flashover, oxygen-limited, open (collapsed). */
export const ROOM_COLORS = { cold: '#9aa1a8', warm: '#f2c230', burning: '#ff4d1a', flashover: '#b0174f', limited: '#6a3fb5', open: '#2a2420' } as const;
