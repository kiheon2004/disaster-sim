/**
 * Phase 37 — plans (§4, §9): what one intent will do to one document, as data. A plan is made by pure functions from
 * (intent, document, Context); nothing is written until `apply` runs its operations inside one `worldStore.batch`.
 * The same plan runs on a fork of the document for the preview and on the document itself when confirmed.
 */
import type { EntityId } from '@/core/types';
import type { WorldObject } from '@/core/model';
import type { PhenomenonInstance } from '@/phenomena/types';
import type { SnapKind } from '@/editor/snap/snapEngine';
import type { PlacementWarning } from '@/editor/build/placementCheck';
import type { VehicleCar } from '@/vehicle/settings';
import type { CreateObjectInput } from '@/world/WorldDocument';
import type { WorldEdit } from '@/world/worldStore';
import type { Highlight, Msg } from './context';
import type { Intent } from './intent';
import type { Clarify, Resolved } from './resolve';

// ── Safety limits (§19) ──────────────────────────────────────────────────────────────

/** Most objects one command may create or change. */
export const MAX_ITEMS = 2000;
/** From this many created / changed / removed objects on, a command needs an explicit confirmation. */
export const CONFIRM_ITEMS = 200;
/** Share of the map one terrain / forest command may cover before it needs an explicit confirmation. */
export const CONFIRM_AREA_SHARE = 0.5;
/** Editing commands that touch at most this many objects may be applied without a preview when the user allows it. */
export const SMALL_EDIT_ITEMS = 20;

// ── Operations on the document ───────────────────────────────────────────────────────

/** One per-vertex terrain stroke of a command: the dabs are made from the terrain it is applied to. */
export interface ProgramStroke {
  /** Vertices and their weights (0 … 1: 1 inside the area, falling to 0 over the feather band at its edge). */
  cells: { x: number; z: number; w: number }[];
  op: 'raise' | 'lower' | 'flatten' | 'smooth' | 'paint';
  /** raise / lower: metres at weight 1. */
  by?: number;
  /** flatten: the level (m). */
  to?: number;
  /** paint: the ground type id. */
  ground?: number;
}

export type PlanOp =
  /** `applyEdit` — `result` says which ids become the result set: the ones it adds, the ones it updates, or none. */
  | { op: 'edit'; edit: WorldEdit; result: 'added' | 'updated' | 'none' }
  /**
   * Copies of existing objects (duplicate), committed like the editor's stamps (world/stamp.ts `applyStamp`): the car
   * settings the copied cars carry (`cars`, by the stamp's keys; `keys[k]` belongs to `inputs[k]`) are written under
   * the new ids in the same step.
   */
  | { op: 'stamp'; inputs: CreateObjectInput[]; cars: Record<string, VehicleCar> | null; keys: string[] }
  | { op: 'groupName'; group: string; name: string }
  /** The experiment plan's instances (placed disasters), as a whole. */
  | { op: 'experiment'; instances: PhenomenonInstance[] }
  | { op: 'terrain'; stroke: ProgramStroke };

// ── Effects outside the document ─────────────────────────────────────────────────────

export type Effect =
  | { fx: 'select'; ids: EntityId[]; primary: EntityId | null }
  /** Select what the plan's operations added (ids are not known before they run). */
  | { fx: 'selectAdded' }
  | { fx: 'focus'; ids: EntityId[] }
  | { fx: 'focusAt'; x: number; z: number }
  | { fx: 'sim'; op: 'run' | 'pause' | 'reset' }
  | { fx: 'speed'; value: number }
  /** Control of an instance in the current run. */
  | { fx: 'control'; key: string; op: 'stop' | 'pause' | 'resume' | 'cancel' }
  /** Start these instances of the plan at once (entering the simulation if needed). */
  | { fx: 'runInstances'; ids: string[] }
  | { fx: 'undo' }
  | { fx: 'redo' };

// ── What the user is shown ───────────────────────────────────────────────────────────

/** One thing a plan makes or tries to make (a building of "three houses", a car on a lane …). */
export interface PlanItem {
  status: 'ok' | 'warn' | 'rejected';
  x: number;
  z: number;
  /** Warnings of the placement check (orange), or why it was rejected. */
  reasons: (PlacementWarning | 'room' | 'onRoad' | 'endedLane' | 'noSidewalk')[];
  /** What the position was snapped to. */
  snap?: SnapKind;
}

export interface QueryColumn {
  key: string;
  label: Msg;
}

/** The answer of a query: a small table; `ids` are the objects it is about ("select these"). */
export interface QueryTable {
  title: Msg;
  columns: QueryColumn[];
  rows: { cells: Record<string, string | number | Msg>; id?: EntityId; instance?: string }[];
  ids: EntityId[];
}

export interface Plan {
  intent: Intent;
  canonical: string;
  ops: PlanOp[];
  effects: Effect[];
  /** What the operations are meant to create / change / remove (the preview counts the real difference again). */
  counts: { create: number; change: number; remove: number };
  items: PlanItem[];
  /** What was assumed, skipped or clamped — shown with the summary. */
  notes: Msg[];
  /** Warnings that deserve attention (shown with a mark, not only a colour). */
  warnings: Msg[];
  table?: QueryTable;
  /** Existing objects this plan changes — with what its operations add, the next "last" result set. */
  resultIds: EntityId[];
  /** Applies at once, without a preview: queries, camera, selection, run control, run-now disasters. */
  immediate: boolean;
  /** Large enough to need an explicit confirmation step (§19). */
  confirm: Msg | null;
  /** Things to highlight while the plan is open (what will be removed / changed). */
  highlight: Highlight;
}

export interface PlanClarifyOption {
  label: Msg;
  /** The intent with the ambiguous reference replaced. */
  intent: Intent;
  canonical: string;
  highlight?: Highlight;
}

export interface PlanClarify {
  question: Msg;
  options: PlanClarifyOption[];
}

export type PlanResult = { ok: true; plan: Plan } | { ok: false; error: Msg; notes: Msg[] } | { ok: false; clarify: PlanClarify };

/** Thrown inside a planner to leave it with an error / a question (caught by `planIntent`). */
export class PlanStop extends Error {
  constructor(readonly stop: { error: Msg } | { clarify: Clarify } | { planClarify: PlanClarify }) {
    super('plan stopped');
  }
}

/** A resolved reference, or leave the planner with its error / question. */
export function need<T>(r: Resolved<T>, notes: Msg[]): T {
  if (r.ok) {
    notes.push(...r.notes);
    return r.value;
  }
  throw new PlanStop('error' in r ? { error: r.error } : { clarify: r.clarify });
}

export const stop = (error: Msg): never => {
  throw new PlanStop({ error });
};

/** Options the planners share. */
export interface PlanOptions {
  /** The document's simulation seed: seeds of everything a command creates derive from it and the command text. */
  seed: number;
}

export type Objs = readonly WorldObject[];

/** What a planner fills in while it works on one intent. */
export interface Draft {
  ops: PlanOp[];
  effects: Effect[];
  counts: { create: number; change: number; remove: number };
  items: PlanItem[];
  notes: Msg[];
  warnings: Msg[];
  table?: QueryTable;
  resultIds: EntityId[];
  immediate: boolean;
  confirm: Msg | null;
  highlight: Highlight;
}

export const newDraft = (): Draft => ({
  ops: [], effects: [], counts: { create: 0, change: 0, remove: 0 }, items: [], notes: [], warnings: [], resultIds: [], immediate: false, confirm: null, highlight: {},
});
