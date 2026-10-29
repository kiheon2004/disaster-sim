/**
 * Geometry helpers for air-blast fields (Phase 24, render-only): a colored grid draped at the
 * field points (FIELD_HEIGHT above the ground) and isolines by marching squares. Both read a
 * BlastField — the same contributions the simulation computes.
 */
import * as THREE from 'three';
import type { BlastField } from '@/blast/plan';
import { FIELD_HEIGHT } from '@/blast/plan';

/** Draped colored grid over a BlastField. `color` returns the vertex opacity (0 = clear). */
export class FieldGrid {
  readonly geometry = new THREE.BufferGeometry();
  private readonly col: Float32Array;

  constructor(readonly f: BlastField, lift = 0.15) {
    const { nx, nz } = f;
    const pos = new Float32Array(nx * nz * 3);
    this.col = new Float32Array(nx * nz * 4);
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
      const i = iz * nx + ix;
      pos[i * 3] = f.x0 + ix * f.step;
      pos[i * 3 + 1] = f.y[i] - FIELD_HEIGHT + lift;
      pos[i * 3 + 2] = f.z0 + iz * f.step;
    }
    const idx = new Uint32Array(Math.max(0, (nx - 1) * (nz - 1) * 6));
    let n = 0;
    for (let iz = 0; iz < nz - 1; iz++) for (let ix = 0; ix < nx - 1; ix++) {
      const a = iz * nx + ix, b = a + 1, c = a + nx, d = c + 1;
      idx[n++] = a; idx[n++] = c; idx[n++] = b;
      idx[n++] = b; idx[n++] = c; idx[n++] = d;
    }
    this.geometry.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geometry.computeBoundingSphere();
  }

  paint(color: (i: number, out: THREE.Color) => number) {
    const c = new THREE.Color(), col = this.col;
    const n = this.f.nx * this.f.nz;
    for (let i = 0; i < n; i++) {
      const a = color(i, c);
      col[i * 4] = c.r; col[i * 4 + 1] = c.g; col[i * 4 + 2] = c.b; col[i * 4 + 3] = a;
    }
    this.geometry.attributes.color.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
  }
}

/** Isoline segments (x, y, z pairs) of a grid value at `level` (marching squares, linear edges). */
export function isolines(f: BlastField, values: ArrayLike<number>, level: number, lift = 0.25): Float32Array {
  const { nx, nz, x0, z0, step } = f;
  const out: number[] = [];
  const v = (ix: number, iz: number) => values[iz * nx + ix];
  const y = (ix: number, iz: number) => f.y[iz * nx + ix] - FIELD_HEIGHT + lift;
  const edge = (ax: number, az: number, bx: number, bz: number) => {
    const va = v(ax, az), vb = v(bx, bz);
    const t = va === vb ? 0.5 : (level - va) / (vb - va);
    out.push(x0 + (ax + (bx - ax) * t) * step, y(ax, az) + (y(bx, bz) - y(ax, az)) * t, z0 + (az + (bz - az) * t) * step);
  };
  for (let iz = 0; iz < nz - 1; iz++) for (let ix = 0; ix < nx - 1; ix++) {
    const a = v(ix, iz) >= level ? 1 : 0, b = v(ix + 1, iz) >= level ? 2 : 0, c = v(ix + 1, iz + 1) >= level ? 4 : 0, d = v(ix, iz + 1) >= level ? 8 : 0;
    const k = a | b | c | d;
    if (k === 0 || k === 15) continue;
    if (!Number.isFinite(v(ix, iz)) || !Number.isFinite(v(ix + 1, iz)) || !Number.isFinite(v(ix + 1, iz + 1)) || !Number.isFinite(v(ix, iz + 1))) continue;
    // Edges: 0 = top (a–b), 1 = right (b–c), 2 = bottom (d–c), 3 = left (a–d).
    const E = [() => edge(ix, iz, ix + 1, iz), () => edge(ix + 1, iz, ix + 1, iz + 1), () => edge(ix, iz + 1, ix + 1, iz + 1), () => edge(ix, iz, ix, iz + 1)];
    const pairs: Record<number, [number, number][]> = {
      1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 5: [[3, 0], [1, 2]], 6: [[0, 2]], 7: [[3, 2]],
      8: [[2, 3]], 9: [[0, 2]], 10: [[0, 1], [2, 3]], 11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[0, 3]],
    };
    for (const [p, q] of pairs[k]) { E[p](); E[q](); }
  }
  return new Float32Array(out);
}
