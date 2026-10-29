/**
 * Shared benchmark / test scenes (Phase 24): the Phase 23 first-frame probe town (n × n modular
 * houses) and its direct impact.
 */
import { useWorldStore } from '@/world/worldStore';
import { createEmptyDocument } from '@/world/WorldDocument';
import { presetDesign } from '@/roads/city';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';

const S = () => useWorldStore.getState();

export function townDoc(n = 11, spacing = 12): WorldDocument {
  S().setLocked(false);
  S().replaceDocument(createEmptyDocument('bench'));
  const d = presetDesign('house', 1)!, add = [];
  const h = ((n - 1) * spacing) / 2;
  for (let z = -h; z <= h + 1e-9; z += spacing) for (let x = -h; x <= h + 1e-9; x += spacing) add.push({ type: 'building' as const, building: d, seed: add.length + 1, transform: { position: [x, 0, z] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] } });
  S().applyEdit({ add });
  return structuredClone(S().doc);
}

export const PROBE_IMPACT: EventSpec = { event: 'impact', target: [6, 6], material: 'stony', diameter: 1, speed: 8000, angle: 70, azimuth: 45, entry: 'direct' } as EventSpec;

