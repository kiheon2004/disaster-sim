import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { EntityId } from '@/core/types';
import type { WorldObject } from '@/core/model';
import { getDefinition } from '@/objects/registry';
import { useWorldStore } from '@/world/worldStore';
import { boxSelect } from '@/app/buildActions';
import { useEditorStore } from './editorStore';
import { beginGesture, type Gesture } from './input/gesture';

const v = new THREE.Vector3();

/**
 * Ids of the objects whose center (half height) projects inside the screen rectangle
 * (normalized device coordinates, any corner order). Objects behind the camera are skipped.
 */
export function objectsInRect(objs: Iterable<WorldObject>, camera: THREE.Camera, a: [number, number], b: [number, number]): EntityId[] {
  const x0 = Math.min(a[0], b[0]);
  const x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const y1 = Math.max(a[1], b[1]);
  const out: EntityId[] = [];
  camera.updateMatrixWorld();
  for (const o of objs) {
    // Phase 36: locked and hidden objects are not picked up by a box (select them in the outliner).
    if (o.locked || o.hidden) continue;
    const d = getDefinition(o.type).getDimensions(o.params);
    const p = o.transform.position;
    v.set(p[0], p[1] + (d[1] * o.transform.scale[1]) / 2, p[2]).project(camera);
    if (v.z > 1 || v.z < -1) continue;
    if (v.x >= x0 && v.x <= x1 && v.y >= y0 && v.y <= y1) out.push(o.id);
  }
  return out;
}

/**
 * Shift + left-drag in the Select tool draws a selection box (instead of panning the camera);
 * releasing adds the objects inside it to the selection (with Ctrl/⌘ also held: removes them). A Shift-click without dragging is an
 * ordinary click (toggles the object under the cursor). Phase 36: the box is a gesture — Esc /
 * pointercancel drop it without selecting, the camera lock is owned and always released.
 */
export function MarqueeSelect() {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);

  useEffect(() => {
    const el = gl.domElement;
    const host = el.parentElement ?? el;
    const box = document.createElement('div');
    box.dataset.testid = 'marquee';
    Object.assign(box.style, {
      position: 'absolute', border: '1px solid #4f8cff', background: 'rgba(79,140,255,0.12)', pointerEvents: 'none', display: 'none', zIndex: '5',
    });
    host.appendChild(box);
    let gesture: Gesture | null = null;

    const rel = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || !e.shiftKey) return;
      const start = rel(e);
      // Shift+drag adds the boxed objects; Shift+Ctrl/⌘+drag removes them (Phase 36).
      const subtract = e.ctrlKey || e.metaKey;
      let dragging = false;
      let last = start;
      // OrbitControls would pan with Shift+left-drag: hand the gesture to the selection box.
      gesture = beginGesture('marquee', {
        move: (ev) => {
          const p = rel(ev);
          last = p;
          if (!dragging && Math.hypot(p.x - start.x, p.y - start.y) < 5) return;
          dragging = true;
          Object.assign(box.style, {
            display: 'block',
            left: `${el.offsetLeft + Math.min(p.x, start.x)}px`,
            top: `${el.offsetTop + Math.min(p.y, start.y)}px`,
            width: `${Math.abs(p.x - start.x)}px`,
            height: `${Math.abs(p.y - start.y)}px`,
          });
        },
        end: (commit) => {
          gesture = null;
          box.style.display = 'none';
          if (!dragging) return;
          // The click that ends the drag must not clear / toggle the selection (also after Esc).
          useEditorStore.getState().setDragging(true);
          setTimeout(() => useEditorStore.getState().setDragging(false), 0);
          if (!commit) return;
          const p = last;
          const ndc = (x: number, y: number): [number, number] => [(x / p.w) * 2 - 1, -(y / p.h) * 2 + 1];
          const ids = objectsInRect(Object.values(useWorldStore.getState().doc.objects), camera, ndc(start.x, start.y), ndc(p.x, p.y));
          boxSelect(ids, subtract ? 'subtract' : 'add');
        },
      }, { lockCamera: true });
    };
    el.addEventListener('pointerdown', down, true);
    return () => {
      el.removeEventListener('pointerdown', down, true);
      gesture?.finish(false, 'abort');
      box.remove();
    };
  }, [gl, camera]);
  return null;
}
