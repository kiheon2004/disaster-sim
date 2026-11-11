/**
 * Phase 37 — adapter to the OLD command grammar (src/commands: wind, earthquake, rain, rising water, water source and
 * the run controls). That library and its 53 tests are not changed; it is used here as a grammar library only.
 *
 * It is asked ONLY when the new rules read nothing in a clause, and only for
 *  - run-now sentences of the five legacy types (a legacy disaster word + a run verb), and
 *  - the old control sentences (play / pause / reset / speed).
 *
 * Its regular expressions match words anywhere in a sentence and ignore the rest, so a clause is let through only
 * when EVERY token is something the old grammar reads (`legacyAllowed`) — "주택을 놓고 시작" never becomes "play".
 * The result is always the legacy form of conventions §6 D1: every basic field (the said values, the definition's
 * defaults for the rest), `now`, and a start time when the sentence gives a delay. Values that the old grammar filled
 * in by itself (its notes say so: a category speed for "태풍", 30 mm/h for "비") are NOT said values.
 *
 * Synchronous and pure: fixed `ParseDefaults` from the wind definition (never the wind form or the running wind).
 */
import type { I18nMessage } from '@/i18n/i18n';
import type { ParseDefaults } from '@/commands/CommandParser';
import { parseCommands } from '@/commands/RuleBasedParser';
import { phenomena } from '@/phenomena/registry';
import type { CompassDir } from '@/core/compass';
import type { Intent, IntentOf, PlaceRef } from './intent';
import { LEGACY_FIELDS, LEGACY_TYPES } from './aliases';
import type { Tok } from './lexicon';

type Fields = Record<string, number | string>;

const defaultsOf = (type: string): Record<string, unknown> => (phenomena.implemented(type)?.defaults() ?? {}) as unknown as Record<string, unknown>;

/** What the old grammar uses when a wind sentence leaves something out: the wind DEFINITION's defaults. */
export const LEGACY_DEFAULTS: ParseDefaults = (() => {
  const d = defaultsOf('wind');
  return {
    direction: (typeof d.direction === 'string' ? d.direction : 'E') as CompassDir,
    duration: typeof d.duration === 'number' ? d.duration : 60,
    gustStrength: typeof d.gustStrength === 'number' ? d.gustStrength : 0.3,
  };
})();

/**
 * The fields of a run-now command of a legacy type (§6 D1): the said values, and for every other basic field the
 * definition's default. Earthquake: only `magnitude` is filled in (the model assumes `pga` / `duration`).
 */
export function legacyForm(type: string, said: Fields): Fields {
  const out: Fields = { ...said };
  const def = defaultsOf(type);
  const keys = type === 'earthquake' ? ['magnitude'] : LEGACY_FIELDS[type] ?? [];
  for (const k of keys) {
    const v = def[k];
    if (out[k] === undefined && (typeof v === 'number' || typeof v === 'string')) out[k] = v;
  }
  return out;
}

/** A disaster started by an earlier clause of the same sentence (relative starts: "태풍이 끝나고 5초 뒤에 …"). */
export interface LegacyEvent {
  type: string;
  /** Seconds from now to its start. */
  delay: number;
  /** Its length (s), when the sentence fixes it. */
  duration: number | null;
}

/** The events a list of intents starts now (for relative starts in later clauses). */
export function eventsOf(intents: Intent[]): LegacyEvent[] {
  const out: LegacyEvent[] = [];
  for (const i of intents) {
    if (i.kind !== 'disaster' || !i.now) continue;
    out.push({ type: i.type, delay: i.start ?? 0, duration: typeof i.fields.duration === 'number' ? i.fields.duration : null });
  }
  return out;
}

// ── What the old grammar may be shown ────────────────────────────────────────────────────

const RUN_VERBS = ['trigger', 'legacyRun', 'supply', 'raise', 'lower'];
const CONTROL_VERBS = ['run', 'pauseSim', 'reset', 'stop', 'pause', 'resume'];
const DISASTER_WORDS = new Set(['magnitude', 'pga', 'during', 'perHour', 'perMinute', 'perSecond', 'windSpeed', 'level', 'boundary', 'after', 'toward', 'place:center', 'dir:north', 'dir:south', 'dir:east', 'dir:west']);
const CONTROL_WORDS = new Set(['simNoun', 'speedNoun', 'halfSpeed', 'normalSpeed', 'half', 'double', 'faster']);

type LegacyKind = 'disaster' | 'control' | null;

/** Whether every token of a clause is something the old grammar reads — and which of its two families it is. */
export function legacyAllowed(toks: Tok[]): LegacyKind {
  // A clause is of a family when every token can be read by that family and its own words are there.
  let allDisaster = true, allControl = true, disaster = 0, runVerb = 0, verbs = 0, speedWords = 0, numbers = 0;
  for (const tok of toks) {
    if (tok.t === 'num') { numbers++; continue; }
    if (tok.t === 'xz') { allControl = false; continue; }
    if (tok.t !== 'w') return null;
    const old = tok.s.some((s) => s.c === 'legacy');
    const weak = old || tok.s.some((s) => s.c === 'part' || s.c === 'prep' || s.c === 'fill');
    const dis = tok.s.some((s) => s.c === 'dis' && LEGACY_TYPES.includes(s.type));
    const run = tok.s.some((s) => s.c === 'verb' && RUN_VERBS.includes(s.id));
    const ctl = tok.s.some((s) => s.c === 'verb' && CONTROL_VERBS.includes(s.id));
    const dWord = tok.s.some((s) => s.c === 'w' && (DISASTER_WORDS.has(s.id) || s.id.startsWith('wind:') || s.id.startsWith('diag:')));
    const cWord = tok.s.some((s) => s.c === 'w' && CONTROL_WORDS.has(s.id));
    if (dis) disaster++;
    if (run) runVerb++;
    if (ctl || old) verbs++;
    else if (cWord && !tok.s.some((s) => s.c === 'w' && s.id === 'simNoun')) speedWords++;
    if (!(weak || dis || run || dWord)) allDisaster = false;
    if (!(weak || ctl || cWord)) allControl = false;
  }
  if (allDisaster && disaster && runVerb) return 'disaster';
  // The old control grammar answers with ONE command and ignores the rest: let through one control word alone
  // (계속 · halt), or a speed phrase with no control word in it ("2배속 실행" is two commands — not for the old grammar).
  if (allControl && ((verbs === 1 && numbers === 0 && speedWords === 0) || (verbs === 0 && speedWords > 0))) return 'control';
  return null;
}

// ── Old result → intents ─────────────────────────────────────────────────────────────────

const has = (notes: I18nMessage[], key: string): boolean => notes.some((n) => n.key === key);
const isPair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number';
const pointOf = (p: [number, number]): PlaceRef => (p[0] === 0 && p[1] === 0 ? { p: 'center' } : { p: 'xz', x: p[0], z: p[1] });

/** One old event spec → the said fields and position; null when it holds something the legacy form cannot write. */
function saidOf(spec: Record<string, unknown>, notes: I18nMessage[]): { said: Fields; at?: PlaceRef } | null {
  const said: Fields = {};
  const put = (k: string, defaulted: boolean) => { const v = spec[k]; if (!defaulted && (typeof v === 'number' || typeof v === 'string')) said[k] = v; };
  switch (spec.event) {
    case 'wind':
      // A ramp ("50 m/s까지 20초 동안 증가") or "stop the wind" (speed 0) is not a plain run-now wind.
      if (spec.rampDuration !== undefined || spec.rampFrom !== undefined || spec.speed === 0) return null;
      put('speed', has(notes, 'parse.note.categorySpeed'));
      put('direction', has(notes, 'parse.note.defaultDirection'));
      put('duration', has(notes, 'parse.note.defaultDuration'));
      return { said };
    case 'earthquake':
      if (spec.depth !== undefined || spec.direction !== undefined || spec.dominantFrequency !== undefined || spec.seed !== undefined) return null;
      put('magnitude', has(notes, 'parse.note.eq.defaultMagnitude'));
      put('pga', false);
      put('duration', false);
      return isPair(spec.epicenter) ? { said, at: pointOf(spec.epicenter) } : { said };
    case 'rain':
      if (spec.area !== undefined) return null;
      put('intensity', has(notes, 'parse.note.flood.defaultIntensity'));
      put('duration', has(notes, 'parse.note.flood.defaultDuration'));
      return { said };
    case 'risingWater':
      put('boundary', has(notes, 'parse.note.flood.defaultSide'));
      put('level', has(notes, 'parse.note.flood.defaultLevel'));
      put('riseRate', false);
      put('duration', false);
      return { said };
    case 'waterSource':
      if (spec.radius !== undefined) return null;
      put('rate', false);
      put('duration', has(notes, 'parse.note.flood.defaultSourceDuration'));
      return isPair(spec.position) && !has(notes, 'parse.note.flood.centerAssumed') ? { said, at: pointOf(spec.position) } : { said };
    default:
      return null;
  }
}

export interface LegacyResult {
  intents: Intent[];
  notes: I18nMessage[];
}

/**
 * One clause through the old grammar. `text`: the clause as normalised text; `toks`: its tokens (for the "nothing
 * else in it" check); `earlier`: what earlier clauses of the sentence start (relative starts). Null: not a legacy
 * sentence, or the old grammar refuses it, or it says something the legacy form cannot write.
 */
export function legacyClause(text: string, toks: Tok[], earlier: LegacyEvent[]): LegacyResult | null {
  const family = legacyAllowed(toks);
  if (!family) return null;
  const r = parseCommands(text, LEGACY_DEFAULTS);
  if (!r.ok || r.errors.length || r.unsupported.length || !r.commands.length) return null;
  const notes: I18nMessage[] = [{ key: 'cmd37.nl.note.legacy' }];
  if (family === 'control') {
    if (r.commands.length !== 1) return null;
    const c = r.commands[0].command;
    if (c.kind === 'control') return { intents: [{ kind: 'sim', op: c.action === 'play' ? 'run' : c.action }], notes };
    if (c.kind === 'speed') return { intents: [{ kind: 'speed', value: c.value }], notes };
    return null;
  }
  const intents: Intent[] = [];
  const started = earlier.slice();
  for (const pc of r.commands) {
    if (pc.command.kind !== 'event') return null;
    const spec = pc.command.spec as unknown as Record<string, unknown>;
    const type = String(spec.event);
    if (!LEGACY_TYPES.includes(type)) return null;
    const s = saidOf(spec, pc.notes);
    if (!s) return null;
    // Start: an absolute delay, or relative to a disaster the same sentence starts (what the old dispatcher computes).
    let delay = pc.delay ?? 0;
    if (pc.after) {
      const after = pc.after;
      const ref = [...started].reverse().find((e) => e.type === after.type);
      if (ref) {
        if (after.anchor === 'end' && ref.duration === null) return null;
        delay = Math.max(0, ref.delay + (after.anchor === 'end' ? ref.duration! : 0) + after.offset);
      } else {
        // The other disaster is not in this sentence: the old dispatcher starts at now + offset and says so.
        if (after.anchor === 'end') return null;
        delay = Math.max(0, after.offset);
        notes.push({ key: 'cmd37.nl.note.afterUnresolved', params: { type: after.type, s: delay } });
      }
    }
    const fields = legacyForm(type, s.said);
    const intent: IntentOf<'disaster'> = { kind: 'disaster', type, fields, now: true };
    if (s.at) intent.at = s.at;
    if (delay > 0) intent.start = delay;
    intents.push(intent);
    started.push({ type, delay, duration: typeof fields.duration === 'number' ? fields.duration : null });
  }
  return { intents, notes };
}
