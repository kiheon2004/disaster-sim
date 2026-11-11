/**
 * Phase 37 — planning the read-only commands (§12, §13): camera focus and queries. A query never changes the document
 * or the history; its answer is a small table of values the existing functions compute (object definitions, the
 * structural analysis of a design, the terrain sampler, the experiment plan, the running simulation's own summary) —
 * no new physical estimates are made here.
 */
import type { WorldObject } from '@/core/model';
import { getDefinition } from '@/objects/registry';
import { displayRotation, heightAboveGround } from '@/editor/build/numericTransform';
import { catalogOf } from '@/phenomena/catalog';
import { controlSupport } from '@/phenomena/controls';
import { segmentLine } from '@/roads/network';
import { presetOf } from '@/roads/crossSection';
import { msg, orderedObjects, type Env, type Msg } from './context';
import type { IntentOf } from './intent';
import { kindOfObject } from './kinds';
import { targetOf } from './planEdit';
import { need, stop, type Draft, type QueryColumn, type QueryTable } from './planTypes';
import { designWarnings, floorsOf, footprintArea, footprintBounds, heightOf, resolvePlace } from './resolve';

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const col = (key: string): QueryColumn => ({ key, label: msg(`cmd37.col.${key}` as 'cmd37.col.kind') });

/** Most rows a table shows (the count and the id list are always complete). */
export const MAX_ROWS = 200;

export function planFocus(i: IntentOf<'focus'>, env: Env, d: Draft): void {
  d.immediate = true;
  if (i.at) {
    const p = need(resolvePlace(i.at, env), d.notes);
    d.effects.push({ fx: 'focusAt', x: p.x, z: p.z });
    d.highlight = { points: [[p.x, p.z]] };
    return;
  }
  const set = targetOf(i.target!, env, d, false);
  const ids = set.objects.map((o) => o.id);
  d.effects.push({ fx: 'focus', ids });
  d.highlight = { ids };
  d.table = { title: msg('cmd37.sum.focus', { count: ids.length }), columns: [], rows: [], ids };
}

const flagsOf = (o: WorldObject): string => [o.hidden ? 'hidden' : '', o.locked ? 'locked' : ''].filter(Boolean).join(' ');
const warningsOf = (o: WorldObject): string => designWarnings(o).filter((w) => w.level !== 'info' || w.code.startsWith('brace')).map((w) => w.code).join(' ');

function objectRow(o: WorldObject, env: Env, full: boolean): QueryTable['rows'][number] {
  const [x, , z] = o.transform.position;
  const cells: Record<string, string | number | Msg> = { kind: kindOfObject(o), name: o.name || '—', id: o.id, x: r1(x), z: r1(z) };
  const floors = floorsOf(o);
  if (floors !== null) cells.floors = floors;
  const warn = warningsOf(o);
  if (warn) cells.warnings = warn;
  if (full) {
    const dims = getDefinition(o.type).getDimensions(o.params);
    cells.heading = r1(displayRotation(o.transform.rotation)[1]);
    cells.height = r2(heightOf(o));
    cells.size = `${r2(dims[0] * o.transform.scale[0])} × ${r2(dims[2] * o.transform.scale[2])}`;
    cells.lift = r2(heightAboveGround(o, env.terrain));
    cells.slope = r1(env.terrain.flat ? 0 : env.terrain.sampleSlope(x, z));
    if (o.building) cells.structure = o.building.spec.system;
    if (o.group) cells.group = env.doc.groups?.[o.group]?.name ?? o.group;
    const flags = flagsOf(o);
    if (flags) cells.flags = flags;
  }
  return { cells, id: o.id };
}

/** Columns that at least one row fills, in a fixed order. */
function columnsOf(rows: QueryTable['rows'], order: readonly string[]): QueryColumn[] {
  return order.filter((k) => rows.some((r) => r.cells[k] !== undefined)).map(col);
}

const OBJECT_COLUMNS = ['kind', 'name', 'id', 'x', 'z', 'floors', 'structure', 'heading', 'height', 'size', 'lift', 'slope', 'group', 'flags', 'warnings'] as const;

function topic(i: IntentOf<'query'>, env: Env, d: Draft): void {
  const doc = env.doc;
  if (i.topic === 'disasters') {
    const all = doc.scenario.experiment?.instances ?? [];
    const running = new Map((env.ctx.runtime?.instances ?? []).map((r) => [r.key, r]));
    if (i.op === 'count') {
      const by = new Map<string, number>();
      for (const x of all) by.set(x.type, (by.get(x.type) ?? 0) + 1);
      d.table = { title: msg('cmd37.sum.countDisasters', { count: all.length }), columns: [col('type'), col('count')], rows: [...by.entries()].sort().map(([type, count]) => ({ cells: { type, count } })), ids: [] };
      return;
    }
    const rows = all.map((x) => {
      const at = catalogOf(x.type)?.placement.get(x.spec) ?? null;
      const rt = running.get(x.id);
      const c = controlSupport(x.type);
      const cells: Record<string, string | number | Msg> = {
        id: x.id, type: x.type, start: 'at' in x.start ? x.start.at : `${x.start.after} ${x.start.anchor} ${x.start.offset >= 0 ? '+' : ''}${x.start.offset}`,
        controls: [c.stop ? 'stop' : '', c.pause ? 'pause' : ''].filter(Boolean).join(' ') || '—',
      };
      if (at) { cells.x = r1(at[0]); cells.z = r1(at[1]); }
      if (!x.enabled) cells.flags = 'off';
      if (rt) cells.status = rt.status;
      return { cells, instance: x.id };
    });
    d.table = { title: msg('cmd37.sum.listDisasters', { count: all.length }), columns: columnsOf(rows, ['id', 'type', 'x', 'z', 'start', 'status', 'controls', 'flags']), rows, ids: [] };
    d.highlight = { instances: all.map((x) => x.id) };
    return;
  }
  if (i.topic === 'groups') {
    const by = new Map<string, WorldObject[]>();
    for (const o of orderedObjects(doc)) if (o.group) (by.get(o.group) ?? by.set(o.group, []).get(o.group)!).push(o);
    const rows = [...by.entries()].map(([id, members]) => ({ cells: { name: doc.groups?.[id]?.name ?? '—', count: members.length, id } as Record<string, string | number | Msg> }));
    d.table = { title: msg('cmd37.sum.countGroups', { count: rows.length }), columns: i.op === 'count' ? [] : [col('name'), col('count'), col('id')], rows: i.op === 'count' ? [] : rows, ids: [] };
    return;
  }
  if (i.topic === 'roads') {
    const segs = Object.values(doc.roads.segments).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
    let total = 0;
    const rows = segs.map((s) => {
      const length = segmentLine(doc.roads, s).length;
      total += length;
      return { cells: { id: s.id, from: s.a, to: s.b, length: r1(length), lanes: s.profile.lanes, width: s.profile.width, preset: presetOf(s.profile) ?? '—' } as Record<string, string | number | Msg> };
    });
    d.table = { title: msg('cmd37.sum.countRoads', { count: segs.length, nodes: Object.keys(doc.roads.nodes).length, length: Math.round(total) }), columns: i.op === 'count' ? [] : ['id', 'from', 'to', 'length', 'lanes', 'width', 'preset'].map(col), rows: i.op === 'count' ? [] : rows, ids: [] };
    d.highlight = { segments: segs.map((s) => s.id) };
    return;
  }
  // The running simulation: the numbers its own results panel shows.
  const rt = env.ctx.runtime;
  if (!rt) return stop(msg('cmd37.err.simNotRunning'));
  const rows = [{ cells: { name: msg('cmd37.col.time'), value: r1(rt.time) } as Record<string, string | number | Msg> }, ...Object.keys(rt.summary).sort().map((k) => ({ cells: { name: k, value: rt.summary[k] } as Record<string, string | number | Msg> }))];
  d.table = { title: msg('cmd37.sum.sim', { time: r1(rt.time), count: rt.instances.length }), columns: [col('name'), col('value')], rows, ids: [] };
}

export function planQuery(i: IntentOf<'query'>, env: Env, d: Draft): void {
  d.immediate = true;
  if (i.topic) return topic(i, env, d);
  if (i.from && i.to) {
    const a = need(resolvePlace(i.from, env), d.notes), b = need(resolvePlace(i.to, env), d.notes);
    const dy = env.terrain.sampleHeight(b.x, b.z) - env.terrain.sampleHeight(a.x, a.z);
    const dist = Math.hypot(b.x - a.x, b.z - a.z);
    d.table = {
      title: msg('cmd37.sum.distance', { dist: r2(dist) }), columns: ['dist', 'east', 'south', 'rise'].map(col),
      rows: [{ cells: { dist: r2(dist), east: r2(b.x - a.x), south: r2(b.z - a.z), rise: r2(dy) } }], ids: [],
    };
    d.highlight = { points: [[a.x, a.z], [b.x, b.z]] };
    return;
  }
  // "How many …?" and "which …?" have an answer when nothing matches: 0 / an empty list (not an error).
  const set = targetOf(i.target!, env, d, false, i.op === 'count' || i.op === 'list');
  const objs = set.objects;
  const ids = objs.map((o) => o.id);
  d.highlight = { ids };
  if (i.op === 'count') {
    const by = new Map<string, number>();
    for (const o of objs) by.set(kindOfObject(o), (by.get(kindOfObject(o)) ?? 0) + 1);
    d.table = { title: msg('cmd37.sum.count', { count: objs.length }), columns: [col('kind'), col('count')], rows: [...by.entries()].sort().map(([kind, count]) => ({ cells: { kind, count } })), ids };
    return;
  }
  if (i.op === 'measure') {
    const [x0, z0, x1, z1] = footprintBounds(objs);
    const rows = objs.slice(0, MAX_ROWS).map((o) => {
      const dims = getDefinition(o.type).getDimensions(o.params);
      return { cells: { kind: kindOfObject(o), id: o.id, height: r2(heightOf(o)), size: `${r2(dims[0] * o.transform.scale[0])} × ${r2(dims[2] * o.transform.scale[2])}`, area: r2(footprintArea(o)), lift: r2(heightAboveGround(o, env.terrain)) } as Record<string, string | number | Msg>, id: o.id };
    });
    d.table = { title: msg('cmd37.sum.measure', { count: objs.length, width: r2(x1 - x0), depth: r2(z1 - z0), height: r2(Math.max(...objs.map(heightOf))) }), columns: ['kind', 'id', 'height', 'size', 'area', 'lift'].map(col), rows, ids };
    if (objs.length > MAX_ROWS) d.notes.push(msg('cmd37.note.rowsCut', { shown: MAX_ROWS, count: objs.length }));
    return;
  }
  const rows = objs.slice(0, MAX_ROWS).map((o) => objectRow(o, env, i.op === 'info'));
  if (objs.length > MAX_ROWS) d.notes.push(msg('cmd37.note.rowsCut', { shown: MAX_ROWS, count: objs.length }));
  d.table = { title: msg(i.op === 'info' ? 'cmd37.sum.info' : 'cmd37.sum.list', { count: objs.length }), columns: columnsOf(rows, OBJECT_COLUMNS), rows, ids };
}
