/**
 * Modular building runtime (Phase 17): member-level damage on top of the shared hazard models.
 *
 *  - Earthquake: story drifts are reconstructed from the lumped structural model (structural
 *    adapter: group drift × each story's flexibility share). Every lateral member (frame
 *    column, bearing / shear wall) and every primary beam compares the PEAK drift of its story
 *    with its own drift capacity (material × ductility penalty for high axial load × ±25 %
 *    deterministic scatter × pre-existing damage); damage = demand / capacity, failure at ≥ 1.
 *  - Failure → the member is removed: its story stiffness / strength contribution leaves the
 *    structural model, the load path is re-analyzed (members left without support fall as
 *    debris, vertical members overloaded by the redistributed gravity load fail too — a few
 *    rounds per step), and a story that lost most of its vertical capacity collapses with
 *    everything above it (PARTIAL collapse, or total when it is the ground story).
 *  - Wind: the existing fatigue model decides the structural health (its capacity now follows
 *    the members); damage is drawn on the weakest story; failure = collapse of that story.
 *  - Flood: the ground story's lateral capacity, the material's water sensitivity and the
 *    openings (doors / broken windows) replace the system-level constants.
 *  - Residual strength: member failures lower the capacity every hazard sees (reserve).
 *
 * What it is NOT: no dynamic analysis of falling floors, impact on the floors below, catenary
 * action or connection detailing — a progressive collapse beyond the load-path rounds below is
 * left to a later phase (Phase 25).
 */
import type { Vec3 } from '@/core/types';
import type { WorldObject } from '@/core/model';
import { hashString, qRotate, seededRandom, vAdd, vScale } from '@/core/math';
import { GRAVITY } from '@/core/units';
import { analyzeBuilding, type BuildingAnalysis } from '@/buildings/analysis';
import { analysisOf } from '@/buildings/design';
import { MATERIALS, material } from '@/buildings/materials';
import { lumpStories, type ModularUnit } from '@/buildings/structuralAdapter';
import { isLateralRole, type BuildingDesign } from '@/buildings/types';
import type { SystemContext } from '../systems/SimulationSystem';
import type { RuntimeEntity } from '../SimulationRuntime';
import type { StructuralModel } from '../seismic/StructuralModel';
import { DamageState, worst } from '../damage/DamageState';
import { spawnDebris } from '../damage/spawn';
import { collapse, COMPONENT_ROUNDS, downhill, noteFacadeFailure, type QuakeCollapse } from '../damage/behaviors/building';
import { accumulate, capacities, CRACK_LEVELS, failPart, isDriftPart } from '../damage/behaviors/seismic';
import { seismicDamageIndex } from '../damage/seismicLevels';
import type { DamageCause, Hazard } from '../analysis/DamageEvent';
import { foundationPlinth } from '@/terrain/groundPlacement';
import { scaleShape } from '../RuntimeBuilder';

/** ± scatter of member drift capacities (deterministic per object seed + member id). */
const SCATTER = 0.25;
/** Debris bodies spawned for individually failing members of one building. */
const DEBRIS_BUDGET = 24;
/** Damage events recorded per building for individual members. */
const EVENT_BUDGET = 60;
/** Load-path re-analysis rounds per failure batch. */
const ROUNDS = 6;
/** Utilization above which a vertical member fails under redistributed gravity load. */
const OVERLOAD = 1.25;
/** A story collapses when its surviving vertical members carry less than this share of its capacity. */
const STORY_LOSS = 0.4;

export interface ModularRuntime {
  design: BuildingDesign;
  floors: number;
  scale: Vec3;
  /** Analysis at t = 0 and after the failures so far. */
  initial: BuildingAnalysis;
  current: BuildingAnalysis;
  /** Component index of a member (facade parts), −1 for structural members. */
  comp: Int32Array;
  /** Member damage 0 … 1 (≥ 1 = failed) and failure flags. */
  damage: Float64Array;
  failed: Uint8Array;
  failedSet: Set<string>;
  /** Drift capacity (rad) per member (Infinity = not drift-governed). */
  capacity: Float64Array;
  /** Lateral members + primary beams per story (indices). */
  storyMembers: number[][];
  /** Current / peak story drift per story (magnitude) and peak per local axis [x0, z0, x1, …]. */
  storyDrift: Float64Array;
  storyPeak: Float64Array;
  storyPeakAxis: Float64Array;
  /** Peak at the last member evaluation (skip unchanged stories). */
  evalPeak: Float64Array;
  /** Structural unit (once the earthquake runtime exists) and the dof values last written. */
  unit: ModularUnit | null;
  unitIndex: number;
  modelK: Float64Array;
  modelFy: Float64Array;
  /** Lowest collapsed story (Infinity = none). */
  collapsedFrom: number;
  /** min over stories of current / initial lateral strength (1 = intact). */
  reserve: number;
  /** Remaining share of the wind-exposed height after a partial collapse (1 = intact). */
  windShare: number;
  /** Members failing at the first evaluation (unsupported / overloaded in the original world). */
  pending: number[];
  debrisLeft: number;
  eventsLeft: number;
  /** Bumped on member state changes (renderers). */
  rev: number;
}

const scatterOf = (seed: number, id: string) => 1 + (seededRandom((seed ^ hashString(`member:${id}`)) >>> 0)() * 2 - 1) * SCATTER;

export function createModularRuntime(o: Readonly<WorldObject>): ModularRuntime {
  const design = o.building!;
  const scale: Vec3 = [...o.transform.scale] as Vec3;
  const unscaled = scale[0] === 1 && scale[1] === 1 && scale[2] === 1;
  const initial = unscaled ? analysisOf(design) : analyzeBuilding(design, { scale });
  const n = design.members.length;
  const floors = Math.max(1, design.spec.floors);
  const comp = new Int32Array(n).fill(-1);
  const byComp = new Map(o.components.map((c, i) => [c.id, i]));
  const damage = new Float64Array(n);
  const failed = new Uint8Array(n);
  const failedSet = new Set<string>();
  const capacity = new Float64Array(n).fill(Infinity);
  const storyMembers: number[][] = Array.from({ length: floors }, () => []);
  const pending: number[] = [];
  design.members.forEach((m, i) => {
    comp[i] = byComp.get(m.id) ?? -1;
    damage[i] = Math.min(1, m.initialDamage ?? 0);
    if (damage[i] >= 0.999) {
      // Broken in the original world: absent from the start (no event, no debris).
      failed[i] = 1;
      failedSet.add(m.id);
      return;
    }
    const a = initial.members[i];
    const lateral = (m.type === 'column' || m.type === 'wall') && isLateralRole(m.role) && a.driftCapacity > 0;
    const beam = m.type === 'beam' && m.role === 'primary' && material(m.material).structural;
    if ((lateral || beam) && m.level >= 0 && m.level < floors) {
      const base = lateral ? a.driftCapacity : material(m.material).driftCapacity.column * 1.2;
      capacity[i] = base * scatterOf(o.seed, m.id);
      storyMembers[m.level].push(i);
    }
    // Members without a load path / over capacity in the original world fall at the start.
    if (!a.supported || (a.bearing && a.utilization > 1)) pending.push(i);
  });
  return {
    design, floors, scale, initial, current: initial, comp, damage, failed, failedSet, capacity, storyMembers,
    storyDrift: new Float64Array(floors), storyPeak: new Float64Array(floors), storyPeakAxis: new Float64Array(2 * floors), evalPeak: new Float64Array(floors),
    unit: null, unitIndex: -1, modelK: new Float64Array(0), modelFy: new Float64Array(0),
    collapsedFrom: Infinity, reserve: strengthReserve(initial, initial), windShare: 1, pending, debrisLeft: DEBRIS_BUDGET, eventsLeft: EVENT_BUDGET, rev: 0,
  };
}

/** min over stories of current / initial lateral strength (per axis). */
function strengthReserve(initial: BuildingAnalysis, current: BuildingAnalysis): number {
  let r = 1;
  initial.stories.forEach((s, i) => {
    const c = current.stories[i];
    if (!c) return;
    if (s.vx > 0) r = Math.min(r, c.vx / s.vx);
    if (s.vz > 0) r = Math.min(r, c.vz / s.vz);
  });
  return Math.max(0.05, r);
}

/** Attach the structural unit created by the earthquake runtime (values written to the model). */
export function attachUnit(mr: ModularRuntime, unit: ModularUnit, unitIndex: number) {
  mr.unit = unit;
  mr.unitIndex = unitIndex;
  const nd = unit.lumps.mass.length;
  mr.modelK = new Float64Array(2 * nd);
  mr.modelFy = new Float64Array(2 * nd);
  for (let j = 0; j < nd; j++) {
    mr.modelK[2 * j] = unit.lumps.kx[j];
    mr.modelK[2 * j + 1] = unit.lumps.kz[j];
    mr.modelFy[2 * j] = unit.lumps.fyX[j];
    mr.modelFy[2 * j + 1] = unit.lumps.fyZ[j];
  }
}

/** Story drifts (building-local axes) from the lumped model, with peaks. */
export function updateStoryDrifts(mr: ModularRuntime, model: StructuralModel, ui: number) {
  const L = mr.unit!.lumps;
  const st = mr.current.stories;
  for (let s = 0; s < mr.floors; s++) {
    if (s >= mr.collapsedFrom) break;
    const j = L.dof[s];
    const h = Math.max(0.5, st[s]?.height ?? 3);
    const dx = (model.storyDelta(ui, j, 0) * L.share[2 * s]) / h;
    const dz = (model.storyDelta(ui, j, 1) * L.share[2 * s + 1]) / h;
    const mag = Math.sqrt(dx * dx + dz * dz);
    mr.storyDrift[s] = mag;
    if (mag > mr.storyPeak[s]) mr.storyPeak[s] = mag;
    if (Math.abs(dx) > mr.storyPeakAxis[2 * s]) mr.storyPeakAxis[2 * s] = Math.abs(dx);
    if (Math.abs(dz) > mr.storyPeakAxis[2 * s + 1]) mr.storyPeakAxis[2 * s + 1] = Math.abs(dz);
  }
}

/** Drift demand on a member from its story's peaks (walls: in-plane component). */
function memberDemand(mr: ModularRuntime, i: number): number {
  const m = mr.design.members[i];
  const s = m.level;
  if (m.type === 'wall') {
    const y = m.rotation[1];
    return Math.abs(Math.cos(y)) * mr.storyPeakAxis[2 * s] + Math.abs(Math.sin(y)) * mr.storyPeakAxis[2 * s + 1];
  }
  return mr.storyPeak[s];
}

/** Members whose story peak drift grew since the last evaluation; returns the newly failed. */
function evaluateDrift(mr: ModularRuntime): number[] {
  const out: number[] = [];
  for (let s = 0; s < mr.floors; s++) {
    if (s >= mr.collapsedFrom) break;
    const peak = mr.storyPeak[s];
    if (peak <= mr.evalPeak[s] * 1.005) continue;
    mr.evalPeak[s] = peak;
    for (const i of mr.storyMembers[s]) {
      if (mr.failed[i]) continue;
      const d = memberDemand(mr, i) / mr.capacity[i];
      if (d > mr.damage[i]) {
        mr.damage[i] = Math.min(1, d);
        mr.rev++;
      }
      if (d >= 1) out.push(i);
    }
  }
  return out;
}

const memberCenter = (e: RuntimeEntity, mr: ModularRuntime, i: number): Vec3 => {
  const b = mr.initial.members[i].box;
  const local: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  return vAdd(e.initialPose.position, qRotate(e.initialPose.quaternion, local));
};

interface FailOpts {
  hazard: Hazard;
  cause: DamageCause;
  response: number;
  /** Horizontal push direction for debris (world). */
  dir: Vec3;
}

/** Remove one member (state, facade component, debris, event). */
function markFailed(e: RuntimeEntity, ctx: SystemContext, i: number, o: FailOpts, record: boolean) {
  const mr = e.modular!;
  if (mr.failed[i]) return;
  const m = mr.design.members[i];
  mr.failed[i] = 1;
  mr.failedSet.add(m.id);
  mr.damage[i] = 1;
  const ci = mr.comp[i];
  if (ci >= 0) {
    const c = e.components[ci];
    if (c.condition === 'intact') {
      c.condition = m.type === 'window' ? 'broken' : 'detached';
      c.health = 0;
      c.state = DamageState.DESTROYED;
      noteFacadeFailure(e);
    }
  }
  const pos = memberCenter(e, mr, i);
  const a = mr.initial.members[i];
  if (mr.debrisLeft > 0 && m.type !== 'window' && m.level >= 0) {
    mr.debrisLeft--;
    const k = mr.scale;
    spawnDebris(ctx, e, {
      kind: m.type === 'wall' && ci >= 0 ? 'cladding' : 'structure',
      position: pos,
      size: [m.size[0] * k[0], m.size[1] * k[1], m.size[2] * k[2]],
      mass: Math.min(80000, Math.max(20, a.mass)),
      color: MATERIALS[m.material].color,
      push: vScale(o.dir, 0.3),
      hazard: o.hazard === 'wind' ? undefined : o.hazard,
    });
  }
  if (record && mr.eventsLeft > 0 && (m.type !== 'window' && m.type !== 'door')) {
    mr.eventsLeft--;
    ctx.recordDamage(e, {
      eventType: 'FAILED', cause: o.cause, hazard: o.hazard, componentId: m.id, memberType: m.type, worldPosition: pos,
      response: o.response, damageBefore: 0, damageAfter: 1, localWindSpeed: o.hazard === 'wind' ? e.localWind.speed : 0,
    });
  }
}

/**
 * Fail members and propagate: stiffness / strength out of the structural model, load-path
 * re-analysis (unsupported members fall, overloaded vertical members fail), story collapse.
 */
export function failMembers(e: RuntimeEntity, ctx: SystemContext, list: number[], o: FailOpts) {
  const mr = e.modular!;
  let batch = list.filter((i) => !mr.failed[i]);
  if (!batch.length) return;
  let first = true;
  for (let round = 0; batch.length && round < ROUNDS; round++) {
    for (const i of batch) markFailed(e, ctx, i, round === 0 ? o : { ...o, cause: 'gravity' }, first || mr.design.members[i].type === 'column');
    first = false;
    mr.current = analyzeBuilding(mr.design, { scale: mr.scale, failed: mr.failedSet });
    const next: number[] = [];
    mr.design.members.forEach((m, i) => {
      if (mr.failed[i] || m.level < 0 || m.level >= mr.collapsedFrom) return;
      const a = mr.current.members[i];
      if (!a.supported) next.push(i);
      else if (a.bearing && (m.type === 'column' || m.type === 'wall') && a.utilization > OVERLOAD) next.push(i);
    });
    batch = next;
  }
  if (batch.length) for (const i of batch) markFailed(e, ctx, i, { ...o, cause: 'gravity' }, false);
  if (batch.length) mr.current = analyzeBuilding(mr.design, { scale: mr.scale, failed: mr.failedSet });
  mr.reserve = strengthReserve(mr.initial, mr.current);
  mr.rev++;
  e.rev++;
  const lost = lostStory(mr);
  if (lost !== null) {
    collapseFrom(e, ctx, lost, o);
    return;
  }
  syncModel(e, ctx);
  ctx.log(e.id, 'warn', { key: 'log.building.memberFailed', params: { n: mr.failedSet.size } });
}

/** Lowest story that lost most of its vertical capacity (null = none). */
function lostStory(mr: ModularRuntime): number | null {
  for (let s = 0; s < Math.min(mr.floors, mr.collapsedFrom); s++) {
    let all = 0, left = 0;
    mr.design.members.forEach((m, i) => {
      if (m.level !== s || (m.type !== 'column' && !(m.type === 'wall' && m.role === 'bearing'))) return;
      const mat = material(m.material);
      if (!mat.structural) return;
      const a = mr.initial.members[i];
      const cap = mat.compressive * a.size[0] * a.size[2] * mat.fill[m.type === 'column' ? 'column' : 'wall'];
      all += cap;
      if (!mr.failed[i] && mr.current.members[i].supported) left += cap;
    });
    if (all > 0 && left < STORY_LOSS * all) return s;
  }
  return null;
}

/** Write the current story stiffness / strength into the structural model (if it exists). */
function syncModel(e: RuntimeEntity, ctx: SystemContext) {
  const mr = e.modular!;
  const sr = ctx.runtime.seismic;
  if (!mr.unit || !sr || mr.unitIndex < 0) return;
  const st = mr.current.stories;
  const L = lumpStories(st.map((s) => s.mass), st.map((s) => s.height), st.map((s) => s.kx), st.map((s) => s.kz), st.map((s) => s.vx), st.map((s) => s.vz));
  const U = mr.unit;
  for (let j = 0; j < L.kx.length; j++) {
    if (mr.unit.lumps.first[j] >= mr.collapsedFrom) break;
    for (const ax of [0, 1] as const) {
      const k = (ax === 0 ? L.kx[j] : L.kz[j]) * U.kScale[ax];
      const fy = (ax === 0 ? L.fyX[j] : L.fyZ[j]) * U.fyScale;
      const i = 2 * j + ax;
      const kf = k / mr.modelK[i];
      const ff = fy / mr.modelFy[i];
      if (kf < 0.9999 || ff < 0.9999) {
        sr.model.scaleStory(mr.unitIndex, j + 1, ax, kf, ff);
        mr.modelK[i] *= Math.min(1, kf);
        mr.modelFy[i] *= Math.min(1, ff);
      }
    }
  }
}

/**
 * Collapse of story `s` and everything above it. Ground story → the whole building (existing
 * collapse). Otherwise the upper part falls as chunks, the lower stories keep standing: their
 * collider, wind obstacle and structural model are cut at the story's base.
 */
export function collapseFrom(e: RuntimeEntity, ctx: SystemContext, story: number, o: FailOpts, quake?: QuakeCollapse) {
  const mr = e.modular!;
  // The lumped structural model resolves collapse per dof group.
  let s = story;
  if (mr.unit) s = mr.unit.lumps.first[mr.unit.lumps.dof[Math.min(mr.floors - 1, story)] - 1];
  if (s <= 0) {
    mr.design.members.forEach((m, i) => {
      if (!mr.failed[i]) {
        mr.failed[i] = 1;
        mr.failedSet.add(m.id);
        mr.damage[i] = 1;
      }
    });
    mr.collapsedFrom = 0;
    mr.reserve = 0.05;
    mr.rev++;
    collapse(e, ctx, quake ?? (o.hazard === 'wind' ? undefined : { dir: o.dir, speed: 0.3, cause: o.cause, response: o.response, hazard: o.hazard === 'flood' ? 'flood' : o.hazard === 'ground' ? 'ground' : 'earthquake' }));
    return;
  }
  if (s >= mr.collapsedFrom) return;
  mr.collapsedFrom = s;
  const k = mr.scale;
  const base = mr.initial.stories[s].base;
  // Members of the collapsed stories leave without individual debris (chunks below).
  let lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  let mass = 0;
  mr.design.members.forEach((m, i) => {
    if (m.level < s) return;
    const a = mr.initial.members[i];
    if (!mr.failed[i]) mass += a.mass;
    for (let d = 0; d < 3; d++) {
      lo[d] = Math.min(lo[d], a.box.min[d]);
      hi[d] = Math.max(hi[d], a.box.max[d]);
    }
    if (!mr.failed[i]) {
      mr.failed[i] = 1;
      mr.failedSet.add(m.id);
      mr.damage[i] = 1;
      const ci = mr.comp[i];
      if (ci >= 0 && e.components[ci].condition === 'intact') {
        e.components[ci].condition = 'detached';
        e.components[ci].health = 0;
        e.components[ci].state = DamageState.DESTROYED;
        noteFacadeFailure(e);
      }
    }
  });
  // Rooftop units / sign above the cut go too.
  for (const c of e.components) {
    if (c.spec.kind !== 'structure' && c.condition === 'intact' && c.spec.position[1] * k[1] >= base) {
      c.condition = 'detached';
      c.state = DamageState.DESTROYED;
    }
  }
  const layers = Math.max(1, Math.min(4, mr.floors - s));
  const H = hi[1] - lo[1];
  for (let ly = 0; ly < layers; ly++) {
    for (let ix = 0; ix < 2; ix++) {
      for (let iz = 0; iz < 2; iz++) {
        const local: Vec3 = [lo[0] + (hi[0] - lo[0]) * (0.25 + ix * 0.5), lo[1] + (H * (ly + 0.5)) / layers, lo[2] + (hi[2] - lo[2]) * (0.25 + iz * 0.5)];
        spawnDebris(ctx, e, {
          kind: 'structure',
          position: vAdd(e.pose.position, qRotate(e.pose.quaternion, local)),
          size: [((hi[0] - lo[0]) / 2) * 0.97, (H / layers) * 0.97, ((hi[2] - lo[2]) / 2) * 0.97],
          mass: Math.min(80000, Math.max(100, mass / (layers * 4))),
          color: mr.design.spec.color,
          push: vScale(o.dir, 0.3 + ly * 0.25),
          hazard: o.hazard === 'wind' ? undefined : o.hazard,
        });
      }
    }
  }
  // The remaining lower stories: shorter collider, wake and structural model.
  if (e.body !== null) {
    ctx.physics.removeBody(e.body);
    const plinth = foundationPlinth(e.source, ctx.env.terrain);
    const shapes = [scaleShape({ type: 'box', halfExtents: [e.dims[0] / 2 / k[0], base / 2 / k[1], e.dims[2] / 2 / k[2]], offset: [0, base / 2 / k[1], 0] }, k)];
    if (plinth > 0) shapes.push({ type: 'box', halfExtents: [e.dims[0] / 2 + 0.1, plinth / 2, e.dims[2] / 2 + 0.1], offset: [0, -plinth / 2, 0] });
    e.body = ctx.physics.createBody({
      kind: 'fixed', position: e.initialPose.position, quaternion: e.initialPose.quaternion, shapes, mass: e.source.physics.mass,
      friction: e.source.physics.friction, restitution: e.source.physics.restitution, linearDamping: 0.05, angularDamping: 0.35, userData: { entityId: e.id },
    });
  }
  mr.windShare = Math.max(0.05, base / Math.max(0.5, mr.initial.top));
  e.dims[1] = base;
  e.copLocal[1] = base * 0.55;
  ctx.env.windField.updateObstacle(e.id, { height: base });
  const sr = ctx.runtime.seismic;
  if (sr && mr.unit && mr.unitIndex >= 0) sr.model.truncateFrom(mr.unitIndex, mr.unit.lumps.dof[s], GRAVITY);
  mr.current = analyzeBuilding(mr.design, { scale: mr.scale, failed: mr.failedSet });
  mr.reserve = strengthReserve(mr.initial, mr.current);
  e.flags.partialCollapse = s;
  mr.rev++;
  e.rev++;
  ctx.recordDamage(e, { eventType: 'STORY_COLLAPSED', cause: o.cause, hazard: o.hazard, response: s + 1, damageAfter: 1 - e.health, localWindSpeed: o.hazard === 'wind' ? e.localWind.speed : 0 });
  ctx.log(e.id, 'danger', { key: 'log.building.storyCollapsed', params: { story: s + 1 } });
}

/** Members that fall at the very start (no load path / over capacity in the original world). */
export function processPending(e: RuntimeEntity, ctx: SystemContext) {
  const mr = e.modular!;
  const list = mr.pending;
  mr.pending = [];
  if (list.length) failMembers(e, ctx, list, { hazard: 'wind', cause: 'gravity', response: 0, dir: [0, 0, 0] });
}

// ── Earthquake ───────────────────────────────────────────────────────

const vel: [number, number] = [0, 0];

export function updateModularQuake(e: RuntimeEntity, ctx: SystemContext, model: StructuralModel, dt: number) {
  const mr = e.modular!;
  const st = e.seismic!;
  const th = st.thresholds!;
  const ui = st.unit;
  if (!mr.unit || ui < 0) return;
  updateStoryDrifts(mr, model, ui);
  let maxDrift = 0, maxPeak = 0;
  for (let s = 0; s < Math.min(mr.floors, mr.collapsedFrom); s++) {
    if (mr.storyDrift[s] > maxDrift) maxDrift = mr.storyDrift[s];
    if (mr.storyPeak[s] > maxPeak) maxPeak = mr.storyPeak[s];
  }
  // Story-level drifts (the dof drift of a lumped group averages its stories).
  st.drift = maxDrift;
  st.peakDrift = Math.max(st.peakDrift, maxPeak);
  st.stress = st.drift / th.slight;

  // Wall cracking (visual + event) from the peak story drift.
  st.crack = Math.max(0, Math.min(1, (maxPeak - th.slight) / (th.extensive - th.slight)));
  const level = CRACK_LEVELS.findIndex((l, i) => i >= st.crackRecorded && st.crack >= l);
  if (level >= 0 && level >= st.crackRecorded) {
    st.crackRecorded = level + 1;
    e.rev++;
    ctx.recordDamage(e, { eventType: 'CRACKED', cause: 'drift', hazard: 'earthquake', response: maxPeak, damageBefore: 1 - e.health, damageAfter: 1 - e.health, localWindSpeed: 0 });
    ctx.log(e.id, level === 0 ? 'info' : 'warn', { key: level === 0 ? 'log.quake.cracks' : 'log.quake.heavyCracks' });
  }
  if (!st.foundationFailed && st.tiltMag >= st.failureTilt) {
    st.foundationFailed = true;
    e.rev++;
    ctx.recordDamage(e, { eventType: 'TILTED', cause: 'foundation', hazard: 'earthquake', response: (st.tiltMag * 180) / Math.PI, localWindSpeed: 0 });
    ctx.log(e.id, 'danger', { key: 'log.quake.tilted', params: { deg: ((st.tiltMag * 180) / Math.PI).toFixed(1) } });
  }
  const dir = (): Vec3 => {
    let dx = st.top[0], dz = st.top[1];
    const l = Math.hypot(dx, dz);
    if (l > 1e-9) { dx /= l; dz /= l; } else { dx = st.shakeDir[0]; dz = st.shakeDir[1]; }
    return [dx, 0, dz];
  };
  // Member failures (drift capacity) → load path → partial / total collapse.
  const failedNow = evaluateDrift(mr);
  if (failedNow.length) failMembers(e, ctx, failedNow, { hazard: 'earthquake', cause: 'drift', response: maxPeak, dir: dir() });
  if (e.flags.collapsed) return;
  // Backstop: the lumped model's damage index (drift + cumulative plastic drift) at a dof, or
  // the foundation tilt (→ whole building).
  const D = seismicDamageIndex(st);
  if (D >= 1) {
    const tiltDriven = st.tiltMag / (3 * st.failureTilt) >= st.damage;
    let worstDof = 1, worstD = -1;
    const o = model.off[ui];
    for (let j = 1; j <= model.n[ui]; j++) if (model.storyD[o + j] > worstD) { worstD = model.storyD[o + j]; worstDof = j; }
    model.topVelocity(ui, vel);
    const story = tiltDriven ? 0 : mr.unit.lumps.first[worstDof - 1];
    const q: QuakeCollapse = { dir: tiltDriven ? [st.tilt[0], 0, st.tilt[1]] : dir(), speed: Math.hypot(vel[0], vel[1]), cause: tiltDriven ? 'foundation' : 'drift', response: tiltDriven ? (st.tiltMag * 180) / Math.PI : st.peakDrift };
    if (story < mr.collapsedFrom) collapseFrom(e, ctx, story, { hazard: 'earthquake', cause: q.cause, response: q.response, dir: q.dir }, q);
    if (e.flags.collapsed) {
      e.state = DamageState.DESTROYED;
      return;
    }
  }

  // Facade parts: windows / cladding / doors by their STORY drift, the rest by floor acceleration.
  if (!ctx.env.groundMotion.active) return;
  const cap = capacities(e);
  const dmg = st.partDamage!;
  const comps = e.components;
  const cdt = dt * COMPONENT_ROUNDS;
  const levelOf = facadeLevels(e);
  for (let ci = ctx.step % COMPONENT_ROUNDS; ci < comps.length; ci += COMPONENT_ROUNDS) {
    const c = comps[ci];
    if (c.condition !== 'intact' || c.spec.kind === 'structure' || cap[ci] === Infinity) continue;
    const lv = levelOf[ci];
    if (lv >= mr.collapsedFrom) continue;
    let response: number;
    if (isDriftPart(c.spec.kind)) response = mr.storyDrift[Math.max(0, Math.min(mr.floors - 1, lv))];
    else response = model.accelAt(ui, c.spec.position[1] * e.source.transform.scale[1]) / GRAVITY;
    const ratio = response / cap[ci];
    if (accumulate(dmg, ci, ratio, cdt)) failPart(e, c, ctx, model, response, isDriftPart(c.spec.kind) ? 'drift' : 'acceleration');
    else if (dmg[ci] > 0) {
      c.health = Math.min(c.health, 1 - dmg[ci]);
      c.state = worst(c.state, dmg[ci] > 0.5 ? DamageState.CRITICAL : DamageState.DAMAGED);
    }
  }
}

/** Story of each facade component (from its member; rooftop extras: top story). */
const levelCache = new WeakMap<RuntimeEntity, Int32Array>();
function facadeLevels(e: RuntimeEntity): Int32Array {
  let l = levelCache.get(e);
  if (l) return l;
  const mr = e.modular!;
  l = new Int32Array(e.components.length).fill(mr.floors - 1);
  const idx = new Map(mr.design.members.map((m, i) => [m.id, i]));
  e.components.forEach((c, ci) => {
    const i = idx.get(c.spec.id);
    if (i !== undefined) l![ci] = Math.min(mr.floors - 1, Math.max(0, mr.design.members[i].level));
  });
  levelCache.set(e, l);
  return l;
}

// ── Wind / flood helpers ─────────────────────────────────────────────

/**
 * Wind: draw the structural fatigue on the weakest story's lateral members, and turn a failed
 * structure into the collapse of that story (total when it is the ground story).
 * Returns true when the building (or part of it) collapsed.
 */
export function modularWindStructure(e: RuntimeEntity, ctx: SystemContext, health: number, governing: Hazard = 'wind'): boolean {
  const mr = e.modular!;
  const weak = Math.min(mr.current.weakStory[0], mr.current.weakStory[1]);
  const d = 1 - health;
  if (d > 0.12 && weak < mr.collapsedFrom) {
    for (const i of mr.storyMembers[weak] ?? []) {
      if (!mr.failed[i] && d * 0.9 > mr.damage[i] + 0.02) {
        mr.damage[i] = d * 0.9;
        mr.rev++;
        e.rev++;
      }
    }
  }
  if (health > 0) return false;
  // Attributed to the hazard whose health governed (Phase 21 / 22): a building whose structural
  // health ran out because of the earthquake, the water or the ground is not a wind failure.
  if (governing === 'ground' && e.ground) {
    collapseFrom(e, ctx, weak, { hazard: 'ground', cause: 'foundation', response: e.ground.peakBeta, dir: downhill(e.ground.gradient) });
    return true;
  }
  const flow = ctx.env.wind.flow();
  const dir: Vec3 = [flow[0], 0, flow[2]];
  if (governing === 'earthquake') collapseFrom(e, ctx, weak, { hazard: 'earthquake', cause: 'drift', response: e.loadRatio, dir });
  else if (governing === 'flood') collapseFrom(e, ctx, weak, { hazard: 'flood', cause: 'hydrostatic', response: e.flood?.depth ?? 0, dir });
  else collapseFrom(e, ctx, weak, { hazard: 'wind', cause: e.loadRatio >= e.source.physics.breakThreshold ? 'overload' : 'fatigue', response: e.loadRatio, dir });
  return true;
}

/** Wet timber / masonry loses strength over time in water (approximate). */
const WET_LOSS = 0.2;
const WET_TIME = 3600;

/**
 * Lateral capacity (N) of the ground story against water load, with the structural strength
 * factor, wet-material and foundation-scour reductions. Also returns the finishes multiplier.
 */
export function modularFloodCapacity(e: RuntimeEntity, exposure: number, speed: number): { capacity: number; finish: number } {
  const mr = e.modular!;
  const s0 = mr.current.stories[0];
  const f = e.source.seismic?.structure.strengthFactor ?? 1;
  let cap = Math.max(0, Math.min(s0?.vx ?? 0, s0?.vz ?? 0)) * f;
  // Ground-story materials: lateral members for strength loss, walls for finishes.
  let wetW = 0, wetSum = 0, finW = 0, finSum = 0;
  mr.design.members.forEach((m, i) => {
    if (m.level !== 0 || mr.failed[i]) return;
    const mat = MATERIALS[m.material];
    if (isLateralRole(m.role)) {
      const w = mr.current.members[i].vx + mr.current.members[i].vz;
      wetW += w;
      if (m.material === 'timber' || m.material === 'masonry') wetSum += w;
    }
    if (m.type === 'wall') {
      const w = m.size[0] * m.size[1];
      finW += w;
      finSum += w * mat.waterSensitivity;
    }
  });
  const wet = wetW > 0 ? wetSum / wetW : 0;
  cap *= 1 - WET_LOSS * wet * Math.min(1, exposure / WET_TIME);
  // Scour around shallow foundations in fast flow.
  const scour = { spread: 0.3, mat: 0.15, pile: 0 }[mr.design.spec.foundation];
  cap *= 1 - scour * Math.min(1, Math.max(0, (speed - 1.5) / 2)) * Math.min(1, exposure / 1800);
  return { capacity: cap, finish: finW > 0 ? finSum / finW : 1 };
}

/** Doors that failed or were opened by the water count as openings for the interior fill. */
export function openDoors(e: RuntimeEntity): number {
  let n = 0;
  for (const c of e.components) if (c.spec.kind === 'door' && c.condition !== 'intact') n++;
  return n;
}
