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
 * Earthquake (Phase 13, render-only): buildings are drawn sheared by their computed top
 * displacement and moved with the ground/foundation displacement (× a visual exaggeration),
 * tilted by the residual foundation tilt, tinted by their drift demand, and show crack marks;
 * every other object moves with the ground under it. Nothing here feeds back into physics.
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
import { flatSampler, type TerrainSampler } from '@/terrain/TerrainSampler';
import { foundationPlinth } from '@/terrain/groundPlacement';
import { seededRandom } from '@/core/math';
import {
  buildingPlinthParts, buildingShellParts, buildingSignParts, carParts, FACADE_KINDS, FACADE_STYLE, facadeColor, humanParts, PART_MATS,
  signParts, streetLightParts, treeParts, wallParts, type BoxPart, type FacadeKind, type PartMat,
} from '../parts/objectParts';
import { MATERIAL_LOOKS } from '@/buildings/materials';
import { MemberLayer, interiorMask, type MemberOffset, type MemberSet } from './MemberLayer';
import { MS, OVERLOAD } from '@/structure/types';
import { hashString } from '@/core/math';
import { useViewStore, type StructureColorMode } from '../viewStore';
import type { ThermalRuntime } from '@/simulation/thermal/runtime';
import { factorColor, temperatureColor, utilColor } from '../thermal/thermalColors';

/** Distance (m) beyond which simplified geometry is used (with hysteresis). */
export const LOD_FAR = 110;
/** Structural view colors (Phase 25). */
const DEMAND_LOW = new THREE.Color('#3fbf7f');
const DEMAND_MID = new THREE.Color('#f2c94c');
const FAILED_RED = new THREE.Color('#e0443a');
const SEVERE_ORANGE = new THREE.Color('#f08a24');
const DEMAND_NONE = new THREE.Color('#9aa1a8');
const SEQ_EARLY = new THREE.Color('#3a7bd5');
const LOD_HYST = 6;
/** Beyond this distance visual-only animation is refreshed every ANIM_STRIDE frames. */
export const ANIM_FAR = 70;
const ANIM_STRIDE = 3;

type Role = 'root' | 'stump' | 'upper' | 'canopy' | 'armL' | 'armR' | 'lamp' | 'panel' | 'shopSign' | 'plinth';

/** Earthquake drawing options for a frame (from the view store). */
export interface QuakeRenderOptions {
  /** Visual displacement exaggeration (1 = true scale). */
  exaggeration: number;
  /** Tint structures by their drift demand. */
  stress: boolean;
}

const CRACKS_PER_BUILDING = 8;

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
  /** Hidden by the editor (drawn elsewhere while selected / dragged). Phase 16. */
  userHidden?: boolean;
  /** Facade instances of a building: [kind, instance index, component index]. */
  facade?: [FacadeKind, number, number][];
  /** Facade part matrices in the building's local frame (earthquake deformation). */
  facadeLocal?: THREE.Matrix4[];
  /** Crack overlay instances (index into the crack mesh) and their local matrices. */
  cracks?: { index: number; local: THREE.Matrix4 }[];
  /** Earthquake drawing state last applied (skip unchanged frames). */
  quakeKey?: number;
  /** Ground deformation pose last applied (Phase 21). */
  groundKey?: number;
  cracksShown?: number;
  tint?: number;
  /** Flood: wetness tint last applied (0 = dry; quantized). */
  wet?: number;
  /** Modular building (Phase 17): its member instances and member → component index. */
  members?: MemberSet;
  memberComp?: Int32Array;
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

const mShear = new THREE.Matrix4();
const mTilt = new THREE.Matrix4();
const vShaken: [number, number, number] = [0, 0, 0];
const cTint = new THREE.Color();
/** Wet / submerged look: darker and bluer (multiplies the part colors). */
const WET = new THREE.Color(0.5, 0.62, 0.78);
const TINT_STOPS = [new THREE.Color(1, 1, 1), new THREE.Color(1, 0.93, 0.45), new THREE.Color(1, 0.62, 0.3), new THREE.Color(1, 0.36, 0.32)];

/** Drift demand (0 … 3, × slight-damage drift) → shell tint (white = unstressed). */
export function tintColor(x: number, out: THREE.Color): THREE.Color {
  const i = Math.min(TINT_STOPS.length - 2, Math.floor(x));
  return out.copy(TINT_STOPS[i]).lerp(TINT_STOPS[i + 1], Math.min(1, x - i));
}

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
  private byId = new Map<EntityId, EntityView>();
  private facade: FacadeLayer;
  private frame = 0;
  private camPos = new THREE.Vector3();

  private crackMesh: THREE.InstancedMesh;
  private quake: QuakeRenderOptions | null = null;
  /** Members of modular buildings (Phase 17); null when the scene has none. */
  private memberLayer: MemberLayer | null = null;

  constructor(private runtime: SimulationRuntime, terrain: TerrainSampler = flatSampler()) {
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
    const memberCounts = MATERIAL_LOOKS.map(() => 0);
    let modular = 0;
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
          if (o.building) {
            // Modular building (Phase 17): every member is an instance of the member layer; the
            // batch only carries the slope plinth and the shop sign. Rooftop units stay facade.
            modular++;
            MemberLayer.count(o.building, memberCounts);
            const plinth = buildingPlinthParts(p, foundationPlinth(o, terrain) / o.transform.scale[1]);
            if (plinth.length) add(list, 'standard', plinth, 'plinth');
            const sign = o.components.find((c) => c.kind === 'sign');
            if (sign) add(list, 'shopSign', buildingSignParts(sign), 'shopSign', translation(sign.position));
            for (const c of o.components) if (c.kind === 'exterior') facadeCounts.exterior++;
            break;
          }
          add(list, 'standard', buildingShellParts(p), 'root');
          // Slope foundation plinth (Phase 13; none on flat ground).
          const plinth = buildingPlinthParts(p, foundationPlinth(o, terrain) / o.transform.scale[1]);
          if (plinth.length) add(list, 'standard', plinth, 'plinth');
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
    if (modular > 0) {
      this.memberLayer = new MemberLayer(memberCounts);
      for (const m of this.memberLayer.meshes) this.root.add(m);
    }
    const buildings = entities.filter((e) => e.source.type === 'building').length;
    this.crackMesh = new THREE.InstancedMesh(UNIT_BOX, getMaterial('#2a2622', { roughness: 1 }), Math.max(1, buildings * CRACKS_PER_BUILDING));
    this.crackMesh.name = 'quake:cracks';
    this.crackMesh.count = buildings * CRACKS_PER_BUILDING;
    for (let i = 0; i < this.crackMesh.count; i++) this.crackMesh.setMatrixAt(i, HIDDEN);
    this.crackMesh.raycast = () => {};
    this.crackMesh.frustumCulled = false;
    this.crackMesh.visible = false; // no draw call until the first crack appears
    this.root.add(this.crackMesh);

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
      this.byId.set(e.id, view);
    });
    this.facade.finish();
    this.memberLayer?.finish();
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
    v.facadeLocal = [];
    const wallColor = new THREE.Color(facadeColor('wall', p));
    const design = v.e.source.building;
    if (design && this.memberLayer) {
      const comps = new Map(v.e.source.components.map((c, i) => [c.id, i]));
      v.memberComp = Int32Array.from(design.members, (m) => comps.get(m.id) ?? -1);
      v.members = this.memberLayer.add(v.e.id, design, root, interiorMask(design, (id) => comps.has(id)));
    }
    v.e.source.components.forEach((c, ci) => {
      if (!(FACADE_KINDS as string[]).includes(c.kind)) return;
      if (design && c.kind !== 'exterior') return; // modular: drawn as members
      const kind = c.kind as FacadeKind;
      const local = new THREE.Matrix4().compose(vPos.set(c.position[0], c.position[1], c.position[2]), qB.identity(), vScaleTmp.set(c.size[0], c.size[1], c.size[2]));
      const m = new THREE.Matrix4().multiplyMatrices(root, local);
      const i = this.facade.add(kind, v.e.id, m, kind === 'wall' ? wallColor : WHITE);
      v.facade!.push([kind, i, ci]);
      v.facadeLocal!.push(local);
    });
    // Crack marks: thin dark diagonal strips at seeded spots on the facades (hidden until cracked).
    const rnd = seededRandom((v.e.source.seed ^ 0x6b43a9b5) >>> 0);
    const H = p.floors * p.floorHeight;
    v.cracks = [];
    for (let k = 0; k < CRACKS_PER_BUILDING; k++) {
      const face = Math.floor(rnd() * 4);
      const along = (rnd() - 0.5) * 0.8;
      const y = Math.min(H - 0.5, (Math.floor(rnd() * p.floors) + 0.35 + rnd() * 0.3) * p.floorHeight);
      const len = 0.9 + rnd() * 1.4;
      const angle = (rnd() < 0.5 ? -1 : 1) * (0.55 + rnd() * 0.35);
      const nx = face === 0 ? 0 : face === 1 ? 0 : face === 2 ? 1 : -1;
      const nz = face === 0 ? 1 : face === 1 ? -1 : 0;
      const pos = nz !== 0 ? [along * p.width, y, nz * (p.depth / 2 + 0.05)] : [nx * (p.width / 2 + 0.05), y, along * p.depth];
      // Rotate in the facade plane: about the facade normal.
      qB.setFromAxisAngle(vAxis.set(nx, 0, nz), angle);
      const local = new THREE.Matrix4().compose(vPos.set(pos[0], pos[1], pos[2]), qB, vScaleTmp.set(nz !== 0 ? len : 0.06, 0.07, nz !== 0 ? 0.06 : len));
      v.cracks.push({ index: this.nextCrack++, local });
    }
  }

  private nextCrack = 0;

  /** Entity id for a picked object + instance (BatchedMesh batchId / InstancedMesh instanceId). */
  pick(object: THREE.Object3D, id: number | undefined): EntityId | null {
    if (id === undefined) return null;
    const member = this.memberLayer?.pick(object, id);
    if (member) return member.owner;
    for (const b of this.batches.values()) if (b.mesh === object) return b.owners[id] ?? null;
    for (const kind of FACADE_KINDS) if (this.facade.meshes[kind] === object) return this.facade.owners[kind][id] ?? null;
    return null;
  }

  /** Modular building member under a picked instance (building editor, Phase 17). */
  pickMember(object: THREE.Object3D, id: number | undefined): { owner: EntityId; member: number } | null {
    return this.memberLayer?.pick(object, id) ?? null;
  }

  /** Show / hide the culled interior members of a modular building (building editor x-ray). */
  setRevealed(id: EntityId, revealed: boolean) {
    const v = this.byId.get(id);
    if (!v?.members || v.members.revealed === revealed) return;
    v.members.revealed = revealed;
    this.writeMembers(v, v.members.root);
  }

  private memberGone(v: EntityView): (i: number) => boolean {
    const e = v.e;
    const mr = e.modular;
    const comp = v.memberComp!;
    const model = mr?.structure?.model;
    if (v.userHidden || (v.hidden && !model)) return () => true;
    const ms = v.members!.design.members;
    const far = v.far;
    // Phase 25: members are drawn from the collapse model — fallen members stay visible where they
    // came to rest; only what the physics engine / rubble field / fines took over is hidden.
    if (model) return (i: number) => model.external[i] === 1 || model.state[i] === MS.ABSENT || (far && (ms[i].type === 'window' || ms[i].type === 'door'));
    return (i: number) => (mr !== undefined && mr.failed[i] === 1) || (comp[i] >= 0 && e.components[comp[i]].condition === 'detached')
      || (far && (ms[i].type === 'window' || ms[i].type === 'door'));
  }

  private offsetOut: MemberOffset = { dx: 0, dy: 0, dz: 0, sy: 1, tilt: 0, tiltAxis: 0 };

  /** Displacement of fallen members from the collapse model (unscaled local frame); tilt visual only. */
  private memberOffset(v: EntityView): ((i: number) => MemberOffset | null) | undefined {
    const model = v.e.modular?.structure?.model;
    if (!model) return undefined;
    const k = v.scale, o = this.offsetOut;
    return (i: number) => {
      const st = model.state[i];
      if (st <= MS.SEVERE || st === MS.ABSENT) return null;
      o.dx = model.dx[i] / k.x;
      o.dy = model.dy[i] / k.y;
      o.dz = model.dz[i] / k.z;
      o.sy = model.sy[i];
      // Broken pieces at rest are drawn slightly askew (deterministic per member; visual only).
      if (st === MS.RESTING || st === MS.SETTLED) {
        const h = hashString(`${v.e.id}/${i}`) >>> 0;
        o.tilt = (((h & 1023) / 1023) - 0.5) * 0.5;
        o.tiltAxis = (h >> 10) & 1 ? 1 : 0;
      } else o.tilt = 0;
      return o;
    };
  }

  private writeMembers(v: EntityView, root: THREE.Matrix4) {
    this.memberLayer!.writeMatrices(v.members!, root, this.memberGone(v), this.memberOffset(v));
    this.memberLayer!.markDirty(false);
  }

  private writeMemberColors(v: EntityView, mul?: THREE.Color) {
    const e = v.e;
    const mr = e.modular;
    const comp = v.memberComp!;
    const ms = v.members!.design.members;
    const model = mr?.structure?.model;
    this.memberLayer!.writeColors(
      v.members!,
      (i) => (model && model.state[i] > MS.SEVERE ? 2 : mr ? mr.damage[i] : ms[i].initialDamage ?? 0),
      (i) => ms[i].type === 'window' && ((mr !== undefined && mr.failed[i] === 1) || (comp[i] >= 0 && e.components[comp[i]].condition !== 'intact')),
      mul,
      this.structureColor(v),
    );
    this.memberLayer!.markDirty(true);
  }

  private colorMode: StructureColorMode = 'normal';
  /** Thermal state of the run (Phase 26) for the thermal member colors; set by the layer. */
  thermal: (() => ThermalRuntime | null) | null = null;
  private thermalScale = 300;

  private static readonly THERMAL_MODES = new Set<StructureColorMode>(['temperature', 'thermalStress', 'strength']);

  /** Member colors from the computed thermal state (render-only): temperature, thermal stress, strength. */
  private thermalColor(v: EntityView, mode: StructureColorMode): ((i: number, out: THREE.Color) => boolean) | undefined {
    const rt = this.thermal?.();
    const bt = rt?.entity(v.e.id)?.b;
    if (!rt || !bt) return (_i, out) => { out.copy(DEMAND_NONE); return true; };
    const B = rt.world.bodies, scale = this.thermalScale;
    const model = v.e.modular?.structure?.model;
    return (i, out) => {
      const b = bt.body[i];
      if (b < 0) { out.copy(DEMAND_NONE); return true; }
      // Members within 1 K of the ambient keep their material look (the scale starts at 0 °C).
      if (mode === 'temperature') { if (Math.abs(B.TS[b] - rt.world.Tref) < 1) return false; temperatureColor(B.TS[b] - 273.15, scale, out); return true; }
      if (model && model.state[i] > MS.SEVERE) { out.copy(FAILED_RED); return true; }
      if (!bt.g.structural[i]) { out.copy(DEMAND_NONE); return true; }
      if (mode === 'strength') factorColor(bt.fApplied[i], out);
      else utilColor(bt.util[i], out);
      return true;
    };
  }

  /**
   * Member colors of the structural views (Phase 25) — all from computed state: demand / capacity
   * (green → yellow → red at the failure utilization), member state (damaged / severe / failed), the
   * collapse sequence (failure time, early blue → late red). Null for the normal look.
   */
  private structureColor(v: EntityView): ((i: number, out: THREE.Color) => boolean) | undefined {
    const mode = this.colorMode;
    if (mode === 'normal') return undefined;
    if (SimRenderAdapter.THERMAL_MODES.has(mode)) return this.thermalColor(v, mode);
    const mr = v.e.modular;
    const model = mr?.structure?.model;
    const g = model?.g;
    if (mode === 'demand') {
      const a = mr?.initial;
      return (i, out) => {
        const structural = g ? g.structural[i] : a ? a.members[i].bearing : false;
        if (!structural) { out.copy(DEMAND_NONE); return true; }
        if (model && model.state[i] > MS.SEVERE) { out.copy(FAILED_RED).multiplyScalar(0.6); return true; }
        const u = Math.min(1, (model ? model.s.util[i] : a?.members[i].utilization ?? 0) / OVERLOAD);
        if (u < 0.5) out.copy(DEMAND_LOW).lerp(DEMAND_MID, u / 0.5);
        else out.copy(DEMAND_MID).lerp(FAILED_RED, (u - 0.5) / 0.5);
        return true;
      };
    }
    if (!model) return undefined;
    if (mode === 'failure') {
      return (i, out) => {
        const st = model.state[i];
        if (st > MS.SEVERE && st !== MS.ABSENT) { out.copy(FAILED_RED); return true; }
        if (st === MS.SEVERE) { out.copy(SEVERE_ORANGE); return true; }
        if (st === MS.DAMAGED) { out.copy(DEMAND_MID); return true; }
        return false;
      };
    }
    const recs = model.records;
    const t0 = recs.length ? recs[0].time : 0, t1 = recs.length ? recs[recs.length - 1].time : 1;
    return (i, out) => {
      const t = model.failTime[i];
      if (!(t === t)) { out.copy(DEMAND_NONE); return true; }
      const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      out.copy(SEQ_EARLY).lerp(FAILED_RED, f);
      return true;
    };
  }

  stats(): AdapterStats {
    let instances = 0;
    for (const b of this.batches.values()) instances += b.mesh.instanceCount;
    let facade = 0;
    for (const kind of FACADE_KINDS) facade += this.facade.meshes[kind].count;
    if (this.memberLayer) for (const m of this.memberLayer.meshes) facade += m.count;
    return { instances, batches: this.batches.size, facadeInstances: facade, far: this.views.filter((v) => v.far).length };
  }

  /**
   * Per-frame sync from simulation state. `elapsed` drives visual-only animation;
   * `storm` (0–1) scales canopy flutter.
   */
  update(camera: THREE.Camera, elapsed: number, storm: number, quake: QuakeRenderOptions | null = null) {
    this.frame++;
    const vs = useViewStore.getState();
    const mode = vs.structureViz.color;
    // Thermal member colors follow the changing temperatures: refreshed every 15 frames (Phase 26).
    const thermalRefresh = SimRenderAdapter.THERMAL_MODES.has(mode) && this.frame % 15 === 0;
    if (mode !== this.colorMode || thermalRefresh || vs.thermalViz.scale !== this.thermalScale) {
      this.colorMode = mode;
      this.thermalScale = vs.thermalViz.scale;
      const rt = this.thermal?.();
      if (this.memberLayer) for (const v of this.views) if (v.members && (!thermalRefresh || rt?.entity(v.e.id)?.b)) this.writeMemberColors(v, (v.tint ?? 0) > 0 ? tintColor(v.tint!, cTint) : undefined);
    }
    camera.getWorldPosition(this.camPos);
    // Earthquake drawing only once the earthquake systems exist (wind-only runs: unchanged path).
    this.quake = quake && this.runtime.seismic ? quake : null;
    let cracksDirty = false;
    // Flood (Phase 14): only once the water model created flood state (dry runs: unchanged path).
    const flood = this.runtime.flood !== undefined;
    for (const v of this.views) {
      if (v.e.rev !== v.lastRev) this.applyRev(v);
      if (v.hidden || v.userHidden) continue;
      if (flood && v.e.flood) this.updateWet(v);
      if (v.type === 'building') {
        if (v.members) this.updateMemberLod(v);
        if (this.quake && v.e.seismic && this.updateBuildingQuake(v)) cracksDirty = true;
        else if (v.e.ground && this.updateBuildingGround(v)) cracksDirty = true;
        continue;
      }
      this.updateLod(v);
      this.updateTransforms(v, elapsed, storm);
    }
    if (cracksDirty) {
      this.crackMesh.instanceMatrix.needsUpdate = true;
      for (const kind of FACADE_KINDS) this.facade.meshes[kind].instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * Submerged / wet objects (render-only): parts are tinted darker and bluer by how much of the
   * object stands in water. Buildings with an active earthquake stress tint keep that tint.
   */
  private updateWet(v: EntityView) {
    const st = v.e.flood!;
    const h = Math.max(0.4, v.e.dims[1]);
    const w = Math.round(Math.min(1, st.depth / h + (st.depth > 0.02 ? 0.15 : 0)) * 10) / 10;
    if (w === (v.wet ?? 0)) return;
    v.wet = w;
    if (v.type === 'building' && (v.tint ?? 0) > 0) return;
    cTint.copy(WHITE).lerp(WET, w * 0.85);
    for (const part of v.parts) part.batch.mesh.setColorAt(part.id, cTint);
    if (v.members) this.writeMemberColors(v, cTint);
  }

  /**
   * Earthquake deformation of a building (render-only): M = T(position + exaggerated ground +
   * foundation displacement) · R(residual tilt) · Shear(exaggerated drift profile) · R(yaw) · S.
   * Returns whether instance matrices were rewritten.
   */
  private updateBuildingQuake(v: EntityView): boolean {
    const e = v.e;
    const st = e.seismic!;
    const q = this.quake!;
    const k = q.exaggeration;
    const H = Math.max(1, e.dims[1]);
    const gx = st.ground.d[0] * k + st.base[0] * k;
    const gy = st.ground.d[1] * k;
    const gz = st.ground.d[2] * k + st.base[1] * k;
    const sx = ((st.top[0] - st.base[0]) * k) / H;
    const sz = ((st.top[1] - st.base[1]) * k) / H;
    const tilt = st.tiltMag;
    // Stress tint: current drift / slight-damage drift → white … yellow … red.
    // (Modular buildings recolor hundreds of member instances per change: 0.05 steps.)
    const tint = q.stress ? (v.members ? Math.round(Math.min(3, st.stress) * 20) / 20 : Math.min(3, st.stress)) : 0;
    const gr = e.ground;
    const key = gx * 7.1 + gy * 3.3 + gz * 5.7 + sx * 131 + sz * 97 + tilt * 53 + tint * 0.01 + k + (gr ? gr.settlement * 17.3 + gr.gradient[0] * 911 + gr.gradient[1] * 577 : 0);
    const crackCount = Math.ceil(st.crack * CRACKS_PER_BUILDING);
    // Distant buildings refresh every ANIM_STRIDE frames (visual only).
    if (!this.isNear(v) && (this.frame + v.index) % ANIM_STRIDE !== 0) return false;
    if (key === v.quakeKey && crackCount === v.cracksShown) return false;
    v.quakeKey = key;
    const t = e.source.transform;
    // R(yaw)·S — with ground deformation (Phase 21) the ground-following orientation instead.
    if (gr) mTmp.compose(vPos.set(0, 0, 0), setQ(qA, e.pose.quaternion), v.scale);
    else mTmp.compose(vPos.set(0, 0, 0), qA.setFromEuler(euler.set(t.rotation[0], t.rotation[1], t.rotation[2])), v.scale);
    mShear.set(1, sx, 0, 0, 0, 1, 0, 0, 0, sz, 1, 0, 0, 0, 0, 1);
    mRoot.multiplyMatrices(mShear, mTmp);
    if (tilt > 1e-6) {
      vAxis.set(st.tilt[1] / tilt, 0, -st.tilt[0] / tilt);
      mTilt.makeRotationAxis(vAxis, tilt);
      mRoot.premultiply(mTilt);
    }
    const base = gr ? e.pose.position : t.position;
    mRoot.setPosition(base[0] + gx, base[1] + gy, base[2] + gz);
    for (const part of v.parts) part.batch.mesh.setMatrixAt(part.id, part.local ? mTmp.multiplyMatrices(mRoot, part.local) : mRoot);
    if (v.facade && v.facadeLocal) {
      for (let f = 0; f < v.facade.length; f++) {
        const [kind, i, ci] = v.facade[f];
        if (e.components[ci].condition === 'detached') continue;
        this.facade.meshes[kind].setMatrixAt(i, mTmp.multiplyMatrices(mRoot, v.facadeLocal[f]));
      }
    }
    if (v.members) this.writeMembers(v, mRoot);
    if (v.cracks) {
      v.cracksShown = crackCount;
      if (crackCount > 0) this.crackMesh.visible = true;
      v.cracks.forEach((c, n) => this.crackMesh.setMatrixAt(c.index, n < crackCount ? mTmp.multiplyMatrices(mRoot, c.local) : HIDDEN));
    }
    if (tint !== v.tint) {
      v.tint = tint;
      tintColor(tint, cTint);
      for (const part of v.parts) if (part.role === 'root') part.batch.mesh.setColorAt(part.id, cTint);
      if (v.members) this.writeMemberColors(v, cTint);
    }
    return true;
  }

  /**
   * Ground deformation of a building (Phase 21, no earthquake drawing active): the shell, facade,
   * members and cracks follow the building's kinematic pose (settlement + rigid tilt computed by
   * the deformation response). Only rewritten when that pose changed.
   */
  private updateBuildingGround(v: EntityView): boolean {
    const e = v.e;
    const g = e.ground!;
    const key = g.settlement * 17.3 + g.gradient[0] * 911 + g.gradient[1] * 577;
    if (key === v.groundKey) return false;
    v.groundKey = key;
    const root = mRoot.compose(vPos.set(e.pose.position[0], e.pose.position[1], e.pose.position[2]), setQ(qA, e.pose.quaternion), v.scale);
    v.staticRoot = root.clone();
    for (const part of v.parts) part.batch.mesh.setMatrixAt(part.id, part.local ? mTmp.multiplyMatrices(root, part.local) : root);
    if (v.facade && v.facadeLocal) {
      for (let f = 0; f < v.facade.length; f++) {
        const [kind, i, ci] = v.facade[f];
        if (e.components[ci].condition === 'detached') continue;
        this.facade.meshes[kind].setMatrixAt(i, mTmp.multiplyMatrices(root, v.facadeLocal[f]));
      }
    }
    if (v.members) this.writeMembers(v, root);
    return true;
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
      if (part.nearOnly) part.batch.mesh.setVisibleAt(part.id, !far && !v.userHidden && !v.hidden);
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
    if (v.members) {
      // Modular building: the interior shows once the envelope opens or a story collapsed.
      if (!v.members.revealed && (e.flags.partialCollapse !== undefined || (v.memberComp && e.components.some((c) => c.condition === 'detached' && c.spec.kind !== 'exterior' && c.spec.kind !== 'sign')))) v.members.revealed = true;
      this.writeMembers(v, v.members.root);
      this.writeMemberColors(v, (v.tint ?? 0) > 0 ? tintColor(v.tint!, cTint) : undefined);
    }
    if (gone) return;
    for (const part of v.parts) {
      const id = part.role === 'lamp' ? 'lamp' : part.role === 'panel' ? 'panel' : part.role === 'shopSign' ? 'sign' : null;
      if (!id) continue;
      const c = e.components.find((x) => x.spec.id === id);
      part.batch.mesh.setVisibleAt(part.id, !c || c.condition !== 'detached');
    }
  }

  /** Pose position + the exaggerated ground displacement under the object (earthquake). */
  private shaken(e: RuntimeEntity, p: readonly number[]): readonly number[] {
    const st = e.seismic;
    if (!this.quake || !st) return p;
    const k = this.quake.exaggeration;
    const d = st.ground.d;
    vShaken[0] = p[0] + d[0] * k;
    vShaken[1] = p[1] + d[1] * k;
    vShaken[2] = p[2] + d[2] * k;
    return vShaken;
  }

  private updateTransforms(v: EntityView, elapsed: number, storm: number) {
    const e = v.e;
    // Visual-only animation: every frame nearby, every ANIM_STRIDE-th frame (staggered) beyond.
    const animate = (this.frame + v.index) % (this.isNear(v) ? 1 : ANIM_STRIDE) === 0;
    switch (v.type) {
      case 'tree': {
        const broken = e.flags.snapped || e.flags.uprooted;
        // Upper part (trunk + canopy): falling body or swaying around the base.
        if (broken) this.compose(mRoot, this.shaken(e, e.pose.position), setQ(qA, e.pose.quaternion), v.scale);
        // (A standing tree follows deforming ground through its pose, Phase 21; else its rest pose.)
        else this.compose(mRoot, this.shaken(e, e.ground ? e.pose.position : e.initialPose.position), this.swayed(e, e.visual.swayAngle, e.ground ? e.pose.quaternion : e.initialPose.quaternion), v.scale);
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
        if (e.flags.uprooted) this.compose(mRoot, this.shaken(e, e.pose.position), setQ(qA, e.pose.quaternion), v.scale);
        else this.compose(mRoot, this.shaken(e, e.ground ? e.pose.position : e.initialPose.position), setQ(qA, e.ground ? e.pose.quaternion : e.initialPose.quaternion), v.scale);
        stump.batch.mesh.setMatrixAt(stump.id, mRoot);
        return;
      }
      case 'human': {
        const lean = !e.flags.fallen && e.dynamic;
        const q = lean ? this.swayed(e, e.visual.swayAngle, e.pose.quaternion, true) : setQ(qA, e.pose.quaternion);
        this.compose(mRoot, this.shaken(e, e.pose.position), q, v.scale);
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
        let q = setQ(qA, e.pose.quaternion);
        const st = e.seismic;
        if (this.quake && st) {
          if (v.type === 'car') {
            // Visual rocking on the suspension: roll/pitch against the ground acceleration.
            const ax = st.ground.a[0];
            const az = st.ground.a[2];
            const a = Math.hypot(ax, az);
            if (a > 1e-3) q = qB.setFromAxisAngle(vAxis.set(-az / a, 0, ax / a), Math.min(0.12, a * 0.012)).multiply(qA);
          } else if (!e.dynamic && st.unit >= 0) {
            // Anchored poles / signs / walls sway with their computed top displacement.
            const tx = st.top[0];
            const tz = st.top[1];
            const d = Math.hypot(tx, tz);
            if (d > 1e-6) q = qB.setFromAxisAngle(vAxis.set(tz / d, 0, -tx / d), Math.min(0.5, (d * this.quake.exaggeration) / Math.max(1, e.dims[1]))).multiply(qA);
          }
        }
        this.compose(mRoot, this.shaken(e, e.pose.position), q, v.scale);
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

  // ── Editor use (Phase 16): static world objects, no simulation state ─────

  /**
   * Hide / show one entity's instances (the editor draws a selected object separately while
   * it is being edited). Static objects only: matrices are restored from the entity's pose.
   */
  setHidden(id: EntityId, hidden: boolean) {
    const v = this.byId.get(id);
    if (!v || !!v.userHidden === hidden) return;
    v.userHidden = hidden;
    for (const part of v.parts) part.batch.mesh.setVisibleAt(part.id, !hidden && !v.hidden && !(part.nearOnly && v.far));
    if (v.facade && v.facadeLocal && v.staticRoot) {
      for (let f = 0; f < v.facade.length; f++) {
        const [kind, i] = v.facade[f];
        this.facade.meshes[kind].setMatrixAt(i, hidden ? HIDDEN : mTmp.multiplyMatrices(v.staticRoot, v.facadeLocal[f]));
        this.facade.meshes[kind].instanceMatrix.needsUpdate = true;
      }
    }
    if (v.members) this.writeMembers(v, v.staticRoot ?? v.members.root);
  }

  /** Distance LOD only — for static scenes whose transforms were written by one update(). */
  updateLodOnly(camera: THREE.Camera) {
    camera.getWorldPosition(this.camPos);
    for (const v of this.views) {
      if (v.hidden) continue;
      if (v.type !== 'building') this.updateLod(v);
      else if (v.members) this.updateMemberLod(v);
    }
  }

  /**
   * Modular buildings far away (render-only LOD, same distance / hysteresis as other objects):
   * windows and doors are not drawn — the facade reads the same at that size and they are a
   * third of a building's instances. Rewritten only when the threshold is crossed.
   */
  private updateMemberLod(v: EntityView) {
    const p = v.e.pose.position;
    const dx = p[0] - this.camPos.x, dy = p[1] - this.camPos.y, dz = p[2] - this.camPos.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    const r = v.e.dims[1] / 2 + Math.max(v.e.dims[0], v.e.dims[2]) / 2;
    const far = v.far ? d2 > (LOD_FAR + r - LOD_HYST) ** 2 : d2 > (LOD_FAR + r + LOD_HYST) ** 2;
    if (far === v.far) return;
    v.far = far;
    this.writeMembers(v, v.members!.root);
  }

  /** Draw every part with one material (placement ghosts), without shadows. */
  setMaterialOverride(material: THREE.Material) {
    for (const b of this.batches.values()) {
      b.mesh.material = material;
      b.mesh.castShadow = false;
      b.mesh.receiveShadow = false;
    }
    for (const kind of FACADE_KINDS) {
      const m = this.facade.meshes[kind];
      m.material = material;
      m.castShadow = false;
      m.receiveShadow = false;
    }
    if (this.memberLayer) {
      for (const m of this.memberLayer.meshes) {
        m.material = material;
        m.castShadow = false;
        m.receiveShadow = false;
      }
    }
  }

  /** Empty instanced layers are not drawn at all (no zero-instance draw calls). */
  cullEmpty() {
    for (const kind of FACADE_KINDS) this.facade.meshes[kind].visible = this.facade.meshes[kind].count > 0;
  }

  dispose() {
    for (const b of this.batches.values()) b.mesh.dispose();
    for (const kind of FACADE_KINDS) this.facade.meshes[kind].dispose();
    this.crackMesh.dispose();
    this.memberLayer?.dispose();
    this.root.clear();
  }

  /** Runtime this adapter renders (for consumers that need the id → entity mapping). */
  getRuntime() {
    return this.runtime;
  }
}
