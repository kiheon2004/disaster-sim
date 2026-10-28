import * as THREE from 'three';

/** Speed → color ramp shared by arrows and the legend (m/s stops). */
export const WIND_COLOR_STOPS: [number, string][] = [
  [0, '#5fb6d9'],
  [14, '#4fc28a'],
  [25, '#e6d14a'],
  [33, '#f5a13b'],
  [44, '#ef4d4d'],
  [60, '#c43bd6'],
];

const stops = WIND_COLOR_STOPS.map(([v, c]) => [v, new THREE.Color(c)] as const);

export function windColor(speed: number, out: THREE.Color): THREE.Color {
  if (speed <= stops[0][0]) return out.copy(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    if (speed <= stops[i][0]) {
      const [v0, c0] = stops[i - 1];
      const [v1, c1] = stops[i];
      return out.copy(c0).lerp(c1, (speed - v0) / (v1 - v0));
    }
  }
  return out.copy(stops[stops.length - 1][1]);
}
