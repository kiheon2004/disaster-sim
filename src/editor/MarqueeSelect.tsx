import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { EntityId } from '@/core/types';
import type { WorldObject } from '@/core/model';
import { getDefinition } from '@/objects/registry';
import { useWorldStore } from '@/world/worldStore';
import { boxSelect } from '@/app/buildActions';
import { useEditorStore } from './editorStore';

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
 * releasing adds the objects inside it to the selection. A Shift-click without dragging is an
 * ordinary click (toggles the object under the cursor).
 */
export function MarqueeSelect() {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as { enabled: boolean } | null;

  useEffect(() => {
    const el = gl.domElement;
    const host = el.parentElement ?? el;
    const box = document.createElement('div');
    box.dataset.testid = 'marquee';
    Object.assign(box.style, {
      position: 'absolute', border: '1px solid #4f8cff', background: 'rgba(79,140,255,0.12)', pointerEvents: 'none', display: 'none', zIndex: '5',
    });
    host.appendChild(box);
    let start: { x: number; y: number } | null = null;
    let dragging = false;

    const rel = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || !e.shiftKey) return;
      start = rel(e);
      dragging = false;
      // OrbitControls would pan with Shift+left-drag: hand the gesture to the selection box.
      if (controls) controls.enabled = false;
    };
    const move = (e: PointerEvent) => {
      if (!start) return;
      const p = rel(e);
      if (!dragging && Math.hypot(p.x - start.x, p.y - start.y) < 5) return;
      dragging = true;
      Object.assign(box.style, {
        display: 'block',
        left: `${el.offsetLeft + Math.min(p.x, start.x)}px`,
        top: `${el.offsetTop + Math.min(p.y, start.y)}px`,
        width: `${Math.abs(p.x - start.x)}px`,
        height: `${Math.abs(p.y - start.y)}px`,
      });
    };
    const up = (e: PointerEvent) => {
      if (!start) return;
      const s = start;
      start = null;
      box.style.display = 'none';
      if (controls) controls.enabled = true;
      if (!dragging) return;
      const p = rel(e);
      const ndc = (x: number, y: number): [number, number] => [(x / p.w) * 2 - 1, -(y / p.h) * 2 + 1];
      const ids = objectsInRect(Object.values(useWorldStore.getState().doc.objects), camera, ndc(s.x, s.y), ndc(p.x, p.y));
      boxSelect(ids, true);
      // Swallow the click that ends the drag (it must not clear / toggle the selection).
      useEditorStore.getState().setDragging(true);
      setTimeout(() => useEditorStore.getState().setDragging(false), 0);
    };
    el.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      el.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      box.remove();
      if (controls) controls.enabled = true;
    };
  }, [gl, camera, controls]);
  return null;
}
