/**
 * Structural destruction in the simulation (Phase 25) — per-building state and scene bookkeeping.
 *
 * A modular building gets its collapse model (src/structure/collapse.ts) LAZILY, the first time
 * something can change its structure (a member fails, the ground under a foundation gives way, a
 * debris strike). Buildings that are never touched allocate nothing and cost nothing; the graph
 * behind the model is shared by every copy of the design.
 */
import type { EntityId, Vec3 } from '@/core/types';
import { qRotate } from '@/core/math';
import { graphOf } from '@/structure/graph';
import { CollapseModel } from '@/structure/collapse';
import type { WorldObject } from '@/core/model';
import { foundationContact } from '@/buildings/foundation';
import type { RuntimeEntity, SimulationRuntime } from '../SimulationRuntime';
import type { SystemContext } from '../systems/SimulationSystem';
import { RubbleField } from './rubbleField';
import { simProfiler } from '../profiling/SimProfiler';

export interface StructureState {
  model: CollapseModel;
  /** Member FAILED events recorded in the damage log for this building (budget). */
  recorded: number;
  /** Model revision last synchronized into the Phase 17 runtime / renderers, and its structural revision. */
  syncedRev: number;
  syncedStruct: number;
  /** Records already turned into damage events / milestones. */
  seenRecords: number;
  /** Lateral members that left since the last lumped-model sync. */
  lateralDirty: boolean;
  /** A full Phase 17 re-analysis (mr.current) is due (throttled). */
  analysisDirty: boolean;
  lastAnalysis: number;
  /** Scene rubble heap of each model pile. */
  heaps: number[];
  /** COLLAPSED recorded (global collapse). */
  globalRecorded: boolean;
  /** Building-level events already logged / milestoned. */
  noted: Set<string>;
  /** Cause given to the latest story mechanism (lumped model) — the cause recorded for its members. */
  storyCause?: import('../analysis/DamageEvent').DamageCause;
  /** Rubble mass already added to each dof of the lumped structural model (kg). */
  restMass?: Float64Array;
  /** Last collapse classification (logs / milestones on change). */
  level?: ReturnType<CollapseModel['collapseLevel']>;
}

/** Scene-level structural destruction state (created with the first structural change). */
export interface StructuresRuntime {
  /** Buildings whose model has work to do (falling blocks, pending rounds, events). */
  active: RuntimeEntity[];
  /** Every building with a model (results, inspector). */
  all: RuntimeEntity[];
  rubble: RubbleField;
  /** Fragment bodies (debris pieces) of the structural engine, oldest first, and by id. */
  fragments: import('../SimulationRuntime').DebrisPiece[];
  fragmentById: Map<string, import('../SimulationRuntime').DebrisPiece>;
  /** Mass of fragments aggregated over the active-body budget (kg) — also in each building's ledger. */
  aggregated: number;
  /** Strike episodes already evaluated: `${debris}|${target}` → last step seen. */
  strikes: Map<string, number>;
  /** Secondary damage events recorded. */
  secondary: number;
  /** Legacy debris recycled by the Phase 0–24 debris cap (bookkeeping only, kg). */
  legacyRecycled: number;
  /** First-occurrence milestones. */
  milestones: Set<string>;
}

export function structuresOf(rt: SimulationRuntime): StructuresRuntime {
  return (rt.structures ??= { active: [], all: [], rubble: new RubbleField(), fragments: [], fragmentById: new Map(), aggregated: 0, strikes: new Map(), secondary: 0, legacyRecycled: 0, milestones: new Set() });
}

/** Static bearing ratio of the building in the original world (Phase 17 foundation contact). */
function bearing0(e: RuntimeEntity, ctx: SystemContext): number {
  if (e.ground && Number.isFinite(e.ground.bearing0)) return e.ground.bearing0;
  try {
    const eng = ctx.env.deformation.engine;
    const c = foundationContact(e.source as WorldObject, eng ? eng.originalSampler() : ctx.env.terrain);
    return Number.isFinite(c.bearingRatio) ? c.bearingRatio : 0;
  } catch {
    return 0;
  }
}

/** The building's structure state, created on first use. */
export function structureOf(e: RuntimeEntity, ctx: SystemContext): StructureState {
  const mr = e.modular!;
  if (mr.structure) return mr.structure;
  const tProf = simProfiler.now();
  const g = graphOf(mr.design, mr.scale);
  const model = new CollapseModel(g, mr.damage);
  model.init(bearing0(e, ctx));
  simProfiler.add('struct.create', tProf);
  // Members the Phase 17 runtime already removed (absent in the original world) stay absent.
  const st: StructureState = {
    model, recorded: 0, syncedRev: -1, syncedStruct: -1, seenRecords: 0, lateralDirty: false, analysisDirty: false, lastAnalysis: -Infinity,
    heaps: [], globalRecorded: false, noted: new Set(),
  };
  st.level = model.collapseLevel();
  mr.structure = st;
  const S = structuresOf(ctx.runtime);
  S.all.push(e);
  activate(e, ctx);
  return st;
}

/** Put a building on the active list (its model has work to do). */
export function activate(e: RuntimeEntity, ctx: SystemContext) {
  const S = structuresOf(ctx.runtime);
  if (!S.active.includes(e)) S.active.push(e);
}

const tmp: [number, number] = [0, 0];

/**
 * Horizontal velocity of the standing structure at a member, in the building's local frame
 * (relative to the ground — the physics world is the ground frame): the lumped model's top
 * velocity scaled by the member's height (first-mode shape). Zero without a structural model.
 */
export function kinematics(e: RuntimeEntity, ctx: SystemContext) {
  const sr = ctx.runtime.seismic;
  const ui = e.seismic?.unit ?? -1;
  const mr = e.modular!;
  const H = Math.max(1, mr.initial.top);
  const q = e.initialPose.quaternion;
  const inv: [number, number, number, number] = [-q[0], -q[1], -q[2], q[3]];
  return (i: number, out: Vec3) => {
    out[0] = out[1] = out[2] = 0;
    if (!sr || ui < 0) return;
    sr.model.topVelocity(ui, tmp);
    const g = mr.structure!.model.g;
    const yc = (g.box[6 * i + 1] + g.box[6 * i + 4]) / 2;
    const f = Math.max(0, Math.min(1, yc / H));
    const local = qRotate(inv, [tmp[0] * f, 0, tmp[1] * f]);
    out[0] = local[0];
    out[2] = local[2];
  };
}

/** World position of a point given in the building's local frame (current pose). */
export function toWorld(e: RuntimeEntity, local: Vec3): Vec3 {
  const p = qRotate(e.pose.quaternion, local);
  return [e.pose.position[0] + p[0], e.pose.position[1] + p[1], e.pose.position[2] + p[2]];
}

/** Local → world direction (current pose). */
export function dirToWorld(e: RuntimeEntity, v: Vec3): Vec3 {
  return qRotate(e.pose.quaternion, v);
}

export type { EntityId };
