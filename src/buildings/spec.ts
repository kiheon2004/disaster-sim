/**
 * Building spec defaults, validation and presets (Phase 17).
 *
 * Presets are plain parameter sets of the same generator — not a separate system — and every
 * value stays editable. They carry no safety / seismic rating: whatever a preset does in a
 * simulation follows from its members and the approximate models.
 */
import type { StructuralSystem } from '@/core/model';
import { MATERIALS, isMaterialId, type MaterialId } from './materials';
import { FACADE_STYLES, OCCUPANCIES, ROOF_TYPES, type BuildingSpec } from './types';
import { isFrameSystem, totalHeight } from './generate';

export const SPEC_LIMITS = {
  width: [3, 60],
  depth: [3, 60],
  floors: [1, 40],
  floorHeight: [2.2, 8],
  groundFloorHeight: [2.2, 10],
  roofPitch: [3, 60],
  windowDensity: [0, 0.9],
  bay: [2.5, 15],
  rooftopUnits: [0, 6],
  /** Total height (m) — the world is 200 m wide. */
  height: [2.2, 150],
} as const;

export const SYSTEMS: readonly StructuralSystem[] = ['rcFrame', 'steelFrame', 'masonry', 'wood'];

/** Default materials of a structural system. */
export const SYSTEM_MATERIALS: Record<StructuralSystem, { structure: MaterialId; slab: MaterialId; cladding: MaterialId }> = {
  rcFrame: { structure: 'reinforcedConcrete', slab: 'reinforcedConcrete', cladding: 'masonry' },
  steelFrame: { structure: 'structuralSteel', slab: 'reinforcedConcrete', cladding: 'glass' },
  masonry: { structure: 'masonry', slab: 'reinforcedConcrete', cladding: 'masonry' },
  wood: { structure: 'timber', slab: 'timber', cladding: 'timber' },
};

export function defaultSpec(): BuildingSpec {
  return {
    width: 12, depth: 10, floors: 4, floorHeight: 3.2, groundFloorHeight: 3.2,
    roof: 'flat', roofPitch: 25, system: 'rcFrame',
    structureMaterial: 'reinforcedConcrete', slabMaterial: 'reinforcedConcrete', claddingMaterial: 'masonry',
    facade: 'punched', windowDensity: 0.35, foundation: 'mat', bay: 6, core: false, ceiling: true,
    occupancy: 'office', color: '#c9b79c', sign: false, rooftopUnits: 0,
  };
}

export interface BuildingPreset {
  id: string;
  /** i18n key suffix: `building.preset.<id>` */
  spec: BuildingSpec;
}

const P = (id: string, patch: Partial<BuildingSpec>): BuildingPreset => ({ id, spec: { ...defaultSpec(), ...patch } });

export const BUILDING_PRESETS: readonly BuildingPreset[] = [
  P('house', { width: 8, depth: 7, floors: 2, floorHeight: 2.8, groundFloorHeight: 2.9, roof: 'gable', roofPitch: 30, system: 'wood',
    structureMaterial: 'timber', slabMaterial: 'timber', claddingMaterial: 'timber', facade: 'punched', windowDensity: 0.22, foundation: 'spread',
    bay: 4, occupancy: 'residential', color: '#e6d6bb' }),
  P('apartment', { width: 18, depth: 12, floors: 6, floorHeight: 2.9, groundFloorHeight: 3, roof: 'flat', system: 'rcFrame',
    claddingMaterial: 'masonry', facade: 'punched', windowDensity: 0.35, foundation: 'mat', bay: 6, core: true, occupancy: 'residential', color: '#d8d2c4' }),
  P('office', { width: 24, depth: 18, floors: 10, floorHeight: 3.6, groundFloorHeight: 4.5, roof: 'flat', system: 'steelFrame',
    structureMaterial: 'structuralSteel', slabMaterial: 'reinforcedConcrete', claddingMaterial: 'glass', facade: 'curtain', windowDensity: 0.7,
    foundation: 'mat', bay: 8, core: true, occupancy: 'office', color: '#8d9db2', rooftopUnits: 3 }),
  P('warehouse', { width: 36, depth: 24, floors: 1, floorHeight: 8, groundFloorHeight: 8, roof: 'gable', roofPitch: 10, system: 'steelFrame',
    structureMaterial: 'structuralSteel', slabMaterial: 'reinforcedConcrete', claddingMaterial: 'lightCladding', facade: 'ribbon', windowDensity: 0.08,
    foundation: 'spread', bay: 8, ceiling: false, occupancy: 'storage', color: '#c7ccd1' }),
  P('industrial', { width: 30, depth: 20, floors: 2, floorHeight: 5, groundFloorHeight: 6, roof: 'flat', system: 'rcFrame',
    claddingMaterial: 'masonry', facade: 'ribbon', windowDensity: 0.3, foundation: 'spread', bay: 7.5, occupancy: 'industrial', color: '#a9a39a', rooftopUnits: 4 }),
  P('tower', { width: 30, depth: 30, floors: 30, floorHeight: 3.5, groundFloorHeight: 5, roof: 'flat', system: 'rcFrame',
    claddingMaterial: 'glass', facade: 'curtain', windowDensity: 0.75, foundation: 'pile', bay: 7.5, core: true, occupancy: 'office', color: '#7f93ab', rooftopUnits: 4 }),
];

export function presetSpec(id: string): BuildingSpec | null {
  const p = BUILDING_PRESETS.find((x) => x.id === id);
  return p ? structuredClone(p.spec) : null;
}

export type IssueLevel = 'error' | 'warning' | 'info';
export interface SpecIssue {
  field: keyof BuildingSpec | 'height';
  level: IssueLevel;
  /** i18n key suffix: `building.issue.<code>` */
  code: string;
  params?: Record<string, string | number>;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Check a spec. Errors block applying it (the editor shows them; nothing is clamped silently);
 * warnings are allowed — they explain where the approximate model or typical practice ends.
 */
export function validateSpec(spec: BuildingSpec): SpecIssue[] {
  const out: SpecIssue[] = [];
  const range = (field: keyof typeof SPEC_LIMITS & keyof BuildingSpec, integer = false) => {
    const v = spec[field] as unknown;
    const [lo, hi] = SPEC_LIMITS[field];
    if (!finite(v)) out.push({ field, level: 'error', code: 'notNumber' });
    else if (v < lo || v > hi) out.push({ field, level: 'error', code: v <= 0 ? 'nonPositive' : 'range', params: { min: lo, max: hi } });
    else if (integer && !Number.isInteger(v)) out.push({ field, level: 'error', code: 'integer' });
  };
  range('width');
  range('depth');
  range('floors', true);
  range('floorHeight');
  range('groundFloorHeight');
  range('windowDensity');
  range('bay');
  if (spec.roof !== 'flat') range('roofPitch');
  range('rooftopUnits', true);
  if (out.some((i) => i.level === 'error')) return out;

  const H = totalHeight(spec);
  if (H > SPEC_LIMITS.height[1]) out.push({ field: 'height', level: 'error', code: 'tooTall', params: { h: Math.round(H), max: SPEC_LIMITS.height[1] } });
  for (const [field, id] of [['structureMaterial', spec.structureMaterial], ['slabMaterial', spec.slabMaterial], ['claddingMaterial', spec.claddingMaterial]] as const) {
    if (!isMaterialId(id)) out.push({ field, level: 'error', code: 'material' });
  }
  if (!ROOF_TYPES.includes(spec.roof)) out.push({ field: 'roof', level: 'error', code: 'option' });
  if (!FACADE_STYLES.includes(spec.facade)) out.push({ field: 'facade', level: 'error', code: 'option' });
  if (!OCCUPANCIES.includes(spec.occupancy)) out.push({ field: 'occupancy', level: 'error', code: 'option' });
  if (!SYSTEMS.includes(spec.system)) out.push({ field: 'system', level: 'error', code: 'option' });
  if (out.some((i) => i.level === 'error')) return out;

  if (!MATERIALS[spec.structureMaterial].structural) out.push({ field: 'structureMaterial', level: 'error', code: 'notStructural' });
  if (!MATERIALS[spec.slabMaterial].structural) out.push({ field: 'slabMaterial', level: 'error', code: 'notStructural' });

  // Warnings: outside typical practice / the model's tested range.
  if (spec.system === 'masonry' && spec.floors > 5) out.push({ field: 'floors', level: 'warning', code: 'masonryTall', params: { n: 5 } });
  if (spec.system === 'wood' && spec.floors > 6) out.push({ field: 'floors', level: 'warning', code: 'timberTall', params: { n: 6 } });
  const longSpan = spec.structureMaterial === 'timber' ? 8 : spec.structureMaterial === 'structuralSteel' ? 15 : 12;
  if (spec.bay > longSpan) out.push({ field: 'bay', level: 'warning', code: 'longSpan', params: { m: longSpan } });
  if (spec.floors > 1 && spec.groundFloorHeight > spec.floorHeight * 1.4) out.push({ field: 'groundFloorHeight', level: 'warning', code: 'softStory' });
  if (!isFrameSystem(spec.system) && spec.windowDensity > 0.55) out.push({ field: 'windowDensity', level: 'warning', code: 'weakPiers' });
  if (!isFrameSystem(spec.system) && spec.core) out.push({ field: 'core', level: 'info', code: 'coreIgnored' });
  const expected = SYSTEM_MATERIALS[spec.system].structure;
  if (spec.structureMaterial !== expected) out.push({ field: 'structureMaterial', level: 'info', code: 'systemMaterial' });
  if (H > 60 && !spec.core && isFrameSystem(spec.system)) out.push({ field: 'core', level: 'warning', code: 'tallNoCore' });
  if (spec.foundation === 'spread' && spec.floors > 12) out.push({ field: 'foundation', level: 'warning', code: 'spreadTall' });
  return out;
}

export const hasErrors = (issues: readonly SpecIssue[]) => issues.some((i) => i.level === 'error');

/** Fill missing / invalid fields with defaults (load path); finite numbers are clamped into range. */
export function normalizeSpec(raw: Partial<Record<keyof BuildingSpec, unknown>> | undefined): BuildingSpec {
  const d = defaultSpec();
  if (!raw) return d;
  const num = (k: keyof typeof SPEC_LIMITS & keyof BuildingSpec, integer = false): number => {
    const v = raw[k];
    if (!finite(v)) return d[k] as number;
    const [lo, hi] = SPEC_LIMITS[k];
    const c = Math.min(hi, Math.max(lo, v));
    return integer ? Math.round(c) : c;
  };
  const pick = <T>(v: unknown, opts: readonly T[], fallback: T): T => (opts.includes(v as T) ? (v as T) : fallback);
  const mat = (v: unknown, fallback: MaterialId) => (isMaterialId(v) ? v : fallback);
  return {
    width: num('width'), depth: num('depth'), floors: num('floors', true), floorHeight: num('floorHeight'), groundFloorHeight: num('groundFloorHeight'),
    roof: pick(raw.roof, ROOF_TYPES, d.roof), roofPitch: num('roofPitch'), system: pick(raw.system, SYSTEMS, d.system),
    structureMaterial: mat(raw.structureMaterial, d.structureMaterial), slabMaterial: mat(raw.slabMaterial, d.slabMaterial), claddingMaterial: mat(raw.claddingMaterial, d.claddingMaterial),
    facade: pick(raw.facade, FACADE_STYLES, d.facade), windowDensity: num('windowDensity'), foundation: pick(raw.foundation, ['spread', 'mat', 'pile'] as const, d.foundation),
    bay: num('bay'), core: typeof raw.core === 'boolean' ? raw.core : d.core, ceiling: typeof raw.ceiling === 'boolean' ? raw.ceiling : d.ceiling,
    occupancy: pick(raw.occupancy, OCCUPANCIES, d.occupancy), color: typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : d.color,
    sign: typeof raw.sign === 'boolean' ? raw.sign : d.sign, rooftopUnits: num('rooftopUnits', true),
  };
}
