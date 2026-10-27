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
}

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

  { id: 'infra.streetLight', type: 'streetLight', category: 'infrastructure', labelKey: 'object.streetLight', icon: 'streetLight', disabled: true },
  { id: 'infra.sign', type: 'sign', category: 'infrastructure', labelKey: 'object.sign', icon: 'sign', disabled: true },
  { id: 'infra.wall', type: 'wall', category: 'infrastructure', labelKey: 'object.wall', icon: 'wall', disabled: true },
  { id: 'env.road', type: 'road', category: 'environment', labelKey: 'object.road', icon: 'road', disabled: true },
];

export function getPaletteItem(id: string | null): PaletteItem | undefined {
  return id ? PALETTE.find((p) => p.id === id) : undefined;
}
