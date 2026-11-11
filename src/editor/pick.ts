/**
 * Viewport picking shared by the editor scene and the multi-selection proxy (Phase 36 §10).
 *
 * `hitIds` lists the objects under the cursor, nearest first — React-drawn entities by their node name (`entity:<id>`),
 * batched objects through the batch layer's picker, the objects of a multi-selection through its proxy adapter — so a
 * click can cycle through overlapping objects and an object already in a multi-selection can be clicked again (before,
 * the proxy ignored rays and the click fell through to the ground, clearing the selection).
 */
import type * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { EntityId } from '@/core/types';

type Picker = (o: THREE.Object3D, id: number | undefined) => EntityId | null;

let batchPicker: Picker = () => null;
let groupPicker: Picker = () => null;

export function setBatchPicker(p: Picker | null): void {
  batchPicker = p ?? (() => null);
}

export function setGroupPicker(p: Picker | null): void {
  groupPicker = p ?? (() => null);
}

export function hitIds(e: ThreeEvent<MouseEvent>): EntityId[] {
  const out: EntityId[] = [];
  for (const i of e.intersections) {
    let id: EntityId | null = null;
    for (let o: THREE.Object3D | null = i.object; o && !id; o = o.parent) if (o.name.startsWith('entity:')) id = o.name.slice(7);
    const inst = (i as { batchId?: number }).batchId ?? i.instanceId;
    if (!id) id = batchPicker(i.object, inst) ?? groupPicker(i.object, inst);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

export const clickMods = (e: ThreeEvent<MouseEvent>) => ({ shift: e.nativeEvent.shiftKey, alt: e.nativeEvent.altKey, toggle: e.nativeEvent.ctrlKey || e.nativeEvent.metaKey });
export const clickScreen = (e: ThreeEvent<MouseEvent>): [number, number] => [e.nativeEvent.clientX, e.nativeEvent.clientY];
