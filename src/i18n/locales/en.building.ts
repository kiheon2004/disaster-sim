import type { koBuilding } from './ko.building';

/** English strings of the Modular Building Creator (Phase 17). */
export const enBuilding: Record<keyof typeof koBuilding, string> = {
  'component.door': 'Door',
  'building.preset.house': 'Small house (timber)',
  'building.preset.apartment': 'Mid-rise apartment (RC)',
  'building.preset.office': 'Office building (steel + core)',
  'building.preset.warehouse': 'Warehouse (steel portal)',
  'building.preset.industrial': 'Industrial building (RC)',
  'building.preset.tower': 'High-rise tower (RC + core)',
  'building.preset.custom': 'Building Creator design',
  'component.cladding': 'Cladding panel',
  'cause.gravity': 'Lost load path / gravity overload',
  'evt.FAILED': 'Member failed',
  'evt.STORY_COLLAPSED': 'Story collapse (partial)',
  'log.building.memberFailed': '{name}: structural member failed ({n} so far) — load path recomputed',
  'log.building.storyCollapsed': '{name}: partial collapse from story {story} up',
  'member.type.foundation': 'Foundation',
  'member.type.column': 'Column',
  'member.type.beam': 'Beam',
  'member.type.slab': 'Floor slab',
  'member.type.wall': 'Wall',
  'member.type.window': 'Window',
  'member.type.door': 'Door',
  'member.type.roof': 'Roof',
};
