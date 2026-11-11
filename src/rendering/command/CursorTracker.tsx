/**
 * Phase 37 — "here" for commands (audit U4): the ground point under the pointer, written to the command session
 * (`cursor`, x / z rounded to 0.1 m). Mounted with the editor and the simulation scene.
 *
 *  - One look-up per frame at most, and a store write only when the rounded point changed (a write per pointermove
 *    would re-render every subscriber of the session).
 *  - The last point is KEPT when the pointer leaves the canvas (the user moves to the command bar to type "here"), when
 *    the pointer is over the sky and when it is over ground outside the map.
 *  - Nothing is written while a button is down (camera drag, a tool's gesture); the point is looked up again when the
 *    button is released, and when the camera moves under a still pointer (wheel zoom, damping).
 *
 * UI state only: nothing here reaches the document or a simulation.
 */
import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useCommandSession } from '@/ui/Command/commandSession';
import { liveGround, liveMapHalf } from '../terrain/liveGround';
import { groundPoint, ndcOf, newPointerState, samePoint, shouldSample } from './pointMath';

export function CursorTracker() {
  const gl = useThree((s) => s.gl);
  const pointer = useRef(newPointerState());
  const ray = useRef(new THREE.Raycaster());
  const seen = useRef(new THREE.Matrix4());
  const ndc = useRef(new THREE.Vector2());

  useEffect(() => {
    const el = gl.domElement;
    const s = pointer.current;
    const note = (ev: PointerEvent) => {
      s.x = ev.clientX;
      s.y = ev.clientY;
      s.inside = true;
      s.held = ev.buttons !== 0;
      s.dirty = true;
    };
    const leave = () => {
      s.inside = false;
      s.held = false;
      s.dirty = false;
    };
    el.addEventListener('pointermove', note);
    el.addEventListener('pointerdown', note);
    el.addEventListener('pointerup', note);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('pointercancel', leave);
    return () => {
      el.removeEventListener('pointermove', note);
      el.removeEventListener('pointerdown', note);
      el.removeEventListener('pointerup', note);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('pointercancel', leave);
    };
  }, [gl]);

  useFrame(({ camera }) => {
    const s = pointer.current;
    const moved = !seen.current.equals(camera.matrixWorld);
    if (!shouldSample(s, moved)) return;
    s.dirty = false;
    seen.current.copy(camera.matrixWorld);
    const at = ndcOf(s.x, s.y, gl.domElement.getBoundingClientRect());
    if (!at) return;
    ray.current.setFromCamera(ndc.current.set(at[0], at[1]), camera);
    const o = ray.current.ray.origin, d = ray.current.ray.direction;
    const p = groundPoint(liveGround(), [o.x, o.y, o.z], [d.x, d.y, d.z], liveMapHalf());
    const session = useCommandSession.getState();
    if (p && !samePoint(p, session.cursor)) session.setCursor(p);
  });

  return null;
}
