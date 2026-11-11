/**
 * Draped preview of a terrain change (Phase 36 §22, shared since Phase 37): one vertex per terrain vertex of the
 * changed rectangle, coloured by the predicted height change (warm = raise, cool = lower, stronger = more), or by a
 * paint colour where the ground type would change. Alpha 0 where nothing changes.
 *
 * Used by the terrain tool (what 1 s of the brush would do under the cursor) and by the command preview (what a
 * terrain / paint command would change — `DocDiff.terrain`). The document is never touched.
 */
import * as THREE from 'three';
import type { GridRect } from '@/terrain/TerrainData';

/** A predicted change over a vertex rectangle of the full grid (row-major per vertex). */
export interface HeightPreview {
  rect: GridRect;
  /** Height change (m) per vertex of `rect`. */
  dh: ArrayLike<number>;
  /** 1 where the ground / soil type would change. */
  painted: ArrayLike<number>;
  /** Largest raise (m, ≥ 0) and largest lowering (m, ≤ 0 — the sign `previewDab` reports it with). */
  up: number;
  down: number;
}

/** The terrain the preview is draped on (the ground as it is NOW: heights before the change). */
export interface PreviewGround {
  nx: number;
  cellSize: number;
  originX: number;
  originZ: number;
  heights: Float32Array;
}

/** Smallest height change (m) an edit's preview draws at full strength (`showEdit`). */
export const EDIT_FULL_SCALE = 0.5;

/** Paint colour at a vertex of the rectangle (shown where `painted` is set), or null where no paint applies. */
export type PaintColorOf = (k: number) => THREE.Color | null;

export class HeightPreviewMesh {
  readonly mesh: THREE.Mesh;
  private size = { w: 0, h: 0 };
  constructor() {
    const g = new THREE.BufferGeometry();
    const m = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.renderOrder = 9;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.raycast = () => {};
  }

  /**
   * The terrain tool's preview of one brush: with a paint colour, the vertices the brush would paint in that colour
   * (heights are not coloured — a paint brush does not move the ground); without, the height change.
   */
  show(p: HeightPreview, t: PreviewGround, paintColor: THREE.Color | null) {
    this.fill(p, t, paintColor ? () => paintColor : null, !paintColor, 1e-6);
  }

  /**
   * A whole edit (several strokes of a command): the height change where the ground moves, and the paint colour of a
   * vertex (`paintOf`) where only its ground type changes. The colour is full at the largest change of the edit, but
   * never below `EDIT_FULL_SCALE`: the few centimetres a new road grades its bed by are a faint tint, not a full one.
   */
  showEdit(p: HeightPreview, t: PreviewGround, paintOf: PaintColorOf) {
    this.fill(p, t, paintOf, true, EDIT_FULL_SCALE);
  }

  private fill(p: HeightPreview, t: PreviewGround, paintOf: PaintColorOf | null, heights: boolean, floor: number) {
    const w = p.rect.x1 - p.rect.x0 + 1, h = p.rect.z1 - p.rect.z0 + 1, n = w * h;
    const g = this.mesh.geometry;
    if (w !== this.size.w || h !== this.size.h) {
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
      const idx: number[] = [];
      for (let z = 0; z < h - 1; z++) for (let x = 0; x < w - 1; x++) {
        const a = z * w + x;
        idx.push(a, a + w, a + 1, a + 1, a + w, a + w + 1);
      }
      g.setIndex(idx);
      this.size = { w, h };
    }
    const pos = g.attributes.position as THREE.BufferAttribute, col = g.attributes.color as THREE.BufferAttribute;
    const scale = Math.max(p.up, -p.down, floor);
    for (let k = 0; k < n; k++) {
      const ix = p.rect.x0 + (k % w), iz = p.rect.z0 + Math.floor(k / w);
      const d = p.dh[k];
      pos.setXYZ(k, t.originX + ix * t.cellSize, t.heights[iz * t.nx + ix] + Math.max(0, d) + 0.06, t.originZ + iz * t.cellSize);
      // (an unpainted vertex keeps the paint colour at alpha 0: the edge of a painted patch fades in its own colour)
      const paint = paintOf ? paintOf(k) : null;
      if (heights && d > 0) col.setXYZW(k, 1, 0.55, 0.2, 0.18 + 0.6 * (d / scale));
      else if (heights && d < 0) col.setXYZW(k, 0.25, 0.6, 1, 0.18 + 0.6 * (-d / scale));
      else if (paint) col.setXYZW(k, paint.r, paint.g, paint.b, p.painted[k] ? 0.55 : 0);
      else col.setXYZW(k, 0, 0, 0, 0);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.mesh.visible = true;
  }

  hide() {
    this.mesh.visible = false;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
