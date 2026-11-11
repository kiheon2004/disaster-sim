/**
 * Phase 37 — planning disasters and run control (§11, §12).
 *
 * A placed disaster is the same experiment instance a mouse placement makes: the type's default spec, its values
 * written in the spec's own units (clamped to the field limits — said in the summary — and checked by the type's
 * schema), its position set by the catalogue's placement policy (`placement.set`, 0.1 m), `createInstance` for the id
 * and the start time, and one `setExperiment` with the new list. Nothing here starts a simulation: "run now" and the
 * controls of a running instance are effects the command bar carries out through the simulation controller.
 */
import type { EventSpec } from '@/events/specs';
import { SIM_SPEEDS } from '@/core/units';
import { catalogOf, placeable } from '@/phenomena/catalog';
import { controlSupport, CONTROL_SUPPORT, singleStateOf } from '@/phenomena/controls';
import { assignSpecValue } from '@/phenomena/fields';
import { phenomena } from '@/phenomena/registry';
import { createInstance, removeInstances } from '@/phenomena/schedule';
import type { PhenomenonContext } from '@/phenomena/types';
import { mapHalf, msg, type Env } from './context';
import { formatCanonical } from './canonical';
import type { IntentOf } from './intent';
import { need, PlanStop, stop, type Draft } from './planTypes';
import { resolveInstances, resolvePlace } from './resolve';

const r1 = (v: number) => Math.round(v * 10) / 10;

const phenomenonContext = (env: Env): PhenomenonContext => ({ seed: env.doc.settings.simulation.seed, terrain: env.doc.terrain, water: env.doc.settings.simulation.water });

/** Latest start time a plan accepts (s) — the limit of the saved experiment schema. */
export const MAX_START = 86_400;

export function planDisaster(i: IntentOf<'disaster'>, env: Env, d: Draft): void {
  const def = phenomena.listImplemented().find((x) => x.type.toLowerCase() === i.type.toLowerCase()) ?? stop(msg('cmd37.err.unknownDisaster', { type: i.type, known: phenomena.listImplemented().map((x) => x.type).join(', ') }));
  const entry = catalogOf(def.type);
  let spec: EventSpec = def.defaults();
  for (const key of Object.keys(i.fields).sort()) {
    const r = assignSpecValue(def, spec, key, i.fields[key]);
    if (!r.ok) {
      if (r.reason === 'badOption') return stop(msg('cmd37.err.fieldOption', { type: def.type, field: key, value: String(i.fields[key]), options: (r.options ?? []).join(', ') }));
      if (r.reason === 'notANumber') return stop(msg('cmd37.err.fieldNumber', { type: def.type, field: key, value: String(i.fields[key]) }));
      return stop(msg('cmd37.err.unknownField', { type: def.type, field: key, known: r.known.join(', ') }));
    }
    spec = r.spec;
    if (r.clamped) d.warnings.push(msg('cmd37.warn.clamped', { field: key, from: r.clamped.from, to: r.clamped.to, min: r.clamped.min, max: r.clamped.max }));
  }
  const half = mapHalf(env.doc);
  const kind = entry?.placement.kind ?? 'global';
  if (i.at) {
    if (!entry || !placeable(def.type, spec)) d.notes.push(msg('cmd37.note.noPosition', { type: def.type }));
    else {
      const p = need(resolvePlace(i.at, env), d.notes);
      // (an epicentre may lie outside the map; everything else is placed on it — the mouse cannot click outside)
      if (kind !== 'epicentre' && (Math.abs(p.x) > half || Math.abs(p.z) > half)) stop(msg('cmd37.err.outside', { x: r1(p.x), z: r1(p.z), half }));
      spec = entry.placement.set(spec, [p.x, p.z], half);
      const at = entry.placement.get(spec);
      if (at) d.highlight = { points: [at] };
    }
  } else if (entry && placeable(def.type, spec) && (kind === 'ground' || kind === 'space' || kind === 'epicentre' || (kind === 'area' && entry.placement.get(spec) !== null))) {
    const at = entry.placement.get(spec);
    if (!i.now) {
      // Where? — the places a command can name by itself.
      const places = [env.ctx.cursor ? 'cursor' : null, env.ctx.view ? 'view' : null, 'center'].filter((x): x is 'cursor' | 'view' | 'center' => x !== null);
      throw new PlanStop({
        planClarify: {
          question: msg('cmd37.ask.where'),
          options: places.map((pl) => {
            const intent = { ...i, at: { p: pl } };
            const pt = pl === 'cursor' ? env.ctx.cursor! : pl === 'view' ? env.ctx.view! : ([0, 0] as const);
            return { label: msg(`cmd37.opt.place.${pl}`, { x: r1(pt[0]), z: r1(pt[1]) }), intent, canonical: formatCanonical(intent), highlight: { points: [[pt[0], pt[1]] as [number, number]] } };
          }),
        },
      });
    }
    // "Make an explosion" (run now, no place said): the type's default position, as the library's Add button places it.
    if (at) d.notes.push(msg('cmd37.note.defaultPosition', { x: r1(at[0]), z: r1(at[1]) }));
  } else if (kind === 'area' && !i.at) d.notes.push(msg('cmd37.note.mapWide', { type: def.type }));

  if (i.start !== undefined && i.start > MAX_START) stop(msg('cmd37.err.start', { max: MAX_START }));
  const cur = env.doc.scenario.experiment?.instances ?? [];
  const inst = createInstance(def.type, cur, (i.start !== undefined ? { ...spec, startTime: i.start } : spec) as EventSpec);
  const valid = def.schema.safeParse(inst.spec);
  if (!valid.success) stop(msg('cmd37.err.invalidSpec', { type: def.type, issues: valid.error.issues.slice(0, 3).map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') }));
  // One wind, one map-wide rain, one rising water per map edge: a second one takes over when it starts.
  const state = singleStateOf(def.type, inst.spec);
  const same = state ? cur.filter((x) => x.enabled && singleStateOf(x.type, x.spec) === state) : [];
  if (same.length) d.warnings.push(msg('cmd37.warn.replaces', { type: def.type, ids: same.map((x) => x.id).join(', ') }));
  if (i.start !== undefined) d.notes.push(msg(env.ctx.simulating ? 'cmd37.note.startRunning' : 'cmd37.note.startEditor', { start: i.start }));
  if (env.ctx.simulating) d.warnings.push(msg('cmd37.warn.noHistory'));
  d.notes.push(msg('cmd37.note.instance', { id: inst.id, type: def.type }));
  d.ops.push({ op: 'experiment', instances: [...cur, inst] });
  d.counts.create = 1;
  d.highlight = { ...d.highlight, instances: [inst.id] };
  if (i.now) {
    d.effects.push({ fx: 'runInstances', ids: [inst.id] });
    d.immediate = true;
  } else if (env.ctx.simulating) d.notes.push(msg('cmd37.note.planOnly'));
}

const supported = (op: 'stop' | 'pause') => Object.keys(CONTROL_SUPPORT).filter((t) => CONTROL_SUPPORT[t][op]).join(', ');

export function planInstance(i: IntentOf<'instance'>, env: Env, d: Draft): void {
  const list = need(resolveInstances(i.ref, env), d.notes);
  const all = env.doc.scenario.experiment?.instances ?? [];
  const running = new Map((env.ctx.runtime?.instances ?? []).map((r) => [r.key, r]));
  d.highlight = { instances: list.map((x) => x.id) };
  if (i.op === 'move') {
    if (list.length !== 1) stop(msg('cmd37.err.moveOne', { count: list.length }));
    const inst = list[0];
    // As with the mouse: an instance that is part of the run cannot be moved.
    if (running.has(inst.id)) stop(msg('cmd37.err.instanceRunning', { id: inst.id }));
    const entry = catalogOf(inst.type);
    if (!entry || !placeable(inst.type, inst.spec)) return stop(msg('cmd37.err.instanceNoPosition', { id: inst.id, type: inst.type }));
    const half = mapHalf(env.doc);
    const p = need(resolvePlace(i.to!, env), d.notes);
    if (entry.placement.kind !== 'epicentre' && (Math.abs(p.x) > half || Math.abs(p.z) > half)) stop(msg('cmd37.err.outside', { x: r1(p.x), z: r1(p.z), half }));
    const spec = entry.placement.set(inst.spec, [p.x, p.z], half);
    if (env.ctx.simulating) d.warnings.push(msg('cmd37.warn.noHistory'));
    d.ops.push({ op: 'experiment', instances: all.map((x) => (x.id === inst.id ? { ...x, spec } : x)) });
    d.counts.change = 1;
    return;
  }
  if (i.op === 'delete') {
    // From the plan — and, when it is in the run: cancelled before its start, stopped when it can be stopped.
    for (const inst of list) {
      const rt = running.get(inst.id);
      if (!rt) continue;
      if (rt.status === 'pending') d.effects.push({ fx: 'control', key: rt.key, op: 'cancel' });
      else if ((rt.status === 'active' || rt.status === 'paused') && rt.stop) d.effects.push({ fx: 'control', key: rt.key, op: 'stop' });
      else if (rt.status === 'active' || rt.status === 'paused') d.warnings.push(msg('cmd37.warn.staysInRun', { id: inst.id, type: inst.type }));
    }
    if (env.ctx.simulating) d.warnings.push(msg('cmd37.warn.noHistory'));
    d.ops.push({ op: 'experiment', instances: removeInstances(all, list.map((x) => x.id), phenomenonContext(env)) });
    d.counts.remove = list.length;
    return;
  }
  // stop / pause / resume act on the run.
  const op = i.op;
  const need2 = op === 'stop' ? 'stop' : 'pause';
  if (!env.ctx.simulating || !env.ctx.runtime) return stop(msg('cmd37.err.notRunning', { op: `@cmd37.op.${op}`, supported: supported(need2) }));
  let done = 0;
  for (const inst of list) {
    const rt = running.get(inst.id);
    if (!rt) { d.notes.push(msg('cmd37.note.notInRun', { id: inst.id })); continue; }
    if (rt.status === 'pending' && op === 'stop') { d.effects.push({ fx: 'control', key: rt.key, op: 'cancel' }); done++; continue; }
    if (!(need2 === 'stop' ? rt.stop : rt.pause) || !controlSupport(inst.type)[need2]) {
      // One named instance that cannot do it: refuse and say what can. In a sweep ("stop everything") it is skipped.
      if (list.length === 1) return stop(msg('cmd37.err.unsupportedControl', { id: inst.id, type: inst.type, op: `@cmd37.op.${op}`, supported: supported(need2) }));
      d.notes.push(msg('cmd37.note.controlSkipped', { id: inst.id, type: inst.type }));
      continue;
    }
    if ((op === 'pause' && rt.status !== 'active') || (op === 'resume' && rt.status !== 'paused') || (op === 'stop' && rt.status !== 'active' && rt.status !== 'paused')) {
      d.notes.push(msg('cmd37.note.controlState', { id: inst.id, status: rt.status }));
      continue;
    }
    d.effects.push({ fx: 'control', key: rt.key, op });
    done++;
  }
  if (!done) stop(msg('cmd37.err.nothingToControl', { op: `@cmd37.op.${op}` }));
  d.immediate = true;
}

export function planSim(i: IntentOf<'sim'>, d: Draft): void {
  d.effects.push({ fx: 'sim', op: i.op });
  d.immediate = true;
}

export function planSpeed(i: IntentOf<'speed'>, d: Draft): void {
  if (!(SIM_SPEEDS as readonly number[]).includes(i.value)) stop(msg('cmd37.err.speed', { value: i.value, known: SIM_SPEEDS.join(', ') }));
  d.effects.push({ fx: 'speed', value: i.value });
  d.immediate = true;
}
