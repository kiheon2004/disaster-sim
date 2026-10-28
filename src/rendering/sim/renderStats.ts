import type { SimRenderAdapter } from './SimRenderAdapter';

/** The adapter currently on screen (read by the dev performance HUD). */
let active: SimRenderAdapter | null = null;

export function setActiveAdapter(a: SimRenderAdapter | null) {
  active = a;
}

export function getActiveAdapter() {
  return active;
}
