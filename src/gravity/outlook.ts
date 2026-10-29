/**
 * Outlook of a gravity experiment (Phase 31, editor / preview / HUD): the global path sampled from the same functions
 * as the run, the extremes it reaches, and which models are valid, scaled, limited or unsupported under it.
 *
 * Support levels (docs/VARIABLE_GRAVITY.md §3, §17–§27):
 *   full         the model takes the full vector and stays valid (rigid bodies, contacts, vehicles, people, debris)
 *   scaled       the model takes g (its down component) and is valid within its own range; Earth-calibrated
 *                correlations are scaled by the documented rule (convection ∝ g^⅓, …)
 *   limited      part of the effect is not represented (e.g. the horizontal component in a ground-based solver beyond a
 *                shallow tilt, structures under uplift) — results are shown with the limitation
 *   unsupported  the model's assumptions break (no downward gravity for a free-surface solver): it holds its state and
 *                says so — nothing is shown as a physical result
 */
import { experimentBlend, globalVector } from './field';
import { EARTH_G, type GravitySpec } from './types';

export type Support = 'full' | 'scaled' | 'limited' | 'unsupported';
export const SUPPORTED_MODELS = [
  'rigid', 'contact', 'vehicles', 'people', 'debris', 'structure', 'roofSnow', 'collapse', 'flood', 'buoyancy', 'atmosphere',
  'convection', 'fire', 'snow', 'precipitation', 'ash', 'bombs', 'lava', 'meteor', 'blast', 'ground',
] as const;
export type SupportedModel = (typeof SUPPORTED_MODELS)[number];

export interface GravityPathPoint {
  t: number;
  gx: number; gy: number; gz: number;
  magnitude: number;
}

/** Thresholds of the support rules (shares of g₀ and of the down component). */
export const TILT_LIMIT = 0.3;
export const DOWN_MIN = 0.05;
export const HORIZONTAL_SHARE = 0.05;

/** State of one sample of the field for the support rules. */
export interface FieldState {
  /** Down component (m/s², −g_y), horizontal magnitude, |g|. */
  down: number;
  horizontal: number;
  magnitude: number;
  /** Local sources act somewhere. */
  local: boolean;
}

/** Support of each model under one field state (g₀ = Earth gravity of the project). */
export function supportOf(st: FieldState, g0 = EARTH_G): Record<SupportedModel, Support> {
  const noDown = st.down < DOWN_MIN * g0;
  const tilt = st.down > 0 ? st.horizontal / st.down : Infinity;
  const tilted = st.horizontal > HORIZONTAL_SHARE * g0;
  // Ground-based free-surface solvers (water, lava, granular runout): the horizontal part enters as a tilted
  // reference surface while it is shallow; without a downward component they cannot run.
  const surface: Support = noDown ? 'unsupported' : tilt > TILT_LIMIT ? 'limited' : st.local || tilted || Math.abs(st.down - g0) > 1e-9 ? 'scaled' : 'full';
  const structure: Support = st.down < 0 || tilted ? 'limited' : Math.abs(st.down - g0) > 1e-9 || st.local ? 'scaled' : 'full';
  return {
    rigid: 'full', contact: 'full', vehicles: 'full', people: 'full', debris: 'full',
    structure,
    roofSnow: structure,
    collapse: noDown ? 'limited' : structure,
    flood: surface,
    buoyancy: noDown ? 'unsupported' : tilted ? 'limited' : surface === 'full' ? 'full' : 'scaled',
    atmosphere: noDown ? 'unsupported' : tilted || st.local ? 'limited' : Math.abs(st.down - g0) > 1e-9 ? 'scaled' : 'full',
    convection: st.magnitude < DOWN_MIN * g0 ? 'limited' : tilted ? 'limited' : Math.abs(st.down - g0) > 1e-9 ? 'scaled' : 'full',
    fire: st.magnitude < DOWN_MIN * g0 || st.down <= 0 ? 'limited' : Math.abs(st.down - g0) > 1e-9 || tilted ? 'scaled' : 'full',
    snow: noDown ? 'limited' : Math.abs(st.down - g0) > 1e-9 || tilted ? 'scaled' : 'full',
    precipitation: noDown ? 'limited' : 'full',
    ash: noDown ? 'unsupported' : Math.abs(st.down - g0) > 1e-9 || tilted ? 'scaled' : 'full',
    bombs: 'full',
    lava: surface,
    meteor: Math.abs(st.down - g0) > 1e-9 || tilted ? 'scaled' : 'full',
    blast: 'full',
    ground: noDown ? 'unsupported' : tilt > TILT_LIMIT ? 'limited' : Math.abs(st.down - g0) > 1e-9 || tilted ? 'scaled' : 'full',
  };
}

const RANK: Record<Support, number> = { full: 0, scaled: 1, limited: 2, unsupported: 3 };
/** Worse of two support levels. */
export const worse = (a: Support, b: Support): Support => (RANK[a] >= RANK[b] ? a : b);

export interface GravityOutlook {
  path: GravityPathPoint[];
  /** Extremes of the global part over the window (m/s²). */
  maxMagnitude: number;
  minMagnitude: number;
  maxDown: number;
  minDown: number;
  maxHorizontal: number;
  /** Largest acceleration a local source adds at its peak (m/s²; radial: the core maximum). */
  localPeak: number;
  /** Worst support of each model over the path. */
  support: Record<SupportedModel, Support>;
  /** Assumption / limitation keys that apply (i18n). */
  limits: string[];
  issues: string[];
}

/** Peak |a| of a source (region: |accel|; radial: the maximum of its law inside the radius). */
function sourcePeak(s: GravitySpec['sources'][number]): number {
  if (s.kind === 'region') { const a = s.accel ?? [0, 0, 0]; return Math.hypot(a[0], a[1], a[2]); }
  const S = Math.abs(s.strength ?? 0), r0 = s.r0 ?? 1, eps = s.softening ?? 1, R = s.radius;
  switch (s.law ?? 'inverseSquare') {
    case 'inverseSquare': {
      const r = Math.min(R, eps / Math.SQRT2);
      return (S * r0 * r0 * r) / Math.pow(r * r + eps * eps, 1.5);
    }
    case 'linear': return (S * R) / r0;
    case 'constant': return S;
  }
}

/** Sample the experiment's global path (n points over its window, from the project gravity g₀). */
export function gravityOutlook(spec: GravitySpec, g0 = EARTH_G, n = 121): GravityOutlook {
  const e = { id: '', spec, start: 0 };
  const path: GravityPathPoint[] = [];
  const v: [number, number, number] = [0, 0, 0];
  let maxM = 0, minM = Infinity, maxD = -Infinity, minD = Infinity, maxH = 0;
  for (let k = 0; k < n; k++) {
    const t = (spec.duration * k) / (n - 1) - (k === n - 1 ? 1e-9 : 0);
    const b = experimentBlend(e, t);
    if (spec.global && b !== null) globalVector(spec, [0, -g0, 0], b, v);
    else { v[0] = 0; v[1] = -g0; v[2] = 0; }
    const m = Math.hypot(v[0], v[1], v[2]);
    path.push({ t, gx: v[0], gy: v[1], gz: v[2], magnitude: m });
    maxM = Math.max(maxM, m); minM = Math.min(minM, m);
    maxD = Math.max(maxD, -v[1]); minD = Math.min(minD, -v[1]);
    maxH = Math.max(maxH, Math.hypot(v[0], v[2]));
  }
  const localPeak = spec.sources.reduce((a, s) => Math.max(a, sourcePeak(s)), 0);
  // Worst support over the path; local sources: the worst of the global state with ± their peak added downward.
  let support = supportOf({ down: path[0].gy * -1, horizontal: Math.hypot(path[0].gx, path[0].gz), magnitude: path[0].magnitude, local: spec.sources.length > 0 }, g0);
  const fold = (st: FieldState) => {
    const s = supportOf(st, g0);
    for (const k of Object.keys(support) as SupportedModel[]) support[k] = worse(support[k], s[k]);
  };
  for (const p of path) {
    const st = { down: -p.gy, horizontal: Math.hypot(p.gx, p.gz), magnitude: p.magnitude, local: spec.sources.length > 0 };
    fold(st);
    if (localPeak > 0) {
      fold({ ...st, down: st.down - localPeak, magnitude: Math.max(0, st.magnitude - localPeak) });
      fold({ ...st, horizontal: st.horizontal + localPeak });
    }
  }
  support = { ...support };
  const limits: string[] = [];
  if (support.structure === 'limited') limits.push(minD < 0 ? 'gravity.lim.uplift' : 'gravity.lim.lateral');
  if (support.flood === 'unsupported') limits.push('gravity.lim.waterNoDown');
  else if (support.flood === 'limited') limits.push('gravity.lim.waterTilt');
  if (support.atmosphere !== 'full' && support.atmosphere !== 'scaled') limits.push(support.atmosphere === 'unsupported' ? 'gravity.lim.atmosNoDown' : 'gravity.lim.atmosTilt');
  if (support.convection === 'limited') limits.push('gravity.lim.convection');
  if (support.fire === 'limited') limits.push('gravity.lim.fire');
  if (support.collapse === 'limited') limits.push('gravity.lim.collapse');
  if (support.precipitation === 'limited') limits.push('gravity.lim.precipitation');
  if (support.lava === 'unsupported' || support.ash === 'unsupported') limits.push('gravity.lim.volcano');
  if (maxM > 3 * g0) limits.push('gravity.lim.high');
  if (spec.sources.some((s) => s.kind === 'region')) limits.push('gravity.lim.nonConservative');
  if ((spec.profile === 'pulse' || spec.profile === 'constant' || spec.profile === 'staged' || spec.profile === 'scheduled') && spec.global) limits.push('gravity.lim.sudden');
  return { path, maxMagnitude: maxM, minMagnitude: minM, maxDown: maxD, minDown: minD, maxHorizontal: maxH, localPeak, support, limits, issues: [] };
}
