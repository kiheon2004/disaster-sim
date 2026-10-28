import * as THREE from 'three';

/** Ground acceleration (g) → color stops: calm blue … green … yellow … orange … red. */
export const ACCEL_COLOR_STOPS: [number, string][] = [
  [0, '#3a6fb0'],
  [0.08, '#3fbf7f'],
  [0.2, '#e6d14a'],
  [0.4, '#f5973b'],
  [0.7, '#ef4d4d'],
  [1.2, '#b0247a'],
];
const stops = ACCEL_COLOR_STOPS.map(([g, c]) => [g, new THREE.Color(c)] as const);

export function accelColor(g: number, out: THREE.Color): THREE.Color {
  if (g <= stops[0][0]) return out.copy(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    if (g <= stops[i][0]) return out.copy(stops[i - 1][1]).lerp(stops[i][1], (g - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]));
  }
  return out.copy(stops[stops.length - 1][1]);
}

/** CSS gradient of the scale (legend), 0 … `max` g. */
export function accelGradient(max = 1.2): string {
  return `linear-gradient(90deg, ${ACCEL_COLOR_STOPS.map(([g, c]) => `${c} ${(g / max) * 100}%`).join(', ')})`;
}
