/**
 * Building Creator / Building Edit Mode actions (Phase 17). Every change of a building goes
 * through worldStore.applyEdit({ update }) → ONE undo step; the new object (design + every
 * derived field) is built completely first, so an error leaves the world untouched.
 */
import type { EntityId, Vec3 } from '@/core/types';
import type { WorldObject } from '@/core/model';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { useMemberStore } from '@/editor/memberStore';
import { useBuildStore } from '@/editor/buildStore';
import { CUSTOM_BUILDING_ID } from '@/objects/palette';
import { analysisOf, createDesign, regenerate, withDesign } from '@/buildings/design';
import { addFloor, addMembers, duplicateMembers, moveMembers, newMember, nextUserIds, removeFloor, removeMembers, rotateMembers, setInitialDamage, setMaterial, setRole, setSize } from '@/buildings/edit';
import { convertLegacy, type ConversionNote } from '@/buildings/convert';
import { hasErrors, validateSpec } from '@/buildings/spec';
import { assertValidDesign } from '@/buildings/schema';
import type { BuildingDesign, BuildingSpec, FoundationPolicy, MemberType, StructuralRole } from '@/buildings/types';
import type { MaterialId } from '@/buildings/materials';
import { samplerFor } from '@/terrain/TerrainSampler';
import { foundationPlinth } from '@/terrain/groundPlacement';
import { toast } from '@/ui/common/toast';
import { t } from '@/i18n/i18n';

const world = () => useWorldStore.getState();
const editable = () => useEditorStore.getState().mode === 'editor' && !world().locked;

export function modularBuilding(id: EntityId | null): WorldObject | null {
  const o = id ? world().doc.objects[id] : undefined;
  return o && o.type === 'building' && o.building ? o : null;
}

/**
 * Commit a new design for a building (one undo step). Returns false when nothing changed.
 * New members without a load path need confirmation unless the design allows them.
 */
export function commitDesign(id: EntityId, design: BuildingDesign, opts: { confirm?: (n: number) => boolean } = {}): boolean {
  if (!editable()) return false;
  const obj = modularBuilding(id);
  if (!obj) return false;
  try {
    assertValidDesign(design);
  } catch (err) {
    toast('error', { key: 'building.toast.failed' }, String(err));
    return false;
  }
  const before = analysisOf(obj.building!).unsupported.length;
  const after = analysisOf(design).unsupported.length;
  if (after > before && !design.options.allowUnsupported) {
    const ask = opts.confirm ?? ((n: number) => window.confirm(t('building.confirm.unsupported', { n })));
    if (!ask(after - before)) return false;
  }
  try {
    world().applyEdit({ update: [withDesign(obj, design)] });
  } catch (err) {
    console.error(err);
    toast('error', { key: 'building.toast.failed' }, String(err));
    return false;
  }
  return true;
}

// ── Building Creator ─────────────────────────────────────────────────

/** New building: generate the Creator's spec and arm placement (click places, like a preset). */
export function placeCreatorBuilding(): boolean {
  const c = useBuildStore.getState().creator;
  if (hasErrors(validateSpec(c.spec))) return false;
  const design = createDesign(c.spec, c.preset ?? undefined);
  useBuildStore.getState().setCreator({ design });
  const ed = useEditorStore.getState();
  if (ed.placeItemId === CUSTOM_BUILDING_ID) ed.armPlacement(null);
  ed.armPlacement(CUSTOM_BUILDING_ID);
  return true;
}

/**
 * Edit a building's parameters. Size / system / layout changes regenerate the members (manual
 * member edits are replaced — the caller confirmed); material-only changes on an edited design
 * replace the materials of the matching members and keep the edits.
 */
export function applySpec(id: EntityId, spec: BuildingSpec, opts: { confirm?: (n: number) => boolean } = {}): boolean {
  const obj = modularBuilding(id);
  if (!obj || hasErrors(validateSpec(spec))) return false;
  return commitDesign(id, designForSpec(obj.building!, spec), opts);
}

/** Whether applying `spec` regenerates the members (manual member edits would be replaced). */
export function specRegenerates(d: BuildingDesign, spec: BuildingSpec): boolean {
  const appearance: (keyof BuildingSpec)[] = ['structureMaterial', 'slabMaterial', 'claddingMaterial', 'color', 'sign', 'rooftopUnits'];
  const changed = (Object.keys(spec) as (keyof BuildingSpec)[]).filter((k) => spec[k] !== d.spec[k]);
  if (!changed.length) return false;
  return d.edits === 0 || changed.some((k) => !appearance.includes(k));
}

/**
 * The design a spec change produces (pure — used for the preview and by applySpec). Size /
 * system / layout changes regenerate the members; material-only changes on an edited design
 * replace the materials of the matching members and keep the manual edits.
 */
export function designForSpec(d: BuildingDesign, spec: BuildingSpec): BuildingDesign {
  if (specRegenerates(d, spec) || d.edits === 0) return regenerate(d, spec);
  let members = d.members;
  const swap = (from: MaterialId, to: MaterialId, f: (m: BuildingDesign['members'][number]) => boolean) => {
    if (from !== to) members = members.map((m) => (m.material === from && f(m) ? { ...m, material: to } : m));
  };
  swap(d.spec.structureMaterial, spec.structureMaterial, (m) => m.type === 'column' || m.type === 'beam' || (m.type === 'wall' && m.role === 'bearing' && !m.id.startsWith('wc')));
  swap(d.spec.slabMaterial, spec.slabMaterial, (m) => m.type === 'slab' && m.level >= 0);
  swap(d.spec.claddingMaterial, spec.claddingMaterial, (m) => m.type === 'wall' && m.role === 'cladding');
  return { ...d, spec: { ...spec }, members, edits: d.edits + 1 };
}

export function addFloorTo(id: EntityId): boolean {
  const obj = modularBuilding(id);
  if (!obj) return false;
  if (obj.building!.spec.floors >= 40) {
    toast('warn', { key: 'building.toast.maxFloors' });
    return false;
  }
  return commitDesign(id, addFloor(obj.building!));
}

export function removeFloorFrom(id: EntityId): boolean {
  const obj = modularBuilding(id);
  if (!obj || obj.building!.spec.floors <= 1) return false;
  return commitDesign(id, removeFloor(obj.building!));
}

export function setFoundationPolicy(id: EntityId, policy: FoundationPolicy): boolean {
  const obj = modularBuilding(id);
  if (!obj) return false;
  const d = obj.building!;
  // Switching to 'preserve' freezes the current plinth; 'refit' lets it follow the terrain.
  const plinthDepth = policy === 'preserve' ? Math.round(foundationPlinth(obj, samplerFor(world().doc.terrain)) * 1000) / 1000 : null;
  return commitDesign(id, { ...d, options: { ...d.options, foundationPolicy: policy, plinthDepth } });
}

export function setAllowUnsupported(id: EntityId, allow: boolean): boolean {
  const obj = modularBuilding(id);
  if (!obj) return false;
  const d = obj.building!;
  return commitDesign(id, { ...d, options: { ...d.options, allowUnsupported: allow } });
}

/** Convert a legacy building (explicit, one undo step). Returns the conversion report. */
export function convertToModular(id: EntityId): ConversionNote[] | null {
  if (!editable()) return null;
  const o = world().doc.objects[id];
  if (!o || o.type !== 'building' || o.building) return null;
  const r = convertLegacy(o);
  world().applyEdit({ update: [r.object] });
  return r.notes;
}

// ── Building Edit Mode (members) ─────────────────────────────────────

export function enterBuildingEdit(id: EntityId) {
  if (!modularBuilding(id) || !editable()) return;
  useMemberStore.getState().reset();
  useEditorStore.getState().setBuildingEdit(id);
}

export function exitBuildingEdit() {
  const id = useEditorStore.getState().buildingId;
  useMemberStore.getState().reset();
  useEditorStore.getState().setBuildingEdit(null);
  if (id) useEditorStore.getState().select(id);
}

const target = () => modularBuilding(useEditorStore.getState().buildingId);
const selectedMembers = () => useMemberStore.getState().selected;

/** Move the selected members by a building-local delta. */
export function moveSelectedMembers(delta: Vec3): boolean {
  const o = target();
  const ids = selectedMembers();
  if (!o || !ids.length) return false;
  return commitDesign(o.id, moveMembers(o.building!, ids, delta));
}

export function rotateSelectedMembers(yaw: number, pivot: [number, number]): boolean {
  const o = target();
  const ids = selectedMembers();
  if (!o || !ids.length) return false;
  return commitDesign(o.id, rotateMembers(o.building!, ids, yaw, pivot));
}

export function deleteSelectedMembers(): boolean {
  const o = target();
  const ids = selectedMembers();
  if (!o || !ids.length) return false;
  const r = removeMembers(o.building!, ids);
  if (!r.removed.length) return false;
  const ok = commitDesign(o.id, r.design);
  if (ok) {
    useMemberStore.getState().select([]);
    if (r.removed.length > ids.length) toast('info', { key: 'building.toast.removedHosted', params: { n: r.removed.length - ids.length } });
  }
  return ok;
}

export function duplicateSelectedMembers(offset: Vec3 = [1, 0, 1]): boolean {
  const o = target();
  const ids = selectedMembers();
  if (!o || !ids.length) return false;
  const r = duplicateMembers(o.building!, ids, offset);
  const ok = commitDesign(o.id, r.design);
  if (ok) useMemberStore.getState().select(ids.map((id) => r.map.get(id)!).filter(Boolean));
  return ok;
}

/** Add a member of `type` at a building-local point (already snapped by the caller). */
export function addMemberAt(type: MemberType, at: Vec3, rotationY = 0): string | null {
  const o = target();
  if (!o) return null;
  const [id] = nextUserIds(o.building!, 1);
  const m = newMember(o.building!, type, at, id);
  m.rotation = [m.rotation[0], rotationY, m.rotation[2]];
  if ((type === 'window' || type === 'door') && !m.host) {
    // Openings join the nearest wall at that point (if any).
    const host = nearestWall(o.building!, at);
    if (host) m.host = host;
  }
  const ok = commitDesign(o.id, addMembers(o.building!, [m]));
  if (ok) useMemberStore.getState().select([id]);
  return ok ? id : null;
}

function nearestWall(d: BuildingDesign, at: Vec3): string | undefined {
  let best: string | undefined;
  let bestD = 1.2;
  for (const m of d.members) {
    if (m.type !== 'wall') continue;
    const dy = Math.abs(at[1] - m.position[1]);
    if (dy > m.size[1] / 2 + 0.5) continue;
    const dist = Math.hypot(at[0] - m.position[0], at[2] - m.position[2]) - m.size[0] / 2;
    if (dist < bestD) { bestD = dist; best = m.id; }
  }
  return best;
}

export function setSelectedMaterial(material: MaterialId): boolean {
  const o = target();
  const ids = selectedMembers();
  if (!o || !ids.length) return false;
  return commitDesign(o.id, setMaterial(o.building!, ids, material));
}

export function setSelectedRole(role: StructuralRole): boolean {
  const o = target();
  const ids = selectedMembers();
  if (!o || !ids.length) return false;
  return commitDesign(o.id, setRole(o.building!, ids, role));
}

export function setMemberSize(id: string, size: Vec3): boolean {
  const o = target();
  if (!o) return false;
  return commitDesign(o.id, setSize(o.building!, id, size));
}

export function setSelectedInitialDamage(v: number): boolean {
  const o = target();
  const ids = selectedMembers();
  if (!o || !ids.length) return false;
  return commitDesign(o.id, setInitialDamage(o.building!, ids, v));
}

export { regenerate };
