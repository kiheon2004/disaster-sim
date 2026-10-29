import type { ObjectCategory, ObjectType } from '@/core/types';
import type { ObjectParams } from '@/core/model';
import type { MessageKey } from '@/i18n/i18n';

/** A preset shown in the left panel. Several presets can share one object type. */
export interface PaletteItem {
  id: string;
  type: ObjectType;
  category: ObjectCategory;
  labelKey: MessageKey;
  descKey?: MessageKey;
  icon: string;
  params?: ObjectParams;
  /** Apply the definition's natural random variation on placement. */
  randomize?: boolean;
  /** Not implemented yet (shown as “coming soon”). */
  disabled?: boolean;
  /**
   * Modular building preset (Phase 17): a parameter set of the Building Creator
   * (buildings/spec BUILDING_PRESETS). 'custom' = the design being edited in the Creator.
   */
  buildingPreset?: string;
}

/** Palette id of the Building Creator's current design (placed like any preset). */
export const CUSTOM_BUILDING_ID = 'building.custom';

export const CATEGORY_ORDER: ObjectCategory[] = [
  'buildings',
  'nature',
  'vehicles',
  'people',
  'infrastructure',
  'environment',
];

export const PALETTE: PaletteItem[] = [
  { id: 'building.lowrise', type: 'building', category: 'buildings', labelKey: 'preset.building.lowrise', icon: 'building',
    params: { floors: 3, width: 10, depth: 8, color: '#c9b79c', sign: true, rooftopUnits: 2 } },
  { id: 'building.office', type: 'building', category: 'buildings', labelKey: 'preset.building.office', icon: 'building',
    params: { floors: 10, width: 14, depth: 12, color: '#8d9db2', sign: false, rooftopUnits: 3 } },
  { id: 'building.house', type: 'building', category: 'buildings', labelKey: 'preset.building.house', icon: 'building',
    params: { floors: 2, width: 7, depth: 7, floorHeight: 2.9, color: '#e6d6bb', sign: false, rooftopUnits: 1 } },

  // Phase 17 modular buildings (members, materials, structural model) — editable in the Building Creator.
  { id: 'building.m.house', type: 'building', category: 'buildings', labelKey: 'building.preset.house', icon: 'building', buildingPreset: 'house' },
  { id: 'building.m.apartment', type: 'building', category: 'buildings', labelKey: 'building.preset.apartment', icon: 'building', buildingPreset: 'apartment' },
  { id: 'building.m.office', type: 'building', category: 'buildings', labelKey: 'building.preset.office', icon: 'building', buildingPreset: 'office' },
  { id: 'building.m.warehouse', type: 'building', category: 'buildings', labelKey: 'building.preset.warehouse', icon: 'building', buildingPreset: 'warehouse' },
  { id: 'building.m.industrial', type: 'building', category: 'buildings', labelKey: 'building.preset.industrial', icon: 'building', buildingPreset: 'industrial' },
  { id: 'building.m.tower', type: 'building', category: 'buildings', labelKey: 'building.preset.tower', icon: 'building', buildingPreset: 'tower' },

  { id: 'tree.broadleaf', type: 'tree', category: 'nature', labelKey: 'preset.tree.broadleaf', icon: 'tree',
    params: { species: 'broadleaf', height: 8, canopyRadius: 2.6, trunkRadius: 0.3 }, randomize: true },
  { id: 'tree.conifer', type: 'tree', category: 'nature', labelKey: 'preset.tree.conifer', icon: 'conifer',
    params: { species: 'conifer', height: 11, canopyRadius: 2.2, trunkRadius: 0.32 }, randomize: true },

  { id: 'car.sedan', type: 'car', category: 'vehicles', labelKey: 'preset.car.sedan', icon: 'car',
    params: { variant: 'sedan', length: 4.5, width: 1.8, height: 1.45, color: '#3d6fd6' } },
  { id: 'car.suv', type: 'car', category: 'vehicles', labelKey: 'preset.car.suv', icon: 'car',
    params: { variant: 'suv', length: 4.8, width: 1.95, height: 1.8, color: '#e9e9e6' } },
  { id: 'car.truck', type: 'car', category: 'vehicles', labelKey: 'preset.car.truck', icon: 'truck',
    params: { variant: 'truck', length: 8, width: 2.5, height: 3.2, color: '#d9a033' } },

  { id: 'human.adult', type: 'human', category: 'people', labelKey: 'preset.human.adult', icon: 'human', randomize: true },

  { id: 'infra.streetLight', type: 'streetLight', category: 'infrastructure', labelKey: 'object.streetLight', icon: 'streetLight' },
  { id: 'infra.sign', type: 'sign', category: 'infrastructure', labelKey: 'preset.sign.road', icon: 'sign' },
  { id: 'infra.billboard', type: 'sign', category: 'infrastructure', labelKey: 'preset.sign.billboard', icon: 'sign',
    params: { height: 6, panelWidth: 6, panelHeight: 3, color: '#e0a526' } },
  { id: 'infra.signal', type: 'sign', category: 'infrastructure', labelKey: 'preset.sign.signal', icon: 'sign',
    params: { height: 5.2, panelWidth: 0.45, panelHeight: 1.2, color: '#24272b' } },
  { id: 'infra.guardrail', type: 'wall', category: 'infrastructure', labelKey: 'preset.wall.guardrail', icon: 'wall',
    params: { length: 4, height: 0.75, thickness: 0.15, color: '#a9b0b6' } },
  { id: 'infra.wall', type: 'wall', category: 'infrastructure', labelKey: 'preset.wall.masonry', icon: 'wall' },
  { id: 'infra.fence', type: 'wall', category: 'infrastructure', labelKey: 'preset.wall.fence', icon: 'wall',
    params: { length: 8, height: 1.8, thickness: 0.12, color: '#d9d6cf' } },
  { id: 'env.road', type: 'road', category: 'environment', labelKey: 'preset.road.twoLane', icon: 'road' },
  { id: 'env.road4', type: 'road', category: 'environment', labelKey: 'preset.road.fourLane', icon: 'road',
    params: { length: 40, width: 14, lanes: 4 } },
];

/** The Building Creator's design as a placeable item (hidden from the palette list). */
const CUSTOM_BUILDING: PaletteItem = { id: CUSTOM_BUILDING_ID, type: 'building', category: 'buildings', labelKey: 'building.preset.custom', icon: 'building', buildingPreset: 'custom' };

export function getPaletteItem(id: string | null): PaletteItem | undefined {
  if (id === CUSTOM_BUILDING_ID) return CUSTOM_BUILDING;
  return id ? PALETTE.find((p) => p.id === id) : undefined;
}
