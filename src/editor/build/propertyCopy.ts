/**
 * Copy properties from one object to others (Phase 36 §20). Each property says which targets it applies to; a
 * target it does not fit is skipped (counted, never half-applied):
 *
 *   scale      any object (modular buildings excepted: their size is their design, changed in the building editor)
 *   heading    any object (re-seated on a slope when it stands on the ground)
 *   params     same object type, not modular buildings (their parameters are derived from the design)
 *   physics    same object type (mass, wind resistance, durability … are per-type quantities)
 *   structure  buildings: the earthquake structure / foundation properties (legacy buildings), or — between modular
 *              buildings — the members' materials and therefore their structural type (src/buildings/structuralType)
 */
import type { WorldObject } from '@/core/model';
import type { TerrainSampler } from '@/terrain/TerrainSampler';
import { applyParams } from '@/world/WorldDocument';
import { matchObjects } from './groupTransform';
import { withDesign } from '@/buildings/design';

export type CopyProp = 'scale' | 'heading' | 'params' | 'physics' | 'structure';
export const COPY_PROPS: readonly CopyProp[] = ['scale', 'heading', 'params', 'physics', 'structure'];

/** Whether `prop` of `ref` can be applied to `target`. */
export function copyApplies(prop: CopyProp, ref: WorldObject, target: WorldObject): boolean {
  if (ref.id === target.id) return false;
  switch (prop) {
    case 'scale': return !target.building;
    case 'heading': return true;
    case 'params': return ref.type === target.type && !ref.building && !target.building;
    case 'physics': return ref.type === target.type;
    case 'structure': return ref.type === 'building' && target.type === 'building' && (!!ref.building === !!target.building) && (!!ref.building || !!ref.seismic);
  }
}

export interface CopyResult {
  objects: WorldObject[];
  applied: number;
  skipped: number;
}

export function copyProperties(ref: WorldObject, targets: readonly WorldObject[], props: ReadonlySet<CopyProp>, terrain: TerrainSampler): CopyResult {
  let applied = 0, skipped = 0;
  const out: WorldObject[] = [];
  for (const t0 of targets) {
    if (t0.id === ref.id || t0.locked) continue;
    let t = t0;
    for (const prop of COPY_PROPS) {
      if (!props.has(prop)) continue;
      if (!copyApplies(prop, ref, t)) { skipped++; continue; }
      applied++;
      if (prop === 'scale') t = { ...t, transform: { ...t.transform, scale: [...ref.transform.scale] as WorldObject['transform']['scale'] } };
      else if (prop === 'heading') t = matchObjects([t], ref, 'rotation', terrain)[0];
      else if (prop === 'params') t = applyParams(t, structuredClone(ref.params));
      else if (prop === 'physics') t = { ...t, physics: { ...ref.physics } };
      else if (ref.building && t.building) {
        // Member materials by role (columns / beams / walls / slabs …) from the reference: the structural type follows them.
        const byRole = new Map(ref.building.members.map((m) => [`${m.type}:${m.role}`, m.material]));
        const members = t.building.members.map((m) => ({ ...m, material: byRole.get(`${m.type}:${m.role}`) ?? m.material }));
        const spec = { ...t.building.spec, system: ref.building.spec.system, structureMaterial: ref.building.spec.structureMaterial, slabMaterial: ref.building.spec.slabMaterial };
        t = withDesign(t, { ...t.building, spec, members });
      } else t = { ...t, seismic: structuredClone(ref.seismic) };
    }
    if (t !== t0) out.push(t);
  }
  return { objects: out, applied, skipped };
}
