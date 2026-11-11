/**
 * Phase 37 — what the viewport draws for a command plan (§9), as plain data: the plan's document difference
 * (`Preview.diff`, command/diff.ts) and its items turned into lists the preview layer hands to the renderers —
 * ghosts for the batched ghost renderer, boxes for the removed / changed markings, road lines, disaster pins, snap
 * markers, highlights. Pure: no three.js, no store; the same plan gives the same model.
 *
 * Nothing of the difference is left out: an object the plan re-seats on changed ground is a "moved" object like one
 * the command moves — except that a move of less than 5 cm is marked as a change, not drawn as a ghost (`settledOnly`).
 */
import type { EntityId, Vec3 } from '@/core/types';
import type { WorldDocument, WorldObject } from '@/core/model';
import type { Highlight } from '@/command/context';
import type { PlanItem } from '@/command/planTypes';
import type { Preview } from '@/command/run';
import type { TerrainDiff } from '@/command/diff';
import type { PlannedObject } from '@/editor/build/placementPlan';
import type { PlacementWarning } from '@/editor/build/placementCheck';
import type { SnapKind } from '@/editor/snap/snapEngine';
import { getDefinition } from '@/objects/registry';
import { catalogOf, placeable, type Category, type Footprint } from '@/phenomena/catalog';
import type { PhenomenonInstance } from '@/phenomena/types';
import { segmentLine } from '@/roads/network';
import type { RoadNetwork } from '@/roads/types';
import type { GridRect } from '@/terrain/TerrainData';
import type { CreateObjectInput } from '@/world/WorldDocument';

// ── Pieces ───────────────────────────────────────────────────────────────────────────

/** An object's bounding box: its origin (the middle of its base), its rotation, its size (dimensions × scale). */
export interface BoxMark {
  id: EntityId;
  position: Vec3;
  /** Euler XYZ, radians — the document's transform. */
  rotation: Vec3;
  size: Vec3;
}

export interface GroundMark {
  x: number;
  z: number;
}

export interface SnapMark extends GroundMark {
  kind: SnapKind;
}

/** A road segment's centre line (points about 1 m apart, a → b) and its carriageway width. */
export interface RoadMark {
  id: string;
  points: [number, number][];
  width: number;
}

export interface PinMark {
  id: string;
  type: string;
  category: Category;
  at: [number, number];
  /** A moved instance: where its pin is now. */
  from?: [number, number];
  footprint: Footprint | null;
  /** What the plan does with the instance — or `highlight`: an existing instance a question / plan points at. */
  state: 'added' | 'changed' | 'removed' | 'highlight';
}

export interface RingMark extends GroundMark {
  /** Radius (m). */
  r: number;
  of: 'node' | 'point';
}

/** A terrain change as the height preview mesh takes it (rendering/terrain/HeightPreviewMesh.ts). */
export interface TerrainMark {
  rect: GridRect;
  dh: Float32Array;
  painted: Uint8Array;
  /** Largest raise (≥ 0) and largest lowering as the mesh wants it (≤ 0 — the diff has it ≥ 0). */
  up: number;
  down: number;
  /** Changed area (m²). */
  area: number;
  /**
   * Ground type id a paint stroke of the plan gives each vertex of `rect` (−1: none). One vertex around every painted
   * patch carries its neighbour's id, so the patch's edge fades in its own colour.
   */
  paint: Int16Array;
}

export interface HighlightMarks {
  boxes: BoxMark[];
  lines: RoadMark[];
  rings: RingMark[];
  pins: PinMark[];
}

export interface PreviewModel {
  /** Added objects, then moved objects at their new transform — for the batched ghost renderer. */
  ghosts: PlannedObject[];
  /** How many of `ghosts` are added objects (the first ones) and how many of all carry a warning. */
  added: number;
  warned: number;
  /** Plan items that were rejected: a marker, no ghost. */
  rejected: GroundMark[];
  /** Moved by more than a hair (see `settledOnly`). */
  moved: { from: BoxMark; to: BoxMark }[];
  removed: BoxMark[];
  /** Changed in another way than by moving (name, group, flags, parameters) — and objects that only settle. */
  changed: BoxMark[];
  terrain: TerrainMark | null;
  roads: { added: RoadMark[]; removed: RoadMark[] };
  pins: PinMark[];
  snaps: SnapMark[];
  /** What the plan's lines point at (`Plan.highlight`). */
  highlight: HighlightMarks;
}

// ── Objects ──────────────────────────────────────────────────────────────────────────

export function boxOf(o: WorldObject): BoxMark {
  const d = getDefinition(o.type).getDimensions(o.params);
  const k = o.transform.scale;
  return { id: o.id, position: [...o.transform.position], rotation: [...o.transform.rotation], size: [d[0] * k[0], d[1] * k[1], d[2] * k[2]] };
}

/**
 * An object of the difference as the ghost renderer's input. The seed is the object's own: the renderer builds the
 * ghost with `createWorldObject(input)`, and with the seed passed through the ghost is the object that will be placed
 * (same generated parts), not a random sibling.
 */
export function plannedOf(o: WorldObject, warnings: readonly PlacementWarning[] = []): PlannedObject {
  const input: CreateObjectInput = { type: o.type, params: o.params, seed: o.seed, transform: o.transform };
  if (o.building) input.building = o.building;
  if (o.terrainAlign !== undefined) input.terrainAlign = o.terrainAlign;
  return { input, ok: true, warnings: [...warnings] };
}

/** A transform change smaller than this is not drawn as a move (m; rad). */
export const SETTLE_DISTANCE = 0.05;
export const SETTLE_ANGLE = 0.01;

/**
 * Whether a "moved" object of the difference only settles: its place changes by less than 5 cm, its rotation by less
 * than 0.01 rad and its scale not at all — what a terrain or road edit does to objects whose ground it barely touches.
 * Such an object is marked as changed; it gets no ghost and no arrow.
 */
export function settledOnly(a: WorldObject, b: WorldObject): boolean {
  const p = a.transform.position, q = b.transform.position;
  if (Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) >= SETTLE_DISTANCE) return false;
  if (a.transform.rotation.some((v, i) => Math.abs(v - b.transform.rotation[i]) >= SETTLE_ANGLE)) return false;
  return a.transform.scale.every((v, i) => v === b.transform.scale[i]);
}

/** Plan items are matched with the objects they became by position (the planner places the object at the item). */
const spot = (x: number, z: number) => `${Math.round(x * 1000)},${Math.round(z * 1000)}`;

const PLACEMENT_WARNINGS: ReadonlySet<string> = new Set<PlacementWarning>(['slope', 'floating', 'buried', 'overlap', 'outside', 'wheelContact', 'steep', 'inWater', 'offRoad']);
const isPlacementWarning = (r: PlanItem['reasons'][number]): r is PlacementWarning => PLACEMENT_WARNINGS.has(r);

/**
 * The warnings an item carries, for the ghost renderer (any → the orange ghost). An item marked `warn` for a reason
 * that is not a placement warning still counts as warned.
 */
export function warningsOf(item: PlanItem | undefined): PlacementWarning[] {
  if (!item || item.status !== 'warn') return [];
  const own = item.reasons.filter(isPlacementWarning);
  return own.length ? own : ['overlap'];
}

// ── Roads ────────────────────────────────────────────────────────────────────────────

export function roadMark(net: RoadNetwork, id: string): RoadMark | null {
  const seg = net.segments[id];
  if (!seg || !net.nodes[seg.a] || !net.nodes[seg.b]) return null;
  return { id, points: segmentLine(net, seg).samples.map((s) => [s.x, s.z] as [number, number]), width: seg.profile.width };
}

const roadMarks = (net: RoadNetwork, ids: readonly string[]): RoadMark[] => ids.map((id) => roadMark(net, id)).filter((m): m is RoadMark => m !== null);

// ── Disasters ────────────────────────────────────────────────────────────────────────

/**
 * The pin of an instance — null for one without a place on the map (map-wide wind, a rising-water edge), and for a
 * disabled one (the pin layer draws no pin for it either).
 */
export function pinMark(inst: PhenomenonInstance, state: PinMark['state']): PinMark | null {
  const entry = catalogOf(inst.type);
  if (!entry || !inst.enabled || !placeable(inst.type, inst.spec)) return null;
  const at = entry.placement.get(inst.spec);
  if (!at) return null;
  return { id: inst.id, type: inst.type, category: entry.category, at: [at[0], at[1]], footprint: entry.placement.footprint(inst.spec), state };
}

// ── Terrain ──────────────────────────────────────────────────────────────────────────

/** Ground type per vertex of the changed rectangle, from the paint strokes of the plan (later strokes win). */
function paintMap(rect: GridRect, preview: Preview): Int16Array {
  const w = rect.x1 - rect.x0 + 1, h = rect.z1 - rect.z0 + 1;
  const map = new Int16Array(w * h).fill(-1);
  if (!preview.result.ok) return map;
  let any = false;
  for (const line of preview.result.lines) {
    for (const op of line.plan.ops) {
      if (op.op !== 'terrain' || op.stroke.op !== 'paint' || op.stroke.ground === undefined) continue;
      for (const c of op.stroke.cells) {
        if (c.x < rect.x0 || c.x > rect.x1 || c.z < rect.z0 || c.z > rect.z1) continue;
        map[(c.z - rect.z0) * w + (c.x - rect.x0)] = op.stroke.ground;
        any = true;
      }
    }
  }
  if (!any) return map;
  // One vertex of margin in the neighbour's colour (drawn at alpha 0): the edge of the patch does not fade to black.
  const out = map.slice();
  for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
    const k = z * w + x;
    if (map[k] >= 0) continue;
    for (let dz = -1; dz <= 1 && out[k] < 0; dz++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= w || nz >= h || map[nz * w + nx] < 0) continue;
      out[k] = map[nz * w + nx];
      break;
    }
  }
  return out;
}

export function terrainMark(t: TerrainDiff, preview: Preview): TerrainMark {
  // (`0 - x`: a diff that only raises has down = 0, and the mesh's scale must not see −0 as a number below 0)
  return { rect: t.rect, dh: t.dh, painted: t.painted, up: t.up, down: 0 - t.down, area: t.area, paint: paintMap(t.rect, preview) };
}

// ── Highlights ───────────────────────────────────────────────────────────────────────

/** Radius of the ground ring around a road node / a point a plan or a question points at (m). */
export const NODE_RING = 2.4;
export const POINT_RING = 1.4;

export interface HighlightSource {
  /** The document the highlight's ids are looked up in. */
  doc: WorldDocument;
  /** What a plan adds on top of it: its new objects, the road network after it, its new instances. */
  added?: readonly WorldObject[];
  network?: RoadNetwork | null;
  instances?: readonly PhenomenonInstance[];
  /** Instance ids that already have a pin of the plan (not drawn a second time as a highlight). */
  pinned?: ReadonlySet<string>;
  /** Object ids the plan already marks as removed / changed / moved (a white box over the marking would hide it). */
  marked?: ReadonlySet<string>;
}

/** The things a Highlight names, found in a document (ids that name nothing are skipped). */
export function highlightMarks(highlights: readonly (Highlight | null | undefined)[], src: HighlightSource): HighlightMarks {
  const out: HighlightMarks = { boxes: [], lines: [], rings: [], pins: [] };
  const seen = new Set<string>();
  const once = (key: string) => (seen.has(key) ? false : (seen.add(key), true));
  const extra = new Map((src.added ?? []).map((o) => [o.id, o]));
  const insts = [...(src.doc.scenario.experiment?.instances ?? []), ...(src.instances ?? [])];
  for (const h of highlights) {
    if (!h) continue;
    for (const id of h.ids ?? []) {
      if (src.marked?.has(id)) continue;
      const o = src.doc.objects[id] ?? extra.get(id);
      if (o && once(`o:${id}`)) out.boxes.push(boxOf(o));
    }
    for (const id of h.segments ?? []) {
      const m = roadMark(src.doc.roads, id) ?? (src.network ? roadMark(src.network, id) : null);
      if (m && once(`s:${id}`)) out.lines.push(m);
    }
    for (const id of h.nodes ?? []) {
      const n = src.doc.roads.nodes[id] ?? src.network?.nodes[id];
      if (n && once(`n:${id}`)) out.rings.push({ x: n.x, z: n.z, r: NODE_RING, of: 'node' });
    }
    for (const p of h.points ?? []) {
      if (Number.isFinite(p[0]) && Number.isFinite(p[1]) && once(`p:${p[0]},${p[1]}`)) out.rings.push({ x: p[0], z: p[1], r: POINT_RING, of: 'point' });
    }
    for (const id of h.instances ?? []) {
      if (src.pinned?.has(id)) continue;
      const inst = insts.find((x) => x.id === id);
      const m = inst ? pinMark(inst, 'highlight') : null;
      if (m && once(`i:${id}`)) out.pins.push(m);
    }
  }
  return out;
}

export const emptyHighlight = (): HighlightMarks => ({ boxes: [], lines: [], rings: [], pins: [] });

// ── The model ────────────────────────────────────────────────────────────────────────

export function buildPreviewModel(preview: Preview): PreviewModel {
  const diff = preview.diff;
  const lines = preview.result.ok ? preview.result.lines : [];
  const model: PreviewModel = {
    ghosts: [], added: 0, warned: 0, rejected: [], moved: [], removed: [], changed: [], terrain: null,
    roads: { added: [], removed: [] }, pins: [], snaps: [], highlight: emptyHighlight(),
  };
  if (!diff) return model;

  // Plan items: where each one is, whether it is warned / rejected, what it snapped to.
  const items = new Map<string, PlanItem>();
  for (const line of lines) {
    for (const item of line.plan.items) {
      if (item.status === 'rejected') model.rejected.push({ x: item.x, z: item.z });
      else if (!items.has(spot(item.x, item.z))) items.set(spot(item.x, item.z), item);
      // (grid / free are not snap targets: the mouse shows no marker for them either)
      if (item.snap && item.snap !== 'grid' && item.snap !== 'free') model.snaps.push({ x: item.x, z: item.z, kind: item.snap });
    }
  }

  for (const o of diff.added) {
    const p = plannedOf(o, warningsOf(items.get(spot(o.transform.position[0], o.transform.position[2]))));
    if (p.warnings.length) model.warned++;
    model.ghosts.push(p);
  }
  model.added = diff.added.length;
  model.removed = diff.removed.map(boxOf);
  model.changed = diff.changed.map((c) => boxOf(c.after));
  for (const m of diff.moved) {
    if (settledOnly(m.before, m.after)) {
      // Re-seated by a hair (a road's graded bed under it): a ghost would only flicker inside the object itself.
      model.changed.push(boxOf(m.after));
      continue;
    }
    model.ghosts.push(plannedOf(m.after));
    model.moved.push({ from: boxOf(m.before), to: boxOf(m.after) });
  }

  if (diff.terrain) model.terrain = terrainMark(diff.terrain, preview);

  if (diff.roads) {
    model.roads.added = roadMarks(diff.roads.network, diff.roads.added);
    model.roads.removed = roadMarks(preview.doc.roads, diff.roads.removed);
  }

  const before = new Map((preview.doc.scenario.experiment?.instances ?? []).map((x) => [x.id, x]));
  for (const [list, state] of [[diff.instances.added, 'added'], [diff.instances.changed, 'changed'], [diff.instances.removed, 'removed']] as const) {
    for (const inst of list) {
      const m = pinMark(inst, state);
      if (!m) continue;
      const old = state === 'changed' ? before.get(inst.id) : undefined;
      const from = old ? pinMark(old, 'highlight')?.at : undefined;
      if (from && (from[0] !== m.at[0] || from[1] !== m.at[1])) m.from = from;
      model.pins.push(m);
    }
  }

  model.highlight = highlightMarks(lines.map((l) => l.plan.highlight), {
    doc: preview.doc, added: diff.added, network: diff.roads?.network ?? null, instances: diff.instances.added, pinned: new Set(model.pins.map((p) => p.id)),
    marked: new Set<string>([...model.removed, ...model.changed, ...model.moved.map((m) => m.from)].map((b) => b.id)),
  });
  return model;
}

// ── Real pins and commands ───────────────────────────────────────────────────────────

/**
 * What the disaster pin layer (rendering/placement/PlacementLayer.tsx) does for commands. Its pins are drawn only on
 * the disasters tab, with one selected, or while placing; a command adds:
 *
 *  - `all`: every placed pin while a plan that adds / moves / removes disasters is open (as while placing by mouse:
 *    the neighbours are visible), with the ones it removes marked (`removing`);
 *  - `show`: the pins the last confirmed command's result is about — the disaster it just placed (or moved, stopped,
 *    listed) — and the ones a plan or the option under the pointer points at (`emphasis`).
 *
 * Nothing is SELECTED for this: selecting a pin clears the object selection (input policy), and the object selection
 * is what the next command means by "these".
 */
export interface CommandPins {
  all: boolean;
  show: string[];
  removing: string[];
  emphasis: string[];
}

export const NO_COMMAND_PINS: CommandPins = { all: false, show: [], removing: [], emphasis: [] };

interface DoneLines {
  k: string;
  lines?: readonly { plan: { highlight: Highlight } }[];
}

export function commandPins(preview: Preview | null, feedback: DoneLines, hover: Highlight | null): CommandPins {
  const diff = preview?.diff ?? null;
  const lines = preview?.result.ok ? preview.result.lines : [];
  const all = !!diff && diff.instances.added.length + diff.instances.changed.length + diff.instances.removed.length > 0;
  const removing = diff ? diff.instances.removed.map((x) => x.id) : [];
  const emphasis = [...new Set([...lines.flatMap((l) => l.plan.highlight.instances ?? []), ...(hover?.instances ?? [])])];
  const placed = feedback.k === 'done' ? (feedback.lines ?? []).flatMap((l) => l.plan.highlight.instances ?? []) : [];
  const show = [...new Set([...placed, ...emphasis])];
  if (!all && !show.length) return NO_COMMAND_PINS;
  return { all, show, removing, emphasis };
}

// ── Keys and counts ──────────────────────────────────────────────────────────────────

const docSerials = new WeakMap<WorldDocument, number>();
let nextSerial = 1;

/**
 * Identity of a preview for the GPU objects built from it: the plan hash (the same hash = the same plan) and the
 * document it was made on (the same plan on a changed document can move other things). Typing more of a command that
 * plans to the same thing, or Enter turning the draft into the open plan, keeps the key — nothing is rebuilt.
 */
export function previewKey(preview: Preview): string {
  let n = docSerials.get(preview.doc);
  if (!n) docSerials.set(preview.doc, (n = nextSerial++));
  return `${preview.result.ok ? preview.result.hash : 'failed'}@${n}`;
}

/** What `window.__ds.command.preview()` reports (counts by kind of what the layer draws). */
export interface PreviewCounts {
  ghosts: number;
  warned: number;
  rejected: number;
  moved: number;
  removed: number;
  changed: number;
  terrain: { up: number; down: number; area: number } | null;
  roads: number;
  pins: number;
  snaps: number;
  highlight: number;
}

export const emptyCounts = (): PreviewCounts => ({ ghosts: 0, warned: 0, rejected: 0, moved: 0, removed: 0, changed: 0, terrain: null, roads: 0, pins: 0, snaps: 0, highlight: 0 });

const highlightCount = (h: HighlightMarks) => h.boxes.length + h.lines.length + h.rings.length + h.pins.length;

/**
 * Counts of a model as a scope of the layer draws it: `all` (the editor scene), or `pins` (the simulation scene —
 * disaster pins and what highlights point at on the ground; objects, terrain and roads are not edited there).
 * `hover`: the marks of the option under the pointer in a question, drawn on top.
 */
export function countsOf(model: PreviewModel | null, hover: HighlightMarks | null, scope: 'all' | 'pins' = 'all'): PreviewCounts {
  const c = emptyCounts();
  const all = scope === 'all';
  if (model) {
    c.pins = model.pins.length;
    c.highlight = all ? highlightCount(model.highlight) : highlightCount({ ...model.highlight, boxes: [] });
    if (all) {
      c.ghosts = model.ghosts.length;
      c.warned = model.warned;
      c.rejected = model.rejected.length;
      c.moved = model.moved.length;
      c.removed = model.removed.length;
      c.changed = model.changed.length;
      // (the diff's numbers: both ≥ 0)
      c.terrain = model.terrain ? { up: model.terrain.up, down: 0 - model.terrain.down, area: model.terrain.area } : null;
      c.roads = model.roads.added.length + model.roads.removed.length;
      c.snaps = model.snaps.length;
    }
  }
  if (hover) c.highlight += all ? highlightCount(hover) : highlightCount({ ...hover, boxes: [] });
  return c;
}

/** Whether these counts mean something is drawn (false: the layer renders nothing at all). */
export function drawsAnything(c: PreviewCounts): boolean {
  return c.ghosts + c.rejected + c.moved + c.removed + c.changed + c.roads + c.pins + c.snaps + c.highlight > 0 || c.terrain !== null;
}
