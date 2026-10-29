/**
 * Building design of a palette item (Phase 17): a preset (cached — designs are immutable values,
 * every placed object stores its own copy) or the Building Creator's current design.
 */
import type { ObjectParams } from '@/core/model';
import type { PaletteItem } from '@/objects/palette';
import { getDefinition } from '@/objects/registry';
import type { BuildingDesign } from '@/buildings/types';
import { createDesign, designParams } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import { useBuildStore } from '../buildStore';

const presets = new Map<string, BuildingDesign>();

export function itemDesign(item: Pick<PaletteItem, 'buildingPreset'>): BuildingDesign | undefined {
  const id = item.buildingPreset;
  if (!id) return undefined;
  if (id === 'custom') return useBuildStore.getState().creator.design ?? undefined;
  let d = presets.get(id);
  if (!d) {
    const spec = presetSpec(id);
    if (!spec) return undefined;
    presets.set(id, (d = createDesign(spec, id)));
  }
  return d;
}

/** Params an item places with (a design's derived params, or the preset params). */
export function itemParams(item: PaletteItem): ObjectParams {
  const d = itemDesign(item);
  if (d) return designParams(d);
  const def = getDefinition(item.type);
  return { ...def.defaultParams, ...(item.params ?? {}) };
}
