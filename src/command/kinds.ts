/**
 * Phase 37 — the kinds of objects a command can name (§7): generated from the object palette (objects/palette.ts), the
 * single source of what can be placed. A kind is `<object type>[:<preset>]` — `building:house`, `car:truck`, `tree`.
 * The command lexicon (Korean / English names and aliases) is keyed by these; nothing here repeats palette data.
 *
 * Preset keys come from the palette item ids by one rule (below); the three legacy box buildings (Phase 5, before
 * the modular buildings of Phase 17) share names with modular presets and get a `box` prefix.
 */
import type { ObjectType } from '@/core/types';
import type { WorldObject } from '@/core/model';
import { PALETTE, type PaletteItem } from '@/objects/palette';

export interface Kind {
  /** `type` or `type:preset` — the text of a canonical command. */
  key: string;
  type: ObjectType;
  /** Absent on the plain kind of a type (`tree`, `car` …), which places the type's default preset. */
  preset?: string;
  item: PaletteItem;
}

/** Palette ids whose preset key the rule would get wrong (name clashes, no separator). */
const PRESET_OVERRIDES: Record<string, string> = {
  'building.lowrise': 'boxLowrise',
  'building.office': 'boxOffice',
  'building.house': 'boxHouse',
  'env.road4': 'fourLane',
  'infra.sign': 'road',
  'infra.wall': 'masonry',
  'obj.ball': 'solid',
  'env.road': 'twoLane',
};

/**
 * Preset key of a palette item: its id without the leading family (`building.` `tree.` `car.` `human.` `infra.` `obj.`
 * `env.`), without the modular marker `m.` and without the type name itself (`crate.wood` → `wood`); nothing left =
 * the item is the only one of its type and has no preset key.
 */
export function presetKeyOf(item: PaletteItem): string | undefined {
  const over = PRESET_OVERRIDES[item.id];
  if (over) return over;
  let rest = item.id.slice(item.id.indexOf('.') + 1);
  if (rest.startsWith('m.')) rest = rest.slice(2);
  if (rest === item.type) return undefined;
  if (rest.startsWith(`${item.type}.`)) rest = rest.slice(item.type.length + 1);
  return rest;
}

/** The preset a bare type places (`place building` = a modular house, not a legacy box). */
const DEFAULT_PRESET: Partial<Record<ObjectType, string>> = { building: 'house' };

function build(): { kinds: Kind[]; byKey: Map<string, Kind>; defaults: Map<ObjectType, Kind> } {
  const kinds: Kind[] = [];
  const byKey = new Map<string, Kind>();
  const defaults = new Map<ObjectType, Kind>();
  for (const item of PALETTE) {
    if (item.disabled) continue;
    const preset = presetKeyOf(item);
    const key = preset ? `${item.type}:${preset}` : item.type;
    if (byKey.has(key.toLowerCase())) throw new Error(`Duplicate command kind ${key}`);
    const kind: Kind = preset ? { key, type: item.type, preset, item } : { key, type: item.type, item };
    kinds.push(kind);
    byKey.set(key.toLowerCase(), kind);
  }
  for (const k of kinds) {
    const want = DEFAULT_PRESET[k.type];
    if (!defaults.has(k.type) && (want === undefined || k.preset === want)) defaults.set(k.type, k);
  }
  return { kinds, byKey, defaults };
}

const TABLE = build();

/** Every placeable kind, in palette order. */
export const KINDS: readonly Kind[] = TABLE.kinds;

/** The object types that have at least one kind (in palette order). */
export const KIND_TYPES: readonly ObjectType[] = [...new Set(TABLE.kinds.map((k) => k.type))];

/**
 * The kind a command names (case does not matter): `type:preset`, or a bare `type` = that type's default preset.
 * Null when there is no such kind.
 */
export function findKind(type: string, preset?: string): Kind | null {
  if (preset !== undefined) return TABLE.byKey.get(`${type}:${preset}`.toLowerCase()) ?? null;
  const exact = TABLE.byKey.get(type.toLowerCase());
  if (exact) return exact;
  const t = KIND_TYPES.find((x) => x.toLowerCase() === type.toLowerCase());
  return t ? TABLE.defaults.get(t) ?? null : null;
}

/** The canonical spelling of a type name (`streetlight` → `streetLight`), or null. */
export function canonicalType(type: string): ObjectType | null {
  return KIND_TYPES.find((x) => x.toLowerCase() === type.toLowerCase()) ?? null;
}

/** A preset's distinguishing parameters: its text values (`variant: 'truck'`, `species: 'conifer'`); sizes and colours are free to differ. */
function tagsOf(item: PaletteItem): [string, string][] {
  return Object.entries(item.params ?? {}).filter((e): e is [string, string] => e[0] !== 'color' && typeof e[1] === 'string');
}

/**
 * Whether an object in the document is of a kind — for `type:building:house` targets. Objects do not remember the
 * palette item they came from, so a preset is recognised by what it leaves on the object:
 *  - a modular building by its design's preset (the rule "select same type" uses);
 *  - a legacy box building by having no design (the three box presets differ only in size: any of them matches all);
 *  - other objects by the preset's text parameters (car variant, tree species, crate material, barrel fill …);
 *  - presets that differ only in size or colour (signs, walls) cannot be told apart: they match the whole type
 *    (`presetIsExact` is false for them, and the planner says so).
 */
export function isOfKind(o: WorldObject, kind: Kind): boolean {
  if (o.type !== kind.type) return false;
  if (kind.preset === undefined) return true;
  if (o.type === 'building') return kind.item.buildingPreset ? o.building?.preset === kind.item.buildingPreset : !o.building;
  return tagsOf(kind.item).every(([k, v]) => (o.params as Record<string, unknown>)[k] === v);
}

/** Whether `isOfKind` can tell this preset from the other presets of its type. */
export function presetIsExact(kind: Kind): boolean {
  if (kind.preset === undefined) return true;
  if (kind.type === 'building') return !!kind.item.buildingPreset;
  return tagsOf(kind.item).length > 0;
}

/** The kind an object is shown as: the most specific exact kind it matches, else its bare type. */
export function kindOfObject(o: WorldObject): string {
  const hit = KINDS.find((k) => k.preset !== undefined && presetIsExact(k) && isOfKind(o, k));
  return hit ? hit.key : o.type;
}
