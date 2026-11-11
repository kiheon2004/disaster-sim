/**
 * Reading and writing the parameters of a phenomenon spec (Phase 37: moved out of the experiment panel so that the
 * panel and the command planner share one implementation).
 *
 * A `ParamField` shows `stored × scale` (seconds as minutes, joules as MJ …) and may map a nested or non-numeric spec
 * value through `get` / `set`. Two views of a value:
 *  - display (`fieldValue` / `setField`): what the panel's number fields show and take;
 *  - stored (`assignSpecValue`): the spec's own value in its own unit — what a command writes (`energy=1.8e9` J).
 */
import type { EventSpec } from '@/events/specs';
import type { ImplementedPhenomenon, ParamField } from './types';

/** The value a field shows (display units). */
export function fieldValue(f: ParamField, spec: EventSpec): number | string | undefined {
  const v = f.get ? f.get(spec) : (spec as unknown as Record<string, number | string | undefined>)[f.key];
  return typeof v === 'number' ? v * (f.scale ?? 1) : v;
}

/** The spec with a field set from a display value (undefined = leave it to the model's assumption). */
export function setField(f: ParamField, spec: EventSpec, v: number | string | undefined): EventSpec {
  const stored = typeof v === 'number' ? v / (f.scale ?? 1) : v;
  if (f.set) return f.set(spec, stored);
  const next = { ...spec } as unknown as Record<string, unknown>;
  if (stored === undefined) delete next[f.key];
  else next[f.key] = stored;
  return next as unknown as EventSpec;
}

/** A field's limits in STORED units (the panel's min / max are display units). */
export function storedLimits(f: ParamField): { min: number; max: number } {
  const k = f.scale ?? 1;
  // (12 significant digits: 0.001 MJ ÷ 1e-6 is 1000 J, not 1000.0000000000001)
  const stored = (v: number) => (k === 1 ? v : Number((v / k).toPrecision(12)));
  return { min: stored(f.min), max: stored(f.max) };
}

/**
 * A stored number brought inside its field's limits — the clamp the panel's number fields apply to typed values
 * (ui/common/fields.tsx), in stored units. `clamped` says whether it moved.
 */
export function clampField(f: ParamField, stored: number): { value: number; clamped: boolean } {
  const { min, max } = storedLimits(f);
  const value = Math.min(max, Math.max(min, stored));
  return { value, clamped: value !== stored };
}

export type AssignResult =
  | { ok: true; spec: EventSpec; /** The value written when it was brought inside the field's limits. */ clamped?: { from: number; to: number; min: number; max: number } }
  | { ok: false; reason: 'unknownField' | 'badOption' | 'notANumber'; known: string[]; options?: string[] };

/**
 * Write one top-level value of a spec by its own name, in its own (stored) unit: `energy` in J, `duration` in s …
 * Names are the spec's keys (those the type's defaults or its fields carry); a field that maps through `get` / `set`
 * and is not a key of the spec (a position coordinate, a direction shown as a bearing) takes the value its `set`
 * takes. Numbers are clamped to the field's limits; choices must be one of the field's options. The result still has
 * to pass the type's schema (the caller checks — a clamp cannot repair every combination).
 */
export function assignSpecValue(def: ImplementedPhenomenon<EventSpec>, spec: EventSpec, key: string, value: number | string): AssignResult {
  const bag = spec as unknown as Record<string, unknown>;
  const defaults = def.defaults() as unknown as Record<string, unknown>;
  const field = def.fields.find((f) => f.key === key) ?? def.fields.find((f) => f.key.toLowerCase() === key.toLowerCase());
  const raw = key in bag || key in defaults ? key : Object.keys({ ...defaults, ...bag }).find((k) => k.toLowerCase() === key.toLowerCase());
  const known = [...new Set([...Object.keys(defaults).filter((k) => k !== 'event' && typeof defaults[k] !== 'object'), ...def.fields.map((f) => f.key)])].sort();
  if (!field && raw === undefined) return { ok: false, reason: 'unknownField', known };
  if (field?.options) {
    const hit = field.options.find((o) => o.value === value) ?? field.options.find((o) => o.value.toLowerCase() === String(value).toLowerCase());
    if (!hit) return { ok: false, reason: 'badOption', known, options: field.options.map((o) => o.value) };
    return { ok: true, spec: field.set ? field.set(spec, hit.value) : ({ ...bag, [field.key]: hit.value } as unknown as EventSpec) };
  }
  // A plain key of the spec (or a plain field the defaults leave out: optional values) is written as it is stored.
  const mapped = !!field && (!!field.get || !!field.set);
  const plain = raw ?? (field && !mapped ? field.key : undefined);
  if (plain !== undefined) {
    const current = bag[plain] ?? defaults[plain];
    if (typeof value === 'string') {
      if (typeof current !== 'string') return { ok: false, reason: 'notANumber', known };
      return { ok: true, spec: { ...bag, [plain]: value } as unknown as EventSpec };
    }
    if (field && !mapped) {
      const c = clampField(field, value);
      const { min, max } = storedLimits(field);
      return { ok: true, spec: { ...bag, [plain]: c.value } as unknown as EventSpec, ...(c.clamped ? { clamped: { from: value, to: c.value, min, max } } : {}) };
    }
    return { ok: true, spec: { ...bag, [plain]: value } as unknown as EventSpec };
  }
  // A mapped field that is not a key of the spec: through its own setter.
  if (field?.set) return { ok: true, spec: field.set(spec, value) };
  return { ok: false, reason: 'unknownField', known };
}
