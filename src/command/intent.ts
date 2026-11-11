/**
 * Phase 37 — command intents (§4, §5): what one command asks for, as plain data.
 *
 * Every way in — the canonical grammar (`canonical.ts`), the rule-based Korean / English parser (`parse.ts`) and an
 * optional language-model provider (§16) — produces values of this one schema; nothing downstream (resolve → plan →
 * preview → commit) looks at the sentence again. An intent names things symbolically ("the selection", "node n4",
 * "north of #id"); what they are in a particular document is decided later, by `resolve`.
 *
 * Units are the ones the document already uses: metres, degrees (headings, slopes), seconds, and for disaster fields
 * the unit of the phenomenon's own spec field (J, g, …) — the intent carries the number as written.
 */
import { z } from 'zod';

export const DIRECTIONS = ['north', 'south', 'east', 'west'] as const;
export type Direction = (typeof DIRECTIONS)[number];

// ── Positions ────────────────────────────────────────────────────────────────────────

/** A point on the ground. */
export type PlaceRef =
  | { p: 'xz'; x: number; z: number }
  | { p: 'node'; id: string }
  /** A point on a road segment, `t` = fraction of its length from its first node (0 … 1). */
  | { p: 'seg'; id: string; t: number }
  /** The ground point under the mouse (when it is over the viewport). */
  | { p: 'cursor' }
  /** The point the camera looks at. */
  | { p: 'view' }
  /** The middle of the map. */
  | { p: 'center' }
  /** "The junction": the node where three or more roads meet (a choice when there are several). */
  | { p: 'junction' }
  | { p: 'object'; id: string }
  /** The pivot of the current selection / of the last result set. */
  | { p: 'selection' }
  | { p: 'last' }
  | { p: 'group'; name: string }
  /** An object or a group by its name (object names first; a choice when several match). */
  | { p: 'name'; name: string }
  /** A terrain feature — its centre: by id (f3), or by kind (hill, lake …; a choice when there are several). */
  | { p: 'feature'; id: string }
  /** `dist` m (default: just clear of it) to the north / south / east / west of another place. */
  | { p: 'dir'; dir: Direction; of: PlaceRef; dist?: number }
  /** Beside another place (the free side nearest the cursor, else east). */
  | { p: 'next'; of: PlaceRef };

export const placeRefSchema: z.ZodType<PlaceRef> = z.lazy(() =>
  z.union([
    z.object({ p: z.literal('xz'), x: z.number().finite(), z: z.number().finite() }).strict(),
    z.object({ p: z.literal('node'), id: z.string().min(1) }).strict(),
    z.object({ p: z.literal('seg'), id: z.string().min(1), t: z.number().min(0).max(1) }).strict(),
    z.object({ p: z.literal('cursor') }).strict(),
    z.object({ p: z.literal('view') }).strict(),
    z.object({ p: z.literal('center') }).strict(),
    z.object({ p: z.literal('junction') }).strict(),
    z.object({ p: z.literal('object'), id: z.string().min(1) }).strict(),
    z.object({ p: z.literal('selection') }).strict(),
    z.object({ p: z.literal('last') }).strict(),
    z.object({ p: z.literal('group'), name: z.string().min(1) }).strict(),
    z.object({ p: z.literal('name'), name: z.string().min(1) }).strict(),
    z.object({ p: z.literal('feature'), id: z.string().min(1) }).strict(),
    z.object({ p: z.literal('dir'), dir: z.enum(DIRECTIONS), of: placeRefSchema, dist: z.number().finite().nonnegative().optional() }).strict(),
    z.object({ p: z.literal('next'), of: placeRefSchema }).strict(),
  ]),
);

// ── Roads ────────────────────────────────────────────────────────────────────────────

/** A road segment (or the run of segments between two nodes). */
export type RoadRef =
  | { r: 'seg'; id: string }
  /** The road between two nodes (one segment, or the shortest chain of segments). */
  | { r: 'between'; a: string; b: string }
  /** "The main road": the widest road of the map (a choice when there are several). */
  | { r: 'main' }
  /** "The road", when the sentence names none: the only road of the map (a choice when there are several). */
  | { r: 'any' }
  /** The road nearest a place. */
  | { r: 'nearest'; at: PlaceRef };

export const roadRefSchema: z.ZodType<RoadRef> = z.union([
  z.object({ r: z.literal('seg'), id: z.string().min(1) }).strict(),
  z.object({ r: z.literal('between'), a: z.string().min(1), b: z.string().min(1) }).strict(),
  z.object({ r: z.literal('main') }).strict(),
  z.object({ r: z.literal('any') }).strict(),
  z.object({ r: z.literal('nearest'), at: placeRefSchema }).strict(),
]);

// ── Targets (sets of objects) ────────────────────────────────────────────────────────

export const COMPARE_OPS = ['>=', '<=', '>', '<', '='] as const;
export type CompareOp = (typeof COMPARE_OPS)[number];

export type TargetBase =
  | { b: 'selection' }
  /** What the last confirmed command made or changed. */
  | { b: 'last' }
  /** "Them", with nothing named: the selection when there is one, else the last result set. */
  | { b: 'it' }
  | { b: 'all' }
  | { b: 'id'; id: string }
  | { b: 'group'; name: string }
  /** Objects or a group by name (object names first; a choice when several match). */
  | { b: 'name'; name: string }
  /** Every object of a kind (`preset`: a palette preset of that kind, e.g. building:house). */
  | { b: 'type'; type: string; preset?: string };

export type Predicate =
  /** Storeys of a building · ground slope under the object (°) · height of the object (m). */
  | { f: 'floors' | 'slope' | 'height'; op: CompareOp; v: number }
  | { f: 'near'; at: PlaceRef; r: number }
  /** Standing on a road (any road, or the one named). */
  | { f: 'onRoad'; road?: RoadRef }
  | { f: 'hidden' | 'locked' | 'visible' | 'unlocked' }
  /** Buildings whose structural analysis reports a warning (any, or the one named). */
  | { f: 'warning'; code?: string };

export type Rank = { by: 'largest' | 'tallest' } | { by: 'nearest'; at: PlaceRef };

export interface TargetRef {
  base: TargetBase;
  where?: Predicate[];
  rank?: Rank;
  /** Keep only the first N (after filtering and ranking; without a rank: document order). */
  first?: number;
}

const targetBaseSchema: z.ZodType<TargetBase> = z.union([
  z.object({ b: z.literal('selection') }).strict(),
  z.object({ b: z.literal('last') }).strict(),
  z.object({ b: z.literal('it') }).strict(),
  z.object({ b: z.literal('all') }).strict(),
  z.object({ b: z.literal('id'), id: z.string().min(1) }).strict(),
  z.object({ b: z.literal('group'), name: z.string().min(1) }).strict(),
  z.object({ b: z.literal('name'), name: z.string().min(1) }).strict(),
  z.object({ b: z.literal('type'), type: z.string().min(1), preset: z.string().min(1).optional() }).strict(),
]);

const predicateSchema: z.ZodType<Predicate> = z.union([
  z.object({ f: z.enum(['floors', 'slope', 'height']), op: z.enum(COMPARE_OPS), v: z.number().finite() }).strict(),
  z.object({ f: z.literal('near'), at: placeRefSchema, r: z.number().finite().positive() }).strict(),
  z.object({ f: z.literal('onRoad'), road: roadRefSchema.optional() }).strict(),
  z.object({ f: z.enum(['hidden', 'locked', 'visible', 'unlocked']) }).strict(),
  z.object({ f: z.literal('warning'), code: z.string().min(1).optional() }).strict(),
]);

const rankSchema: z.ZodType<Rank> = z.union([
  z.object({ by: z.enum(['largest', 'tallest']) }).strict(),
  z.object({ by: z.literal('nearest'), at: placeRefSchema }).strict(),
]);

export const targetRefSchema: z.ZodType<TargetRef> = z
  .object({
    base: targetBaseSchema,
    where: z.array(predicateSchema).min(1).optional(),
    rank: rankSchema.optional(),
    first: z.number().int().positive().optional(),
  })
  .strict();

// ── Areas ────────────────────────────────────────────────────────────────────────────

export type AreaRef =
  | { a: 'rect'; x0: number; z0: number; x1: number; z1: number }
  | { a: 'circle'; at: PlaceRef; r: number }
  /** Within `r` m of the footprints of some objects. */
  | { a: 'around'; target: TargetRef; r: number }
  /** The footprint of a terrain feature (hill, lake …). */
  | { a: 'feature'; id: string };

export const areaRefSchema: z.ZodType<AreaRef> = z.union([
  z.object({ a: z.literal('rect'), x0: z.number().finite(), z0: z.number().finite(), x1: z.number().finite(), z1: z.number().finite() }).strict(),
  z.object({ a: z.literal('circle'), at: placeRefSchema, r: z.number().finite().positive() }).strict(),
  z.object({ a: z.literal('around'), target: targetRefSchema, r: z.number().finite().positive() }).strict(),
  z.object({ a: z.literal('feature'), id: z.string().min(1) }).strict(),
]);

// ── Placed disasters ─────────────────────────────────────────────────────────────────

/** One placed disaster: its instance id (p3), or — when there is only one of them — its type, or the n-th of a type. */
export type InstanceRef = { i: 'id'; id: string } | { i: 'type'; type: string; nth?: number } | { i: 'all' };

export const instanceRefSchema: z.ZodType<InstanceRef> = z.union([
  z.object({ i: z.literal('id'), id: z.string().min(1) }).strict(),
  z.object({ i: z.literal('type'), type: z.string().min(1), nth: z.number().int().positive().optional() }).strict(),
  z.object({ i: z.literal('all') }).strict(),
]);

// ── Intents ──────────────────────────────────────────────────────────────────────────

export const SIDES = ['left', 'right', ...DIRECTIONS] as const;
export type Side = (typeof SIDES)[number];
export const TERRAIN_OPS = ['raise', 'lower', 'flatten', 'smooth'] as const;
export const ALIGN_AXES = ['x', 'z'] as const;
/** Align by the side the objects face instead of a world axis (decided from their headings when planned). */
export const ALIGN_EDGES = ['front', 'back'] as const;
/** `auto`: the axis along which the objects are spread out more. */
export const DISTRIBUTE_AXES = ['x', 'z', 'auto'] as const;
export const ALIGN_MODES = ['min', 'center', 'max'] as const;
export const ALIGN_REFS = ['origin', 'footprint'] as const;
export const MATCH_WHAT = ['heading', 'height', 'scale'] as const;
export const COPY_PROPS = ['scale', 'heading', 'params', 'physics', 'structure'] as const;
export const FLAG_OPS = ['hide', 'show', 'lock', 'unlock'] as const;
export const INSTANCE_OPS = ['move', 'delete', 'stop', 'pause', 'resume'] as const;
export const QUERY_OPS = ['count', 'list', 'measure', 'info'] as const;
/** What a query without an object target is about. */
export const QUERY_TOPICS = ['disasters', 'groups', 'roads', 'sim'] as const;

const num = z.number().finite();
const fieldValue = z.union([num, z.string().min(1)]);

export const intentSchema = z.discriminatedUnion('kind', [
  /** New objects of a palette kind: at a place, or `count` of them along one side of a road. */
  z.object({
    kind: z.literal('place'),
    type: z.string().min(1),
    preset: z.string().min(1).optional(),
    count: z.number().int().positive().optional(),
    at: placeRefSchema.optional(),
    along: roadRefSchema.optional(),
    side: z.enum(SIDES).optional(),
    /** Clear distance between neighbours (m). */
    gap: num.nonnegative().optional(),
    floors: z.number().int().positive().optional(),
    /** Heading (°): the Inspector's "Y heading" — counter-clockwise seen from above, 0 = the object's local +x points east. */
    heading: num.optional(),
  }).strict(),
  z.object({ kind: z.literal('select'), mode: z.enum(['set', 'add', 'remove']), target: targetRefSchema }).strict(),
  z.object({ kind: z.literal('deselect') }).strict(),
  /** Rigid move: by an offset (east, up, south — the document's x, y, z) or with the pivot to a place. */
  z.object({ kind: z.literal('move'), target: targetRefSchema, by: z.tuple([num, num, num]).optional(), to: placeRefSchema.optional() }).strict(),
  /** Turn about the pivot (°, counter-clockwise seen from above — the sign of the Inspector's Y heading). */
  z.object({ kind: z.literal('rotate'), target: targetRefSchema, by: num }).strict(),
  z.object({ kind: z.literal('scale'), target: targetRefSchema, factor: num.positive() }).strict(),
  /** Write the same value into a transform field of every object (the multi-inspector's common fields). */
  z.object({
    kind: z.literal('set'),
    target: targetRefSchema,
    x: num.optional(), y: num.optional(), z: num.optional(),
    heading: num.optional(), scale: num.positive().optional(),
    /** Height above the ground under each object (m). */
    lift: num.optional(),
  }).strict(),
  /** Line objects up on a world axis (x: west ↔ east, z: north ↔ south) — or by the side they face (`edge`). */
  z.object({
    kind: z.literal('align'), target: targetRefSchema,
    axis: z.enum(ALIGN_AXES).optional(), mode: z.enum(ALIGN_MODES).optional(), edge: z.enum(ALIGN_EDGES).optional(),
    ref: z.enum(ALIGN_REFS),
  }).strict(),
  z.object({ kind: z.literal('distribute'), target: targetRefSchema, axis: z.enum(DISTRIBUTE_AXES), gaps: z.boolean() }).strict(),
  z.object({ kind: z.literal('match'), target: targetRefSchema, what: z.enum(MATCH_WHAT), to: targetRefSchema.optional() }).strict(),
  z.object({ kind: z.literal('copy'), props: z.array(z.enum(COPY_PROPS)).min(1), from: targetRefSchema, target: targetRefSchema }).strict(),
  z.object({ kind: z.literal('group'), target: targetRefSchema, name: z.string().min(1).max(80).optional() }).strict(),
  z.object({ kind: z.literal('ungroup'), target: targetRefSchema }).strict(),
  z.object({ kind: z.literal('rename'), target: targetRefSchema, name: z.string().min(1).max(80) }).strict(),
  z.object({ kind: z.literal('flag'), op: z.enum(FLAG_OPS), target: targetRefSchema }).strict(),
  z.object({ kind: z.literal('delete'), target: targetRefSchema }).strict(),
  z.object({ kind: z.literal('duplicate'), target: targetRefSchema, offset: z.tuple([num, num]).optional() }).strict(),
  z.object({ kind: z.literal('terrain'), op: z.enum(TERRAIN_OPS), area: areaRefSchema, by: num.positive().optional(), to: num.optional() }).strict(),
  z.object({ kind: z.literal('paint'), area: areaRefSchema, ground: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('road'), from: placeRefSchema, to: placeRefSchema, preset: z.string().min(1).optional() }).strict(),
  z.object({ kind: z.literal('forest'), area: areaRefSchema, density: fieldValue.optional(), seed: z.number().int().nonnegative().optional() }).strict(),
  /** Place a disaster: `fields` are the phenomenon's own spec fields, in their own units. */
  z.object({
    kind: z.literal('disaster'),
    type: z.string().min(1),
    at: placeRefSchema.optional(),
    fields: z.record(z.string(), fieldValue),
    /** Start time (s): after the simulation starts — or, during a run, from now. */
    start: num.nonnegative().optional(),
    /**
     * Also run it at once (the mouse's "run on click"): the instance is placed in the plan and started in the
     * simulation, entering it if needed. This is what the older "make an earthquake" sentences mean.
     */
    now: z.literal(true).optional(),
  }).strict(),
  z.object({ kind: z.literal('instance'), ref: instanceRefSchema, op: z.enum(INSTANCE_OPS), to: placeRefSchema.optional() }).strict(),
  z.object({ kind: z.literal('sim'), op: z.enum(['run', 'pause', 'reset']) }).strict(),
  z.object({ kind: z.literal('speed'), value: num.positive() }).strict(),
  z.object({ kind: z.literal('focus'), target: targetRefSchema.optional(), at: placeRefSchema.optional() }).strict(),
  z.object({ kind: z.literal('undo') }).strict(),
  z.object({ kind: z.literal('redo') }).strict(),
  /** Read-only questions: about objects (`target`), the distance between two places, or a topic. */
  z.object({
    kind: z.literal('query'),
    op: z.enum(QUERY_OPS),
    target: targetRefSchema.optional(),
    topic: z.enum(QUERY_TOPICS).optional(),
    from: placeRefSchema.optional(),
    to: placeRefSchema.optional(),
  }).strict(),
]);

export type Intent = z.infer<typeof intentSchema>;
export type IntentKind = Intent['kind'];
export type IntentOf<K extends IntentKind> = Extract<Intent, { kind: K }>;

/** Intents that change the document (the rest act at once: queries, camera, selection, run control). */
export const EDITING_KINDS: ReadonlySet<IntentKind> = new Set<IntentKind>([
  'place', 'move', 'rotate', 'scale', 'set', 'align', 'distribute', 'match', 'copy', 'group', 'ungroup', 'rename', 'flag',
  'delete', 'duplicate', 'terrain', 'paint', 'road', 'forest', 'disaster',
]);

export const isEditing = (i: Intent): boolean => EDITING_KINDS.has(i.kind) || (i.kind === 'instance' && (i.op === 'move' || i.op === 'delete'));

/**
 * Rules between the fields of one intent that the shape alone does not say (null = fine): what must come together and
 * what excludes what. Checked wherever intents enter (canonical text, the rule parser, a provider's JSON).
 */
export function intentProblem(i: Intent): string | null {
  switch (i.kind) {
    case 'place':
      if (i.at && i.along) return 'place: at and along exclude each other';
      if (i.side && !i.along) return 'place: side needs along';
      return null;
    case 'move': return (i.by === undefined) === (i.to === undefined) ? 'move: exactly one of by / to' : null;
    case 'align':
      if (i.edge !== undefined) return i.axis !== undefined || i.mode !== undefined ? 'align: edge excludes axis / mode' : null;
      return i.axis === undefined || i.mode === undefined ? 'align: axis and mode, or edge' : null;
    case 'set': return [i.x, i.y, i.z, i.heading, i.scale, i.lift].every((v) => v === undefined) ? 'set: no field' : i.y !== undefined && i.lift !== undefined ? 'set: y and lift exclude each other' : null;
    case 'terrain': return i.to !== undefined && i.op !== 'flatten' ? 'terrain: to is for flatten' : null;
    case 'instance': return (i.op === 'move') !== (i.to !== undefined) ? 'disaster move: to=<place> (only for move)' : null;
    case 'focus': return (i.target === undefined) === (i.at === undefined) ? 'focus: a target or at=<place>' : null;
    case 'query': {
      const forms = [i.target !== undefined, i.topic !== undefined, i.from !== undefined || i.to !== undefined].filter(Boolean).length;
      if (forms !== 1) return 'query: one of target / topic / two places';
      if ((i.from === undefined) !== (i.to === undefined)) return 'measure: two places';
      if (i.from && i.op !== 'measure') return 'query: two places are for measure';
      if (i.topic && i.op === 'measure') return 'measure: a target or two places';
      return null;
    }
    default: return null;
  }
}

/** Validate intents from any source (the canonical parser, the rule parser, a language-model provider). */
export function validateIntents(value: unknown): { ok: true; intents: Intent[] } | { ok: false; issues: string[] } {
  const r = z.array(intentSchema).safeParse(value);
  if (!r.success) return { ok: false, issues: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  const issues = r.data.flatMap((i, k) => { const p = intentProblem(i); return p ? [`${k}: ${p}`] : []; });
  return issues.length ? { ok: false, issues } : { ok: true, intents: r.data };
}
