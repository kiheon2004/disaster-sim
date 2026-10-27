import * as THREE from 'three';
import { seededRandom } from '@/core/math';

/** Procedural voxel-style textures (no external assets). */
const cache = new Map<string, THREE.Texture>();

function pixelTexture(key: string, size: number, paint: (ctx: CanvasRenderingContext2D, rnd: () => number) => void) {
  const hit = cache.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  paint(ctx, seededRandom(size * 7919 + key.length));
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  cache.set(key, tex);
  return tex;
}

export function grassTexture(): THREE.Texture {
  return pixelTexture('grass', 16, (ctx, rnd) => {
    const palette = ['#5f8f43', '#6a9a4a', '#578a3d', '#72a352', '#5a8540', '#66944a'];
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        ctx.fillStyle = palette[Math.floor(rnd() * palette.length)];
        ctx.fillRect(x, y, 1, 1);
      }
  });
}

export function asphaltTexture(): THREE.Texture {
  return pixelTexture('asphalt', 16, (ctx, rnd) => {
    const palette = ['#3a3f45', '#41464c', '#363b40', '#3e4349'];
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        ctx.fillStyle = palette[Math.floor(rnd() * palette.length)];
        ctx.fillRect(x, y, 1, 1);
      }
  });
}
