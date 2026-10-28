/**
 * Earthquake clauses of the rule-based parser (Korean + English), Phase 13.
 *
 *   "규모 6.5의 지진을 발생시켜"                → magnitude 6.5 (PGA etc. = labeled assumptions)
 *   "중앙에서 30초 동안 지진을 발생시켜"         → epicenter at the map center, 30 s
 *   "최대 지반가속도 0.3g의 지진을 발생시켜"     → PGA 0.3 g
 *   "Generate a magnitude 6.5 earthquake"
 *   "Apply 0.3g peak ground acceleration for 30 seconds"
 *
 * Nothing unclear is silently turned into a physical value: whatever the text does not state
 * comes from resolveEarthquake()'s defaults and is listed as an assumption note.
 */
import { COMPASS_BEARING, type CompassDir } from '@/core/compass';
import type { I18nMessage } from '@/i18n/i18n';
import type { EarthquakeEventSpec } from '@/events/specs';
import { resolveEarthquake } from '@/events/earthquake/resolveEarthquake';
import type { ParseResult } from './CommandParser';
import { EN_DIR_WORD, KO_DIR, KO_DIR_WORD, enDir, isDelay, type NumToken } from './RuleBasedParser';

const EQ_WORDS = /지진|여진|본진|진동|흔들|지반\s*가속도|지반\s*운동|earthquake|quake|seismic|tremor|aftershock|ground\s*(?:motion|acceleration|shaking)|\bpga\b/;
const DEFAULT_MAGNITUDE = 6.5;
/** Distance assumed when only a direction is given for the epicenter (km). */
const DEFAULT_EPICENTER_KM = 10;

export function isEarthquakeClause(clause: string, tokens: NumToken[]): boolean {
  return EQ_WORDS.test(clause) || tokens.some((t) => t.kind === 'accel');
}

const round2 = (v: number) => Math.round(v * 100) / 100;

function compassOffset(dir: CompassDir, km: number): [number, number] {
  const b = (COMPASS_BEARING[dir] * Math.PI) / 180;
  // Bearing → world (x = E, z = S).
  return [Math.round(Math.sin(b) * km * 1000) + 0, Math.round(-Math.cos(b) * km * 1000) + 0]; // + 0: no -0
}

function epicenterDirection(clause: string): CompassDir | null {
  // "동쪽 20km", "동쪽에서", "북동쪽 지점", "20 km east", "east of the city", "from the east"
  const ko = clause.match(new RegExp(`${KO_DIR_WORD}\\s*(?:쪽|방향)?\\s*(?:에서|으로부터|부근|지점|\\d)`));
  if (ko) return KO_DIR[ko[1]];
  const en = clause.match(new RegExp(`(?:\\d\\s*(?:km|m)?\\s+|from\\s+(?:the\\s+)?|to\\s+the\\s+)${EN_DIR_WORD}`));
  if (en && enDir(en[1])) return enDir(en[1])!;
  return null;
}

export function parseEarthquake(
  clause: string,
  _original: string,
  tokens: NumToken[],
  notes: I18nMessage[],
  result: ParseResult,
): { spec: EarthquakeEventSpec; delay: number } | null {
  const spec: EarthquakeEventSpec = { event: 'earthquake', magnitude: DEFAULT_MAGNITUDE };
  const used = new Set<NumToken>();

  // Magnitude: "규모 6.5", "magnitude 6.5", "M6.5", "6.5 규모"
  const mag = clause.match(/(?:규모|매그니튜드|magnitude|\bmw?)\s*(\d+(?:\.\d+)?)/) ?? clause.match(/(\d+(?:\.\d+)?)\s*(?:의\s*)?규모/);
  if (mag) {
    const v = parseFloat(mag[1]);
    if (v < 3 || v > 9.5) {
      result.errors.push({ key: 'parse.eq.magnitudeRange', params: { m: v } });
      return null;
    }
    spec.magnitude = v;
    const tok = tokens.find((t) => t.value === v);
    if (tok) used.add(tok);
  } else {
    notes.push({ key: 'parse.note.eq.defaultMagnitude', params: { m: DEFAULT_MAGNITUDE } });
  }

  // Intensity: acceleration with a unit (g, gal, m/s²). A bare "0.3" is not assumed to be g.
  const acc = tokens.find((t) => t.kind === 'accel');
  if (acc) {
    if (acc.si > 2) {
      result.errors.push({ key: 'parse.eq.pgaRange', params: { g: round2(acc.si) } });
      return null;
    }
    spec.pga = round2(acc.si);
    used.add(acc);
    if (!/\d\s*g\b/.test(clause) || /gal|갈|mpss/.test(clause)) notes.push({ key: 'parse.note.eq.convertedPga', params: { g: spec.pga } });
  }

  // Depth: "깊이 10km", "진원 깊이 15 km", "10 km deep", "depth 20 km"
  const depth = clause.match(/(?:깊이|depth)\s*(?:가|는|of)?\s*(\d+(?:\.\d+)?)\s*(?:km|킬로미터|킬로)?/) ?? clause.match(/(\d+(?:\.\d+)?)\s*(?:km|킬로미터)\s*(?:깊이|deep|depth)/);
  if (depth) {
    spec.depth = parseFloat(depth[1]);
    const tok = tokens.find((t) => t.value === spec.depth);
    if (tok) used.add(tok);
  }

  // Epicenter: center words, or a compass direction with an optional distance.
  if (/중앙|중심|가운데|한가운데|center|centre|middle/.test(clause)) {
    spec.epicenter = [0, 0];
  } else {
    const dir = epicenterDirection(clause);
    if (dir) {
      const km = tokens.find((t) => t.kind === 'km' && !used.has(t));
      const m = tokens.find((t) => t.kind === 'meter' && !used.has(t));
      const dist = km ? km.si : m ? m.si / 1000 : DEFAULT_EPICENTER_KM;
      if (km) used.add(km);
      else if (m) used.add(m);
      else notes.push({ key: 'parse.note.eq.epicenterDistance', params: { km: DEFAULT_EPICENTER_KM } });
      spec.epicenter = compassOffset(dir, dist);
    }
  }

  // Shaking axis: "남북 방향", "east-west", "45도 방향"
  if (/남북|north[\s-]?south|n-s\b/.test(clause)) spec.direction = 0;
  else if (/동서|east[\s-]?west|e-w\b/.test(clause)) spec.direction = 90;
  else {
    const deg = tokens.find((t) => t.kind === 'degree' && t.value >= 0 && t.value <= 360);
    if (deg) {
      spec.direction = deg.value % 360;
      used.add(deg);
    }
  }

  // Frequency
  const hz = tokens.find((t) => t.kind === 'freq');
  if (hz) {
    spec.dominantFrequency = hz.value;
    used.add(hz);
  }

  // Seed: "시드 42", "seed 42"
  const seed = clause.match(/(?:시드|seed)\s*(\d+)/);
  if (seed) spec.seed = parseInt(seed[1], 10);

  // Times: delay ("10초 후") and duration ("30초 동안").
  const times = tokens.filter((t) => t.kind === 'time');
  const delayTok = times.find(isDelay);
  const span = times.find((t) => t !== delayTok);
  if (span) spec.duration = Math.round(span.si * 10) / 10;

  // The defaults that will apply are shown as assumptions (no hidden physical values).
  for (const a of resolveEarthquake(spec, 0).assumptions) notes.push(a);
  return { spec, delay: delayTok?.si ?? 0 };
}
