/**
 * Road draping (render only). Roads stay infrastructure objects — inert, with their own params
 * and lane markings — and on relief their surface follows the terrain instead of being a rigid
 * slab. The geometry is built in the road's local frame from terrain samples under it.
 */
import * as THREE from 'three';
import type { Transform } from '@/core/types';
import { ROAD_THICKNESS, type RoadParams } from '@/objects/definitions/road';
import type { TerrainSampler } from '@/terrain/TerrainSampler';
import { yawOf } from '@/terrain/groundPlacement';
import type { BoxPart } from '../parts/objectParts';

const STEP = 1; // m between drape samples (= terrain cell size)

function frame(transform: Transform, terrain: TerrainSampler) {
  const [px, py, pz] = transform.position;
  const [sx, sy, sz] = transform.scale;
  const yaw = yawOf(transform.rotation);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  /** Local y (unscaled) that puts a local (lx, lz) point `lift` meters above the ground. */
  return (lx: number, lz: number, lift: number) => {
    const wx = px + lx * sx * c + lz * sz * s;
    const wz = pz - lx * sx * s + lz * sz * c;
    return (terrain.sampleHeight(wx, wz) - py + lift) / sy;
  };
}

function divisions(len: number) {
  return Math.max(1, Math.ceil(len / STEP));
}

/** Textured asphalt surface draped on the terrain (0–1 uv, same texture repeat as the flat box). */
export function drapedRoadSurface(p: RoadParams, transform: Transform, terrain: TerrainSampler): THREE.BufferGeometry {
  const yAt = frame(transform, terrain);
  const nx = divisions(p.length);
  const nz = divisions(p.width);
  const pos: number[] = [];
  const uv: number[] = [];
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const lx = -p.length / 2 + (p.length * i) / nx;
      const lz = -p.width / 2 + (p.width * j) / nz;
      pos.push(lx, yAt(lx, lz, ROAD_THICKNESS), lz);
      uv.push(i / nx, j / nz);
    }
  }
  const index: number[] = [];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + nx + 1;
      const d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setIndex(index);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/** Lane markings (flat boxes) as draped strips with vertex colors. */
export function drapedRoadLines(parts: BoxPart[], transform: Transform, terrain: TerrainSampler): THREE.BufferGeometry {
  const yAt = frame(transform, terrain);
  const pos: number[] = [];
  const col: number[] = [];
  const color = new THREE.Color();
  const lift = ROAD_THICKNESS + 0.012;
  for (const part of parts) {
    color.set(part.color);
    const [len, , wid] = part.size;
    const [cx, , cz] = part.position ?? [0, 0, 0];
    const n = divisions(len);
    const z0 = cz - wid / 2;
    const z1 = cz + wid / 2;
    for (let i = 0; i < n; i++) {
      const xa = cx - len / 2 + (len * i) / n;
      const xb = cx - len / 2 + (len * (i + 1)) / n;
      const a0 = [xa, yAt(xa, z0, lift), z0];
      const a1 = [xa, yAt(xa, z1, lift), z1];
      const b0 = [xb, yAt(xb, z0, lift), z0];
      const b1 = [xb, yAt(xb, z1, lift), z1];
      pos.push(...a0, ...a1, ...b0, ...b0, ...a1, ...b1);
      for (let k = 0; k < 6; k++) col.push(color.r, color.g, color.b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}
