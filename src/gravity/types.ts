/**
 * Gravity experiment spec (Phase 31) — saved in the experiment plan (schema v7, validated per instance).
 * Accelerations in m/s², positions in world metres (y up), times in s on the instance's local clock.
 *
 * The field is g(x, t) = G(t) + Σ local sources(x, t):
 *
 *  global        on: G(t) REPLACES the project gravity G₀ = (0, −g₀, 0) — it runs from G₀ to the target vector
 *                (magnitude × direction) along the time profile; off: G(t) = G₀ and only the local sources act
 *  transition    vector: G = G₀ + s·(G₁ − G₀) (a reversal passes through zero); rotate: the direction turns on the
 *                great circle from G₀ to G₁ while the magnitude is interpolated (a sideways turn at constant |g|)
 *  profile       the blend s(t) (profiles.ts): constant, linear, smooth, staged, cyclic, pulse, scheduled
 *  end           restore: after the duration G returns to G₀ (the experiment window [start, start + duration)),
 *                hold: G keeps its end value (the run continues under the new gravity)
 *  sources       local fields ADDED to G (sum in a canonical order — order-independent): a region (sphere or vertical
 *                column) with an added acceleration vector or a replaced total, and radial fields (attracting /
 *                repelling, softened inverse-square, linear or constant law) — user-defined acceleration fields,
 *                not the field of a real body (no black hole, no general relativity)
 *
 * Mass never changes: weight = m·g(x, t) at the body.
 */
import type { Vec3 } from '@/core/types';
import { GRAVITY } from '@/core/units';
import { GRAVITY_PROFILES, profileIssues, type GravityProfileKind } from './profiles';

export type GravityScenario =
  | 'earth' | 'moon' | 'mars' | 'high' | 'double' | 'zero' | 'reverse' | 'sideways' | 'ramp' | 'pulse'
  | 'well' | 'repulsor' | 'radial' | 'highSnow' | 'highCollapse' | 'custom';
export const GRAVITY_SCENARIOS: readonly GravityScenario[] = [
  'earth', 'moon', 'mars', 'high', 'double', 'zero', 'reverse', 'sideways', 'ramp', 'pulse', 'well', 'repulsor', 'radial', 'highSnow', 'highCollapse', 'custom',
];
export type GravityTransition = 'vector' | 'rotate';
export const GRAVITY_TRANSITIONS: readonly GravityTransition[] = ['vector', 'rotate'];
export type GravityEnd = 'restore' | 'hold';
export const GRAVITY_ENDS: readonly GravityEnd[] = ['restore', 'hold'];

export type SourceKind = 'region' | 'radial';
export const SOURCE_KINDS: readonly SourceKind[] = ['region', 'radial'];
/** sphere: distance to the centre; column: horizontal distance (a vertical cylinder of any height). */
export type RegionShape = 'sphere' | 'column';
export const REGION_SHAPES: readonly RegionShape[] = ['sphere', 'column'];
/** add: the region's vector is added to the field; replace: inside, the total field blends to the region's vector. */
export type RegionMode = 'add' | 'replace';
export const REGION_MODES: readonly RegionMode[] = ['add', 'replace'];
export type Falloff = 'none' | 'linear' | 'smooth';
export const FALLOFFS: readonly Falloff[] = ['none', 'linear', 'smooth'];
/** Radial laws: a(r) = S·r0²/(r² + ε²)·r/√(r² + ε²) (softened inverse square), S·r/r0 (linear), S (constant). */
export type RadialLaw = 'inverseSquare' | 'linear' | 'constant';
export const RADIAL_LAWS: readonly RadialLaw[] = ['inverseSquare', 'linear', 'constant'];

export interface GravitySourceSpec {
  kind: SourceKind;
  /** World position (m). */
  center: Vec3;
  /** Region radius / radial cut-off radius (m). */
  radius: number;
  /** Width of the tapered edge inside the radius (m; falloff 'none' ignores it). */
  edge?: number;
  falloff: Falloff;
  /** Region: shape, mode and its acceleration vector (m/s²). */
  shape?: RegionShape;
  mode?: RegionMode;
  accel?: Vec3;
  /** Radial: strength S (m/s², > 0 attracts, < 0 repels) at the reference radius r0 (m), law and softening ε (m). */
  strength?: number;
  r0?: number;
  law?: RadialLaw;
  softening?: number;
  /** The source's strength follows the experiment's profile s(t) (otherwise it is on for the whole window). */
  followProfile?: boolean;
}

export interface GravitySpec {
  event: 'gravity';
  scenario: GravityScenario;
  /** The experiment replaces the global (uniform) gravity. */
  global: boolean;
  /** Target magnitude (m/s²) and direction (normalized on use; [0, −1, 0] = down). */
  magnitude: number;
  direction: Vec3;
  transition: GravityTransition;
  profile: GravityProfileKind;
  /** Experiment window (s). */
  duration: number;
  ramp?: number;
  /** staged: [local time s, blend s] sorted by time. */
  stages?: [number, number][];
  /** cyclic / pulse period (s), pulse width (s). */
  period?: number;
  pulseWidth?: number;
  /** scheduled windows [on, off) (local s). */
  windows?: [number, number][];
  end: GravityEnd;
  sources: GravitySourceSpec[];
  startTime?: number;
  name?: string;
}

/**
 * Earth gravity of the project (the value every Phase 0–30 model was written with, `GRAVITY` = 9.81 m/s²) — the
 * Earth preset, the "× g₀" display and the presets' multiples use it, so the Earth preset IS the baseline. (Standard
 * gravity 9.80665 m/s² differs by 0.03 %.)
 */
export const EARTH_G = GRAVITY;

export const GRAVITY_LIMITS = {
  /** |g| ≤ 50 m/s² (≈ 5 g): beyond it the structural and fluid models are far outside their range; Phase 32 handles extremes. */
  magnitude: [0, 50] as [number, number],
  duration: [1, 6 * 3600] as [number, number],
  radius: [1, 400] as [number, number],
  strength: [-50, 50] as [number, number],
  sources: 8,
} as const;

const finiteVec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
const norm = (v: Readonly<Vec3>) => Math.hypot(v[0], v[1], v[2]);

/** Validation problems of a spec (i18n keys), empty when valid. Physically contradictory input is rejected with a reason. */
export function gravityIssues(s: GravitySpec): string[] {
  const out: string[] = [];
  const L = GRAVITY_LIMITS;
  if (!(s.magnitude >= L.magnitude[0] && s.magnitude <= L.magnitude[1])) out.push('gravity.invalid.magnitude');
  if (!finiteVec(s.direction) || (s.global && s.magnitude > 0 && !(norm(s.direction) > 1e-6))) out.push('gravity.invalid.direction');
  if (!(s.duration >= L.duration[0] && s.duration <= L.duration[1])) out.push('gravity.invalid.duration');
  if (!GRAVITY_PROFILES.includes(s.profile)) out.push('gravity.invalid.profile');
  else out.push(...profileIssues(s));
  if (s.sources.length > L.sources) out.push('gravity.invalid.sources');
  if (!s.global && !s.sources.length) out.push('gravity.invalid.empty');
  for (const src of s.sources) {
    if (!finiteVec(src.center)) out.push('gravity.invalid.center');
    if (!(src.radius >= L.radius[0] && src.radius <= L.radius[1])) out.push('gravity.invalid.radius');
    if (src.edge !== undefined && !(src.edge >= 0 && src.edge <= src.radius)) out.push('gravity.invalid.edge');
    if (src.kind === 'region') {
      if (!finiteVec(src.accel)) out.push('gravity.invalid.accel');
      else if (norm(src.accel) > L.magnitude[1]) out.push('gravity.invalid.magnitude');
    } else {
      const S = src.strength ?? NaN, r0 = src.r0 ?? NaN, eps = src.softening ?? 0;
      if (!(S >= L.strength[0] && S <= L.strength[1])) out.push('gravity.invalid.strength');
      if (!(r0 > 0 && r0 <= src.radius)) out.push('gravity.invalid.r0');
      // The softening keeps the centre finite: |a| ≤ |S|·r0²/ε² ·(2/3√3) must stay within the magnitude limit.
      if (!(eps > 0 && eps <= src.radius)) out.push('gravity.invalid.softening');
      else if ((src.law ?? 'inverseSquare') === 'inverseSquare' && (Math.abs(S) * r0 * r0 * 0.3849) / (eps * eps) > L.magnitude[1]) out.push('gravity.invalid.core');
    }
  }
  return [...new Set(out)];
}

export function defaultGravitySpec(): GravitySpec {
  return {
    event: 'gravity', scenario: 'moon', global: true, magnitude: 1.62, direction: [0, -1, 0], transition: 'vector',
    profile: 'smooth', duration: 120, ramp: 10, end: 'restore', sources: [],
  };
}
