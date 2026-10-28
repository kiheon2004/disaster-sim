/**
 * Water clauses of the rule-based parser (Korean + English), Phase 14.
 *
 *   "시간당 80mm의 비를 30분 동안 내려줘"          → rain 80 mm/h, 1800 s
 *   "30분 동안 40mm의 비"                          → rain 80 mm/h (total depth ÷ duration, noted)
 *   "남쪽 경계에서 수위를 2m까지 올려줘"            → rising water, S edge, surface 2 m
 *   "중앙에 초당 5세제곱미터의 물을 공급해줘"        → water source at (0, 0), 5 m³/s
 *   "Start rainfall at 80 mm/h for 30 minutes"
 *   "Raise the southern boundary water level to 2 meters"
 *
 * Units are converted exactly (mm/h; m³/s, m³/min, m³/h, L/s, "초당 … 톤"; m/min, m/h) and every
 * default that the text does not state is listed as a note. Water levels are SURFACE
 * ELEVATIONS on the terrain datum, never depths (the preview shows the resulting edge depth).
 */
import type { BoundarySide } from '@/core/model';
import type { I18nMessage } from '@/i18n/i18n';
import type { RainEventSpec, RisingWaterEventSpec, WaterEventSpec, WaterSourceEventSpec } from '@/events/specs';
import { FLOOD_LIMITS } from '@/events/flood/resolveFlood';
import type { ParseResult } from './CommandParser';
import { EN_DIR_WORD, KO_DIR, KO_DIR_WORD, enDir, isDelay, type NumToken } from './RuleBasedParser';

export type WaterKind = 'rain' | 'risingWater' | 'waterSource';

const RAIN_WORDS = /폭우|호우|강우|장대비|소나기|집중\s*호우|강수|(?:^|[\s,])비(?:가|를|는|와|과|의|도|랑|\s|$)|rain|downpour|precipitation|cloudburst|shower/;
const LEVEL_WORDS = /수위|해수면|물\s*높이|범람|침수|홍수|물이\s*차|만조|water\s*level|rising\s*water|flood|inundat|storm\s*surge|high\s*tide|sea\s*level/;
const SOURCE_WORDS = /공급|유입|방류|쏟아|분출|수도관|파열|급수|펌프|(?:물을|물이)\s*(?:흘려|부어|쏟|넣)|supply|inflow|pour|pump|discharge|water\s*source|burst|release\s+water|inject/;

export const DEFAULT_RAIN_DURATION = 1800; // s
export const DEFAULT_SOURCE_DURATION = 600; // s
export const DEFAULT_FLOOD_LEVEL = 1.5; // m (surface elevation)
/** Distance from the center assumed for "북쪽에 물을 공급" (m). */
export const DEFAULT_OFFSET = 50;

const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/** Which water event a clause describes (null = not a water clause). */
export function floodKind(clause: string, tokens: NumToken[]): WaterKind | null {
  if (tokens.some((t) => t.kind === 'flow') || (SOURCE_WORDS.test(clause) && /물|water/.test(clause))) return 'waterSource';
  if (tokens.some((t) => t.kind === 'rainRate' || (t.kind === 'mm' && /시간당|매\s*시간|per\s+hour/.test(t.before))) || RAIN_WORDS.test(clause)) return 'rain';
  if (LEVEL_WORDS.test(clause)) return 'risingWater';
  return null;
}

function side(clause: string): BoundarySide | null {
  const ko = clause.match(new RegExp(KO_DIR_WORD));
  if (ko) {
    const d = KO_DIR[ko[1]];
    if (d.length === 1) return d as BoundarySide;
  }
  const en = clause.match(new RegExp(`\\b${EN_DIR_WORD}(?:ern)?\\b`));
  if (en) {
    const d = enDir(en[1]);
    if (d && d.length === 1) return d as BoundarySide;
  }
  return null;
}

/** "2m", "2 meters", "2미터" (the shared table reads 미터 as m/s — in a water clause it is a length). */
function lengthTokens(clause: string, tokens: NumToken[]): NumToken[] {
  return tokens.filter((t) => t.kind === 'meter' || (t.kind === 'speed' && /미터/.test(clause.slice(t.index, t.end)) && !/m\/s/.test(clause.slice(t.index, t.end + 2))));
}

function durationOf(tokens: NumToken[], exclude: Set<NumToken>): { span?: number; delay: number } {
  const times = tokens.filter((t) => t.kind === 'time' && !exclude.has(t));
  const delayTok = times.find(isDelay);
  const span = times.find((t) => t !== delayTok);
  return { span: span?.si, delay: delayTok?.si ?? 0 };
}

/** Per-time context right before a number: "시간당 80mm", "초당 5톤", "분당 0.5m". */
function perUnit(t: NumToken): 'h' | 'min' | 's' | null {
  const b = t.before.slice(-6);
  if (/시간당|매\s*시간|per\s+hour\s*$/.test(b)) return 'h';
  if (/분당|매\s*분/.test(b)) return 'min';
  if (/초당|매\s*초/.test(b)) return 's';
  const a = t.after.slice(0, 12);
  if (/^\s*(?:per\s+hour|an\s+hour|\/\s*h)/.test(a)) return 'h';
  if (/^\s*(?:per\s+minute|a\s+minute)/.test(a)) return 'min';
  if (/^\s*(?:per\s+second|a\s+second)/.test(a)) return 's';
  return null;
}

/** Position on the map: center, a compass direction (offset), or explicit "(x, z)". */
function position(clause: string, notes: I18nMessage[]): [number, number] {
  const xy = clause.match(/\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/) ?? clause.match(/x\s*=?\s*(-?\d+(?:\.\d+)?)\s*,?\s*z\s*=?\s*(-?\d+(?:\.\d+)?)/);
  if (xy) return [parseFloat(xy[1]), parseFloat(xy[2])];
  if (/중앙|중심|가운데|한가운데|center|centre|middle/.test(clause)) return [0, 0];
  const d = side(clause) ?? null;
  const diag = clause.match(new RegExp(KO_DIR_WORD));
  const dir = diag ? KO_DIR[diag[1]] : d;
  if (dir) {
    const v: Record<string, [number, number]> = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0], NE: [0.71, -0.71], NW: [-0.71, -0.71], SE: [0.71, 0.71], SW: [-0.71, 0.71] };
    const u = v[dir];
    notes.push({ key: 'parse.note.flood.offset', params: { m: DEFAULT_OFFSET } });
    return [Math.round(u[0] * DEFAULT_OFFSET), Math.round(u[1] * DEFAULT_OFFSET)];
  }
  notes.push({ key: 'parse.note.flood.centerAssumed' });
  return [0, 0];
}

export function parseFlood(
  kind: WaterKind, clause: string, tokens: NumToken[], notes: I18nMessage[], result: ParseResult,
): { spec: WaterEventSpec; delay: number } | null {
  switch (kind) {
    case 'rain':
      return parseRain(clause, tokens, notes, result);
    case 'risingWater':
      return parseRisingWater(clause, tokens, notes, result);
    case 'waterSource':
      return parseSource(clause, tokens, notes, result);
  }
}

function parseRain(clause: string, tokens: NumToken[], notes: I18nMessage[], result: ParseResult) {
  const used = new Set<NumToken>();
  let intensity: number | undefined;
  let total: number | undefined;
  const rate = tokens.find((t) => t.kind === 'rainRate');
  if (rate) {
    intensity = rate.si;
    used.add(rate);
  } else {
    const mm = tokens.find((t) => t.kind === 'mm' || t.kind === 'cm');
    if (mm) {
      used.add(mm);
      const mmValue = mm.kind === 'cm' ? mm.value * 10 : mm.value;
      const per = perUnit(mm);
      if (per === 'h') intensity = mmValue;
      else if (per === 'min') intensity = mmValue * 60;
      else total = mmValue;
      if (mm.kind === 'cm') notes.push({ key: 'parse.note.flood.cmToMm' });
    }
  }
  const { span, delay } = durationOf(tokens, used);
  let duration = span;
  if (total !== undefined) {
    // "30분 동안 40mm" = total depth over the duration.
    if (duration === undefined) {
      duration = 3600;
      notes.push({ key: 'parse.note.flood.totalOverHour', params: { mm: total } });
    }
    intensity = (total * 3600) / duration;
    notes.push({ key: 'parse.note.flood.totalToRate', params: { mm: total, rate: round(intensity, 2) } });
  }
  if (intensity === undefined) {
    // Category words.
    if (/집중\s*호우|폭우|torrential|downpour|cloudburst|heavy\s+rain/.test(clause)) intensity = 50;
    else if (/소나기|shower/.test(clause)) intensity = 20;
    else intensity = 30;
    notes.push({ key: 'parse.note.flood.defaultIntensity', params: { mm: intensity } });
  }
  if (duration === undefined) {
    duration = DEFAULT_RAIN_DURATION;
    notes.push({ key: 'parse.note.flood.defaultDuration', params: { min: duration / 60 } });
  }
  if (intensity < FLOOD_LIMITS.rainIntensity[0] || intensity > FLOOD_LIMITS.rainIntensity[1]) {
    result.errors.push({ key: 'parse.flood.rainRange', params: { mm: round(intensity, 1) } });
    return null;
  }
  const spec: RainEventSpec = { event: 'rain', intensity: round(intensity, 3), duration: Math.round(duration) };
  const radiusTok = /반경|반지름|radius|within/.test(clause) ? lengthTokens(clause, tokens).find((t) => /반경|반지름|radius|within/.test(t.before)) : undefined;
  if (radiusTok) spec.area = { center: position(clause, notes), radius: radiusTok.si };
  return { spec, delay };
}

function parseRisingWater(clause: string, tokens: NumToken[], notes: I18nMessage[], result: ParseResult) {
  const used = new Set<NumToken>();
  let s = side(clause);
  if (!s) {
    s = 'S';
    notes.push({ key: 'parse.note.flood.defaultSide' });
  }
  // Rise rate: "분당 0.5m", "0.5 m/min", "시간당 1m".
  let riseRate: number | undefined;
  const rr = tokens.find((t) => t.kind === 'riseRate');
  const lengths = lengthTokens(clause, tokens);
  if (rr) {
    riseRate = rr.si;
    used.add(rr);
  } else {
    const perTok = lengths.find((t) => perUnit(t) !== null);
    if (perTok) {
      const per = perUnit(perTok)!;
      riseRate = per === 'min' ? perTok.si : per === 'h' ? perTok.si / 60 : perTok.si * 60;
      used.add(perTok);
    }
  }
  const levelTok = lengths.find((t) => !used.has(t)) ?? tokens.find((t) => t.kind === 'cm' && !used.has(t));
  if (levelTok && /만큼|^\s*more|\bby\s*$/.test(levelTok.after.slice(0, 6) + (/\bby\s*$/.test(levelTok.before) ? ' by' : ''))) {
    result.errors.push({ key: 'parse.flood.relativeLevel' });
    return null;
  }
  let level: number;
  if (levelTok) {
    level = levelTok.kind === 'cm' ? levelTok.value / 100 : levelTok.si;
    used.add(levelTok);
    notes.push({ key: 'parse.note.flood.levelIsElevation', params: { m: round(level, 2) } });
  } else {
    level = DEFAULT_FLOOD_LEVEL;
    notes.push({ key: 'parse.note.flood.defaultLevel', params: { m: level } });
  }
  // The tokenizer reads unsigned numbers: "-1.5m", "마이너스 1.5m", "minus 1.5 m" → negative.
  if (levelTok && /(?:-|−|마이너스\s*|minus\s+)$/.test(levelTok.before)) level = -level;
  if (level < FLOOD_LIMITS.level[0] || level > FLOOD_LIMITS.level[1]) {
    result.errors.push({ key: 'parse.flood.levelRange', params: { m: level } });
    return null;
  }
  const { span, delay } = durationOf(tokens, used);
  const spec: RisingWaterEventSpec = { event: 'risingWater', boundary: s, level: round(level, 3) };
  if (riseRate !== undefined) spec.riseRate = round(riseRate, 4);
  if (span !== undefined) spec.duration = Math.round(span);
  return { spec, delay };
}

function parseSource(clause: string, tokens: NumToken[], notes: I18nMessage[], result: ParseResult) {
  const used = new Set<NumToken>();
  let rate: number | undefined;
  const flow = tokens.find((t) => t.kind === 'flow');
  if (flow) {
    rate = flow.si;
    used.add(flow);
    if (!/cms/.test(clause)) notes.push({ key: 'parse.note.flood.flowConverted', params: { q: round(rate, 4) } });
  } else {
    const vol = tokens.find((t) => t.kind === 'volume');
    if (vol) {
      used.add(vol);
      const per = perUnit(vol);
      if (per) {
        rate = per === 's' ? vol.si : per === 'min' ? vol.si / 60 : vol.si / 3600;
        if (per !== 's' || /톤/.test(clause)) notes.push({ key: 'parse.note.flood.flowConverted', params: { q: round(rate, 4) } });
      } else {
        // "500세제곱미터의 물을 10분 동안" = total volume over the duration.
        const { span } = durationOf(tokens, used);
        if (span) {
          rate = vol.si / span;
          notes.push({ key: 'parse.note.flood.volumeToRate', params: { m3: vol.si, q: round(rate, 4) } });
        }
      }
    }
  }
  if (rate === undefined) {
    result.errors.push({ key: 'parse.flood.noRate' });
    return null;
  }
  if (rate < FLOOD_LIMITS.sourceRate[0] || rate > FLOOD_LIMITS.sourceRate[1]) {
    result.errors.push({ key: 'parse.flood.rateRange', params: { q: round(rate, 4) } });
    return null;
  }
  const pos = position(clause, notes);
  const { span, delay } = durationOf(tokens, used);
  let duration = span;
  if (duration === undefined) {
    duration = DEFAULT_SOURCE_DURATION;
    notes.push({ key: 'parse.note.flood.defaultSourceDuration', params: { min: duration / 60 } });
  }
  const spec: WaterSourceEventSpec = { event: 'waterSource', position: pos, rate: round(rate, 5), duration: Math.round(duration) };
  const r = lengthTokens(clause, tokens).find((t) => /반경|반지름|radius|within/.test(t.before));
  if (r) spec.radius = r.si;
  return { spec, delay };
}
