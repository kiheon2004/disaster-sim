import { forwardRef, useCallback, useEffect, useRef, type ComponentProps } from 'react';
import { TransformControls } from '@react-three/drei';
import { beginGesture, type Gesture } from './input/gesture';

type DreiProps = ComponentProps<typeof TransformControls>;
type Props = Omit<DreiProps, 'onMouseDown' | 'onMouseUp'> & {
  /** Gesture owner name (devtools / tests). */
  owner?: string;
  /** A handle was grabbed: the drag starts (one gesture, owned camera lock). */
  onDragStart?: () => void;
  /**
   * The drag ended. `commit` = keep the result (pointer released, window left); false = Esc,
   * pointercancel or unmount — restore the state from `onDragStart`.
   */
  onDragEnd?: (commit: boolean) => void;
};
interface Controls {
  dispose: () => void;
  dragging: boolean;
  axis: string | null;
  addEventListener: (type: string, fn: () => void) => void;
  removeEventListener: (type: string, fn: () => void) => void;
}

/**
 * drei's TransformControls, disposed on unmount (Phase 17 memory fix).
 *
 * drei mounts the three-stdlib controls as an R3F `<primitive>`, and R3F never disposes
 * primitives. The controls register `pointerdown` / `pointermove` on the event target and
 * `pointerup` on the document when they are created and only remove them in `dispose()`, so
 * every gizmo mount stayed reachable from the document — with its ~80 handle meshes, their
 * geometries and materials (≈ 330 KB of retained heap per selection change, see
 * scripts/bench-selection-memory.mjs). Disposing removes the listeners and frees the gizmo.
 *
 * Phase 36: every drag is a gesture (input/gesture.ts) with an OWNED camera lock — Esc and
 * pointercancel cancel it, blur commits it, and an unmount mid-drag cancels it and always releases
 * the lock (before, the camera stayed disabled and `editorStore.dragging` stayed true, so viewport
 * clicks stopped selecting).
 */
export const ManagedTransformControls = forwardRef<unknown, Props>(function ManagedTransformControls(props, ref) {
  const { owner = 'gizmo', onDragStart, onDragEnd, ...rest } = props;
  const instance = useRef<Controls | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const handlers = useRef({ onDragStart, onDragEnd, owner });
  handlers.current = { onDragStart, onDragEnd, owner };

  // Listeners on the controls instance (drei's onMouseDown / onMouseUp props are not used).
  const listeners = useRef({
    down: () => {
      const c = instance.current;
      gesture.current = beginGesture(handlers.current.owner, {
        end: (commit, reason) => {
          gesture.current = null;
          // Not a pointer release: stop the controls' own drag so later moves do nothing.
          if (reason !== 'up' && c) { c.dragging = false; c.axis = null; }
          handlers.current.onDragEnd?.(commit);
        },
      }, { lockCamera: true });
      handlers.current.onDragStart?.();
    },
    up: () => gesture.current?.finish(true, 'up'),
  });

  const setRef = useCallback(
    (c: Controls | null) => {
      if (c && instance.current !== c) {
        // drei made a new instance (camera / dom element changed): free the previous one.
        if (instance.current) {
          instance.current.removeEventListener('mouseDown', listeners.current.down);
          instance.current.removeEventListener('mouseUp', listeners.current.up);
          instance.current.dispose();
        }
        instance.current = c;
        c.addEventListener('mouseDown', listeners.current.down);
        c.addEventListener('mouseUp', listeners.current.up);
      }
      if (typeof ref === 'function') ref(c);
      else if (ref) (ref as { current: unknown }).current = c;
    },
    [ref],
  );
  // The controls instance lives as long as the camera / dom element (drei memo) — in practice the
  // lifetime of this component. Cancel a drag in progress, then dispose the last instance seen.
  // Disposal is deferred by one task and cancelled by a remount: React StrictMode (dev) runs this
  // cleanup once right after mounting and mounts again with the SAME controls instance — disposing
  // it there removed its pointer listeners, so in `npm run dev` no gizmo handle could be grabbed
  // (Phase 17–35.5; found by the Phase 36 Chrome checks — production builds were not affected).
  const pendingDispose = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (pendingDispose.current) clearTimeout(pendingDispose.current);
    pendingDispose.current = null;
    return () => {
      gesture.current?.finish(false, 'abort');
      pendingDispose.current = setTimeout(() => {
        pendingDispose.current = null;
        const c = instance.current;
        if (c) {
          c.removeEventListener('mouseDown', listeners.current.down);
          c.removeEventListener('mouseUp', listeners.current.up);
          c.dispose();
        }
        instance.current = null;
      }, 0);
    };
  }, []);
  return <TransformControls {...(rest as DreiProps)} ref={setRef as never} />;
});
