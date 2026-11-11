/**
 * Pointer gestures (Phase 36): ONE drag-style interaction at a time — a gizmo drag, a pin drag,
 * a brush stroke, a handle drag, a marquee — with the same end rules everywhere:
 *
 *   pointerup, a move with no button pressed     → end, commit   ('up')
 *   window blur, the page hidden (tab switch)    → end, commit   ('blur' / 'hidden')
 *   Esc                                          → end, CANCEL   ('escape') — the key goes no further
 *   pointercancel                                → end, CANCEL   ('cancel')
 *   abortGestures() (mode switch, unmount,
 *   simulation start, document replaced)         → end, CANCEL   ('abort')
 *
 * "Commit" keeps what the drag did (as one undo step — the owner's transaction), "cancel" puts the
 * state from before the drag back. Before Phase 36 every tool chose its own subset of these rules
 * (terrain committed on Esc, the forest brush discarded, gizmos and pins ignored Esc and blur, no
 * tool handled pointercancel) and an unmount mid-drag could leave the camera locked.
 *
 * The camera lock of a gesture is owned (cameraLock.ts) and always released when it ends.
 */
import { lockCamera, unlockCamera } from './cameraLock';

export type GestureEnd = 'up' | 'blur' | 'hidden' | 'escape' | 'cancel' | 'abort';

export interface GestureHandlers {
  /** Pointer moves while the gesture is active (window, any target). */
  move?: (e: PointerEvent) => void;
  /** Called exactly once. `commit` = keep the result; false = restore the state before the gesture. */
  end: (commit: boolean, reason: GestureEnd) => void;
}

export interface GestureOptions {
  /** Hold an owned camera lock for the gesture's lifetime (left-drag edits instead of orbiting). */
  lockCamera?: boolean;
}

export interface Gesture {
  readonly owner: string;
  readonly active: boolean;
  /** End the gesture from its owner (e.g. its own pointerup handler). Idempotent. */
  finish: (commit: boolean, reason?: GestureEnd) => void;
}

const COMMITS: Record<GestureEnd, boolean> = { up: true, blur: true, hidden: true, escape: false, cancel: false, abort: false };

// An options object, not `true`: some EventTarget implementations (Node's) do not match a boolean on removal.
const CAPTURE = { capture: true } as const;

let current: (Gesture & { _end: (commit: boolean, reason: GestureEnd) => void }) | null = null;
let seq = 0;

/** Owner of the gesture in progress, or null. */
export function activeGesture(): string | null {
  return current?.owner ?? null;
}

/** End the gesture in progress with `reason` (default 'abort' = cancel). */
export function abortGestures(reason: GestureEnd = 'abort'): void {
  current?._end(COMMITS[reason], reason);
}

/**
 * Start a gesture. A gesture still in progress is aborted first (cancelled): two gestures never
 * run at once.
 */
export function beginGesture(owner: string, h: GestureHandlers, opts: GestureOptions = {}): Gesture {
  abortGestures('abort');
  const lockId = `gesture:${owner}#${++seq}`;
  let active = true;
  const onUp = () => end(true, 'up');
  const onMove = (e: PointerEvent) => {
    // A release outside every listener (e.g. over a native dialog) leaves no pointerup: a mouse
    // move with no button pressed ends the drag there.
    if (e.pointerType === 'mouse' && e.buttons === 0) { end(true, 'up'); return; }
    h.move?.(e);
  };
  const onCancel = () => end(false, 'cancel');
  const onBlur = () => end(true, 'blur');
  const onVisibility = () => { if (document.visibilityState === 'hidden') end(true, 'hidden'); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    // Esc cancels the drag and nothing else (not also "clear selection" / "leave the tool").
    e.preventDefault();
    e.stopImmediatePropagation();
    end(false, 'escape');
  };
  const end = (commit: boolean, reason: GestureEnd) => {
    if (!active) return;
    active = false;
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('keydown', onKey, CAPTURE);
    if (opts.lockCamera) unlockCamera(lockId);
    if (current === g) current = null;
    h.end(commit, reason);
  };
  const g = {
    owner,
    get active() { return active; },
    finish: (commit: boolean, reason?: GestureEnd) => end(commit, reason ?? (commit ? 'up' : 'abort')),
    _end: end,
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('keydown', onKey, CAPTURE);
  }
  if (opts.lockCamera) lockCamera(lockId);
  current = g;
  return g;
}
