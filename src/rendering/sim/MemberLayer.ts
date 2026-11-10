/**
 * Members of modular buildings (Phase 17), drawn as ONE InstancedMesh per material look for the
 * whole scene (concrete, steel, timber, masonry, glass, cladding) — draw calls do not grow with
 * the number of buildings or members, and no React component / useFrame exists per member.
 *
 *  - per-instance color: material color (cladding / parapets tinted by the facade color),
 *    darkened toward a cracked tone by member damage, broken glass dark;
 *  - failed / detached members: zero-scale matrix (debris bodies take over);
 *  - interior members (enclosed by the envelope) and the underground foundation are culled in
 *    batched views until the envelope opens (a facade part detaches, a story collapses) or the
 *    building editor reveals them;
 *  - picking: a custom raycast tests each building's bounds first and only then its members
 *    (three's InstancedMesh.raycast would test every instance of the scene).
 */
import * as THREE from 'three';
import type { EntityId } from '@/core/types';
import { MATERIAL_LOOK, MATERIAL_LOOKS, type MaterialLook } from '@/buildings/materials';
import { memberColor } from '@/buildings/memberColor';
import type { BuildingMember, BuildingDesign } from '@/buildings/types';
import { memberBounds } from '@/buildings/geometry';
import { UNIT_BOX } from '../geometry/primitives';
import { getMaterial } from '../materials';
import { GLASS_MAT } from '../parts/objectParts';

const LOOK_MAT: Record<MaterialLook, { roughness?: number; metalness?: number; emissive?: string; emissiveIntensity?: number }> = {
  concrete: { roughness: 0.92 },
  steel: { roughness: 0.45, metalness: 0.55 },
  timber: { roughness: 0.85 },
  masonry: { roughness: 0.96 },
  glass: GLASS_MAT,
  cladding: { roughness: 0.55, metalness: 0.3 },
};

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const CRACKED = new THREE.Color('#4a3f38');
const RUBBLE = new THREE.Color('#6f675e');
const BROKEN_GLASS = new THREE.Color(0.1, 0.11, 0.13);
const mLocal = new THREE.Matrix4();
const mWorld = new THREE.Matrix4();
const mInv = new THREE.Matrix4();
const vP = new THREE.Vector3();
const vS = new THREE.Vector3();
const qR = new THREE.Quaternion();
const eR = new THREE.Euler();
const cTmp = new THREE.Color();
const ray = new THREE.Ray();
const box = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
const hit = new THREE.Vector3();

export { memberColor };

/** Local matrix of a member box (building space, before the object's own transform). */
export function memberMatrix(m: BuildingMember, out: THREE.Matrix4): THREE.Matrix4 {
  return out.compose(vP.set(m.position[0], m.position[1], m.position[2]), qR.setFromEuler(eR.set(m.rotation[0], m.rotation[1], m.rotation[2])), vS.set(m.size[0], m.size[1], m.size[2]));
}

/**
 * Displacement of a fallen member (Phase 25, collapse model): offset in the building's UNSCALED local
 * frame, vertical scale (compaction into rubble) and a visual-only tilt.
 */
export interface MemberOffset {
  dx: number;
  dy: number;
  dz: number;
  sy: number;
  /** Tilt about a horizontal axis (rad), visual only (broken pieces). */
  tilt: number;
  tiltAxis: 0 | 1;
  /** Phase 35.5: physical orientation from the collapse model (rotation about a hinge, building-local quaternion), or null. */
  q?: readonly [number, number, number, number] | Float32Array | null;
}

const qT = new THREE.Quaternion();
const qP = new THREE.Quaternion();
const vX = new THREE.Vector3(1, 0, 0);
const vZ = new THREE.Vector3(0, 0, 1);

/** Local matrix of a displaced / compacted member. */
export function displacedMatrix(m: BuildingMember, o: MemberOffset, out: THREE.Matrix4): THREE.Matrix4 {
  qR.setFromEuler(eR.set(m.rotation[0], m.rotation[1], m.rotation[2]));
  if (o.q) qR.premultiply(qP.set(o.q[0], o.q[1], o.q[2], o.q[3]));
  if (o.tilt !== 0) qR.premultiply(qT.setFromAxisAngle(o.tiltAxis ? vZ : vX, o.tilt));
  return out.compose(vP.set(m.position[0] + o.dx, m.position[1] + o.dy, m.position[2] + o.dz), qR, vS.set(m.size[0], m.size[1] * o.sy, m.size[2]));
}

/** A building's member instances in the layer. */
export interface MemberSet {
  owner: EntityId;
  design: BuildingDesign;
  /** [look index, instance id] per member (look −1 = not drawn). */
  look: Int8Array;
  inst: Int32Array;
  /** Culled until revealed (interior / foundation). */
  interior: Uint8Array;
  /** World bounds of the building (picking). */
  bounds: THREE.Box3;
  revealed: boolean;
  /** Current object root matrix (static or earthquake-deformed). */
  root: THREE.Matrix4;
  /** Base color per member (rgb), computed once (no per-frame color parsing). */
  base: Float32Array;
}

/** Interior / underground members of a design (culled in batched views). */
export function interiorMask(design: BuildingDesign, hasComponent: (id: string) => boolean): Uint8Array {
  const out = new Uint8Array(design.members.length);
  let hx = 0, hz = 0, top = 0;
  for (const m of design.members) {
    if (m.level < 0) continue;
    const b = memberBounds(m);
    hx = Math.max(hx, -b.min[0], b.max[0]);
    hz = Math.max(hz, -b.min[2], b.max[2]);
    if (m.type === 'slab') top = Math.max(top, m.level);
  }
  const edge = 0.45;
  design.members.forEach((m, i) => {
    if (hasComponent(m.id) || m.type === 'window' || m.type === 'door' || m.type === 'roof') return;
    if (m.level < 0) {
      out[i] = 1;
      return;
    }
    if (m.type === 'slab' && m.level >= top) return;
    const b = memberBounds(m);
    const perimeter = b.min[0] <= -hx + edge || b.max[0] >= hx - edge || b.min[2] <= -hz + edge || b.max[2] >= hz - edge;
    if (!perimeter) out[i] = 1;
  });
  return out;
}

export class MemberLayer {
  readonly meshes: THREE.InstancedMesh[] = [];
  /** Owner entity per instance, per look. */
  private owners: EntityId[][] = [];
  /** Member index per instance, per look. */
  private members: Int32Array[] = [];
  private next: number[] = [];
  readonly sets: MemberSet[] = [];
  private byOwner = new Map<EntityId, MemberSet>();

  constructor(counts: number[]) {
    MATERIAL_LOOKS.forEach((look, li) => {
      const mesh = new THREE.InstancedMesh(UNIT_BOX, getMaterial('#ffffff', LOOK_MAT[look]), Math.max(1, counts[li]));
      mesh.name = `members:${look}`;
      mesh.count = counts[li];
      mesh.castShadow = look !== 'glass';
      mesh.receiveShadow = true;
      mesh.visible = counts[li] > 0;
      const layer = this;
      mesh.raycast = function (raycaster, intersects) {
        layer.raycast(li, this as THREE.InstancedMesh, raycaster, intersects);
      };
      this.meshes.push(mesh);
      this.owners.push([]);
      this.members.push(new Int32Array(Math.max(1, counts[li])).fill(-1));
      this.next.push(0);
    });
  }

  /** Instances needed per look for a design (pass 1). */
  static count(design: BuildingDesign, counts: number[]) {
    for (const m of design.members) counts[MATERIAL_LOOKS.indexOf(MATERIAL_LOOK[m.material])]++;
  }

  /** Add a building's members (pass 2). `root`: object matrix. */
  add(owner: EntityId, design: BuildingDesign, root: THREE.Matrix4, interior: Uint8Array): MemberSet {
    const n = design.members.length;
    const set: MemberSet = { owner, design, look: new Int8Array(n), inst: new Int32Array(n), interior, bounds: new THREE.Box3(), revealed: false, root: root.clone(), base: new Float32Array(3 * n) };
    const colors = new Map<string, THREE.Color>();
    design.members.forEach((m, i) => {
      const hex = memberColor(m, design);
      let c = colors.get(hex);
      if (!c) colors.set(hex, (c = new THREE.Color(hex)));
      set.base[3 * i] = c.r;
      set.base[3 * i + 1] = c.g;
      set.base[3 * i + 2] = c.b;
      const li = MATERIAL_LOOKS.indexOf(MATERIAL_LOOK[m.material]);
      const id = this.next[li]++;
      set.look[i] = li;
      set.inst[i] = id;
      this.owners[li][id] = owner;
      this.members[li][id] = i;
      const mesh = this.meshes[li];
      mesh.setMatrixAt(id, interior[i] ? HIDDEN : mWorld.multiplyMatrices(root, memberMatrix(m, mLocal)));
      mesh.setColorAt(id, cTmp.setRGB(set.base[3 * i], set.base[3 * i + 1], set.base[3 * i + 2]));
      if (!interior[i]) {
        const b = memberBounds(m);
        set.bounds.union(new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max)));
      }
    });
    set.bounds.applyMatrix4(root);
    this.sets.push(set);
    this.byOwner.set(owner, set);
    return set;
  }

  finish() {
    for (const mesh of this.meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  get(owner: EntityId): MemberSet | undefined {
    return this.byOwner.get(owner);
  }

  /**
   * Write a building's member matrices with `root` (static placement or the earthquake shear),
   * hiding failed / detached members and culled interior members.
   */
  writeMatrices(set: MemberSet, root: THREE.Matrix4, gone: (i: number) => boolean, offset?: (i: number) => MemberOffset | null) {
    set.root.copy(root);
    const ms = set.design.members;
    for (let i = 0; i < ms.length; i++) {
      const mesh = this.meshes[set.look[i]];
      if (gone(i) || (set.interior[i] && !set.revealed)) { mesh.setMatrixAt(set.inst[i], HIDDEN); continue; }
      const o = offset?.(i);
      mesh.setMatrixAt(set.inst[i], mWorld.multiplyMatrices(root, o ? displacedMatrix(ms[i], o, mLocal) : memberMatrix(ms[i], mLocal)));
    }
  }

  /**
   * Per-member colors: damage darkens toward a cracked tone; broken glass goes dark; `mul` tints.
   * `override` (Phase 25 structural views): a color for the member instead (demand / capacity,
   * failure state, collapse sequence) — or null for the normal look.
   */
  writeColors(set: MemberSet, damage: (i: number) => number, broken: (i: number) => boolean, mul?: THREE.Color, override?: (i: number, out: THREE.Color) => boolean) {
    const ms = set.design.members;
    const b = set.base;
    for (let i = 0; i < ms.length; i++) {
      if (override && override(i, cTmp)) { this.meshes[set.look[i]].setColorAt(set.inst[i], cTmp); continue; }
      if (broken(i)) cTmp.copy(BROKEN_GLASS);
      else {
        cTmp.setRGB(b[3 * i], b[3 * i + 1], b[3 * i + 2]);
        const d = damage(i);
        if (d > 1.5) cTmp.lerp(RUBBLE, 0.55); // fallen / crushed (Phase 25: damage code 2)
        else if (d > 0.02) cTmp.lerp(CRACKED, Math.min(0.75, 0.15 + 0.6 * Math.min(1, d)));
      }
      if (mul) cTmp.multiply(mul);
      this.meshes[set.look[i]].setColorAt(set.inst[i], cTmp);
    }
  }

  markDirty(colors = true) {
    for (const mesh of this.meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      if (colors && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Owner entity + member index of an instance of look mesh `object`. */
  pick(object: THREE.Object3D, id: number | undefined): { owner: EntityId; member: number } | null {
    if (id === undefined) return null;
    const li = this.meshes.indexOf(object as THREE.InstancedMesh);
    if (li < 0) return null;
    const owner = this.owners[li][id];
    return owner ? { owner, member: this.members[li][id] } : null;
  }

  private raycast(li: number, mesh: THREE.InstancedMesh, raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) {
    if (!mesh.visible) return;
    for (const set of this.sets) {
      if (!raycaster.ray.intersectsBox(set.bounds)) continue;
      const ms = set.design.members;
      for (let i = 0; i < ms.length; i++) {
        if (set.look[i] !== li) continue;
        const id = set.inst[i];
        mesh.getMatrixAt(id, mWorld);
        if (mWorld.elements[0] === 0 && mWorld.elements[5] === 0 && mWorld.elements[10] === 0) continue; // hidden
        mWorld.premultiply(mesh.matrixWorld);
        mInv.copy(mWorld).invert();
        ray.copy(raycaster.ray).applyMatrix4(mInv);
        if (!ray.intersectBox(box, hit)) continue;
        hit.applyMatrix4(mWorld);
        const distance = raycaster.ray.origin.distanceTo(hit);
        if (distance < raycaster.near || distance > raycaster.far) continue;
        intersects.push({ distance, point: hit.clone(), object: mesh, instanceId: id, face: null });
      }
    }
  }

  dispose() {
    for (const m of this.meshes) m.dispose();
  }
}
