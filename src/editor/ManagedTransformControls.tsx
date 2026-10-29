import { forwardRef, useCallback, useEffect, useRef, type ComponentProps } from 'react';
import { TransformControls } from '@react-three/drei';

type Props = ComponentProps<typeof TransformControls>;
interface Disposable { dispose: () => void }

/**
 * drei's TransformControls, disposed on unmount (Phase 17 memory fix).
 *
 * drei mounts the three-stdlib controls as an R3F `<primitive>`, and R3F never disposes
 * primitives. The controls register `pointerdown` / `pointermove` on the event target and
 * `pointerup` on the document when they are created and only remove them in `dispose()`, so
 * every gizmo mount stayed reachable from the document — with its ~80 handle meshes, their
 * geometries and materials (≈ 330 KB of retained heap per selection change, see
 * scripts/bench-selection-memory.mjs). Disposing removes the listeners and frees the gizmo.
 */
export const ManagedTransformControls = forwardRef<unknown, Props>(function ManagedTransformControls(props, ref) {
  const instance = useRef<Disposable | null>(null);
  const setRef = useCallback(
    (c: Disposable | null) => {
      if (c) {
        // drei made a new instance (camera / dom element changed): free the previous one.
        if (instance.current && instance.current !== c) instance.current.dispose();
        instance.current = c;
      }
      if (typeof ref === 'function') ref(c);
      else if (ref) (ref as { current: unknown }).current = c;
    },
    [ref],
  );
  // The controls instance lives as long as the camera / dom element (drei memo) — in practice the
  // lifetime of this component. Dispose the last one seen when unmounting.
  useEffect(() => () => {
    instance.current?.dispose();
    instance.current = null;
  }, []);
  return <TransformControls {...props} ref={setRef as never} />;
});
