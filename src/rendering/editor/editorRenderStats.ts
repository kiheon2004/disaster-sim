import type { EditorBatches } from './EditorBatches';

/** The mounted edit-mode batches (perf HUD, benchmarks). */
let active: EditorBatches | null = null;

export function setEditorBatches(b: EditorBatches | null) {
  active = b;
}

export function getEditorBatches(): EditorBatches | null {
  return active;
}
