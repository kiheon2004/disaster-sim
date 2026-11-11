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
 * Phase 25: member failures, story mechanisms and total collapse go through the structural
 * destruction engine (src/structure, simulation/structure): incremental load-path re-analysis one
 * round per step (beams, slabs and connections checked too), falling blocks with impact on the
 * floors below (crush-down or arrest), rubble, fragments with exact masses. This runtime keeps
 * the Phase 17 views of that state (failed flags, story stiffness / strength for the lumped model,
 * remaining lateral strength, partial / total collapse flags).
 */
import type { Vec3 } from '@/core/types';
import type { WorldObject } from '@/core/model';
import { hashString, seededRandom } from '@/core/math';
import { GRAVITY } from '@/core/units';
import { analyzeBuilding, type BuildingAnalysis } from '@/buildings/analysis';
import { MS, type FailCause } from '@/structure/types';
import { MT_BRACE } from '@/structure/graph';
import type { CollapseModel } from '@/structure/collapse';
import { activate, kinematics, structureOf, type StructureState } from '../structure/state';
import { analysisOf } from '@/buildings/design';
import { MATERIALS, material } from '@/buildings/materials';
import { lumpStories, type ModularUnit } from '@/buildings/structuralAdapter';
import { torsionDemand } from './structureV2';
import { BUCKLED_DAMAGE } from '@/buildings/brace';
import { isLateralRole, type BuildingDesign } from '@/buildings/types';
import type { SystemContext } from '../systems/SimulationSystem';
import type { RuntimeEntity } from '../SimulationRuntime';
import type { StructuralModel } from '../seismic/StructuralModel';
import { DamageState, worst } from '../damage/DamageState';
import { COMPONENT_ROUNDS, downhill, type QuakeCollapse } from '../damage/behaviors/building';
import { blastGovernsStructure, gravityGovernsStructure, impactGovernsShaking } from '../seismic/SeismicState';

/**
 * The hazard a structural-model failure belongs to: the shared structural model is driven by ground
 * motion, impact shocks and air-pressure loads — failures go to the one that governs (Phase 23 / 24
 * attribution), so the collapse sequence and the damage log agree.
 */
export function governingHazard(e: RuntimeEntity, h: Hazard, ctx?: SystemContext): Hazard {
  if (h === 'earthquake') {
    // Phase 32: lateral loads of a celestial source's field drive the same storey model.
    if (gravityGovernsStructure(e.seismic)) return 'gravity';
    if (blastGovernsStructure(e.seismic)) return 'blast';
    if (impactGovernsShaking(e.seismic)) return 'impact';
    return h;
  }
  // Ground changed by an impact (crater, rim, ejecta deposit) is the impact's (Phase 23 attribution).
  if (h === 'ground') {
    const ch = ctx?.env.groundFailure;
    const src = e.ground?.source ?? (ch?.field ? sourceAt(ch, e.initialPose.position[0], e.initialPose.position[2]) : undefined);
    if (src?.startsWith('impact:')) return 'impact';
  }
  return h;
}
import { accumulate, capacities, CRACK_LEVELS, failPart, isDriftPart } from '../damage/behaviors/seismic';
import { seismicDamageIndex } from '../damage/seismicLevels';
import type { DamageCause, Hazard } from '../analysis/DamageEvent';
import { foundationPlinth } from '@/terrain/groundPlacement';
import { sourceAt } from '../ground/objects';
import { scaleShape } from '../RuntimeBuilder';

/** ± scatter of member drift capacities (deterministic per object seed + member id). */
const SCATTER = 0.25;
/** Damage events recorded per building for individual member failures (the full sequence is in the collapse model). */
export const EVENT_BUDGET = 60;

export interface ModularRuntime {
  design: BuildingDesign;
  floors: number;
  scale: Vec3;
  /** Analysis at t = 0 and after the failures so far (`current`: use analysisNow — recomputed on demand). */
  initial: BuildingAnalysis;
  current: BuildingAnalysis;
  currentStale: boolean;
  /**
   * Weakest story of the building as it stands (wind / governing-health path) and whether a
   * load-bearing member failed since it was taken from the analysis. Facade parts (windows, doors,
   * cladding, roof coverings) never change it, so their loss does not re-run the analysis.
   */
  weak: number;
  weakStale: boolean;
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
  /** Bumped on member state changes (renderers). */
  rev: number;
  /** Structural destruction state (Phase 25; created with the first structural change). */
  structure?: StructureState;
  /** Member index of each facade component (−1: none). */
  memberOfComp: Int32Array;
  /** Phase 35.5 (structure v2): staged failure per hazard (face stages, storey backstop stages) and the last stage time. */
  v2Stage?: Record<string, number>;
  /** Phase 36: storey drift at which each brace buckles (0 = not a brace); absent when the design has no brace. */
  buckle?: Float64Array;
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
  const memberOfComp = new Int32Array(o.components.length).fill(-1);
  let buckle: Float64Array | undefined;
  design.members.forEach((m, i) => {
    comp[i] = byComp.get(m.id) ?? -1;
    if (comp[i] >= 0) memberOfComp[comp[i]] = i;
    damage[i] = Math.min(1, m.initialDamage ?? 0);
    if (damage[i] >= 0.999) {
      // Broken in the original world: absent from the start (no event, no debris).
      failed[i] = 1;
      failedSet.add(m.id);
      return;
    }
    const a = initial.members[i];
    // Phase 36: a brace fails at its fracture drift and buckles (damage stage) at its buckling drift (buildings/brace.ts).
    const lateral = (m.type === 'column' || m.type === 'wall' || m.type === 'brace') && isLateralRole(m.role) && a.driftCapacity > 0;
    if (m.type === 'brace' && a.buckleDrift) (buckle ??= new Float64Array(n))[i] = a.buckleDrift * scatterOf(o.seed, m.id);
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
    design, floors, scale, initial, current: initial, currentStale: false, weak: Math.min(initial.weakStory[0], initial.weakStory[1]), weakStale: false, comp, damage, failed, failedSet, capacity, storyMembers,
    storyDrift: new Float64Array(floors), storyPeak: new Float64Array(floors), storyPeakAxis: new Float64Array(2 * floors), evalPeak: new Float64Array(floors),
    unit: null, unitIndex: -1, modelK: new Float64Array(0), modelFy: new Float64Array(0),
    collapsedFrom: Infinity, reserve: strengthReserve(initial, initial), windShare: 1, pending, rev: 0, memberOfComp,
    ...(buckle ? { buckle } : {}),
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
  const st = mr.initial.stories; // story heights do not change with failures
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
  if (m.type === 'wall' || m.type === 'brace') {
    // In-plane component (a brace works along its plan direction, like a wall).
    const y = m.rotation[1];
    return Math.abs(Math.cos(y)) * mr.storyPeakAxis[2 * s] + Math.abs(Math.sin(y)) * mr.storyPeakAxis[2 * s + 1];
  }
  return mr.storyPeak[s];
}

/**
 * Raise a member's damage index (any hazard): through the collapse model when it exists (state
 * DAMAGED / SEVERE, gravity capacity × (1 − 0.3·D)); otherwise the array the model starts from.
 */
export function raiseDamage(mr: ModularRuntime, i: number, d: number, hazard: string) {
  if (d <= mr.damage[i] || mr.failed[i]) return;
  if (mr.structure) mr.structure.model.setDamage(i, Math.min(0.999, d), hazard);
  else mr.damage[i] = Math.min(0.999, d);
  mr.rev++;
}

/** Members whose story peak drift grew since the last evaluation; returns the newly failed. */
function evaluateDrift(mr: ModularRuntime, hazard: Hazard = 'earthquake', v2 = false): number[] {
  const out: number[] = [];
  for (let s = 0; s < mr.floors; s++) {
    if (s >= mr.collapsedFrom) break;
    const peak = mr.storyPeak[s];
    if (peak <= mr.evalPeak[s] * 1.005) continue;
    mr.evalPeak[s] = peak;
    for (const i of mr.storyMembers[s]) {
      if (mr.failed[i]) continue;
      // Phase 35.5 (v2): torsion-amplified demand — perimeter / corner members first.
      const dem = v2 ? torsionDemand(mr, i) : memberDemand(mr, i);
      let d = dem / mr.capacity[i];
      // Phase 36: a brace past its buckling drift is buckled (damage stage) before it fractures at its capacity.
      if (mr.buckle && mr.buckle[i] > 0 && dem >= mr.buckle[i] && d < BUCKLED_DAMAGE) d = BUCKLED_DAMAGE;
      if (d > mr.damage[i] && d < 1) raiseDamage(mr, i, d, hazard);
      if (d >= 1) out.push(i);
    }
  }
  return out;
}

interface FailOpts {
  hazard: Hazard;
  cause: DamageCause;
  response: number;
  /** Horizontal push direction (world) — informational (fragments carry their own velocity). */
  dir: Vec3;
  /** Velocity of each failing member (building frame, m/s) when it is known (wall blown out by a wave). */
  velocity?: (i: number) => Vec3 | undefined;
  /** The velocity is an impulse a wave gave it (fragment momentum origin), not the structure's motion. */
  impulse?: boolean;
}

const FAIL_CAUSE: Partial<Record<DamageCause, FailCause>> = { drift: 'drift', overpressure: 'overpressure', gravity: 'support', foundation: 'foundation', impact: 'impact' };

/** Hazard name used inside the collapse model for members failing in the ORIGINAL world. */
export const ORIGINAL_WORLD = 'original';

/**
 * Members failed by a hazard model (drift capacity, out-of-plane wall failure …): they leave the
 * structure now; the collapse engine redistributes their load from the next round on (one round per
 * fixed step), lets what lost its support fall, and records the sequence.
 */
export function failMembers(e: RuntimeEntity, ctx: SystemContext, list: number[], o: FailOpts) {
  const mr = e.modular!;
  const batch = list.filter((i) => !mr.failed[i]);
  if (!batch.length) return;
  const st = structureOf(e, ctx);
  const kin = kinematics(e, ctx);
  const tmp: Vec3 = [0, 0, 0];
  const pending = o.cause === 'gravity' && o.response === 0;
  st.model.fail(batch, FAIL_CAUSE[o.cause] ?? 'story', pending ? ORIGINAL_WORLD : governingHazard(e, o.hazard, ctx), ctx.time, {
    u: o.response,
    impulse: o.impulse,
    velocity: (i) => o.velocity?.(i) ?? (kin(i, tmp), [tmp[0], tmp[1], tmp[2]] as Vec3),
  });
  for (const i of batch) { mr.failed[i] = 1; mr.failedSet.add(mr.design.members[i].id); }
  st.lateralDirty = true;
  st.analysisDirty = true;
  mr.currentStale = true;
  mr.weakStale = true;
  mr.rev++;
  e.rev++;
  activate(e, ctx);
  if (!st.noted.has('memberLog')) {
    st.noted.add('memberLog');
    ctx.log(e.id, 'warn', { key: 'log.building.memberFailed', params: { n: batch.length } });
  }
}

/** Current story stiffness / strength from the members still standing (original contributions). */
export function currentStories(mr: ModularRuntime): { kx: number[]; kz: number[]; vx: number[]; vz: number[] } {
  const n = mr.floors;
  const out = { kx: new Array(n).fill(0), kz: new Array(n).fill(0), vx: new Array(n).fill(0), vz: new Array(n).fill(0) };
  const model = mr.structure?.model;
  if (!model) {
    mr.initial.stories.forEach((s, k) => { out.kx[k] = s.kx; out.kz[k] = s.kz; out.vx[k] = s.vx; out.vz[k] = s.vz; });
    return out;
  }
  const g = model.g;
  for (let i = 0; i < g.n; i++) {
    const L = g.level[i];
    if (L < 0 || L >= n || !(g.kx[i] || g.kz[i] || g.vx[i] || g.vz[i])) continue;
    if (model.state[i] > MS.SEVERE) continue;
    // Phase 36: a brace stiffens its storey only while both members it is bolted to stand (it may hang on one).
    if (g.type[i] === MT_BRACE && !braceHeld(model, i)) continue;
    // Damaged members keep less of their contribution (k·(1−0.4D), F·(1−0.3D) — as initial damage).
    const d = Math.min(1, mr.damage[i]) - Math.min(1, mr.design.members[i].initialDamage ?? 0);
    const kd = 1 - 0.4 * Math.max(0, d), vd = 1 - 0.3 * Math.max(0, d);
    out.kx[L] += g.kx[i] * kd; out.kz[L] += g.kz[i] * kd; out.vx[L] += g.vx[i] * vd; out.vz[L] += g.vz[i] * vd;
  }
  return out;
}

/** Phase 36: both end members of a brace still stand (its two gusset connections hold). */
function braceHeld(m: CollapseModel, i: number): boolean {
  const g = m.g;
  if (g.eStart[i + 1] - g.eStart[i] !== 2) return false;
  for (let e = g.eStart[i]; e < g.eStart[i + 1]; e++) if (m.state[g.eTo[e]] > MS.SEVERE) return false;
  return true;
}

/** min over stories of the current / initial lateral strength (per axis). */
export function updateReserve(mr: ModularRuntime) {
  const c = currentStories(mr);
  let r = 1;
  mr.initial.stories.forEach((s, i) => {
    if (i >= mr.collapsedFrom) return;
    if (s.vx > 0) r = Math.min(r, c.vx[i] / s.vx);
    if (s.vz > 0) r = Math.min(r, c.vz[i] / s.vz);
  });
  mr.reserve = Math.max(0.05, r);
}

/** Write the current story stiffness / strength into the structural model (if it exists). */
export function syncModel(e: RuntimeEntity, ctx: SystemContext) {
  const mr = e.modular!;
  const sr = ctx.runtime.seismic;
  updateReserve(mr);
  if (!mr.unit || !sr || mr.unitIndex < 0) return;
  const st = mr.initial.stories;
  const c = currentStories(mr);
  const L = lumpStories(st.map((s) => s.mass), st.map((s) => s.height), c.kx, c.kz, c.vx, c.vz);
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
 * The stories from `s` up no longer stand (story mechanism, or crushed from above): shorter
 * collider, wind obstacle and lumped structural model (Phase 17 truncation).
 */
export function truncate(e: RuntimeEntity, ctx: SystemContext, s: number) {
  const mr = e.modular!;
  if (s >= mr.collapsedFrom) return;
  mr.collapsedFrom = s;
  if (s <= 0) return;
  const k = mr.scale;
  const base = mr.initial.stories[s].base;
  // Rooftop units / sign above the cut go too.
  for (const c of e.components) {
    if (c.spec.kind !== 'structure' && c.condition === 'intact' && c.spec.position[1] * k[1] >= base && mr.memberOfComp[e.components.indexOf(c)] < 0) {
      c.condition = 'detached';
      c.state = DamageState.DESTROYED;
    }
  }
  // Phase 36: under structure v2 the body follows the structural cells (cellCollider.ts, rebuilt by the collapse system
  // with this storey cut included) — truncate keeps cutting the dimensions, the wind obstacle and the storey model only.
  if (e.body !== null && !ctx.runtime.structureV2) {
    ctx.physics.removeBody(e.body);
    const plinth = foundationPlinth(e.source, ctx.env.terrain);
    const shapes = [scaleShape({ type: 'box', halfExtents: [e.dims[0] / 2 / k[0], base / 2 / k[1], e.dims[2] / 2 / k[2]], offset: [0, base / 2 / k[1], 0] }, k)];
    if (plinth > 0) shapes.push({ type: 'box', halfExtents: [e.dims[0] / 2 + 0.1, plinth / 2, e.dims[2] / 2 + 0.1], offset: [0, -plinth / 2, 0] });
    e.body = ctx.physics.createBody({
      kind: 'fixed', position: e.pose.position, quaternion: e.pose.quaternion, shapes, mass: e.source.physics.mass,
      friction: e.source.physics.friction, restitution: e.source.physics.restitution, linearDamping: 0.05, angularDamping: 0.35, userData: { entityId: e.id },
    });
  }
  mr.windShare = Math.max(0.05, base / Math.max(0.5, mr.initial.top));
  e.dims[1] = base;
  e.copLocal[1] = base * 0.55;
  ctx.env.windField.updateObstacle(e.id, { height: base });
  const sr = ctx.runtime.seismic;
  if (sr && mr.unit && mr.unitIndex >= 0) sr.model.truncateFrom(mr.unitIndex, mr.unit.lumps.dof[s], GRAVITY);
  e.flags.partialCollapse = e.flags.partialCollapse === undefined ? s : Math.min(e.flags.partialCollapse, s);
  updateReserve(mr);
  mr.rev++;
  e.rev++;
}

/**
 * Total collapse of a modular building (the ground story's mechanism — earthquake, wind, water,
 * ground, impact): recorded now with its cause, as the Phase 0–24 collapse; the superstructure then
 * falls through the collapse engine (crushed onto the ground floor, rubble pile, fragments).
 */
export function modularCollapse(e: RuntimeEntity, ctx: SystemContext, quake?: QuakeCollapse) {
  if (e.flags.collapsed) return;
  const mr = e.modular!;
  const st = structureOf(e, ctx);
  st.storyCause = quake ? quake.cause : e.loadRatio >= e.source.physics.breakThreshold ? 'overload' : 'fatigue';
  e.flags.collapsed = true;
  e.state = DamageState.DESTROYED;
  if (e.body !== null) ctx.physics.removeBody(e.body);
  e.body = null;
  ctx.env.windField.removeObstacle(e.id);
  ctx.env.flood?.removeObstacle(e.id);
  st.globalRecorded = true;
  const hazard: Hazard = quake ? (quake.hazard ?? 'earthquake') : 'wind';
  if (quake) {
    ctx.log(e.id, 'danger', { key: hazard === 'flood' ? 'log.flood.collapsed' : hazard === 'ground' ? 'log.ground.collapsed' : hazard === 'impact' ? 'log.impact.collapsed' : gravityGovernsStructure(e.seismic) ? 'log.celestial.collapsed' : blastGovernsStructure(e.seismic) ? 'log.blast.collapsed' : 'log.quake.collapsed' });
    ctx.recordDamage(e, { eventType: 'COLLAPSED', cause: quake.cause, hazard, response: quake.response, damageAfter: 1, ...quake.extra });
  } else {
    ctx.log(e.id, 'danger', { key: 'log.building.collapsed' });
    ctx.recordDamage(e, { eventType: 'COLLAPSED', cause: e.loadRatio >= e.source.physics.breakThreshold ? 'overload' : 'fatigue', damageAfter: 1 });
  }
  mr.collapsedFrom = 0;
  mr.reserve = 0.05;
  // Direction / speed of the sway (fragments leave with the structure's velocity, not this).
  const kin = kinematics(e, ctx);
  const tmp: Vec3 = [0, 0, 0];
  st.model.failStory(0, 'story', governingHazard(e, hazard, ctx), ctx.time, quake?.response ?? e.loadRatio, (i) => (kin(i, tmp), [tmp[0], tmp[1], tmp[2]] as Vec3));
  syncFailed(mr);
  mr.rev++;
  e.rev++;
  activate(e, ctx);
}

/**
 * Damage level of the structure from the collapse model (folded into the building's state with
 * worst()): partial collapse → CRITICAL, failed structural members → DAMAGED, damaged members → STRESSED.
 */
export function structureLevel(mr: ModularRuntime): DamageState {
  const st = mr.structure;
  if (!st) return DamageState.NORMAL;
  const l = st.level ?? st.model.collapseLevel();
  return l === 'global' ? DamageState.DESTROYED : l === 'partial' ? DamageState.CRITICAL : l === 'local' ? DamageState.DAMAGED : l === 'damaged' ? DamageState.STRESSED : DamageState.NORMAL;
}

/**
 * The Phase 17 analysis of the building as it stands now (failed members removed) — computed on
 * demand when the structure changed (weakest story for the wind, inspector). The simulation itself
 * uses the collapse engine's incremental state (loads, story strengths); this full re-analysis is
 * never run every step.
 */
export function analysisNow(mr: ModularRuntime): BuildingAnalysis {
  if (mr.currentStale) {
    mr.currentStale = false;
    mr.current = analyzeBuilding(mr.design, { scale: mr.scale, failed: mr.failedSet });
  }
  return mr.current;
}

/** Phase 17 failed flags from the collapse model's states. */
export function syncFailed(mr: ModularRuntime) {
  const m = mr.structure?.model;
  if (!m) return;
  for (let i = 0; i < m.n; i++) {
    if (m.state[i] > MS.SEVERE && !mr.failed[i]) {
      mr.failed[i] = 1;
      mr.failedSet.add(mr.design.members[i].id);
      mr.damage[i] = 1;
      if (m.g.structural[i]) mr.weakStale = true;
    }
  }
}

/**
 * Weakest story of the building as it stands, re-derived only after a load-bearing member failed:
 * the Phase 17 criterion (story strength / story shear under the inverted-triangle distribution,
 * analysis §9) with the CURRENT story strengths of the collapse engine — the same per-member
 * contributions the lumped structural model is scaled with (`currentStories`) — and the original
 * story masses. O(members), no full re-analysis (a collapsing building changes every step).
 */
export function weakStoryNow(mr: ModularRuntime): number {
  if (mr.weakStale) {
    mr.weakStale = false;
    const st = mr.initial.stories;
    const c = currentStories(mr);
    let fsum = 0;
    const fz = st.map((s) => { const f = s.mass * (s.base + s.height); fsum += f; return f; });
    let cx = Infinity, cz = Infinity, wx = 0, wz = 0, acc = 0;
    for (let s = mr.floors - 1; s >= 0; s--) {
      acc += fz[s];
      if (s >= mr.collapsedFrom) continue;
      const r = fsum > 0 ? acc / fsum : 1;
      if (c.vx[s] / r < cx) { cx = c.vx[s] / r; wx = s; }
      if (c.vz[s] / r < cz) { cz = c.vz[s] / r; wz = s; }
    }
    // As the analysis' weakStory pair: the lower of the two axes' weakest stories.
    mr.weak = Math.min(wx, wz);
  }
  return mr.weak;
}

/**
 * Collapse of story `s` (the lumped model's mechanism: earthquake damage index, wind fatigue,
 * water or sediment load on the weakest story): its vertical members fail; what they carried
 * falls and strikes the stories below (collapse engine). Ground story → total collapse.
 */
export function collapseFrom(e: RuntimeEntity, ctx: SystemContext, story: number, o: FailOpts, quake?: QuakeCollapse) {
  const mr = e.modular!;
  // The lumped structural model resolves collapse per dof group.
  let s = story;
  if (mr.unit) s = mr.unit.lumps.first[mr.unit.lumps.dof[Math.min(mr.floors - 1, story)] - 1];
  if (s <= 0) {
    modularCollapse(e, ctx, quake ?? (o.hazard === 'wind' ? undefined : { dir: o.dir, speed: 0.3, cause: o.cause, response: o.response, hazard: o.hazard === 'flood' ? 'flood' : o.hazard === 'ground' ? 'ground' : o.hazard === 'impact' ? 'impact' : 'earthquake' }));
    return;
  }
  if (s >= mr.collapsedFrom || e.flags.collapsed) return;
  const st = structureOf(e, ctx);
  st.storyCause = o.cause;
  ctx.recordDamage(e, { eventType: 'STORY_COLLAPSED', cause: o.cause, hazard: o.hazard, response: s + 1, damageAfter: 1 - e.health, localWindSpeed: o.hazard === 'wind' ? e.localWind.speed : 0 });
  ctx.log(e.id, 'danger', { key: 'log.building.storyCollapsed', params: { story: s + 1 } });
  st.noted.add(`story:${s}`);
  truncate(e, ctx, s);
  const kin = kinematics(e, ctx);
  const tmp: Vec3 = [0, 0, 0];
  st.model.failStory(s, 'story', governingHazard(e, o.hazard, ctx), ctx.time, o.response, (i) => (kin(i, tmp), [tmp[0], tmp[1], tmp[2]] as Vec3));
  syncFailed(mr);
  st.lateralDirty = true;
  st.analysisDirty = true;
  mr.currentStale = true;
  mr.weakStale = true;
  mr.rev++;
  e.rev++;
  activate(e, ctx);
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
  const v2 = ctx.runtime.structureV2 === true;
  const failedNow = evaluateDrift(mr, governingHazard(e, 'earthquake', ctx), v2);
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
  const d = 1 - health;
  // The weakest story of the building as it stands now — only when wind damage is drawn or it fails.
  if (d <= 0.12 && health > 0) return false;
  const weak = weakStoryNow(mr);
  if (d > 0.12 && weak < mr.collapsedFrom) {
    for (const i of mr.storyMembers[weak] ?? []) {
      if (!mr.failed[i] && d * 0.9 > mr.damage[i] + 0.02) {
        // The damage the governing health channel draws is that hazard's (Phase 22 attribution).
        raiseDamage(mr, i, d * 0.9, governing);
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
  const c = currentStories(mr);
  const f = e.source.seismic?.structure.strengthFactor ?? 1;
  let cap = Math.max(0, Math.min(c.vx[0] ?? 0, c.vz[0] ?? 0)) * f;
  // Ground-story materials: lateral members for strength loss, walls for finishes.
  let wetW = 0, wetSum = 0, finW = 0, finSum = 0;
  mr.design.members.forEach((m, i) => {
    if (m.level !== 0 || mr.failed[i]) return;
    const mat = MATERIALS[m.material];
    if (isLateralRole(m.role)) {
      const w = mr.initial.members[i].vx + mr.initial.members[i].vz;
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
