/**
 * The design of a building preset with a given number of floors (Phase 37: moved from roads/city.ts, where the city
 * generator made "apartment, 3–6 floors" rows with it — the command planner places "3-storey houses" the same way).
 * Designs are immutable values: every (preset, floors) pair is built once and shared by all its copies.
 */
import { createDesign } from './design';
import { presetSpec } from './spec';
import type { BuildingDesign } from './types';

const designCache = new Map<string, BuildingDesign>();

/** Shared immutable design of a preset with a floor count (structure sharing); null for an unknown preset. */
export function presetDesign(preset: string, floors: number): BuildingDesign | null {
  const key = `${preset}:${floors}`;
  let d = designCache.get(key);
  if (d) return d;
  const spec = presetSpec(preset);
  if (!spec) return null;
  d = createDesign({ ...spec, floors }, preset);
  designCache.set(key, d);
  return d;
}
