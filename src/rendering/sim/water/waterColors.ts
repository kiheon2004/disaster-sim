import * as THREE from 'three';

/**
 * Color ramps of the water display (Phase 14). The same stops feed the shader (as uniforms) and
 * the CSS legends, so the legend always matches the picture.
 */
export const DEPTH_MAX = 3; // m — top of the depth ramp
export const SPEED_MAX = 3; // m/s — top of the speed ramp

/** Water depth heatmap: shallow → deep. */
export const DEPTH_STOPS: [number, string][] = [
  [0, '#d9f0a3'],
  [0.1, '#7fcdbb'],
  [0.5, '#2c9fd1'],
  [1.2, '#2554a8'],
  [2, '#4a2a8c'],
  [3, '#2a0f4f'],
];

/** Flow speed: still → fast. */
export const SPEED_STOPS: [number, string][] = [
  [0, '#2b4c7e'],
  [0.3, '#2c9fd1'],
  [0.8, '#4fc27a'],
  [1.5, '#f2d43d'],
  [2.2, '#f5893b'],
  [3, '#d7303a'],
];

export function cssGradient(stops: [number, string][], max: number): string {
  return `linear-gradient(90deg, ${stops.map(([v, c]) => `${c} ${(v / max) * 100}%`).join(', ')})`;
}

/** Stops as shader uniforms (vec3 colors + values, padded to 6). */
export function stopUniforms(stops: [number, string][]) {
  const c = new THREE.Color();
  return {
    colors: stops.map(([, hex]) => c.set(hex).clone().convertSRGBToLinear()).map((x) => new THREE.Vector3(x.r, x.g, x.b)),
    values: stops.map(([v]) => v),
  };
}
