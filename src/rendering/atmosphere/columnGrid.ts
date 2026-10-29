/**
 * A draped grid of the 5 m air columns (Phase 29, render-only): one flat-colored quad per column a little
 * above the ground (4 vertices each, so a column's color never bleeds into its neighbours — the value is
 * the column's, not an interpolation). Heights follow the terrain at the column corners.
 */
import * as THREE from 'three';

export interface ColumnGridSpec {
  originX: number;
  originZ: number;
  nx: number;
  nz: number;
  dx: number;
}

export function columnGridGeometry(g: ColumnGridSpec, height: (x: number, z: number) => number, lift = 0.35): THREE.BufferGeometry {
  const n = g.nx * g.nz;
  const pos = new Float32Array(n * 4 * 3);
  const col = new Float32Array(n * 4 * 3);
  const idx = new Uint32Array(n * 6);
  for (let iz = 0; iz < g.nz; iz++) for (let ix = 0; ix < g.nx; ix++) {
    const a = iz * g.nx + ix;
    const x0 = g.originX + ix * g.dx, z0 = g.originZ + iz * g.dx;
    const corners: [number, number][] = [[x0, z0], [x0 + g.dx, z0], [x0 + g.dx, z0 + g.dx], [x0, z0 + g.dx]];
    corners.forEach(([x, z], k) => { const o = (a * 4 + k) * 3; pos[o] = x; pos[o + 1] = height(x, z) + lift; pos[o + 2] = z; });
    const v = a * 4, o = a * 6;
    idx[o] = v; idx[o + 1] = v + 2; idx[o + 2] = v + 1; idx[o + 3] = v; idx[o + 4] = v + 3; idx[o + 5] = v + 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
}

const c0 = new THREE.Color();

/** Color every column from `value(a)` through `color(v, out)`; NaN hides the column (alpha by black). */
export function paintColumns(geo: THREE.BufferGeometry, n: number, value: (a: number) => number, color: (v: number, out: THREE.Color) => THREE.Color) {
  const attr = geo.getAttribute('color') as THREE.BufferAttribute;
  const arr = attr.array as Float32Array;
  for (let a = 0; a < n; a++) {
    const v = value(a);
    if (Number.isFinite(v)) color(v, c0); else c0.setRGB(0, 0, 0);
    for (let k = 0; k < 4; k++) { const o = (a * 4 + k) * 3; arr[o] = c0.r; arr[o + 1] = c0.g; arr[o + 2] = c0.b; }
  }
  attr.needsUpdate = true;
}
