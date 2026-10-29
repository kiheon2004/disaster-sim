/**
 * Legacy (Phase 0–16) building → modular design, on explicit user request only (loading never
 * converts). The result is reported field by field: what was mapped exactly, what was kept as a
 * manual override, and what changed because the member model computes it differently.
 * Nothing is dropped silently.
 */
import type { WorldObject } from '@/core/model';
import { getDefinition } from '@/objects/registry';
import { createDesign, designPhysics, withDesign, analysisOf } from './design';
import { SYSTEM_MATERIALS } from './spec';
import { defaultSpec } from './spec';
import type { BuildingDesign, BuildingSpec } from './types';

export type NoteLevel = 'exact' | 'kept' | 'changed' | 'notConverted';

export interface ConversionNote {
  /** i18n key suffix: `building.convert.<field>` */
  field: string;
  level: NoteLevel;
  before?: string | number;
  after?: string | number;
}

export interface ConversionResult {
  object: WorldObject;
  design: BuildingDesign;
  notes: ConversionNote[];
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Spec that reproduces a legacy building's geometry and structure as closely as possible. */
export function legacySpec(obj: WorldObject): BuildingSpec {
  const p = obj.params;
  const system = obj.seismic?.structure.system ?? 'rcFrame';
  const mats = SYSTEM_MATERIALS[system];
  const floorHeight = Math.min(8, Math.max(2.2, num(p.floorHeight, 3.2)));
  const frame = system === 'rcFrame' || system === 'steelFrame';
  // Legacy windows: 1.3 × 1.45 m every 2.6 m of facade, every floor → glazed fraction.
  const density = Math.min(0.9, (1.3 * 1.45) / (2.6 * floorHeight));
  return {
    ...defaultSpec(),
    width: Math.min(60, Math.max(3, num(p.width, 10))),
    depth: Math.min(60, Math.max(3, num(p.depth, 8))),
    floors: Math.min(40, Math.max(1, Math.round(num(p.floors, 4)))),
    floorHeight,
    groundFloorHeight: floorHeight,
    roof: 'flat',
    system,
    structureMaterial: mats.structure,
    slabMaterial: mats.slab,
    claddingMaterial: mats.cladding,
    facade: 'punched',
    windowDensity: Math.round(density * 100) / 100,
    foundation: obj.seismic?.foundation.type ?? 'mat',
    bay: frame ? 6 : 4,
    core: false,
    ceiling: true,
    occupancy: 'office',
    color: typeof p.color === 'string' ? p.color : '#c9b79c',
    sign: p.sign === true,
    rooftopUnits: Math.round(num(p.rooftopUnits, 0)),
  };
}

export function convertLegacy(obj: WorldObject): ConversionResult {
  if (obj.type !== 'building' || obj.building) throw new Error('Not a legacy building');
  const spec = legacySpec(obj);
  const design: BuildingDesign = { ...createDesign(spec), convertedFrom: 'legacy' };
  const notes: ConversionNote[] = [];
  const def = getDefinition('building');
  const legacyDefaults = def.defaultPhysics(obj.params);
  const derived = designPhysics(design, analysisOf(design));

  // Geometry.
  notes.push({ field: 'dimensions', level: 'exact', before: `${obj.params.width}×${obj.params.depth} m`, after: `${spec.width}×${spec.depth} m` });
  notes.push({ field: 'floors', level: 'exact', before: Number(obj.params.floors), after: spec.floors });
  notes.push({ field: 'system', level: 'exact', before: spec.system, after: spec.system });
  notes.push({ field: 'foundationType', level: 'exact', before: spec.foundation, after: spec.foundation });

  // Physical properties: values the user customized stay as overrides; defaults follow the members.
  const legacyObj: WorldObject = { ...obj, physics: { ...obj.physics } };
  const keepMass = obj.physics.mass !== legacyDefaults.mass;
  notes.push({ field: 'mass', level: keepMass ? 'kept' : 'changed', before: Math.round(obj.physics.mass), after: keepMass ? Math.round(obj.physics.mass) : derived.mass });
  const keepWind = obj.physics.windResistance !== legacyDefaults.windResistance;
  notes.push({ field: 'windResistance', level: keepWind ? 'kept' : 'changed', before: obj.physics.windResistance, after: keepWind ? obj.physics.windResistance : derived.windResistance });
  for (const key of ['durability', 'breakThreshold', 'dragCoefficient', 'friction'] as const) {
    if (obj.physics[key] !== legacyDefaults[key]) notes.push({ field: key, level: 'kept', before: obj.physics[key], after: obj.physics[key] });
  }
  // Build: start from derived physics, re-apply customized fields.
  let out = withDesign({ ...legacyObj, building: undefined }, design);
  const physics = { ...out.physics };
  for (const key of Object.keys(physics) as (keyof typeof physics)[]) {
    if (obj.physics[key] !== undefined && obj.physics[key] !== legacyDefaults[key]) (physics as Record<string, unknown>)[key] = obj.physics[key];
  }
  if (obj.physics.frontalAreaOverride !== undefined) physics.frontalAreaOverride = obj.physics.frontalAreaOverride;
  out = { ...out, physics };

  // Seismic factors are kept on top of the member model.
  const st = obj.seismic?.structure;
  if (st && (st.stiffnessFactor !== 1 || st.strengthFactor !== 1 || st.periodOverride !== 0)) {
    notes.push({ field: 'seismicFactors', level: 'kept', before: `k×${st.stiffnessFactor} F×${st.strengthFactor} T=${st.periodOverride}`, after: `k×${out.seismic!.structure.stiffnessFactor} F×${out.seismic!.structure.strengthFactor} T=${out.seismic!.structure.periodOverride}` });
  }
  if (st && Math.abs(st.dampingRatio - (out.seismic?.structure.dampingRatio ?? 0)) > 1e-9) {
    notes.push({ field: 'damping', level: 'changed', before: st.dampingRatio, after: out.seismic!.structure.dampingRatio });
  }
  const f = obj.seismic?.foundation;
  if (f) notes.push({ field: 'foundationParams', level: 'kept', before: `${f.anchorage}/${f.groundContact}`, after: `${out.seismic!.foundation.anchorage}/${out.seismic!.foundation.groundContact}` });

  // Facade: windows are regenerated on the member grid; the legacy shop window is not modeled.
  const legacyWindows = obj.components.filter((c) => c.kind === 'window').length;
  const windows = out.components.filter((c) => c.kind === 'window').length;
  notes.push({ field: 'windows', level: 'changed', before: legacyWindows, after: windows });
  if (obj.components.some((c) => c.kind === 'window' && c.size[0] > 2)) notes.push({ field: 'shopWindow', level: 'notConverted' });
  const k = obj.transform.scale;
  if (k[0] !== 1 || k[1] !== 1 || k[2] !== 1) notes.push({ field: 'scale', level: 'kept', before: k.join('×'), after: k.join('×') });
  return { object: out, design, notes };
}
