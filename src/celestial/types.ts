/**
 * Celestial-gravity experiment spec (Phase 32) — saved in the experiment plan (schema v7, validated per instance).
 * SI units: masses in kg, positions in world metres (y up), times in s on the experiment's local clock.
 *
 * Three layers, kept apart everywhere (docs/EXTREME_CELESTIAL.md §3):
 *  A  Newtonian gravity, COMPUTED: g = −G·M·r/r³ of each source (real G, real mass), potential, gradient tensor, tidal
 *     accelerations, orbits, escape, capture geometry, structural loads from the sampled field;
 *  B  educational reductions, DECLARED: the Plummer softening ε (finite centre), the capture radius (a model
 *     parameter, not the horizon), absorption of captured bodies, the visual accretion disc and lens effect, and the
 *     educational scale (a compact mass of 10¹²–10¹⁷ kg sized to the 200 m sandbox — not an astrophysical black hole);
 *  C  general relativity, NOT computed: horizon, GR orbits, time dilation, redshift, light bending, shadow, Hawking
 *     radiation, frame dragging, Kerr spin — shown as unsupported, never as a result. r_s = 2GM/c² is a reference value.
 *
 * Sources are held on prescribed paths (fixed, constant velocity or a user path): the bodies do not pull a source back
 * (no N-body) — the momentum a held source absorbs is booked as a constraint impulse (docs §22, §24, §25).
 */
import type { Vec3 } from '@/core/types';
import { C_LIGHT, G_N, schwarzschildRadius } from './constants';

export type CelestialScenario =
  | 'compactWell' | 'gentleOrbit' | 'circularOrbit' | 'ellipticalOrbit' | 'escape' | 'flyby' | 'tidalStretch' | 'tidalFailure'
  | 'capture' | 'growing' | 'moving' | 'binary' | 'accretion' | 'nearCity' | 'nearMountain' | 'nearLake' | 'meteor'
  | 'collapse' | 'stress' | 'comparison' | 'custom';
export const CELESTIAL_SCENARIOS: readonly CelestialScenario[] = [
  'compactWell', 'gentleOrbit', 'circularOrbit', 'ellipticalOrbit', 'escape', 'flyby', 'tidalStretch', 'tidalFailure',
  'capture', 'growing', 'moving', 'binary', 'accretion', 'nearCity', 'nearMountain', 'nearLake', 'meteor', 'collapse',
  'stress', 'comparison', 'custom',
];

/** physical: the mass is entered in SI (kg / Earth / Sun masses) — any value, limits enforced at run time;
 *  educational: the mass follows from a target acceleration at a reference distance (scaled to the sandbox). */
export type CelestialScale = 'physical' | 'educational';
export const CELESTIAL_SCALES: readonly CelestialScale[] = ['physical', 'educational'];
/** blackHole: a softened point mass with a capture radius; compact: the same field without capture. */
export type CelestialKind = 'blackHole' | 'compact';
export const CELESTIAL_KINDS: readonly CelestialKind[] = ['blackHole', 'compact'];
/** fixed: captured mass is stored apart (M constant); accumulate: stored and counted, M constant; grow: M += m. */
export type MassPolicy = 'fixed' | 'accumulate' | 'grow';
export const MASS_POLICIES: readonly MassPolicy[] = ['fixed', 'accumulate', 'grow'];
export type MotionKind = 'fixed' | 'velocity' | 'path';
export const MOTION_KINDS: readonly MotionKind[] = ['fixed', 'velocity', 'path'];
/** Initial speed of a probe body: circular / escape speed of the single-source field at its start, or custom. */
export type ProbeMode = 'circular' | 'escape' | 'custom';
export const PROBE_MODES: readonly ProbeMode[] = ['circular', 'escape', 'custom'];
/** At the model's numerical / physical limits: stop the run (physical mode default) or record and continue. */
export type LimitPolicy = 'stop' | 'warn';
export const LIMIT_POLICIES: readonly LimitPolicy[] = ['stop', 'warn'];

export interface CelestialSourceSpec {
  kind: CelestialKind;
  /** Position at the source's start (m). */
  center: Vec3;
  /** Mass (kg); μ = G·M. */
  mass: number;
  /** Plummer softening length ε (m): g = −μ·r/(r² + ε²)^{3/2} — finite centre, not a black hole's field inside ~ε. */
  softening: number;
  /** Capture radius (m, blackHole only) — an educational model parameter, not the Schwarzschild radius. */
  capture: number;
  /** Influence radius (m): 0 = unbounded (the true 1/r² tail); > 0 tapers the field to 0 over its outer 20 % (an
   *  educational cut, potential kept consistent). */
  influence: number;
  massPolicy: MassPolicy;
  motion: MotionKind;
  /** motion 'velocity' (m/s). */
  velocity?: Vec3;
  /** motion 'path': [local time s, x, y, z] waypoints, linear between them, held at the ends. */
  path?: [number, number, number, number][];
  /** Local start / end of this source in the experiment window (s; end defaults to the duration). */
  start?: number;
  end?: number;
  /** Mass ramp at the start (s, smootherstep; 0 = switched on at once). */
  ramp?: number;
  /** Educational mode: target |g| (m/s²) at the reference distance (m) the mass was derived from (editor). */
  refAccel?: number;
  refRadius?: number;
}

export interface ProbeSpec {
  /** Start position (m). */
  position: Vec3;
  mode: ProbeMode;
  /** Multiple of the circular / escape speed (e.g. 0.7 × circular → an ellipse inside, 1.3 × escape → hyperbolic). */
  factor: number;
  /** Direction of the initial velocity (projected perpendicular to the radius for 'circular'); its plane with the
   *  radius is the orbit plane. */
  direction: Vec3;
  /** custom: initial velocity (m/s). */
  velocity?: Vec3;
  /** Mass (kg) and radius (m) of the test sphere. */
  mass: number;
  radius: number;
  /** Index of the source the speeds refer to. */
  source?: number;
}

export interface AccretionSpec {
  /** Visual disc (illustrative: no fluid, viscosity or radiation computed). */
  visual: boolean;
  /** Physical test particles on Newtonian orbits (massless for the field; they collide only with the ground). */
  particles: number;
  /** Ring of the particles' initial circular orbits (m) around source `source`. */
  inner: number;
  outer: number;
  /** Mass of each particle (kg, booked on capture). */
  particleMass: number;
  /** Spread of the initial speeds below circular (0–0.5: speed × (1 − spread·u), u ∈ [0, 1) deterministic) —
   *  eccentric orbits that dive towards the source; 0 = exact circles (a ring that never accretes: no viscosity). */
  spread?: number;
  source?: number;
}

export interface CelestialSpec {
  event: 'celestial';
  scenario: CelestialScenario;
  scale: CelestialScale;
  sources: CelestialSourceSpec[];
  probes: ProbeSpec[];
  accretion: AccretionSpec;
  /** Experiment window (s). */
  duration: number;
  /** restore: the sources vanish when the window closes; hold: they stay. */
  end: 'restore' | 'hold';
  /** Structural response to the field's horizontal / differential part (storey forces, uplift check). */
  tidal: boolean;
  /** Illustrative lens distortion around the core (visual only — not relativistic ray tracing). */
  lensing: boolean;
  limitPolicy: LimitPolicy;
  startTime?: number;
  name?: string;
}

/** Numerical and physical limits (docs §19) — numerical safety and model validity are separate rows. */
export const CELESTIAL_LIMITS = {
  sources: 4,
  probes: 16,
  particles: 2000,
  duration: [1, 6 * 3600] as [number, number],
  /** Softening (m): below 5 cm the core needs more substeps than the cap at any useful mass. */
  softening: [0.05, 200] as [number, number],
  capture: [0, 100] as [number, number],
  influence: [5, 5000] as [number, number],
  /** Educational μ range (m³/s²) — g from ~0.01 to ~10⁴ m/s² at sandbox distances. */
  educationalMu: [1, 1e8] as [number, number],
  /** Physical mass range (kg) accepted by the editor (the run enforces the limits below). */
  mass: [1, 1e42] as [number, number],
  /** KDK substeps per 1/60 s step at most, and the step-size factor η (h ≤ η·τ). */
  substeps: 256,
  eta: 0.02,
  /** Newtonian validity: speeds below 0.1 c (Lorentz factor − 1 < 0.5 %); beyond, GR / SR effects are not small. */
  speed: 0.1 * C_LIGHT,
  /** Field and gradient magnitudes the structural / contact models are evaluated at most (m/s², 1/s²). */
  accel: 1e6,
  gradient: 1e5,
} as const;

const finiteVec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
const norm = (v: Readonly<Vec3>) => Math.hypot(v[0], v[1], v[2]);

/** Dynamical time τ(r) = (r² + ε²)^{3/4}/√μ of a softened point mass (s) — the substep scale near the source. */
export const dynamicalTime = (mu: number, r: number, eps: number) => (r * r + eps * eps) ** 0.75 / Math.sqrt(mu);
/** Peak acceleration of a Plummer field (at r = ε/√2): μ·2/(3√3)/ε². */
export const plummerPeak = (mu: number, eps: number) => (mu * 0.38490017945975050) / (eps * eps);

/** The innermost radius the integrator must resolve: the capture radius, or the centre without capture. */
export const resolvedRadius = (s: CelestialSourceSpec) => (s.kind === 'blackHole' ? s.capture : 0);

/**
 * Whether a source stays inside the numerical limits down to its resolved radius: substeps h = η·τ(r) within the cap
 * for a 1/60 s step, and the escape speed there below the Newtonian speed limit.
 */
export function sourceRegime(s: CelestialSourceSpec, dt = 1 / 60): { substeps: number; vEsc: number; peak: number; within: boolean; relativistic: boolean } {
  const L = CELESTIAL_LIMITS;
  const mu = G_N * s.mass;
  const r = resolvedRadius(s);
  const tau = dynamicalTime(mu, r, s.softening);
  const substeps = Math.ceil(dt / (L.eta * tau));
  const vEsc = Math.sqrt((2 * mu) / Math.sqrt(r * r + s.softening * s.softening));
  const peak = r <= s.softening / Math.SQRT2 ? plummerPeak(mu, s.softening) : (mu * r) / (r * r + s.softening * s.softening) ** 1.5;
  const relativistic = vEsc > L.speed;
  return { substeps, vEsc, peak, within: substeps <= L.substeps && !relativistic && peak <= L.accel, relativistic };
}

/** Validation problems (i18n keys), empty when valid. */
export function celestialIssues(s: CelestialSpec): string[] {
  const out: string[] = [];
  const L = CELESTIAL_LIMITS;
  if (!CELESTIAL_SCALES.includes(s.scale)) out.push('celestial.invalid.scale');
  if (!(s.duration >= L.duration[0] && s.duration <= L.duration[1])) out.push('celestial.invalid.duration');
  if (!s.sources.length) out.push('celestial.invalid.empty');
  if (s.sources.length > L.sources) out.push('celestial.invalid.sources');
  if (s.probes.length > L.probes) out.push('celestial.invalid.probes');
  for (const src of s.sources) {
    if (!finiteVec(src.center)) out.push('celestial.invalid.center');
    if (!(src.mass >= L.mass[0] && src.mass <= L.mass[1])) out.push('celestial.invalid.mass');
    const mu = G_N * src.mass;
    if (s.scale === 'educational' && !(mu >= L.educationalMu[0] && mu <= L.educationalMu[1])) out.push('celestial.invalid.mu');
    if (!(src.softening >= L.softening[0] && src.softening <= L.softening[1])) out.push('celestial.invalid.softening');
    if (!(src.capture >= L.capture[0] && src.capture <= L.capture[1])) out.push('celestial.invalid.capture');
    if (src.kind === 'blackHole' && !(src.capture > 0)) out.push('celestial.invalid.capture');
    if (!(src.influence === 0 || (src.influence >= L.influence[0] && src.influence <= L.influence[1]))) out.push('celestial.invalid.influence');
    if (src.influence > 0 && src.capture >= 0.8 * src.influence) out.push('celestial.invalid.influence');
    if (!MASS_POLICIES.includes(src.massPolicy)) out.push('celestial.invalid.massPolicy');
    if (src.motion === 'velocity' && !finiteVec(src.velocity)) out.push('celestial.invalid.velocity');
    if (src.motion === 'velocity' && finiteVec(src.velocity) && norm(src.velocity) > 200) out.push('celestial.invalid.velocity');
    if (src.motion === 'path') {
      const p = src.path ?? [];
      if (p.length < 2 || p.some((w) => w.length !== 4 || !w.every(Number.isFinite)) || p.some((w, k) => k > 0 && !(w[0] > p[k - 1][0]))) out.push('celestial.invalid.path');
    }
    const st = src.start ?? 0, en = src.end ?? s.duration;
    if (!(st >= 0 && en > st && en <= s.duration)) out.push('celestial.invalid.window');
    if (src.ramp !== undefined && !(src.ramp >= 0 && src.ramp <= en - st)) out.push('celestial.invalid.ramp');
    // Educational runs must stay inside the integrator's limits (a physical run is accepted and stopped / flagged by
    // its limit policy when a body reaches the unresolved region — the editor shows why).
    if (s.scale === 'educational' && !sourceRegime(src).within) out.push('celestial.invalid.core');
  }
  for (const p of s.probes) {
    if (!finiteVec(p.position) || !finiteVec(p.direction)) out.push('celestial.invalid.probe');
    if (!(p.mass > 0 && p.mass <= 1e6) || !(p.radius >= 0.1 && p.radius <= 10)) out.push('celestial.invalid.probe');
    if (!(p.factor >= 0 && p.factor <= 10)) out.push('celestial.invalid.probe');
    if (p.mode === 'custom' && !finiteVec(p.velocity)) out.push('celestial.invalid.probe');
    if (p.mode !== 'custom' && !(norm(p.direction) > 1e-6)) out.push('celestial.invalid.probe');
    if ((p.source ?? 0) >= s.sources.length) out.push('celestial.invalid.probe');
  }
  const a = s.accretion;
  if (!(a.particles >= 0 && a.particles <= L.particles && Number.isInteger(a.particles))) out.push('celestial.invalid.particles');
  if (a.particles > 0 && !(a.inner > 0 && a.outer > a.inner && a.particleMass > 0)) out.push('celestial.invalid.accretion');
  if (a.spread !== undefined && !(a.spread >= 0 && a.spread <= 0.5)) out.push('celestial.invalid.accretion');
  if ((a.source ?? 0) >= Math.max(1, s.sources.length)) out.push('celestial.invalid.accretion');
  return [...new Set(out)];
}

/** Mass giving |g| = a at distance r from a softened point mass: a = μ·r/(r² + ε²)^{3/2}. */
export function massForAccel(a: number, r: number, eps: number): number {
  return (a * (r * r + eps * eps) ** 1.5) / r / G_N;
}

/** Reference values of a source for display: μ, r_s (reference), peak acceleration. */
export function sourceFacts(s: CelestialSourceSpec) {
  const mu = G_N * s.mass;
  return { mu, rs: schwarzschildRadius(s.mass), peak: plummerPeak(mu, s.softening) };
}

export function defaultSource(): CelestialSourceSpec {
  // 7.49·10¹⁴ kg (μ = 5·10⁴ m³/s²): |g| ≈ 20 m/s² at 50 m — an educational compact mass.
  return { kind: 'blackHole', center: [0, 30, 0], mass: 5e4 / G_N, softening: 2, capture: 1.5, influence: 0, massPolicy: 'fixed', motion: 'fixed', ramp: 2 };
}

export function defaultCelestialSpec(): CelestialSpec {
  return {
    event: 'celestial', scenario: 'compactWell', scale: 'educational', sources: [defaultSource()], probes: [],
    accretion: { visual: true, particles: 0, inner: 6, outer: 20, particleMass: 1 }, duration: 120, end: 'restore',
    tidal: true, lensing: false, limitPolicy: 'warn',
  };
}
