/**
 * Phase 37: the terrain preview mesh moved out of the terrain tool into a shared file. The tool's picture must be the
 * same as before the move (positions and vertex colours, both modes); the command preview's mode shows heights AND paint.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createFlatTerrain } from '@/terrain/TerrainData';
import { previewDab } from '@/terrain/TerrainEditor';
import { EDIT_FULL_SCALE, HeightPreviewMesh, type HeightPreview, type PreviewGround } from './HeightPreviewMesh';

/**
 * The tool's `PreviewMesh.show` exactly as it was in editor/tools/TerrainTool.tsx at Phase 36 (d5b5896, lines 94–122),
 * written out as arrays — the reference the shared class is compared with.
 */
function phase36Show(p: HeightPreview, t: PreviewGround, paintColor: THREE.Color | null) {
  const w = p.rect.x1 - p.rect.x0 + 1, h = p.rect.z1 - p.rect.z0 + 1, n = w * h;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 4);
  const scale = Math.max(p.up, -p.down, 1e-6);
  for (let k = 0; k < n; k++) {
    const ix = p.rect.x0 + (k % w), iz = p.rect.z0 + Math.floor(k / w);
    const d = p.dh[k];
    pos.set([t.originX + ix * t.cellSize, t.heights[iz * t.nx + ix] + Math.max(0, d) + 0.06, t.originZ + iz * t.cellSize], 3 * k);
    if (paintColor) col.set([paintColor.r, paintColor.g, paintColor.b, p.painted[k] ? 0.55 : 0], 4 * k);
    else if (d > 0) col.set([1, 0.55, 0.2, 0.18 + 0.6 * (d / scale)], 4 * k);
    else if (d < 0) col.set([0.25, 0.6, 1, 0.18 + 0.6 * (-d / scale)], 4 * k);
    else col.set([0, 0, 0, 0], 4 * k);
  }
  return { pos, col };
}

const arrays = (m: HeightPreviewMesh) => ({
  pos: (m.mesh.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array,
  col: (m.mesh.geometry.attributes.color as THREE.BufferAttribute).array as Float32Array,
});

function bumpy() {
  const t = createFlatTerrain();
  for (let i = 0; i < t.heights.length; i++) t.heights[i] = Math.sin(i * 0.37) * 2 + Math.cos(i * 0.011) * 3;
  return t;
}

const brush = { radius: 6, strength: 0.6 };

describe('HeightPreviewMesh — the terrain tool sees what it saw before the move', () => {
  it('raise / lower / flatten / smooth: same vertices, same colours as the Phase 36 mesh', () => {
    const t = bumpy();
    const mesh = new HeightPreviewMesh();
    for (const op of ['raise', 'lower', 'flatten', 'smooth'] as const) {
      const p = previewDab(t, { op, x: 12.3, z: -20.7, dt: 1, brush, targetHeight: 1.5 })!;
      expect(p).not.toBeNull();
      mesh.show(p, t, null);
      const ref = phase36Show(p, t, null);
      const got = arrays(mesh);
      expect(got.pos.length).toBe(ref.pos.length);
      expect(Array.from(got.pos)).toEqual(Array.from(ref.pos));
      expect(Array.from(got.col)).toEqual(Array.from(ref.col));
      expect(mesh.mesh.visible).toBe(true);
    }
    // (the ops above really moved something: the comparison was not of two empty pictures)
    const p = previewDab(t, { op: 'raise', x: 12.3, z: -20.7, dt: 1, brush })!;
    expect(p.up).toBeGreaterThan(0);
    mesh.dispose();
  });

  it('paint: the painted vertices in the paint colour, the others clear but in the same colour (the edge fades in it)', () => {
    const t = bumpy();
    const mesh = new HeightPreviewMesh();
    const p = previewDab(t, { op: 'paint', x: -30, z: 14, dt: 1, brush, groundType: 3 })!;
    expect(Array.from(p.painted).some((v) => v === 1)).toBe(true);
    const color = new THREE.Color('#8a6f4d');
    mesh.show(p, t, color);
    const ref = phase36Show(p, t, color);
    expect(Array.from(arrays(mesh).pos)).toEqual(Array.from(ref.pos));
    expect(Array.from(arrays(mesh).col)).toEqual(Array.from(ref.col));
    mesh.dispose();
  });

  it('keeps the same mesh object, material settings and index layout (drawn over the ground, never picked)', () => {
    const t = bumpy();
    const mesh = new HeightPreviewMesh();
    const m = mesh.mesh.material as THREE.MeshBasicMaterial;
    expect([m.vertexColors, m.transparent, m.depthTest, m.depthWrite, m.side]).toEqual([true, true, false, false, THREE.DoubleSide]);
    expect([mesh.mesh.renderOrder, mesh.mesh.frustumCulled, mesh.mesh.visible]).toEqual([9, false, false]);
    const p = previewDab(t, { op: 'raise', x: 0, z: 0, dt: 1, brush })!;
    mesh.show(p, t, null);
    const w = p.rect.x1 - p.rect.x0 + 1, h = p.rect.z1 - p.rect.z0 + 1;
    expect(mesh.mesh.geometry.index!.count).toBe((w - 1) * (h - 1) * 6);
    expect(Array.from(mesh.mesh.geometry.index!.array.slice(0, 6))).toEqual([0, w, 1, 1, w, w + 1]);
    // A second preview of the same size reuses the buffers; another size makes new ones.
    const posBefore = mesh.mesh.geometry.attributes.position;
    mesh.show(previewDab(t, { op: 'lower', x: 0, z: 0, dt: 1, brush })!, t, null);
    expect(mesh.mesh.geometry.attributes.position).toBe(posBefore);
    mesh.show(previewDab(t, { op: 'lower', x: 0, z: 0, dt: 1, brush: { radius: 3, strength: 0.6 } })!, t, null);
    expect(mesh.mesh.geometry.attributes.position).not.toBe(posBefore);
    mesh.hide();
    expect(mesh.mesh.visible).toBe(false);
    mesh.dispose();
  });
});

describe('HeightPreviewMesh.showEdit — a command: heights and paint together', () => {
  it('height colours where the ground moves, the paint colour where only the ground type changes, clear elsewhere', () => {
    const t = createFlatTerrain();
    const rect = { x0: 10, z0: 20, x1: 12, z1: 21 }; // 3 × 2 vertices
    const p: HeightPreview = { rect, dh: new Float32Array([0.5, 0, -1, 0, 0, 2]), painted: new Uint8Array([1, 1, 0, 0, 0, 0]), up: 2, down: -1 };
    const mesh = new HeightPreviewMesh();
    const paint = new THREE.Color(0.2, 0.4, 0.6);
    mesh.showEdit(p, t, (k) => (k < 3 ? paint : null));
    const { pos, col } = arrays(mesh);
    const rgba = (k: number) => Array.from(col.slice(4 * k, 4 * k + 4)).map((v) => Math.round(v * 1000) / 1000);
    expect(rgba(0)).toEqual([1, 0.55, 0.2, 0.33]); // raised 0.5 of 2 (and painted: the height wins)
    expect(rgba(1)).toEqual([0.2, 0.4, 0.6, 0.55]); // painted only
    expect(rgba(2)).toEqual([0.25, 0.6, 1, 0.48]); // lowered 1 of 2
    expect(rgba(3)).toEqual([0, 0, 0, 0]);
    expect(rgba(5)).toEqual([1, 0.55, 0.2, 0.78]);
    // Raised vertices are lifted by the raise (the sheet lies on the NEW ground there), lowered ones stay on the old.
    expect(pos[1]).toBeCloseTo(0.5 + 0.06, 5);
    expect(pos[3 * 2 + 1]).toBeCloseTo(0.06, 5);
    expect(pos[0]).toBe(t.originX + 10 * t.cellSize);
    expect(pos[3 * 5 + 2]).toBe(t.originZ + 21 * t.cellSize);
    mesh.dispose();
  });

  it('a slight change is a faint tint: the colour is full at the edit\'s largest change, but not below 0.5 m (the tool\'s own preview keeps its scale)', () => {
    const t = createFlatTerrain();
    const rect = { x0: 0, z0: 0, x1: 1, z1: 1 };
    // A road bed graded by 8 cm up / 7 cm down.
    const p: HeightPreview = { rect, dh: new Float32Array([0.08, -0.07, 0, 0]), painted: new Uint8Array(4), up: 0.08, down: -0.07 };
    const mesh = new HeightPreviewMesh();
    mesh.showEdit(p, t, () => null);
    const edit = Array.from(arrays(mesh).col);
    expect(EDIT_FULL_SCALE).toBe(0.5);
    expect(edit[3]).toBeCloseTo(0.18 + 0.6 * (0.08 / 0.5), 5);
    expect(edit[7]).toBeCloseTo(0.18 + 0.6 * (0.07 / 0.5), 5);
    mesh.show(p, t, null);
    const tool = Array.from(arrays(mesh).col);
    expect(tool[3]).toBeCloseTo(0.78, 5); // the brush preview: full at its own largest change, as in Phase 36
    mesh.dispose();
  });
});
