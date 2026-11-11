/**
 * Camera lock registry (Phase 36). The orbit camera is disabled while ANY owner holds a lock and
 * enabled again only when the last one releases — so one tool can never re-enable the camera
 * under another tool's drag (before Phase 36 six places wrote `controls.enabled` directly and the
 * last writer won; a gizmo unmounted mid-drag left the camera off for good).
 *
 * `attachCameraLock` replaces the controls' `enabled` data property by an accessor: reading it
 * gives "no owner holds a lock", writing it is ignored. The only remaining direct writer is drei's
 * TransformControls (`dragging-changed` → `defaultControls.enabled = !dragging`); its gizmos take
 * an owned lock through ManagedTransformControls instead, so ignoring that write loses nothing.
 */
interface Lockable { enabled: boolean }

const owners = new Set<string>();
let attached: Lockable | null = null;
let ignoredWrites = 0;

export function lockCamera(owner: string): void {
  owners.add(owner);
}

export function unlockCamera(owner: string): void {
  owners.delete(owner);
}

export function cameraLocked(): boolean {
  return owners.size > 0;
}

/** Current lock owners (devtools / tests). */
export function cameraLockOwners(): string[] {
  return [...owners];
}

/** Writes to `controls.enabled` that were ignored (devtools / tests). */
export function cameraLockIgnoredWrites(): number {
  return ignoredWrites;
}

/** Drop every lock (editor ⇄ simulation switch, document replaced): no gesture survives those. */
export function releaseAllCameraLocks(): void {
  owners.clear();
}

/** Route the controls' `enabled` flag through the registry. Returns the detach function. */
export function attachCameraLock(controls: Lockable | null): () => void {
  if (!controls) return () => {};
  if (attached && attached !== controls) detach(attached);
  attached = controls;
  Object.defineProperty(controls, 'enabled', {
    configurable: true,
    enumerable: true,
    get: () => owners.size === 0,
    set: () => { ignoredWrites++; },
  });
  return () => detach(controls);
}

function detach(c: Lockable): void {
  if (attached !== c) return;
  attached = null;
  delete (c as { enabled?: boolean }).enabled;
  c.enabled = true;
}
