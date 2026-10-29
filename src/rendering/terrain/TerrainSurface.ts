/**
 * TerrainRenderer core (no React): TerrainData → Three.js meshes.
 *
 *  - surface: one indexed grid mesh, same vertices and the same cell diagonal as the physics
 *    heightfield, vertex colors per view mode, smooth normals from the height grid;
 *  - skirt: walls from the terrain edge down/up to the y = 0 surroundings (diorama edge);
 *  - outline: the world boundary drawn along the terrain edge.
 *
 * While sculpting only the dirty rectangle is rewritten (positions, normals, colors); the
 * simulation never reads anything from here.
 */
import * as THREE from 'three';
import type { TerrainData } from '@/core/model';
import type { GridRect } from '@/terrain/TerrainData';
import { GROUND_MATERIALS } from '@/terrain/GroundMaterials';
import { soilProfile } from '@/terrain/SoilProfiles';
import { terrainStats } from '@/terrain/terrainStats';

export type TerrainViewMode = 'surface' | 'elevation' | 'ground' | 'soil';

const tmpColor = new THREE.Color();
const groundColors = GROUND_MATERIALS.map((g) => new THREE.Color(g.color));
const soilColors = Array.from({ length: 4 }, (_, i) => new THREE.Color(soilProfile(i).color));

/** Low → high: shore green, grass, olive, ochre, brown, rock, snow-ish. */
const ELEVATION_STOPS: [number, string][] = [
  [-10, '#2f5f8a'],
  [-0.5, '#6fa6c9'],
  [0, '#7dbf72'],
  [5, '#b7cf6b'],
  [12, '#d9b45a'],
  [22, '#b0773f'],
  [35, '#8a7d73'],
  [55, '#f2efe9'],
];
const elevationColors = ELEVATION_STOPS.map(([h, c]) => [h, new THREE.Color(c)] as const);

export function elevationColor(h: number, out: THREE.Color): THREE.Color {
  const s = elevationColors;
  if (h <= s[0][0]) return out.copy(s[0][1]);
  for (let i = 1; i < s.length; i++) {
    if (h <= s[i][0]) return out.copy(s[i - 1][1]).lerp(s[i][1], (h - s[i - 1][0]) / (s[i][0] - s[i - 1][0]));
  }
  return out.copy(s[s.length - 1][1]);
}

/** Stable per-vertex brightness jitter so large areas read like the pixel textures. */
function jitter(ix: number, iz: number): number {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return 0.93 + (((h ^ (h >>> 16)) >>> 0) / 4294967296) * 0.1;
}

export class TerrainSurface {
  readonly geometry = new THREE.BufferGeometry();
  readonly skirt = new THREE.BufferGeometry();
  readonly outline = new THREE.BufferGeometry();
  private positions: Float32Array;
  private normals: Float32Array;
  private colors: Float32Array;

  constructor(private t: TerrainData, private mode: TerrainViewMode) {
    const { nx, nz, cellSize: cs, originX, originZ } = t;
    const n = nx * nz;
    this.positions = new Float32Array(n * 3);
    this.normals = new Float32Array(n * 3);
    this.colors = new Float32Array(n * 3);
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const i = (iz * nx + ix) * 3;
        this.positions[i] = originX + ix * cs;
        this.positions[i + 2] = originZ + iz * cs;
      }
    }
    // Two triangles per cell split along the (x1,z0)–(x0,z1) diagonal (= Rapier heightfield),
    // wound counter-clockwise seen from above.
    const index = new Uint32Array((nx - 1) * (nz - 1) * 6);
    let k = 0;
    for (let iz = 0; iz < nz - 1; iz++) {
      for (let ix = 0; ix < nx - 1; ix++) {
        const a = iz * nx + ix;
        const b = a + 1;
        const c = a + nx;
        const d = c + 1;
        index[k++] = a; index[k++] = c; index[k++] = b;
        index[k++] = b; index[k++] = c; index[k++] = d;
      }
    }
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(this.normals, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.update(null);
  }

  setMode(mode: TerrainViewMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.writeColors({ x0: 0, z0: 0, x1: this.t.nx - 1, z1: this.t.nz - 1 });
    (this.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Rewrite a region (null = everything) after the data changed. */
  update(rect: GridRect | null) {
    const t0 = performance.now();
    const { nx, nz } = this.t;
    const r = rect ?? { x0: 0, z0: 0, x1: nx - 1, z1: nz - 1 };
    const h = this.t.heights;
    for (let iz = r.z0; iz <= r.z1; iz++) for (let ix = r.x0; ix <= r.x1; ix++) this.positions[(iz * nx + ix) * 3 + 1] = h[iz * nx + ix];
    // Normals depend on neighbours: widen by one vertex.
    const nr = { x0: Math.max(0, r.x0 - 1), z0: Math.max(0, r.z0 - 1), x1: Math.min(nx - 1, r.x1 + 1), z1: Math.min(nz - 1, r.z1 + 1) };
    this.writeNormals(nr);
    this.writeColors(nr);
    const g = this.geometry.attributes;
    for (const attr of [g.position, g.normal, g.color] as THREE.BufferAttribute[]) {
      // Upload only the rows of the changed region (one contiguous range) — Phase 19.
      attr.clearUpdateRanges();
      if (rect) attr.addUpdateRange(nr.z0 * nx * 3, (nr.z1 - nr.z0 + 1) * nx * 3);
      attr.needsUpdate = true;
    }
    if (!rect) this.finish();
    terrainStats.meshUpdates++;
    terrainStats.meshMs += performance.now() - t0;
  }

  /** Bounds, skirt and outline (once per finished edit, not per dab). */
  finish() {
    this.geometry.computeBoundingSphere();
    this.geometry.computeBoundingBox();
    this.buildSkirt();
  }

  private writeNormals(r: GridRect) {
    const { nx, nz, cellSize: cs, heights: h } = this.t;
    const at = (ix: number, iz: number) => h[Math.min(nz - 1, Math.max(0, iz)) * nx + Math.min(nx - 1, Math.max(0, ix))];
    for (let iz = r.z0; iz <= r.z1; iz++) {
      for (let ix = r.x0; ix <= r.x1; ix++) {
        const dx = (at(ix + 1, iz) - at(ix - 1, iz)) / (2 * cs);
        const dz = (at(ix, iz + 1) - at(ix, iz - 1)) / (2 * cs);
        const inv = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
        const i = (iz * nx + ix) * 3;
        this.normals[i] = -dx * inv;
        this.normals[i + 1] = inv;
        this.normals[i + 2] = -dz * inv;
      }
    }
  }

  private writeColors(r: GridRect) {
    const { nx, heights: h, ground } = this.t;
    const c = this.colors;
    for (let iz = r.z0; iz <= r.z1; iz++) {
      for (let ix = r.x0; ix <= r.x1; ix++) {
        const v = iz * nx + ix;
        const i = v * 3;
        if (this.mode === 'elevation') {
          elevationColor(h[v], tmpColor);
        } else if (this.mode === 'soil') {
          tmpColor.copy(soilColors[this.t.soil[v]] ?? soilColors[1]);
        } else {
          tmpColor.copy(groundColors[ground[v]] ?? groundColors[0]);
          if (this.mode === 'surface') {
            // Steep ground reads darker / earthier; plus a stable speckle.
            const ny = this.normals[i + 1];
            const k = jitter(ix, iz) * (0.78 + 0.22 * ny * ny);
            tmpColor.multiplyScalar(k);
          }
        }
        c[i] = tmpColor.r;
        c[i + 1] = tmpColor.g;
        c[i + 2] = tmpColor.b;
      }
    }
  }

  private buildSkirt() {
    const { nx, nz, heights: h } = this.t;
    const edge: [number, number][] = [];
    for (let ix = 0; ix < nx; ix++) edge.push([ix, 0]);
    for (let iz = 1; iz < nz; iz++) edge.push([nx - 1, iz]);
    for (let ix = nx - 2; ix >= 0; ix--) edge.push([ix, nz - 1]);
    for (let iz = nz - 2; iz >= 0; iz--) edge.push([0, iz]);
    const pos = this.positions;
    const wall: number[] = [];
    const line: number[] = [];
    for (let k = 0; k < edge.length; k++) {
      const [ax, az] = edge[k];
      const [bx, bz] = edge[(k + 1) % edge.length];
      const a = (az * nx + ax) * 3;
      const b = (bz * nx + bx) * 3;
      const ha = h[az * nx + ax];
      const hb = h[bz * nx + bx];
      line.push(pos[a], ha + 0.03, pos[a + 2]);
      if (ha === 0 && hb === 0) continue;
      // Quad between the edge and the y = 0 surroundings (double-sided material).
      wall.push(pos[a], ha, pos[a + 2], pos[b], hb, pos[b + 2], pos[a], 0, pos[a + 2]);
      wall.push(pos[b], hb, pos[b + 2], pos[b], 0, pos[b + 2], pos[a], 0, pos[a + 2]);
    }
    this.skirt.setAttribute('position', new THREE.Float32BufferAttribute(wall, 3));
    this.skirt.computeVertexNormals();
    this.skirt.computeBoundingSphere();
    line.push(line[0], line[1], line[2]);
    this.outline.setAttribute('position', new THREE.Float32BufferAttribute(line, 3));
    this.outline.computeBoundingSphere();
  }

  dispose() {
    this.geometry.dispose();
    this.skirt.dispose();
    this.outline.dispose();
  }
}

/**
 * Terrain material: vertex colors + optional elevation contour lines and editor grid lines,
 * drawn in the fragment shader from the world position (no extra geometry).
 */
export function createTerrainMaterial() {
  const uniforms = { uContours: { value: 0 }, uGrid: { value: 0 } };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTerrainPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTerrainPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTerrainPos;\nuniform float uContours;\nuniform float uGrid;\n' +
        'float tLine(float v, float w) { float d = abs(fract(v - 0.5) - 0.5) / fwidth(v); return 1.0 - min(d / w, 1.0); }')
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (uContours > 0.5) {
          float minor = tLine(vTerrainPos.y, 0.8);
          float major = tLine(vTerrainPos.y / 5.0, 1.2);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.55, max(minor * 0.45, major));
        }
        if (uGrid > 0.5) {
          float g1 = max(tLine(vTerrainPos.x, 0.6), tLine(vTerrainPos.z, 0.6));
          float g10 = max(tLine(vTerrainPos.x / 10.0, 1.0), tLine(vTerrainPos.z / 10.0, 1.0));
          diffuseColor.rgb *= 1.0 - 0.10 * g1 - 0.22 * g10;
        }`);
  };
  return { material: mat, uniforms };
}
