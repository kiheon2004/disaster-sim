/**
 * Blueprint Mode actions (Phase 20): capture a part of the world into a blueprint, browse the
 * library, place a blueprint (ghost → pin → adjust → confirm = ONE atomic undo step), import /
 * export files, save / apply world templates and run the world creation wizard. UI components
 * and hotkeys call these; the world changes only through worldStore.applyEdit / replaceDocument.
 */
import type { EntityId } from '@/core/types';
import type { WorldDocument } from '@/core/model';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { useRoadStore } from '@/editor/roadStore';
import { useNatureStore } from '@/editor/natureStore';
import { useBuildStore } from '@/editor/buildStore';
import { emptyCapture, emptyPlace, useBlueprintStore, type CaptureShapeKind } from '@/editor/blueprintStore';
import { captureBlueprint } from '@/blueprints/capture';
import { planPlacement, type PlacementPlan } from '@/blueprints/place';
import { useLibraryStore, type LibraryEntry } from '@/blueprints/library';
import type { BlueprintCategory, UnifiedBlueprint } from '@/blueprints/types';
import type { P2 } from '@/landscape/types';
import { validPolygon, type SelectionShape } from '@/blueprints/selection';
import { createTemplate, templateDocument, type WorldTemplate } from '@/templates/template';
import { BUILTIN_TEMPLATES, type BuiltinTemplate } from '@/templates/builtin';
import { blueprintThumbnail, worldThumbnail } from '@/ui/Blueprints/minimap';
import { FootprintIndex } from '@/editor/build/footprint';
import { segmentLine } from '@/roads/network';
import { nearest, pointAt } from '@/roads/curve';
import { yawOf } from '@/terrain/groundPlacement';
import { gridStep } from '@/editor/buildStore';
import { toast } from '@/ui/common/toast';
import { t } from '@/i18n/i18n';

const W = () => useWorldStore.getState();
const B = () => useBlueprintStore.getState();
const L = () => useLibraryStore.getState();
const ED = () => useEditorStore.getState();

function editable(): boolean {
  if (W().locked || ED().mode !== 'editor') {
    toast('warn', { key: 'bp.locked' });
    return false;
  }
  return true;
}

/** Library entry display name (built-ins are translated). */
export function entryName(e: Pick<LibraryEntry, 'name' | 'builtinKey'>): string {
  return e.builtinKey ? t(`${e.builtinKey}.name` as never) : e.name || t('bp.untitled');
}

// ── Library ───────────────────────────────────────────────────────────────────

let initPromise: Promise<void> | null = null;
export function initLibrary(): Promise<void> {
  initPromise ??= L().init().then(() => {
    if (!L().persistent) toast('warn', { key: 'bp.lib.notPersistent' });
  });
  return initPromise;
}

/** Back to browsing; ends any capture / placement session. */
export function backToLibrary() {
  B().setMode('library');
  B().setCapture(emptyCapture());
  B().setPlace(emptyPlace());
  ED().setBlueprintTool(false);
}

export async function renameEntry(id: string, name: string) {
  await L().update(id, { name: name.trim() });
}

export async function duplicateEntry(id: string) {
  const e = L().all().find((x) => x.id === id);
  if (!e) return;
  const copy = await L().duplicate(id, t('bp.copyOf', { name: entryName(e) }));
  if (copy) { B().select(copy.id); toast('success', { key: 'bp.toast.duplicated', params: { name: copy.name } }); }
}

export async function deleteEntry(id: string) {
  const e = L().all().find((x) => x.id === id);
  if (!e || e.builtin) return;
  if (!window.confirm(t('bp.confirmDelete', { name: entryName(e) }))) return;
  await L().remove(id);
  if (B().selectedId === id) B().select(null);
  toast('info', { key: 'bp.toast.deleted', params: { name: entryName(e) } });
}

/**
 * Render and store a missing thumbnail (built-ins: generated on first view). Jobs run one at a
 * time with a frame between them, so opening the wizard / library never freezes the UI while
 * eight template worlds are generated.
 */
let thumbQueue: Promise<void> = Promise.resolve();
const queued = new Set<string>();
export function ensureThumbnail(id: string): Promise<void> {
  if (queued.has(id)) return thumbQueue;
  queued.add(id);
  thumbQueue = thumbQueue.then(async () => {
    await new Promise((r) => setTimeout(r, 16));
    try {
      await renderThumbnail(id);
    } finally {
      queued.delete(id);
    }
  });
  return thumbQueue;
}

async function renderThumbnail(id: string) {
  const e = L().all().find((x) => x.id === id);
  if (!e || e.thumbnail) return;
  if (e.kind === 'blueprint') {
    const bp = await L().loadBlueprint(id);
    const img = bp && blueprintThumbnail(bp);
    if (img) await L().setThumbnail(id, img);
  } else {
    const tpl = await L().loadTemplate(id);
    if (!tpl) return;
    const img = worldThumbnail(templateDocument(tpl));
    if (img) await L().setThumbnail(id, img);
  }
}

function download(text: string, file: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fileBase = (s: string) => (s || 'blueprint').replace(/[^\w\-가-힣]+/g, '_').slice(0, 60);

export async function exportEntry(id: string) {
  const e = L().all().find((x) => x.id === id);
  const text = await L().exportText(id);
  if (!e || !text) return;
  download(text, `${fileBase(entryName(e))}.${e.kind === 'world' ? 'world-template' : 'blueprint'}.json`);
  toast('info', { key: 'bp.toast.exported', params: { name: entryName(e) } });
}

/** Pick a blueprint / template file and open the import dialog with its check result. */
export function importFile(): Promise<void> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (f) importText(await f.text());
      resolve();
    };
    input.click();
  });
}

export function importText(text: string) {
  B().setImportCheck(L().checkImport(text));
}

export async function confirmImport(mode: 'copy' | 'replace') {
  const c = B().importCheck;
  if (!c || !c.ok) return;
  const e = await L().commitImport(c, mode);
  B().setImportCheck(null);
  B().select(e.id);
  B().setFilter('all');
  void ensureThumbnail(e.id);
  toast('success', { key: 'bp.toast.imported', params: { name: entryName(e) } });
}

// ── Capture ───────────────────────────────────────────────────────────────────

/** Start a capture: draw a rectangle / polygon, or take the current selection. */
export function startCapture(kind: CaptureShapeKind) {
  if (!editable()) return;
  const ed = ED();
  const rs = useRoadStore.getState().selection;
  const ns = useNatureStore.getState().selected;
  const selection = { objects: [...ed.selectedIds], segments: [...rs.segments], features: ns ? [ns] : [] };
  B().setMode('capture');
  B().setCapture({ ...emptyCapture(), kind, selection, include: B().capture.include, roads: B().capture.roads, nature: B().capture.nature });
  if (kind === 'selection') {
    ED().setBlueprintTool(false);
    if (!selection.objects.length && !selection.segments.length && !selection.features.length) toast('warn', { key: 'bp.capture.noSelection' });
    recomputeCapture();
  } else ED().setBlueprintTool(true);
}

export function setCaptureShape(shape: SelectionShape | null) {
  if (shape?.kind === 'polygon' && !validPolygon(shape.points)) {
    toast('warn', { key: 'bp.capture.badPolygon' });
    B().setCapture({ draft: [] });
    return;
  }
  B().setCapture({ shape, draft: [] });
  recomputeCapture();
}

let captureTimer: ReturnType<typeof setTimeout> | null = null;
/** Re-capture (debounced: options change while typing / dragging). */
export function recomputeCapture(delay = 60) {
  if (captureTimer) clearTimeout(captureTimer);
  captureTimer = setTimeout(() => {
    captureTimer = null;
    const c = B().capture;
    if (B().mode !== 'capture') return;
    const hasSel = c.selection.objects.length || c.selection.segments.length || c.selection.features.length;
    if (!c.shape && !(c.kind === 'selection' && hasSel)) { B().setCapture({ result: null }); return; }
    const res = captureBlueprint(W().doc, { shape: c.kind === 'selection' ? null : c.shape, ...c.selection }, { include: c.include, roads: c.roads, nature: c.nature });
    B().setCapture({ result: res });
  }, delay);
}

export async function saveCapture(): Promise<LibraryEntry | null> {
  const c = B().capture;
  if (!c.result || c.result.report.empty) { toast('warn', { key: 'bp.capture.empty' }); return null; }
  // Fresh capture with the final metadata (same document state as the summary shown).
  const res = captureBlueprint(W().doc, { shape: c.kind === 'selection' ? null : c.shape, ...c.selection }, {
    include: c.include, roads: c.roads, nature: c.nature,
    meta: {
      name: c.name.trim() || t('bp.defaultName', { n: L().entries.filter((e) => e.kind === 'blueprint').length + 1 }),
      description: c.description.trim(),
      ...(c.category !== 'auto' ? { category: c.category as BlueprintCategory } : {}),
      tags: c.tags.split(/[,，#\s]+/).map((x) => x.trim()).filter(Boolean).slice(0, 32),
    },
  });
  const bp: UnifiedBlueprint = { ...res.blueprint, preview: { ...res.blueprint.preview, thumbnail: blueprintThumbnail(res.blueprint) } };
  const e = await L().saveBlueprint(bp);
  backToLibrary();
  B().select(e.id);
  B().setFilter('all');
  toast('success', { key: 'bp.toast.saved', params: { name: e.name } });
  return e;
}

// ── Placement ─────────────────────────────────────────────────────────────────

export async function startPlacement(id: string) {
  if (!editable()) return;
  const bp = await L().loadBlueprint(id);
  if (!bp) { toast('error', { key: 'bp.toast.loadFailed' }); return; }
  B().setMode('place');
  B().setPlace({ ...emptyPlace(), entryId: id, blueprint: bp, options: { ...emptyPlace().options, include: { ...emptyPlace().options.include } } });
  ED().setSelection([]);
  ED().setBlueprintTool(true);
}

let existingIndex: { objects: WorldDocument['objects']; index: FootprintIndex } | null = null;
/** Footprints of the world's objects (rebuilt only when the objects change). */
function existing(): FootprintIndex {
  const objs = W().doc.objects;
  if (!existingIndex || existingIndex.objects !== objs) existingIndex = { objects: objs, index: FootprintIndex.fromObjects(Object.values(objs)) };
  return existingIndex.index;
}

/** Grid-snapped point (editor snap on → the build grid step, at least 1 m). */
export function snapPoint(x: number, z: number): P2 {
  if (!ED().snap) return [x, z];
  const step = Math.max(1, gridStep(useBuildStore.getState().snapping.grid, 3));
  return [Math.round(x / step) * step, Math.round(z / step) * step];
}

/** The plan for the pinned (or hovered) spot with the current options. */
export function computePlan(at?: P2 | null): PlacementPlan | null {
  const p = B().place;
  const pos = at ?? p.pinned ?? p.hover;
  if (!p.blueprint || !pos) return null;
  return planPlacement(W().doc, p.blueprint, { ...p.options, x: pos[0], z: pos[1], yaw: p.yaw }, existing());
}

let planTimer: ReturnType<typeof setTimeout> | null = null;
/** Validate where the ghost rests (debounced: never on every pointer move). */
export function schedulePlan(delay = 140) {
  if (planTimer) clearTimeout(planTimer);
  planTimer = setTimeout(() => {
    planTimer = null;
    if (B().mode !== 'place') return;
    B().setPlace({ plan: computePlan() });
  }, delay);
}

export function pinPlacement(at: P2 | null) {
  B().setPlace({ pinned: at, plan: null });
  schedulePlan(0);
}

export function rotatePlacement(delta: number) {
  const p = B().place;
  const yaw = Math.atan2(Math.sin(p.yaw + delta), Math.cos(p.yaw + delta));
  B().setPlace({ yaw: Math.abs(yaw) < 1e-9 ? 0 : yaw, plan: null });
  schedulePlan();
}

export function setPlacementYaw(yaw: number) {
  B().setPlace({ yaw, plan: null });
  schedulePlan();
}

/** Main road direction of a blueprint in its local frame (longest segment), or null. */
function blueprintRoadAngle(bp: UnifiedBlueprint): number | null {
  const nodes = new Map(bp.roads.nodes.map((n) => [n.id, n]));
  let best = -1, angle: number | null = null;
  for (const s of bp.roads.segments) {
    const a = nodes.get(s.a)!, b = nodes.get(s.b)!;
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L > best) { best = L; angle = Math.atan2(-(b.z - a.z), b.x - a.x); }
  }
  return angle;
}

/** Turn (and keep the position) so the blueprint's main road / local x axis runs along the nearest road. */
export function alignToRoad() {
  const p = B().place;
  const pos = p.pinned ?? p.hover;
  if (!p.blueprint || !pos) return;
  const net = W().doc.roads;
  let best: { yaw: number; d: number } | null = null;
  for (const s of Object.values(net.segments)) {
    const line = segmentLine(net, s);
    const h = nearest(line, pos[0], pos[1]);
    if (h.dist > 60 || (best && h.dist >= best.d)) continue;
    const q = pointAt(line, h.s);
    best = { yaw: Math.atan2(-q.tz, q.tx), d: h.dist };
  }
  if (!best) { toast('warn', { key: 'bp.place.noRoad' }); return; }
  const own = blueprintRoadAngle(p.blueprint) ?? 0;
  // Two directions run along a road: take the turn closer to the current heading.
  const options = [best.yaw - own, best.yaw - own + Math.PI].map((a) => Math.atan2(Math.sin(a), Math.cos(a)));
  const yaw = options.sort((a, b) => Math.abs(Math.atan2(Math.sin(a - p.yaw), Math.cos(a - p.yaw))) - Math.abs(Math.atan2(Math.sin(b - p.yaw), Math.cos(b - p.yaw))))[0];
  setPlacementYaw(Math.round(yaw * 1e6) / 1e6);
}

/** Turn so the blueprint's buildings line up with the nearest existing object (multiples of 90°). */
export function alignToObjects() {
  const p = B().place;
  const pos = p.pinned ?? p.hover;
  if (!p.blueprint || !pos) return;
  let best: { yaw: number; d: number } | null = null;
  for (const o of Object.values(W().doc.objects)) {
    if (o.type === 'tree' || o.type === 'human') continue;
    const d = Math.hypot(o.transform.position[0] - pos[0], o.transform.position[2] - pos[1]);
    if (d < 80 && (!best || d < best.d)) best = { yaw: yawOf(o.transform.rotation), d };
  }
  if (!best) { toast('warn', { key: 'bp.place.noObject' }); return; }
  const ref = p.blueprint.objects.find((o) => o.type === 'building') ?? p.blueprint.objects[0];
  const own = ref ? yawOf(ref.rotation) : 0;
  const q = Math.PI / 2;
  const base = best.yaw - own;
  const k = Math.round((p.yaw - base) / q);
  setPlacementYaw(Math.atan2(Math.sin(base + k * q), Math.cos(base + k * q)));
}

/** Commit the placement at the pinned spot: ONE undo step, or nothing on any error. */
export function confirmPlacement(): EntityId[] {
  if (!editable()) return [];
  const p = B().place;
  if (!p.blueprint || !p.pinned) { toast('warn', { key: 'bp.place.pinFirst' }); return []; }
  const plan = computePlan(p.pinned);
  if (!plan) return [];
  if (plan.report.errors.length) {
    toast('error', { key: `bp.issue.${plan.report.errors[0].code}` as never, params: { n: plan.report.errors[0].value ?? 0 } }, plan.report.errors[0].detail);
    B().setPlace({ plan });
    return [];
  }
  const t0 = performance.now();
  let ids: EntityId[] = [];
  try {
    ids = W().applyEdit(plan.edit);
  } catch (e) {
    toast('error', { key: 'bp.toast.placeFailed' }, (e as Error).message);
    return [];
  }
  const ms = Math.round(performance.now() - t0);
  if (p.entryId) void L().markUsed(p.entryId);
  const c = plan.report.counts;
  toast(plan.report.warnings.length ? 'warn' : 'success', { key: 'bp.toast.placed', params: { objects: c.objects, trees: c.vegetation, roads: c.roads, features: c.features, ms, warnings: plan.report.warnings.length } });
  // Ready for another copy: the ghost follows the cursor again.
  B().setPlace({ pinned: null, plan: null });
  lastPlacement = { ids, ms };
  return ids;
}

/** Last committed placement (benchmarks / browser verification). */
export let lastPlacement: { ids: EntityId[]; ms: number } | null = null;

// ── World templates ───────────────────────────────────────────────────────────

export async function saveWorldTemplate(name: string, description: string, tags: string, includeExperiment: boolean) {
  const doc = W().doc;
  const tpl = createTemplate(doc, { name: name.trim() || doc.meta.name || t('bp.tpl.defaultName'), description: description.trim(), tags: tags.split(/[,，#\s]+/).filter(Boolean).slice(0, 32) }, includeExperiment);
  tpl.preview.thumbnail = worldThumbnail(doc);
  const e = await L().saveTemplate(tpl);
  B().setTemplateDialog(false);
  B().select(e.id);
  B().setFilter('world');
  toast('success', { key: 'bp.toast.templateSaved', params: { name: e.name } });
}

/** Build / load a template's world (built-ins are generated with the seed). */
export async function templateWorld(id: string, seed: number): Promise<{ template: WorldTemplate; doc: WorldDocument } | null> {
  const tpl = await L().loadTemplate(id, seed);
  if (!tpl) return null;
  return { template: tpl, doc: templateDocument(tpl) };
}

/**
 * Apply a template. 'new': the current world is closed and the template opens as a new world
 * (history starts empty). 'replace': terrain, roads, nature and objects of the current world are
 * replaced in ONE undo step; the template's environment settings and experiment setup are
 * applied too (settings are not part of the undo history — the confirmation says so).
 */
export async function applyTemplate(id: string, seed: number, mode: 'new' | 'replace', name?: string): Promise<boolean> {
  if (!editable()) return false;
  const r = await templateWorld(id, seed);
  if (!r) { toast('error', { key: 'bp.toast.loadFailed' }); return false; }
  const doc = r.doc;
  if (mode === 'new') {
    ED().setSelection([]);
    W().replaceDocument({ ...doc, meta: { ...doc.meta, name: name ?? doc.meta.name } });
  } else {
    try {
      W().applyEdit({
        remove: Object.keys(W().doc.objects),
        roads: doc.roads,
        landscape: {
          base: { heights: doc.landscape.base.heights, ground: doc.landscape.base.ground, soil: doc.terrain.soil, settings: doc.terrain.settings },
          features: doc.landscape.features, next: doc.landscape.next,
          layers: { rect: { x0: 0, z0: 0, x1: doc.terrain.nx - 1, z1: doc.terrain.nz - 1 }, sculpt: doc.landscape.sculpt, paint: doc.landscape.paint },
        },
        add: Object.values(doc.objects).map((o) => ({ type: o.type, name: o.name, seed: o.seed, params: o.params, physics: o.physics, seismic: o.seismic, building: o.building, terrainAlign: o.terrainAlign, transform: o.transform, roadLink: o.roadLink, group: o.group })),
      });
    } catch (e) {
      toast('error', { key: 'bp.toast.placeFailed' }, (e as Error).message);
      return false;
    }
    const w = W();
    const sim = doc.settings.simulation;
    w.updateSimulationSettings({ seed: sim.seed, wind: sim.wind, water: sim.water, interactions: sim.interactions.enabled, ...(sim.vegetation ? { vegetation: sim.vegetation } : {}) });
    if (r.template.includesExperiment) {
      w.setEarthquakeScenario(doc.scenario.earthquake);
      w.setFloodScenario(doc.scenario.flood);
      w.setExperiment(doc.scenario.experiment);
    }
  }
  void L().markUsed(id);
  toast('success', { key: mode === 'new' ? 'bp.toast.worldOpened' : 'bp.toast.worldReplaced', params: { name: name ?? doc.meta.name } });
  return true;
}

export const isBuiltinTemplate = (k: string): k is BuiltinTemplate => (BUILTIN_TEMPLATES as readonly string[]).includes(k);
