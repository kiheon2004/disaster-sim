import * as THREE from 'three';

/**
 * Diverging displacement colors (Phase 21): blue = ground lowered, red = raised; small values
 * keep their sign's tint (pale blue / pale red) and fade out through the overlay opacity.
 * `scale` is the |w| (m) shown fully saturated (legend end).
 */
const DOWN = new THREE.Color('#1646a8');
const DOWN0 = new THREE.Color('#9cc3f2');
const UP = new THREE.Color('#c0301c');
const UP0 = new THREE.Color('#f5b4a4');

export function displacementColor(w: number, scale: number, out: THREE.Color): THREE.Color {
  const s = Math.min(1, Math.abs(w) / Math.max(1e-6, scale));
  return w < 0 ? out.copy(DOWN0).lerp(DOWN, s) : out.copy(UP0).lerp(UP, s);
}

/** CSS gradient of the same ramp (legends). */
export const DISPLACEMENT_GRADIENT = 'linear-gradient(90deg, #1646a8, #9cc3f2 49%, transparent 50%, #f5b4a4 51%, #c0301c)';

/** Legend saturation: the next "nice" value above the largest |w|. */
export function displacementScale(maxAbs: number): number {
  for (const v of [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30]) if (maxAbs <= v) return v;
  return Math.ceil(maxAbs);
}

/** Foundation contact colors: full (green) → partial (amber) → lost (red). */
export function contactColor(contact: number, out: THREE.Color): THREE.Color {
  return contact >= 0.95 ? out.set('#45c27a') : contact >= 0.75 ? out.set('#e6b23c') : out.set('#e0483a');
}

/** Overlay opacity of a vertex displaced by w: clear where nothing moved (< 5 mm). */
export function displacementAlpha(w: number, scale: number): number {
  const a = Math.abs(w);
  return a < 0.005 ? 0 : 0.25 + 0.6 * Math.min(1, a / Math.max(1e-6, scale));
}
