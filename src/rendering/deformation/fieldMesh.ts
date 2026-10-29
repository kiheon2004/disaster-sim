/**
 * A grid patch draped on a terrain over a vertex rectangle, colored per vertex (Phase 21
 * deformation preview / heatmap). Same vertices and cell diagonal as the terrain mesh, lifted
 * a few centimetres so it does not z-fight; render-only.
 */
import * as THREE from 'three';
import type { TerrainData } from '@/core/model';
import type { GridRect } from '@/terrain/TerrainData';

export class FieldPatch {
  readonly geometry = new THREE.BufferGeometry();
  private pos: Float32Array;
  private col: Float32Array;
  readonly w: number;
  readonly h: number;

  constructor(readonly t: TerrainData, readonly rect: GridRect) {
    const w = (this.w = rect.x1 - rect.x0 + 1), h = (this.h = rect.z1 - rect.z0 + 1);
    this.pos = new Float32Array(w * h * 3);
    this.col = new Float32Array(w * h * 4);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const k = (j * w + i) * 3;
      this.pos[k] = t.originX + (rect.x0 + i) * t.cellSize;
      this.pos[k + 2] = t.originZ + (rect.z0 + j) * t.cellSize;
    }
    const idx = new Uint32Array(Math.max(0, (w - 1) * (h - 1) * 6));
    let n = 0;
    for (let j = 0; j < h - 1; j++) for (let i = 0; i < w - 1; i++) {
      const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
      idx[n++] = a; idx[n++] = c; idx[n++] = b;
      idx[n++] = b; idx[n++] = c; idx[n++] = d;
    }
    this.geometry.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
  }

  /**
   * Heights = base(vertex) + lift; color = color(vertex index in rect, global vertex index), which
   * returns the vertex opacity (RGBA vertex colors: untouched ground stays clear).
   * `base` reads a heights array of the full grid (current ground, original ground, …).
   */
  write(base: ArrayLike<number>, lift: number, color: (local: number, global: number, out: THREE.Color) => number, offset?: (local: number) => number) {
    const { w, h, rect, t } = this;
    const c = new THREE.Color();
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const l = j * w + i, g = (rect.z0 + j) * t.nx + rect.x0 + i;
      this.pos[l * 3 + 1] = base[g] + lift + (offset ? offset(l) : 0);
      const a = color(l, g, c);
      this.col[l * 4] = c.r; this.col[l * 4 + 1] = c.g; this.col[l * 4 + 2] = c.b; this.col[l * 4 + 3] = a;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
    this.geometry.computeBoundingSphere();
  }

  dispose() {
    this.geometry.dispose();
  }
}
