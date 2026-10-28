/**
 * Simulation State → Rendering Adapter → Instanced rendering.
 *
 * Builds GPU batches for every simulated object ONCE per runtime and afterwards only writes
 * transforms / visibility / colors from the (read-only) simulation state each frame:
 *
 *  - every voxel part (tree stump/trunk/canopy, person body/arms, car, pole, lamp head, sign
 *    posts/panel, wall, building shell, shop sign) is one instance in a THREE.BatchedMesh — one
 *    batch per material variant, so the whole city is ~7 draw calls (+ shadow pass) instead of
 *    one per part;
 *  - building facade components (windows, roof panels, parapets, exterior units) are global
 *    InstancedMeshes per kind with per-instance color (broken glass) and hiding (detached);
 *  - picking: BatchedMesh intersections carry `batchId` → `pick()` returns the entity id.
 *
 * Rendering LOD (never touches the simulation): distant trees, people and cars swap to simpler
 * geometry, distant people stop drawing separate arms, and visual-only animation (arm swing,
 * canopy flutter) of distant objects is refreshed at a lower rate.
 *
 * No React here; the simulation core does not know this class exists.
 */
import * as THREE from 'three';
import type { EntityId, ObjectType } from '@/core/types';
import type { BuildingParams } from '@/objects/definitions/building';
import type { TreeParams } from '@/objects/definitions/tree';
import type { HumanParams } from '@/objects/definitions/human';
import type { CarParams } from '@/objects/definitions/car';
import type { StreetLightParams } from '@/objects/definitions/streetLight';
import type { SignParams } from '@/objects/definitions/sign';
import type { WallParams } from '@/objects/definitions/wall';
import type { RuntimeEntity, SimulationRuntime } from '@/simulation/SimulationRuntime';
import { buildMergedGeometry, vertexColorMaterial } from '../views/MergedBoxes';
import { getMaterial } from '../materials';
import { UNIT_BOX } from '../geometry/primitives';
import {
  buildingShellParts, buildingSignParts, carParts, FACADE_KINDS, FACADE_STYLE, facadeColor, humanParts, PART_MATS,
  signParts, streetLightParts, treeParts, wallParts, type BoxPart, type FacadeKind, type PartMat,
} from '../parts/objectParts';

/** Distance (m) beyond which simplified geometry is used (with hysteresis). */
export const LOD_FAR = 110;
const LOD_HYST = 6;
/** Beyond this distance visual-only animation is refreshed every ANIM_STRIDE frames. */
export const ANIM_FAR = 70;
const ANIM_STRIDE = 3;

type Role = 'root' | 'stump' | 'upper' | 'canopy' | 'armL' | 'armR' | 'lamp' | 'panel' | 'shopSign';

interface PartRef {
  batch: PartBatch;
  id: number;
  role: Role;
  /** Offset inside the entity root (scaled object space), applied before animation. */
  local: THREE.Matrix4 | null;
  /** Geometry ids: [near, far] (far = near when the part has no LOD variant). */
  geom: [number, number];
  /** Hidden in the far LOD (detail parts). */
  nearOnly?: boolean;
}

interface EntityView {
  e: RuntimeEntity;
  type: ObjectType;
  index: number;
  scale: THREE.Vector3;
  parts: PartRef[];
  /** Static root matrix (buildings, roads). */
  staticRoot: THREE.Matrix4 | null;
  /** Visual-only animation state (cached between refreshes for distant objects). */
  armL?: THREE.Matrix4;
  armR?: THREE.Matrix4;
  canopy?: THREE.Matrix4;
  shoulderL?: THREE.Vector3;
  shoulderR?: THREE.Vector3;
  pivot?: number;
  far: boolean;
  lastRev: number;
  hidden: boolean;
  /** Facade instances of a building: [kind, instance index, component index]. */
  facade?: [FacadeKind, number, number][];
}

/** One BatchedMesh per material variant. */
class PartBatch {
  mesh!: THREE.BatchedMesh;
  owners: EntityId[] = [];
  private geoms = new Map<string, { parts: BoxPart[]; id: number; verts: number }>();
  private instances = 0;

  constructor(readonly mat: PartMat) {}

  /** Pass 1: register a geometry (deduplicated by content) and count an instance. */
  request(parts: BoxPart[]): string {
    const key = JSON.stringify(parts);
    if (!this.geoms.has(key)) this.geoms.set(key, { parts, id: -1, verts: parts.length * 36 });
    return key;
  }

  reserveInstance() {
    this.instances++;
  }

  /** Pass 2: allocate the batch and upload geometries. */
  build() {
    let verts = 0;
    for (const g of this.geoms.values()) verts += g.verts;
    this.mesh = new THREE.BatchedMesh(Math.max(1, this.instances), Math.max(36, verts), 0, vertexColorMaterial(PART_MATS[this.mat]));
    this.mesh.name = `batch:${this.mat}`;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.sortObjects = false; // opaque: skip per-frame depth sorting
    for (const g of this.geoms.values()) {
      const geo = buildMergedGeometry(g.parts);
      g.id = this.mesh.addGeometry(geo);
      geo.dispose();
    }
  }

  geometryId(key: string) {
    return this.geoms.get(key)!.id;
  }

  add(owner: EntityId, geometryId: number): number {
    const id = this.mesh.addInstance(geometryId);
    this.owners[id] = owner;
    return id;
  }
}

/** Facade components of all buildings, one InstancedMesh per kind. */
class FacadeLayer {
  meshes = {} as Record<FacadeKind, THREE.InstancedMesh>;
  owners = {} as Record<FacadeKind, EntityId[]>;
  private next = { window: 0, roof: 0, wall: 0, exterior: 0 } as Record<FacadeKind, number>;

  constructor(counts: Record<FacadeKind, number>) {
    for (const kind of FACADE_KINDS) {
      const style = FACADE_STYLE[kind];
      const mesh = new THREE.InstancedMesh(UNIT_BOX, getMaterial(kind === 'wall' ? '#ffffff' : style.color, style.mat), Math.max(1, counts[kind]));
      mesh.name = `facade:${kind}`;
      mesh.count = counts[kind];
      mesh.castShadow = style.shadow;
      mesh.receiveShadow = true;
      // Clicks fall through to the building shell behind the part.
      mesh.raycast = () => {};
      this.meshes[kind] = mesh;
      this.owners[kind] = [];
    }
  }

  add(kind: FacadeKind, owner: EntityId, m: THREE.Matrix4, color: THREE.Color): number {
    const i = this.next[kind]++;
    this.meshes[kind].setMatrixAt(i, m);
    this.meshes[kind].setColorAt(i, color);
    this.owners[kind][i] = owner;
    return i;
  }

  finish() {
    for (const kind of FACADE_KINDS) {
      const mesh = this.meshes[kind];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }
}

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const WHITE = new THREE.Color(1, 1, 1);
const BROKEN_GLASS = new THREE.Color(0.1, 0.11, 0.13);
const mRoot = new THREE.Matrix4();
const mTmp = new THREE.Matrix4();
const vPos = new THREE.Vector3();
const vAxis = new THREE.Vector3();
const qA = new THREE.Quaternion();
const qB = new THREE.Quaternion();
const euler = new THREE.Euler();
const vOne = new THREE.Vector3(1, 1, 1);
const vScaleTmp = new THREE.Vector3();

function setQ(q: THREE.Quaternion, a: readonly number[]) {
  return q.set(a[0], a[1], a[2], a[3]);
}

function translation(v: readonly number[]) {
  return new THREE.Matrix4().makeTranslation(v[0], v[1], v[2]);
}

export interface AdapterStats {
  instances: number;
  batches: number;
  facadeInstances: number;
  far: number;
}

export class SimRenderAdapter {
  readonly root = new THREE.Group();
  private batches = new Map<PartMat, PartBatch>();
  private views: EntityView[] = [];
  private facade: FacadeLayer;
  private frame = 0;
  private camPos = new THREE.Vector3();

  constructor(private runtime: SimulationRuntime) {
    this.root.name = 'sim-render-adapter';
    const entities = [...runtime.entities.values()].filter((e) => e.source.type !== 'road');
    const batch = (mat: PartMat) => {
      let b = this.batches.get(mat);
      if (!b) this.batches.set(mat, (b = new PartBatch(mat)));
      return b;
    };

    // ── Pass 1: describe every part, count facade instances ─────────────
    type Req = { batch: PartBatch; near: string; far: string; role: Role; local: THREE.Matrix4 | null; nearOnly?: boolean };
    const reqs: Req[][] = [];
    const facadeCounts = { window: 0, roof: 0, wall: 0, exterior: 0 } as Record<FacadeKind, number>;
    const add = (list: Req[], mat: PartMat, parts: BoxPart[], role: Role, local: THREE.Matrix4 | null = null, lod?: BoxPart[], nearOnly = false) => {
      const b = batch(mat);
      const near = b.request(parts);
      list.push({ batch: b, near, far: lod ? b.request(lod) : near, role, local, nearOnly });
      b.reserveInstance();
    };
    const extra: Pick<EntityView, 'shoulderL' | 'shoulderR' | 'pivot'>[] = [];
    for (const e of entities) {
      const list: Req[] = [];
      const x: Pick<EntityView, 'shoulderL' | 'shoulderR' | 'pivot'> = {};
      const o = e.source;
      switch (o.type) {
        case 'building': {
          const p = o.params as BuildingParams;
          add(list, 'standard', buildingShellParts(p), 'root');
          const sign = o.components.find((c) => c.kind === 'sign');
          if (sign) add(list, 'shopSign', buildingSignParts(sign), 'shopSign', translation(sign.position));
          for (const c of o.components) if ((FACADE_KINDS as string[]).includes(c.kind)) facadeCounts[c.kind as FacadeKind]++;
          break;
        }
        case 'tree': {
          const t = treeParts(o.params as TreeParams, o.seed);
          add(list, 'standard', t.stump, 'stump');
          add(list, 'standard', t.trunk, 'upper');
          add(list, 'foliage', t.canopy, 'canopy', null, t.canopyLod);
          x.pivot = t.pivot;
          break;
        }
        case 'human': {
          const h = humanParts(o.params as HumanParams);
          add(list, 'standard', h.body, 'root', null, h.bodyLod);
          add(list, 'standard', h.arm, 'armL', null, undefined, true);
          add(list, 'standard', h.arm, 'armR', null, undefined, true);
          x.shoulderL = new THREE.Vector3(...h.shoulderL);
          x.shoulderR = new THREE.Vector3(...h.shoulderR);
          break;
        }
        case 'car': {
          const c = carParts(o.params as CarParams);
          add(list, 'car', c.body, 'root', null, c.lod);
          break;
        }
        case 'streetLight': {
          const s = streetLightParts(o.params as StreetLightParams);
          add(list, 'pole', s.pole, 'root');
          add(list, 'lamp', s.head, 'lamp', translation(s.headPos));
          break;
        }
        case 'sign': {
          const s = signParts(o.params as SignParams);
          add(list, 'signPost', s.posts, 'root');
          add(list, 'standard', s.panel, 'panel', translation(s.panelPos));
          break;
        }
        case 'wall':
          add(list, 'standard', wallParts(o.params as WallParams), 'root');
          break;
      }
      reqs.push(list);
      extra.push(x);
    }

    // ── Pass 2: allocate batches, add instances ─────────────────────────
    for (const b of this.batches.values()) {
      b.build();
      this.root.add(b.mesh);
    }
    this.facade = new FacadeLayer(facadeCounts);
    for (const kind of FACADE_KINDS) this.root.add(this.facade.meshes[kind]);

    entities.forEach((e, index) => {
      const view: EntityView = {
        e,
        type: e.source.type,
        index,
        scale: new THREE.Vector3(...e.source.transform.scale),
        parts: reqs[index].map((r) => {
          const near = r.batch.geometryId(r.near);
          return { batch: r.batch, id: r.batch.add(e.id, near), role: r.role, local: r.local, geom: [near, r.batch.geometryId(r.far)], nearOnly: r.nearOnly };
        }),
        staticRoot: null,
        far: false,
        lastRev: -1,
        hidden: false,
        ...extra[index],
      };
      // Animation matrices start at the rest pose (distant objects refresh them less often).
      if (view.type === 'human') {
        view.armL = new THREE.Matrix4().setPosition(view.shoulderL!);
        view.armR = new THREE.Matrix4().setPosition(view.shoulderR!);
      }
      if (view.type === 'tree') view.canopy = new THREE.Matrix4().makeTranslation(0, view.pivot!, 0);
      if (view.type === 'building') this.initBuilding(view);
      this.views.push(view);
    });
    this.facade.finish();
  }

  /** Building shells never move: write their matrices once and add facade instances. */
  private initBuilding(v: EntityView) {
    const t = v.e.source.transform;
    const root = new THREE.Matrix4().compose(
      vPos.set(...t.position),
      qA.setFromEuler(euler.set(t.rotation[0], t.rotation[1], t.rotation[2])),
      v.scale,
    );
    v.staticRoot = root;
    for (const part of v.parts) part.batch.mesh.setMatrixAt(part.id, part.local ? mTmp.multiplyMatrices(root, part.local) : root);
    const p = v.e.source.params as BuildingParams;
    v.facade = [];
    const wallColor = new THREE.Color(facadeColor('wall', p));
    v.e.source.components.forEach((c, ci) => {
      if (!(FACADE_KINDS as string[]).includes(c.kind)) return;
      const kind = c.kind as FacadeKind;
      mTmp.compose(vPos.set(c.position[0], c.position[1], c.position[2]), qB.identity(), vScaleTmp.set(c.size[0], c.size[1], c.size[2]));
      const m = new THREE.Matrix4().multiplyMatrices(root, mTmp);
      const i = this.facade.add(kind, v.e.id, m, kind === 'wall' ? wallColor : WHITE);
      v.facade!.push([kind, i, ci]);
    });
  }

  /** Entity id for a picked object + instance (BatchedMesh batchId / InstancedMesh instanceId). */
  pick(object: THREE.Object3D, id: number | undefined): EntityId | null {
    if (id === undefined) return null;
    for (const b of this.batches.values()) if (b.mesh === object) return b.owners[id] ?? null;
    for (const kind of FACADE_KINDS) if (this.facade.meshes[kind] === object) return this.facade.owners[kind][id] ?? null;
    return null;
  }

  stats(): AdapterStats {
    let instances = 0;
    for (const b of this.batches.values()) instances += b.mesh.instanceCount;
    let facade = 0;
    for (const kind of FACADE_KINDS) facade += this.facade.meshes[kind].count;
    return { instances, batches: this.batches.size, facadeInstances: facade, far: this.views.filter((v) => v.far).length };
  }

  /**
   * Per-frame sync from simulation state. `elapsed` drives visual-only animation;
   * `storm` (0–1) scales canopy flutter.
   */
  update(camera: THREE.Camera, elapsed: number, storm: number) {
    this.frame++;
    camera.getWorldPosition(this.camPos);
    for (const v of this.views) {
      if (v.e.rev !== v.lastRev) this.applyRev(v);
      if (v.hidden || v.type === 'building') continue;
      this.updateLod(v);
      this.updateTransforms(v, elapsed, storm);
    }
  }

  private updateLod(v: EntityView) {
    const p = v.e.pose.position;
    const dx = p[0] - this.camPos.x;
    const dy = p[1] - this.camPos.y;
    const dz = p[2] - this.camPos.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    const far = v.far ? d2 > (LOD_FAR - LOD_HYST) ** 2 : d2 > (LOD_FAR + LOD_HYST) ** 2;
    if (far === v.far) return;
    v.far = far;
    for (const part of v.parts) {
      if (part.geom[0] !== part.geom[1]) part.batch.mesh.setGeometryIdAt(part.id, part.geom[far ? 1 : 0]);
      if (part.nearOnly) part.batch.mesh.setVisibleAt(part.id, !far);
    }
  }

  /** Discrete state changes (bumped `rev`): hidden components, broken glass, collapse. */
  private applyRev(v: EntityView) {
    const e = v.e;
    v.lastRev = e.rev;
    const gone = !!e.flags.collapsed && v.type !== 'tree';
    if (gone !== v.hidden) {
      v.hidden = gone;
      for (const part of v.parts) part.batch.mesh.setVisibleAt(part.id, !gone && !(part.nearOnly && v.far));
    }
    if (v.facade) {
      const touched = new Set<FacadeKind>();
      for (const [kind, i, ci] of v.facade) {
        const c = e.components[ci];
        const mesh = this.facade.meshes[kind];
        if (gone || c.condition === 'detached') {
          mesh.setMatrixAt(i, HIDDEN);
          touched.add(kind);
        }
        if (kind === 'window' && c.condition !== 'intact') {
          mesh.setColorAt(i, BROKEN_GLASS);
          touched.add(kind);
        }
      }
      for (const kind of touched) {
        this.facade.meshes[kind].instanceMatrix.needsUpdate = true;
        if (this.facade.meshes[kind].instanceColor) this.facade.meshes[kind].instanceColor!.needsUpdate = true;
      }
    }
    if (gone) return;
    for (const part of v.parts) {
      const id = part.role === 'lamp' ? 'lamp' : part.role === 'panel' ? 'panel' : part.role === 'shopSign' ? 'sign' : null;
      if (!id) continue;
      const c = e.components.find((x) => x.spec.id === id);
      part.batch.mesh.setVisibleAt(part.id, !c || c.condition !== 'detached');
    }
  }

  private updateTransforms(v: EntityView, elapsed: number, storm: number) {
    const e = v.e;
    // Visual-only animation: every frame nearby, every ANIM_STRIDE-th frame (staggered) beyond.
    const animate = (this.frame + v.index) % (this.isNear(v) ? 1 : ANIM_STRIDE) === 0;
    switch (v.type) {
      case 'tree': {
        const broken = e.flags.snapped || e.flags.uprooted;
        // Upper part (trunk + canopy): falling body or swaying around the base.
        if (broken) this.compose(mRoot, e.pose.position, setQ(qA, e.pose.quaternion), v.scale);
        else this.compose(mRoot, e.initialPose.position, this.swayed(e, e.visual.swayAngle, e.initialPose.quaternion), v.scale);
        if (animate) {
          const s = 1 - 0.38 * e.visual.foliageLoss;
          const ph = (e.source.seed % 1000) * 0.37;
          const k = v.far ? 0 : storm;
          qB.setFromEuler(euler.set(Math.sin(elapsed * 6.3 + ph) * 0.025 * k, 0, Math.sin(elapsed * 7.9 + ph * 1.3) * 0.03 * k));
          v.canopy!.compose(vPos.set(0, v.pivot!, 0), qB, vScaleTmp.set(s, s, s));
        }
        for (const part of v.parts) {
          if (part.role === 'upper') part.batch.mesh.setMatrixAt(part.id, mRoot);
          else if (part.role === 'canopy') part.batch.mesh.setMatrixAt(part.id, mTmp.multiplyMatrices(mRoot, v.canopy!));
        }
        // Stump: stays unless uprooted.
        const stump = v.parts[0];
        if (e.flags.uprooted) this.compose(mRoot, e.pose.position, setQ(qA, e.pose.quaternion), v.scale);
        else this.compose(mRoot, e.initialPose.position, setQ(qA, e.initialPose.quaternion), v.scale);
        stump.batch.mesh.setMatrixAt(stump.id, mRoot);
        return;
      }
      case 'human': {
        const lean = !e.flags.fallen && e.dynamic;
        const q = lean ? this.swayed(e, e.visual.swayAngle, e.pose.quaternion, true) : setQ(qA, e.pose.quaternion);
        this.compose(mRoot, e.pose.position, q, v.scale);
        if (animate && !v.far) {
          const b = e.flags.fallen ? 0.3 : e.visual.brace;
          const t = elapsed * (4 + b * 6) + (e.source.seed % 1000) * 0.01;
          v.armL!.compose(v.shoulderL!, qB.setFromEuler(euler.set(-b * 2.2 + Math.sin(t) * 0.25 * b, 0, -b * 0.4)), vOne);
          v.armR!.compose(v.shoulderR!, qB.setFromEuler(euler.set(-b * 2.0 + Math.cos(t * 1.1) * 0.25 * b, 0, b * 0.4)), vOne);
        }
        for (const part of v.parts) {
          const m = part.role === 'armL' ? v.armL : part.role === 'armR' ? v.armR : null;
          if (m && v.far) continue;
          part.batch.mesh.setMatrixAt(part.id, m ? mTmp.multiplyMatrices(mRoot, m) : mRoot);
        }
        return;
      }
      default: {
        // Cars, street lights, signs, walls: rigid, follow the body pose.
        this.compose(mRoot, e.pose.position, setQ(qA, e.pose.quaternion), v.scale);
        for (const part of v.parts) part.batch.mesh.setMatrixAt(part.id, part.local ? mTmp.multiplyMatrices(mRoot, part.local) : mRoot);
      }
    }
  }

  private isNear(v: EntityView) {
    const p = v.e.pose.position;
    const dx = p[0] - this.camPos.x;
    const dz = p[2] - this.camPos.z;
    return dx * dx + dz * dz < ANIM_FAR * ANIM_FAR;
  }

  private compose(out: THREE.Matrix4, p: readonly number[], q: THREE.Quaternion, s: THREE.Vector3) {
    return out.compose(vPos.set(p[0], p[1], p[2]), q, s);
  }

  /** Rotation around the horizontal sway axis through the base, applied on top of `base`. */
  private swayed(e: RuntimeEntity, angle: number, base: readonly number[], always = false): THREE.Quaternion {
    if (!always && Math.abs(angle) < 1e-4) return setQ(qA, base);
    const a = e.visual.swayAxis;
    vAxis.set(a[0], a[1], a[2]);
    if (vAxis.lengthSq() < 1e-18) vAxis.set(0, 0, 0);
    else vAxis.normalize();
    return qA.setFromAxisAngle(vAxis, angle).multiply(setQ(qB, base));
  }

  dispose() {
    for (const b of this.batches.values()) b.mesh.dispose();
    for (const kind of FACADE_KINDS) this.facade.meshes[kind].dispose();
    this.root.clear();
  }

  /** Runtime this adapter renders (for consumers that need the id → entity mapping). */
  getRuntime() {
    return this.runtime;
  }
}
