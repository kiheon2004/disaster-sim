/**
 * Palette previews (Phase 16): each preset rendered once with the same voxel part builders the
 * world uses (SimRenderAdapter), into a small image. One offscreen renderer draws every
 * thumbnail and is released afterwards, so no extra WebGL context stays alive.
 */
import * as THREE from 'three';
import type { PaletteItem } from '@/objects/palette';
import { getDefinition } from '@/objects/registry';
import { createWorldObject } from '@/world/WorldDocument';
import { SimRenderAdapter } from '@/rendering/sim/SimRenderAdapter';
import { staticRuntime } from '@/rendering/editor/EditorBatches';
import { flatSampler } from '@/terrain/TerrainSampler';
import { itemDesign } from '@/editor/build/itemDesign';

const SIZE = 96;
const cache = new Map<string, string>();
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function thumbnail(id: string): string | undefined {
  return cache.get(id);
}

export function subscribeThumbnails(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** A road preset: dark slab with lane marks (roads are not part of the batches). */
function roadObject(item: PaletteItem): THREE.Object3D {
  const def = getDefinition('road');
  const p = { ...def.defaultParams, ...(item.params ?? {}) };
  const len = Math.min(16, Number(p.length) || 16);
  const w = Number(p.width) || 8;
  const g = new THREE.Group();
  const slab = new THREE.Mesh(new THREE.BoxGeometry(len, 0.2, w), new THREE.MeshStandardMaterial({ color: '#3b3f45', flatShading: true }));
  g.add(slab);
  for (let x = -len / 2 + 1; x < len / 2; x += 3) {
    const mark = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.22, 0.2), new THREE.MeshBasicMaterial({ color: '#e8e2c9' }));
    mark.position.set(x + 0.75, 0.01, 0);
    g.add(mark);
  }
  return g;
}

/** Render every preset (once); resolves when all thumbnails exist. Safe to call repeatedly. */
export function renderThumbnails(items: readonly PaletteItem[]): Promise<void> {
  if (pending) return pending;
  const todo = items.filter((i) => !cache.has(i.id));
  if (!todo.length || typeof document === 'undefined') return Promise.resolve();
  pending = new Promise<void>((resolve) => {
    // Let the main canvas initialize first.
    setTimeout(() => {
      let renderer: THREE.WebGLRenderer | null = null;
      try {
        const canvas = document.createElement('canvas');
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
        renderer.setPixelRatio(1);
        renderer.setSize(SIZE, SIZE, false);
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        const scene = new THREE.Scene();
        scene.add(new THREE.HemisphereLight('#dfe9ff', '#3a3326', 1.6));
        const sun = new THREE.DirectionalLight('#ffffff', 2.2);
        sun.position.set(5, 9, 6);
        scene.add(sun);
        const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 500);
        for (const item of todo) {
          const def = getDefinition(item.type);
          const params = { ...def.defaultParams, ...(item.params ?? {}) };
          let content: THREE.Object3D;
          let adapter: SimRenderAdapter | null = null;
          if (item.type === 'road') content = roadObject(item);
          else {
            const obj = createWorldObject({ type: item.type, params, seed: 7, building: itemDesign(item), transform: { position: [0, 0, 0], rotation: [0, -0.6, 0], scale: [1, 1, 1] } }, 0);
            adapter = new SimRenderAdapter(staticRuntime([obj]), flatSampler());
            adapter.update(camera, 0, 0);
            content = adapter.root;
          }
          scene.add(content);
          const box = new THREE.Box3().setFromObject(content);
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());
          const r = Math.max(size.x, size.y, size.z) * 0.5 + 0.2;
          const dist = r / Math.sin((camera.fov * Math.PI) / 360) * 0.95;
          camera.position.set(center.x + dist * 0.62, center.y + dist * 0.5, center.z + dist * 0.62);
          camera.lookAt(center);
          renderer.render(scene, camera);
          cache.set(item.id, canvas.toDataURL('image/png'));
          scene.remove(content);
          adapter?.dispose();
        }
      } catch (err) {
        console.warn('palette thumbnails unavailable', err);
      } finally {
        renderer?.dispose();
        renderer?.forceContextLoss();
        pending = null;
        for (const l of listeners) l();
        resolve();
      }
    }, 300);
  });
  return pending;
}
