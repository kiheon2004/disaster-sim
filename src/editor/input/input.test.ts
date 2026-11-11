/**
 * Phase 36 input ownership: owned camera locks, the shared gesture lifecycle (release / blur commit,
 * Esc / pointercancel / abort cancel), object transactions (one undo step, none when nothing changed,
 * cancel restores), terrain stroke cancel, per-store strokes, the input policy (one owner, one
 * selection focus) and layout-independent shortcut keys.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';

// Minimal DOM: the gesture module listens on window / document (vitest runs in node).
class FakeDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';
  querySelector() { return null; }
}
const fakeWindow = new EventTarget();
const fakeDocument = new FakeDocument();
beforeAll(() => {
  (globalThis as { window?: unknown }).window ??= fakeWindow;
  (globalThis as { document?: unknown }).document ??= fakeDocument;
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame ??= (f: () => void) => setTimeout(f, 0);
});

const win = () => globalThis.window as unknown as EventTarget;
const doc = () => globalThis.document as unknown as FakeDocument;
function pointer(type: string, init: { buttons?: number; pointerType?: string } = {}): Event {
  const e = new Event(type) as Event & { buttons: number; pointerType: string };
  e.buttons = init.buttons ?? 1;
  e.pointerType = init.pointerType ?? 'mouse';
  return e;
}
function key(k: string, code = ''): KeyboardEvent {
  const e = new Event('keydown', { cancelable: true }) as unknown as KeyboardEvent & { key: string; code: string };
  Object.defineProperty(e, 'key', { value: k });
  Object.defineProperty(e, 'code', { value: code });
  return e;
}

import { attachCameraLock, cameraLocked, cameraLockOwners, lockCamera, releaseAllCameraLocks, unlockCamera } from './cameraLock';
import { abortGestures, activeGesture, beginGesture } from './gesture';
import { isTyping, keyOf, opensCommandBar, isImeKey } from './keys';

afterEach(() => {
  abortGestures();
  releaseAllCameraLocks();
});

describe('camera lock registry', () => {
  it('stays locked until the LAST owner releases; direct writes are ignored', () => {
    const controls = { enabled: true };
    const detach = attachCameraLock(controls);
    expect(controls.enabled).toBe(true);
    lockCamera('a');
    lockCamera('b');
    expect(controls.enabled).toBe(false);
    unlockCamera('a'); // the other owner's lock is untouched
    expect(controls.enabled).toBe(false);
    controls.enabled = true; // drei's dragging-changed write: ignored
    expect(controls.enabled).toBe(false);
    unlockCamera('b');
    expect(controls.enabled).toBe(true);
    controls.enabled = false;
    expect(controls.enabled).toBe(true);
    detach();
    expect(Object.getOwnPropertyDescriptor(controls, 'enabled')?.value).toBe(true);
  });
});

describe('gesture lifecycle', () => {
  it('pointerup commits and releases its own camera lock', () => {
    const ends: [boolean, string][] = [];
    beginGesture('t', { end: (c, r) => ends.push([c, r]) }, { lockCamera: true });
    expect(cameraLocked()).toBe(true);
    expect(activeGesture()).toBe('t');
    win().dispatchEvent(pointer('pointerup'));
    expect(ends).toEqual([[true, 'up']]);
    expect(cameraLocked()).toBe(false);
    expect(activeGesture()).toBe(null);
    win().dispatchEvent(pointer('pointerup')); // ended exactly once
    expect(ends.length).toBe(1);
  });

  it('Esc cancels and goes no further; pointercancel cancels; blur and hidden commit', () => {
    const ends: [boolean, string][] = [];
    let later = 0;
    const laterListener = () => later++;
    beginGesture('esc', { end: (c, r) => ends.push([c, r]) });
    // (Node's EventTarget has no capture / bubble phases — listeners run in registration order. In a
    // browser the gesture's window-capture listener runs before every bubble listener, e.g. the hotkeys.)
    win().addEventListener('keydown', laterListener);
    const e = key('Escape');
    win().dispatchEvent(e);
    expect(ends.pop()).toEqual([false, 'escape']);
    expect(later).toBe(0);
    expect(e.defaultPrevented).toBe(true);
    win().removeEventListener('keydown', laterListener);

    beginGesture('c', { end: (c, r) => ends.push([c, r]) });
    win().dispatchEvent(pointer('pointercancel'));
    expect(ends.pop()).toEqual([false, 'cancel']);

    beginGesture('b', { end: (c, r) => ends.push([c, r]) });
    win().dispatchEvent(new Event('blur'));
    expect(ends.pop()).toEqual([true, 'blur']);

    beginGesture('h', { end: (c, r) => ends.push([c, r]) });
    doc().visibilityState = 'hidden';
    doc().dispatchEvent(new Event('visibilitychange'));
    doc().visibilityState = 'visible';
    expect(ends.pop()).toEqual([true, 'hidden']);
  });

  it('a mouse move with no button pressed ends the drag (release missed); moves are forwarded', () => {
    const ends: boolean[] = [];
    let moves = 0;
    beginGesture('m', { move: () => moves++, end: (c) => ends.push(c) });
    win().dispatchEvent(pointer('pointermove', { buttons: 1 }));
    expect(moves).toBe(1);
    win().dispatchEvent(pointer('pointermove', { buttons: 0 }));
    expect(ends).toEqual([true]);
    expect(moves).toBe(1);
  });

  it('only one gesture at a time: a new one cancels the old; abortGestures cancels', () => {
    const ends: string[] = [];
    beginGesture('one', { end: (c) => ends.push(`one:${c}`) }, { lockCamera: true });
    beginGesture('two', { end: (c) => ends.push(`two:${c}`) }, { lockCamera: true });
    expect(ends).toEqual(['one:false']);
    expect(cameraLockOwners().length).toBe(1);
    abortGestures();
    expect(ends).toEqual(['one:false', 'two:false']);
    expect(cameraLocked()).toBe(false);
  });
});

describe('shortcut keys', () => {
  it('letters and brackets come from the physical key', () => {
    expect(keyOf(key('ㅔ', 'KeyP'))).toBe('p'); // Korean IME, Hangul mode
    expect(keyOf(key('Process', 'KeyZ'))).toBe('z');
    expect(keyOf(key('{', 'BracketLeft'))).toBe('['); // Shift+[
    expect(keyOf(key('}', 'BracketRight'))).toBe(']');
    expect(keyOf(key('Escape', 'Escape'))).toBe('escape');
    expect(keyOf(key('Delete', 'Delete'))).toBe('delete');
  });

  // Phase 37 (§14): the command bar's keys.
  it('the slash key is read from the physical key too', () => {
    expect(keyOf(key('/', 'Slash'))).toBe('/');
    expect(keyOf(key('?', 'Slash'))).toBe('/'); // Shift+/
    expect(keyOf(key('Process', 'Slash'))).toBe('/');
  });

  it('/ (no modifier) and Ctrl / ⌘ + K open the command bar — nothing else does', () => {
    const mods = (k: string, code: string, m: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean }) => Object.assign(key(k, code), m);
    expect(opensCommandBar(key('/', 'Slash'))).toBe(true);
    expect(opensCommandBar(mods('k', 'KeyK', { ctrlKey: true }))).toBe(true);
    expect(opensCommandBar(mods('k', 'KeyK', { metaKey: true }))).toBe(true);
    // Hangul mode: the K key types ㅏ, the physical key is still K.
    expect(opensCommandBar(mods('ㅏ', 'KeyK', { metaKey: true }))).toBe(true);
    expect(opensCommandBar(key('k', 'KeyK'))).toBe(false);
    expect(opensCommandBar(mods('?', 'Slash', { shiftKey: true }))).toBe(false);
    expect(opensCommandBar(mods('/', 'Slash', { ctrlKey: true }))).toBe(false);
    expect(opensCommandBar(mods('/', 'Slash', { altKey: true }))).toBe(false);
    expect(opensCommandBar(mods('k', 'KeyK', { ctrlKey: true, shiftKey: true }))).toBe(false);
    // The numeric pad's divide key types '/' but is not the Slash key.
    expect(opensCommandBar(key('/', 'NumpadDivide'))).toBe(false);
    expect(opensCommandBar(key('Enter', 'Enter'))).toBe(false);
  });
});

// Phase 37 (audit U9): one rule for "the key belongs to the field it comes from".
describe('typing or shortcut', () => {
  const from = (el: { tagName: string; type?: string; isContentEditable?: boolean } | null, k: string, code: string): KeyboardEvent => {
    const e = key(k, code);
    Object.defineProperty(e, 'target', { value: el });
    return e;
  };
  const input = (type?: string) => ({ tagName: 'INPUT', ...(type !== undefined ? { type } : {}) });

  it('text fields, text areas, selects and editable elements take every key', () => {
    for (const el of [input('text'), input('number'), input('search'), input(), { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }]) {
      for (const [k, code] of [['/', 'Slash'], ['v', 'KeyV'], ['Escape', 'Escape'], ['Delete', 'Delete'], [' ', 'Space'], ['ArrowUp', 'ArrowUp']]) expect(isTyping(from(el, k, code)), `${el.tagName} ${k}`).toBe(true);
    }
  });

  it('a slider, a checkbox, a radio button, a colour and a button input take only their own keys', () => {
    for (const type of ['range', 'checkbox', 'radio', 'color', 'button', 'submit']) {
      for (const [k, code] of [['/', 'Slash'], ['v', 'KeyV'], ['Escape', 'Escape'], ['Delete', 'Delete'], ['k', 'KeyK'], ['w', 'KeyW']]) expect(isTyping(from(input(type), k, code)), `${type} ${k}`).toBe(false);
    }
    // A slider keeps its arrows (they move it) …
    expect(isTyping(from(input('range'), 'ArrowLeft', 'ArrowLeft'))).toBe(true);
    expect(isTyping(from(input('range'), 'Home', 'Home'))).toBe(true);
    expect(isTyping(from(input('range'), ' ', 'Space'))).toBe(false);
    // … a checkbox its Space (it toggles it), a button input Space and Enter.
    expect(isTyping(from(input('checkbox'), ' ', 'Space'))).toBe(true);
    expect(isTyping(from(input('radio'), ' ', 'Space'))).toBe(true);
    expect(isTyping(from(input('checkbox'), 'ArrowLeft', 'ArrowLeft'))).toBe(false);
    expect(isTyping(from(input('checkbox'), 'Enter', 'Enter'))).toBe(false);
    expect(isTyping(from(input('button'), 'Enter', 'Enter'))).toBe(true);
    expect(isTyping(from(input('color'), ' ', 'Space'))).toBe(true);
    expect(isTyping(from(input('RANGE'), 'v', 'KeyV'))).toBe(false);
  });

  it('other elements (the canvas, buttons, the page) are never typing', () => {
    for (const el of [{ tagName: 'CANVAS' }, { tagName: 'BUTTON' }, { tagName: 'BODY' }, { tagName: 'DIV' }, null]) expect(isTyping(from(el, 'v', 'KeyV'))).toBe(false);
  });
});

import { useWorldStore, scratchWorld } from '@/world/worldStore';
import { createEmptyDocument } from '@/world/WorldDocument';
import { identityTransform } from '@/core/types';

describe('object transactions', () => {
  beforeEach(() => useWorldStore.getState().replaceDocument(createEmptyDocument()));

  it('a drag is one undo step; a drag without change records nothing; cancel restores', () => {
    const w = () => useWorldStore.getState();
    const id = w().addObject({ type: 'wall', transform: identityTransform() });
    const steps = w().past.length;
    w().beginTransaction();
    w().commitTransaction();
    expect(w().past.length).toBe(steps); // click without movement: no empty step

    w().beginTransaction();
    for (let i = 1; i <= 5; i++) w().updateTransform(id, { position: [i, 0, 0] }, { history: false });
    expect(w().commitTransaction()).toBe(true);
    expect(w().past.length).toBe(steps + 1);
    w().undo();
    expect(w().doc.objects[id].transform.position).toEqual([0, 0, 0]);
    w().redo();
    expect(w().doc.objects[id].transform.position).toEqual([5, 0, 0]);

    const before = w().past.length;
    w().beginTransaction();
    w().updateTransform(id, { position: [9, 0, 9] }, { history: false });
    w().undo(); // refused mid-gesture
    expect(w().doc.objects[id].transform.position).toEqual([9, 0, 9]);
    w().cancelTransaction();
    expect(w().doc.objects[id].transform.position).toEqual([5, 0, 0]);
    expect(w().past.length).toBe(before);
  });

  it('replacing the document drops an open transaction', () => {
    const w = () => useWorldStore.getState();
    w().beginTransaction();
    expect(w().busy()).toBe(true);
    w().replaceDocument(createEmptyDocument());
    expect(w().busy()).toBe(false);
    expect(w().commitTransaction()).toBe(false);
  });
});

describe('terrain strokes', () => {
  beforeEach(() => useWorldStore.getState().replaceDocument(createEmptyDocument()));

  it('cancel restores the ground and records nothing', () => {
    const w = () => useWorldStore.getState();
    const before = w().doc.terrain.heights.slice();
    const steps = w().past.length;
    w().beginTerrainStroke();
    w().terrainDab({ op: 'raise', x: 0, z: 0, brush: { radius: 6, strength: 1 }, dt: 0.05 });
    expect(w().doc.terrain.heights.some((h, i) => h !== before[i])).toBe(true);
    const r = w().cancelTerrainStroke();
    expect(r).not.toBe(null);
    expect(w().doc.terrain.heights.every((h, i) => h === before[i])).toBe(true);
    expect(w().past.length).toBe(steps);
    expect(w().busy()).toBe(false);
  });

  it('a scratch store (template build) no longer clears the app store open stroke', () => {
    const w = () => useWorldStore.getState();
    const steps = w().past.length;
    w().beginTerrainStroke();
    w().terrainDab({ op: 'raise', x: 10, z: 10, brush: { radius: 5, strength: 1 }, dt: 0.05 });
    scratchWorld(createEmptyDocument()).getState().newDocument();
    expect(w().busy()).toBe(true);
    w().endTerrainStroke();
    expect(w().past.length).toBe(steps + 1);
  });
});

describe('group heading past 90°', () => {
  it('the heading of a 120° / 180° turn is read from the whole rotation', async () => {
    const { yawOf } = await import('@/terrain/groundPlacement');
    for (const deg of [120, 180, -135, 45]) {
      const o = new THREE.Object3D();
      o.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (deg * Math.PI) / 180);
      o.rotation.setFromQuaternion(o.quaternion);
      const yaw = (yawOf([o.rotation.x, o.rotation.y, o.rotation.z]) * 180) / Math.PI;
      const d = ((yaw - deg + 540) % 360) - 180;
      expect(Math.abs(d)).toBeLessThan(1e-6);
    }
  });
});

import { installInputPolicy } from '@/app/inputPolicy';
import { useEditorStore } from '@/editor/editorStore';
import { usePlacementStore } from '@/ui/placement/placementStore';
import { useUiStore } from '@/ui/uiStore';

describe('input policy', () => {
  let uninstall: () => void = () => {};
  beforeEach(() => {
    useWorldStore.getState().replaceDocument(createEmptyDocument());
    useEditorStore.getState().setMode('editor');
    usePlacementStore.getState().disarm();
    usePlacementStore.getState().select(null);
    uninstall = installInputPolicy();
  });
  afterEach(() => uninstall());

  it('arming disaster placement leaves the editor tool; arming an editor tool disarms placement', () => {
    useEditorStore.getState().setRoadEdit(true);
    expect(useEditorStore.getState().tool).toBe('road');
    usePlacementStore.getState().arm('blast', { event: 'blast' } as never);
    expect(useEditorStore.getState().tool).toBe('select');
    useEditorStore.getState().setTerrainTool('raise');
    expect(usePlacementStore.getState().type).toBe(null);
  });

  it('one selection focus: objects drop the pin, the pin drops the objects', () => {
    const id = useWorldStore.getState().addObject({ type: 'wall', transform: identityTransform() });
    usePlacementStore.getState().select('p1');
    useEditorStore.getState().select(id);
    expect(usePlacementStore.getState().selected).toBe(null);
    usePlacementStore.getState().select('p1');
    expect(useEditorStore.getState().selectedIds).toEqual([]);
  });

  it('closing the right panel disarms placement; a mode switch ends gestures and locks', () => {
    useUiStore.getState().setRightOpen(true);
    usePlacementStore.getState().arm('blast', { event: 'blast' } as never);
    useUiStore.getState().setRightOpen(false);
    expect(usePlacementStore.getState().type).toBe(null);
    useUiStore.getState().setRightOpen(true);

    let ended: boolean | null = null;
    beginGesture('drag', { end: (c) => (ended = c) }, { lockCamera: true });
    useEditorStore.getState().setDragging(true);
    useEditorStore.getState().setMode('simulation');
    expect(ended).toBe(false);
    expect(cameraLocked()).toBe(false);
    expect(useEditorStore.getState().dragging).toBe(false);
    useEditorStore.getState().setMode('editor');
  });

  it('selected ids that no longer exist are pruned (undo of an add)', () => {
    const w = () => useWorldStore.getState();
    const ids = w().addObjects([{ type: 'wall', transform: identityTransform() }, { type: 'wall', transform: { ...identityTransform(), position: [3, 0, 0] } }]);
    useEditorStore.getState().setSelection(ids);
    w().undo();
    expect(useEditorStore.getState().selectedIds).toEqual([]);
  });
});

describe('gizmo frame and axis lock (§11)', () => {
  it('Q-style toggle and X / Y / Z lock live in the editor store; a mode change clears the lock', () => {
    const ed = () => useEditorStore.getState();
    ed().setTransformSpace('local');
    ed().setAxisLock('x');
    expect([ed().transformSpace, ed().axisLock]).toEqual(['local', 'x']);
    ed().setTransformMode('rotate');
    expect(ed().axisLock).toBe(null);
    ed().setTransformSpace('world');
  });
});

describe('IME composition (Phase 37): Enter inside a composition is not the field\'s "done" key', () => {
  it('isImeKey: isComposing or key code 229, on a DOM event or a React event', () => {
    expect(isImeKey({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeKey({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeKey({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeKey({})).toBe(false);
    // React's synthetic event carries the DOM event as nativeEvent (its own isComposing does not exist).
    expect(isImeKey({ nativeEvent: { isComposing: true, keyCode: 13 } })).toBe(true);
    expect(isImeKey({ nativeEvent: { isComposing: false, keyCode: 229 } })).toBe(true);
    expect(isImeKey({ nativeEvent: { isComposing: false, keyCode: 13 } })).toBe(false);
  });

  it('every text field outside the command bar that acts on Enter asks it first', () => {
    // Source check: an onKeyDown that tests for Enter in these files also calls isImeKey (the bar has its own tested rule).
    const files = ['ui/ObjectPalette/Outliner.tsx', 'ui/Inspector/ObjectInspector.tsx', 'ui/Blueprints/BlueprintDialogs.tsx', 'ui/Phenomena/DisasterLibrary.tsx', 'ui/common/fields.tsx'];
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(resolve(__dirname, '../..', f), 'utf8');
      text.split('\n').forEach((line, k) => {
        if (/onKeyDown=/.test(line) && /e\.key === 'Enter'/.test(line) && !/isImeKey\(e\)/.test(line) && !/e\.key === ' '/.test(line)) offenders.push(`${f}:${k + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

