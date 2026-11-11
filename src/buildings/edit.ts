/**
 * Member-level edits of a design (Phase 17). Pure: every operation returns a NEW design (the
 * world store commits it as one undo step) and never mutates its input.
 *
 * Ids: generated members keep their structured ids (c<story>-<ix>-<iz> …); members added or
 * duplicated by the user get fresh `u<n>` ids. References (window / door → host wall) are
 * remapped whenever members are copied, so a duplicated wall takes its windows along.
 */
import type { Vec3 } from '@/core/types';
import { createDesign } from './design';
import { beamSection, columnSize, generateMembers, planGrid, slabThickness, storyBase, storyHeight, wallThickness } from './generate';
import type { MaterialId } from './materials';
import { ROLES_BY_TYPE, type BuildingDesign, type BuildingMember, type MemberType, type StructuralRole } from './types';

const clone = (m: BuildingMember): BuildingMember => structuredClone(m);

function bump(d: BuildingDesign, members: BuildingMember[], spec = d.spec): BuildingDesign {
  return { ...d, spec, members, edits: d.edits + 1 };
}

/** Next free user id (`u1`, `u2`, …). */
export function nextUserIds(d: BuildingDesign, count: number): string[] {
  let max = 0;
  for (const m of d.members) {
    const r = /^u(\d+)$/.exec(m.id);
    if (r) max = Math.max(max, Number(r[1]));
  }
  return Array.from({ length: count }, (_, i) => `u${max + 1 + i}`);
}

/** Story (0 … floors−1) containing elevation y. */
export function storyAt(d: BuildingDesign, y: number): number {
  for (let s = d.spec.floors - 1; s >= 0; s--) if (y >= storyBase(d.spec, s) - 1e-6) return s;
  return 0;
}

/** Openings hosted by any of `ids` (cascade for delete / duplicate / move). */
export function hostedBy(d: BuildingDesign, ids: ReadonlySet<string>): string[] {
  return d.members.filter((m) => m.host !== undefined && ids.has(m.host) && !ids.has(m.id)).map((m) => m.id);
}

// ── Floors ───────────────────────────────────────────────────────────

/** Rename a generated id from one story to another (c3-1-2 → c4-1-2). */
function relevel(id: string, from: number, to: number): string | null {
  const r = /^([a-z]+)(\d+)(-.*)?$/.exec(id);
  if (!r || Number(r[2]) !== from) return null;
  return `${r[1]}${to}${r[3] ?? ''}`;
}

/**
 * Add a story on top. Unedited designs are regenerated (exact parametric result); edited designs
 * get a copy of their top story (manual edits kept) and the roof moves up.
 */
export function addFloor(d: BuildingDesign): BuildingDesign {
  const spec = { ...d.spec, floors: d.spec.floors + 1 };
  if (d.edits === 0) return { ...createDesign(spec, d.preset), options: { ...d.options } };
  const top = d.spec.floors - 1;
  const h = d.spec.floorHeight; // height of the new story
  const base = storyBase(d.spec, top);
  const hTop = storyHeight(d.spec, top);
  const stretch = h / hTop; // ≠ 1 only when the copied story is a taller ground story
  const used = new Set(d.members.map((m) => m.id));
  const fresh = (() => {
    const ids = nextUserIds(d, d.members.length);
    let k = 0;
    return () => ids[k++];
  })();
  const remap = new Map<string, string>();
  const copies: BuildingMember[] = [];
  for (const m of d.members) {
    if (m.level !== top) continue;
    const c = clone(m);
    let id = relevel(m.id, top, top + 1);
    if (!id || used.has(id)) id = fresh();
    used.add(id);
    remap.set(m.id, id);
    c.id = id;
    c.level = top + 1;
    if (m.type === 'beam' || m.type === 'slab') {
      // Ceiling members: the new top is h above the old one.
      c.position = [m.position[0], m.position[1] + h, m.position[2]];
    } else if (m.type === 'column' || m.type === 'wall') {
      const bottom = (m.position[1] - m.size[1] / 2 - base) * stretch;
      c.size = [m.size[0], m.size[1] * stretch, m.size[2]];
      c.position = [m.position[0], base + hTop + bottom + c.size[1] / 2, m.position[2]];
    } else {
      // Openings keep their sill height above the story floor.
      c.position = [m.position[0], m.position[1] + hTop, m.position[2]];
    }
    copies.push(c);
  }
  for (const c of copies) if (c.host && remap.has(c.host)) c.host = remap.get(c.host);
  // The old top story needs a floor between it and the new story (halls had none).
  const extra: BuildingMember[] = [];
  if (!d.members.some((m) => m.type === 'slab' && m.level === top)) {
    for (const s of generateMembers({ ...spec, ceiling: true }).members) if (s.type === 'slab' && s.level === top) extra.push(s);
  }
  const moved = d.members.map((m) => (m.level > top ? { ...clone(m), level: m.level + 1, position: [m.position[0], m.position[1] + h, m.position[2]] as Vec3 } : m));
  // The ground story copy does not carry the door: a door only belongs on the ground floor.
  const kept = copies.filter((c) => c.type !== 'door');
  return bump(d, [...moved, ...extra, ...kept], spec);
}

/** Remove the top story (at least one story stays). Roof members move down. */
export function removeFloor(d: BuildingDesign): BuildingDesign {
  if (d.spec.floors <= 1) return d;
  const spec = { ...d.spec, floors: d.spec.floors - 1 };
  if (d.edits === 0) return { ...createDesign(spec, d.preset), options: { ...d.options } };
  const top = d.spec.floors - 1;
  const h = storyHeight(d.spec, top);
  const members = d.members
    .filter((m) => m.level !== top)
    .map((m) => (m.level > top ? { ...clone(m), level: m.level - 1, position: [m.position[0], m.position[1] - h, m.position[2]] as Vec3 } : m));
  const ids = new Set(members.map((m) => m.id));
  return bump(d, members.filter((m) => !m.host || ids.has(m.host) || m.type === 'door'), spec);
}

// ── Members ──────────────────────────────────────────────────────────

/** Default member of a type at a point (building-local), sized from the spec. */
export function newMember(d: BuildingDesign, type: MemberType, at: Vec3, id: string): BuildingMember {
  const spec = d.spec;
  const s = Math.min(spec.floors - 1, Math.max(0, storyAt(d, at[1])));
  const y0 = storyBase(spec, s);
  const h = storyHeight(spec, s);
  const tSlab = slabThickness(spec.slabMaterial);
  const g = planGrid(spec);
  const sMat = spec.structureMaterial;
  const base = { id, type, role: ROLES_BY_TYPE[type][0], level: s, rotation: [0, 0, 0] as Vec3, material: sMat };
  switch (type) {
    case 'column': {
      const b = columnSize(spec, spec.floors - s, g.bx * g.bz, h - tSlab);
      return { ...base, position: [at[0], y0 + (h - tSlab) / 2, at[2]], size: [b, h - tSlab, b] };
    }
    case 'beam': {
      const [w, dep] = beamSection(sMat, g.bx);
      return { ...base, position: [at[0], y0 + h - tSlab - dep / 2, at[2]], size: [g.bx, dep, w] };
    }
    case 'slab':
      return { ...base, material: spec.slabMaterial, position: [at[0], y0 + h - tSlab / 2, at[2]], size: [g.bx, tSlab, g.bz] };
    case 'wall':
      return { ...base, role: 'bearing', position: [at[0], y0 + (h - tSlab) / 2, at[2]], size: [Math.min(g.bx, 4), h - tSlab, wallThickness(sMat, true)] };
    case 'window':
      return { ...base, material: 'glass', position: [at[0], y0 + Math.min(0.9, h / 3) + 0.7, at[2]], size: [1.2, 1.4, 0.06] };
    case 'door':
      return { ...base, level: 0, material: 'timber', position: [at[0], 1.05, at[2]], size: [1, 2.1, 0.08] };
    case 'roof':
      return { ...base, level: spec.floors, material: 'lightCladding', position: [at[0], storyBase(spec, spec.floors) + 0.05, at[2]], size: [g.bx, 0.1, g.bz] };
    case 'foundation':
      return { ...base, level: -1, material: 'reinforcedConcrete', position: [at[0], -0.45, at[2]], size: [1.5, 0.6, 1.5] };
  }
}

export function addMembers(d: BuildingDesign, members: BuildingMember[]): BuildingDesign {
  const used = new Set(d.members.map((m) => m.id));
  for (const m of members) if (used.has(m.id)) throw new Error(`Duplicate member id ${m.id}`);
  return bump(d, [...d.members, ...members.map(clone)]);
}

/** Remove members and the openings they host. Returns the design and every removed id. */
export function removeMembers(d: BuildingDesign, ids: readonly string[]): { design: BuildingDesign; removed: string[] } {
  const set = new Set(ids);
  for (const h of hostedBy(d, set)) set.add(h);
  const members = d.members.filter((m) => !set.has(m.id));
  if (members.length === d.members.length) return { design: d, removed: [] };
  return { design: bump(d, members), removed: d.members.filter((m) => set.has(m.id)).map((m) => m.id) };
}

/** Recompute the story of moved vertical / floor members from their new elevation. */
function relevelMember(d: BuildingDesign, m: BuildingMember): number {
  if (m.type === 'foundation') return -1;
  if (m.type === 'roof') return m.level;
  if (m.level < 0 && m.type === 'slab' && m.position[1] < 0.1) return -1;
  const bottom = m.position[1] - m.size[1] / 2;
  return storyAt(d, bottom + 0.05);
}

/** Move members by a delta (building-local); hosted openings follow their wall. */
export function moveMembers(d: BuildingDesign, ids: readonly string[], delta: Vec3): BuildingDesign {
  const set = new Set(ids);
  for (const h of hostedBy(d, set)) set.add(h);
  const members = d.members.map((m) => {
    if (!set.has(m.id)) return m;
    const c = clone(m);
    c.position = [m.position[0] + delta[0], m.position[1] + delta[1], m.position[2] + delta[2]];
    c.level = relevelMember(d, c);
    return c;
  });
  return bump(d, members);
}

/** Rotate members about a vertical axis through `pivot` (x, z) by `yaw` rad. */
export function rotateMembers(d: BuildingDesign, ids: readonly string[], yaw: number, pivot: [number, number]): BuildingDesign {
  const set = new Set(ids);
  for (const h of hostedBy(d, set)) set.add(h);
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const members = d.members.map((m) => {
    if (!set.has(m.id)) return m;
    const x = m.position[0] - pivot[0];
    const z = m.position[2] - pivot[1];
    const out = clone(m);
    // Rotation about +Y by yaw: x' = x cos + z sin, z' = −x sin + z cos.
    out.position = [pivot[0] + x * c + z * s, m.position[1], pivot[1] - x * s + z * c];
    out.rotation = [m.rotation[0], normalizeAngle(m.rotation[1] + yaw), m.rotation[2]];
    if (out.facade) out.facade = undefined; // no longer on a known facade
    return out;
  });
  return bump(d, members);
}

const normalizeAngle = (a: number) => {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r <= -Math.PI) r += Math.PI * 2;
  return Math.abs(r) < 1e-12 ? 0 : r;
};

/**
 * Copy members (offset by `delta`) with fresh ids. Openings hosted by a copied wall are copied
 * too and re-pointed at the copy. Returns the design and the ids of the copies (old → new).
 */
export function duplicateMembers(d: BuildingDesign, ids: readonly string[], delta: Vec3): { design: BuildingDesign; map: Map<string, string> } {
  const set = new Set(ids);
  for (const h of hostedBy(d, set)) set.add(h);
  const src = d.members.filter((m) => set.has(m.id));
  const fresh = nextUserIds(d, src.length);
  const map = new Map<string, string>();
  src.forEach((m, i) => map.set(m.id, fresh[i]));
  const copies = src.map((m) => {
    const c = clone(m);
    c.id = map.get(m.id)!;
    c.position = [m.position[0] + delta[0], m.position[1] + delta[1], m.position[2] + delta[2]];
    if (c.host) c.host = map.get(c.host) ?? c.host;
    c.level = relevelMember(d, c);
    return c;
  });
  return { design: bump(d, [...d.members, ...copies]), map };
}

export function setMaterial(d: BuildingDesign, ids: readonly string[], material: MaterialId): BuildingDesign {
  const set = new Set(ids);
  return bump(d, d.members.map((m) => (set.has(m.id) && m.material !== material ? { ...clone(m), material } : m)));
}

/** Change roles (only roles allowed for each member's type are applied). */
export function setRole(d: BuildingDesign, ids: readonly string[], role: StructuralRole): BuildingDesign {
  const set = new Set(ids);
  return bump(d, d.members.map((m) => (set.has(m.id) && (ROLES_BY_TYPE[m.type] as readonly string[]).includes(role) ? { ...clone(m), role } : m)));
}

/**
 * Member type changes that keep the box's meaning (Phase 36 §36): an opening stays an opening in the same wall (window
 * ↔ door). Other types differ in geometry and load path (a column is not a wall turned around), so they are not offered
 * — delete the member and add the other type instead.
 */
export const TYPE_SWAPS: Partial<Record<MemberType, readonly MemberType[]>> = { window: ['door'], door: ['window'] };

export function setType(d: BuildingDesign, ids: readonly string[], type: MemberType): BuildingDesign {
  const set = new Set(ids);
  return bump(d, d.members.map((m) => {
    if (!set.has(m.id) || !(TYPE_SWAPS[m.type] ?? []).includes(type)) return m;
    const roles = ROLES_BY_TYPE[type] as readonly StructuralRole[];
    return { ...clone(m), type, role: roles.includes(m.role) ? m.role : roles[0] };
  }));
}

export function setSize(d: BuildingDesign, id: string, size: Vec3): BuildingDesign {
  if (size.some((v) => !Number.isFinite(v) || v <= 0.01)) throw new Error('Invalid member size');
  return bump(d, d.members.map((m) => (m.id === id ? { ...clone(m), size: [...size] as Vec3 } : m)));
}

export function setInitialDamage(d: BuildingDesign, ids: readonly string[], damage: number): BuildingDesign {
  const set = new Set(ids);
  const v = Math.min(1, Math.max(0, damage));
  return bump(d, d.members.map((m) => {
    if (!set.has(m.id)) return m;
    const c = clone(m);
    if (v > 0) c.initialDamage = v;
    else delete c.initialDamage;
    return c;
  }));
}

/** Replace every member's material of one kind of role group (spec-level material change). */
export function replaceMaterial(d: BuildingDesign, from: MaterialId, to: MaterialId, filter: (m: BuildingMember) => boolean): BuildingDesign {
  return bump(d, d.members.map((m) => (m.material === from && filter(m) ? { ...clone(m), material: to } : m)));
}

// ── Snapping ─────────────────────────────────────────────────────────

export const snapToGrid = (v: number, step: number) => (step > 0 ? Math.round(v / step) * step : v);

/** Grid intersections of the plan (column positions of the parametric grid). */
export function gridPoints(d: BuildingDesign): [number, number][] {
  const g = planGrid(d.spec);
  const out: [number, number][] = [];
  for (const x of g.xs) for (const z of g.zs) out.push([x, z]);
  return out;
}

/**
 * Snap a plan position to the nearest structural connection point within `radius`: column
 * centers and grid intersections (for columns), beam / wall lines (for beams / walls).
 */
export function snapToStructure(d: BuildingDesign, type: MemberType, x: number, z: number, radius = 1.5): [number, number] | null {
  let best: [number, number] | null = null;
  let bestD = radius;
  const consider = (px: number, pz: number) => {
    const dist = Math.hypot(px - x, pz - z);
    if (dist < bestD) { bestD = dist; best = [px, pz]; }
  };
  if (type === 'column' || type === 'foundation') {
    for (const [px, pz] of gridPoints(d)) consider(px, pz);
    for (const m of d.members) if (m.type === 'column') consider(m.position[0], m.position[2]);
    return best;
  }
  // Lines: midpoints between neighbouring grid points along x and z.
  const g = planGrid(d.spec);
  for (const z of g.zs) for (let i = 0; i < g.nx; i++) consider(g.xs[i] + g.bx / 2, z);
  for (const xx of g.xs) for (let i = 0; i < g.nz; i++) consider(xx, g.zs[i] + g.bz / 2);
  if (type === 'slab' || type === 'roof') for (let i = 0; i < g.nx; i++) for (let j = 0; j < g.nz; j++) consider(g.xs[i] + g.bx / 2, g.zs[j] + g.bz / 2);
  return best;
}

/** Elevation that puts a member of `type` on the floor of story `s` (center y). */
export function floorElevation(d: BuildingDesign, m: Pick<BuildingMember, 'type' | 'size'>, s: number): number {
  const y0 = storyBase(d.spec, s);
  const h = storyHeight(d.spec, s);
  const tSlab = slabThickness(d.spec.slabMaterial);
  switch (m.type) {
    case 'beam': return y0 + h - tSlab - m.size[1] / 2;
    case 'slab': return y0 + h - m.size[1] / 2;
    case 'window': return y0 + Math.min(0.9, h / 3) + m.size[1] / 2;
    default: return y0 + m.size[1] / 2;
  }
}
