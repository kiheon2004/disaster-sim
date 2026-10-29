/**
 * The gravity field of a run (Phase 31): g(x, t) from the project gravity and the gravity experiments — pure (no
 * physics engine, no rendering), deterministic and independent of the order experiments / sources were created in.
 *
 * Composition (§7 of docs/VARIABLE_GRAVITY.md):
 *  1. global G(t): the project gravity G₀, REPLACED by the global part of the most recently started experiment whose
 *     window is open (ties: canonical spec order). An experiment runs from the global vector in force just before it
 *     started (frozen at its start — the field is continuous) to its target; restore lets the field fall back to
 *     what the other experiments give after the window, hold keeps the end value.
 *  2. local sources of every open experiment, ADDED in a canonical order (sorted by their parameters — creation order
 *     never changes a floating-point sum); 'replace' regions are applied after the additions, also canonically.
 *
 * `prepare(t)` evaluates every time-dependent scalar once per step; `sample` is then allocation-free. Without local
 * sources the field is uniform (`uniform` = true) and `sample` returns G — the fast path of every solver.
 *
 * Potential Φ (g = −∇Φ) exists for the global part (Φ = −G·x) and for radial sources (central fields); a region source
 * is not curl-free at its edge, so with one active `potentialDefined` is false and no potential is invented — the
 * energy ledger then books the path work of gravity only.
 *
 * Phase 32: celestial point sources (softened point masses of real mass, `points`, celestial/point.ts) are ADDED after
 * the whole Phase 31 composition (g_total = g_Phase31 + Σ g_c, docs/EXTREME_CELESTIAL.md §8); they are conservative
 * (their Φ is added to the potential) and their gradient is analytic. Without a celestial experiment nothing of this
 * path runs (every Phase 31 result unchanged).
 */
import type { Vec3 } from '@/core/types';
import { PointField } from '@/celestial/point';
import type { CelestialSpec } from '@/celestial/types';
import { blendAt, smoother } from './profiles';
import type { GravitySourceSpec, GravitySpec } from './types';

export interface GravityExperiment {
  id: string;
  spec: GravitySpec;
  /** Absolute start time (s). */
  start: number;
}

/** A prepared local source (strength factor of this step included). */
interface Live {
  src: GravitySourceSpec;
  /** Profile / window factor of this step. */
  f: number;
  /** Region vector × f, or radial strength × f. */
  ax: number; ay: number; az: number;
  S: number;
  R: number; R2: number; edge: number; inner: number;
  r0: number; eps2: number;
  law: number;
  shape: number;
  replace: boolean;
  falloff: number;
  /** Radial: ∫ of a·w over the tapered edge (potential offset), per unit strength. */
  edgeInt: number;
  cx: number; cy: number; cz: number;
  /** Experiment index (attribution). */
  owner: number;
  key: string;
}

const LAW = { inverseSquare: 0, linear: 1, constant: 2 } as const;
const FALL = { none: 0, linear: 1, smooth: 2 } as const;

/** Taper weight of a distance d inside radius R with an edge of width e (1 inside, 0 outside). */
function taper(falloff: number, d: number, R: number, e: number): number {
  if (d >= R) return 0;
  if (falloff === 0 || e <= 0 || d <= R - e) return 1;
  const x = (R - d) / e;
  return falloff === 1 ? x : smoother(x);
}

/** Radial law magnitude a(r) per unit strength (attraction > 0). */
function lawA(law: number, r: number, r0: number, eps2: number): number {
  if (law === 0) { const q = r * r + eps2; return (r0 * r0 * r) / (q * Math.sqrt(q)); }
  if (law === 1) return r / r0;
  return r / Math.sqrt(r * r + eps2);
}

/** Antiderivative of a(r) per unit strength. */
function lawInt(law: number, r: number, r0: number, eps2: number): number {
  if (law === 0) return -(r0 * r0) / Math.sqrt(r * r + eps2);
  if (law === 1) return (r * r) / (2 * r0);
  return Math.sqrt(r * r + eps2);
}

/** ∫ₐᵇ a(r)·w(r) dr by composite Simpson (the taper is smooth on the edge). */
function edgeIntegral(l: Live, a: number, b: number): number {
  if (b <= a) return 0;
  const n = 32, h = (b - a) / n;
  let s = 0;
  for (let k = 0; k <= n; k++) {
    const r = a + k * h;
    const v = lawA(l.law, r, l.r0, l.eps2) * taper(l.falloff, r, l.R, l.edge);
    s += (k === 0 || k === n ? 1 : k % 2 ? 4 : 2) * v;
  }
  return (s * h) / 3;
}

const canonCache = new WeakMap<GravitySourceSpec, string>();
const canon = (s: GravitySourceSpec): string => {
  let k = canonCache.get(s);
  if (k === undefined) canonCache.set(s, (k = canonKey(s)));
  return k;
};
const canonKey = (s: GravitySourceSpec) => JSON.stringify([s.kind, s.center, s.radius, s.edge ?? -1, s.falloff, s.shape ?? '', s.mode ?? '', s.accel ?? [], s.strength ?? 0, s.r0 ?? 0, s.law ?? '', s.softening ?? 0, s.followProfile ? 1 : 0]);
const specKey = (e: GravityExperiment) => JSON.stringify([e.spec.global, e.spec.magnitude, e.spec.direction, e.spec.transition, e.spec.profile, e.spec.duration, e.spec.ramp ?? 0, e.spec.stages ?? [], e.spec.period ?? 0, e.spec.pulseWidth ?? 0, e.spec.windows ?? [], e.spec.end, e.spec.sources.map(canon)]);

/** Unit vector of a direction (down when degenerate). */
export function unit(v: Readonly<Vec3>, out: Vec3 = [0, 0, 0]): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]);
  if (!(n > 1e-12)) { out[0] = 0; out[1] = -1; out[2] = 0; return out; }
  out[0] = v[0] / n; out[1] = v[1] / n; out[2] = v[2] / n;
  return out;
}

/** Global vector of an experiment at blend s, from `from` (frozen at its start) to its target. */
export function globalVector(spec: GravitySpec, from: Readonly<Vec3>, s: number, out: Vec3): Vec3 {
  const d = unit(spec.direction);
  const tx = spec.magnitude * d[0], ty = spec.magnitude * d[1], tz = spec.magnitude * d[2];
  if (spec.transition === 'vector') {
    out[0] = from[0] + s * (tx - from[0]);
    out[1] = from[1] + s * (ty - from[1]);
    out[2] = from[2] + s * (tz - from[2]);
    return out;
  }
  // rotate: magnitude interpolated, direction along the great circle (slerp; s outside [0, 1] extrapolates the angle).
  const m0 = Math.hypot(from[0], from[1], from[2]);
  const m = m0 + s * (spec.magnitude - m0);
  if (!(m0 > 1e-12) || !(spec.magnitude > 1e-12)) return globalVector({ ...spec, transition: 'vector' }, from, s, out);
  const ax = from[0] / m0, ay = from[1] / m0, az = from[2] / m0;
  const c = Math.max(-1, Math.min(1, ax * d[0] + ay * d[1] + az * d[2]));
  const th = Math.acos(c);
  if (th < 1e-9) { out[0] = m * ax; out[1] = m * ay; out[2] = m * az; return out; }
  // Axis-free slerp needs a perpendicular: antiparallel vectors turn through the horizontal x axis (or z when along x).
  let px = d[0] - c * ax, py = d[1] - c * ay, pz = d[2] - c * az;
  let pn = Math.hypot(px, py, pz);
  if (pn < 1e-9) {
    const hx = Math.abs(ax) < 0.9 ? 1 : 0, hz = 1 - hx;
    const k = hx * ax + hz * az;
    px = hx - k * ax; py = -k * ay; pz = hz - k * az;
    pn = Math.hypot(px, py, pz);
  }
  px /= pn; py /= pn; pz /= pn;
  const a = s * th, ca = Math.cos(a), sa = Math.sin(a);
  out[0] = m * (ca * ax + sa * px);
  out[1] = m * (ca * ay + sa * py);
  out[2] = m * (ca * az + sa * pz);
  return out;
}

/** Blend of an experiment at absolute time t (null = not in force). Restore with a ramp profile ramps back at the end. */
export function experimentBlend(e: GravityExperiment, t: number): number | null {
  const s = e.spec;
  const local = t - e.start;
  if (local < 0) return null;
  if (local >= s.duration) {
    if (s.end === 'restore') return null;
    return blendAt(s, s.duration);
  }
  const b = blendAt(s, local);
  // restore + linear / smooth: symmetric trapezoid — the field returns along the same ramp before the window closes.
  if (s.end === 'restore' && (s.profile === 'linear' || s.profile === 'smooth')) {
    const r = Math.min(s.ramp ?? 0, s.duration / 2);
    if (r > 0 && local > s.duration - r) {
      const x = (s.duration - local) / r;
      return Math.min(b, s.profile === 'linear' ? x : smoother(x));
    }
  }
  return b;
}

/** A celestial experiment registered with the field (Phase 32). */
export interface CelestialExperiment {
  id: string;
  spec: CelestialSpec;
  start: number;
}

export interface GravityAttribution {
  /** Index of the experiment that sets the global part (−1 = project gravity). */
  global: number;
  /** Bit mask of the experiments whose local sources act at the sample (first 31). */
  local: number;
}

export class GravityField {
  /** Project gravity (m/s², the baseline G₀ = (0, −g0, 0)). */
  readonly g0: number;
  readonly experiments: GravityExperiment[] = [];
  /** Global vector of this step. */
  readonly G: Vec3;
  /** Time the field was prepared for. */
  time = -Infinity;
  /** No local source in force — g(x) = G everywhere. */
  uniform = true;
  /** Φ exists (no region source in force). */
  potentialDefined = true;
  /** Index (in `sorted`) of the experiment setting the global part, −1 = none. */
  globalOwner = -1;
  /** Bumped when the set of experiments changes. */
  rev = 0;
  private sorted: GravityExperiment[] = [];
  private from: Vec3[] = [];
  private live: Live[] = [];
  private nLive = 0;
  private adds: Live[] = [];
  private replaces: Live[] = [];
  private tmp: Vec3 = [0, 0, 0];
  /** Celestial point sources (Phase 32) and their experiments in canonical order (start, then parameters). */
  readonly points = new PointField();
  celestial: CelestialExperiment[] = [];

  constructor(g0: number) {
    this.g0 = g0;
    this.G = [0, -g0, 0];
  }

  /** Register an experiment (any order: the field sorts canonically). */
  add(e: GravityExperiment) {
    this.experiments.push(e);
    this.sorted = [...this.experiments].sort((a, b) => a.start - b.start || (specKey(a) < specKey(b) ? -1 : specKey(a) > specKey(b) ? 1 : 0));
    // Start vectors: the global vector in force just before each experiment begins (sequentially, by start).
    this.from = [];
    for (let k = 0; k < this.sorted.length; k++) this.from.push(this.globalAt(this.sorted[k].start, k));
    this.rev++;
    this.time = -Infinity;
  }

  /** Global vector at time t using only the first `upto` sorted experiments (their start vectors are known). */
  private globalAt(t: number, upto: number): Vec3 {
    for (let k = upto - 1; k >= 0; k--) {
      const e = this.sorted[k];
      if (!e.spec.global) continue;
      const b = experimentBlend(e, t);
      if (b === null) continue;
      return globalVector(e.spec, this.from[k], b, [0, 0, 0]);
    }
    return [0, -this.g0, 0];
  }

  /**
   * Register a celestial experiment (Phase 32; any order — the sources are re-registered in a canonical order, the
   * mass already captured by a growing source is kept).
   */
  addCelestial(e: CelestialExperiment) {
    const grown = new Map(this.points.entries.map((x) => [x.key, x.grown]));
    this.celestial = [...this.celestial, e].sort((a, b) => a.start - b.start || (JSON.stringify(a.spec) < JSON.stringify(b.spec) ? -1 : JSON.stringify(a.spec) > JSON.stringify(b.spec) ? 1 : 0));
    this.points.entries.length = 0;
    this.celestial.forEach((x, k) => this.points.add(x.spec, x.start, k));
    for (const x of this.points.entries) x.grown = grown.get(x.key) ?? 0;
    this.rev++;
    this.time = -Infinity;
  }

  /** Index (canonical order) of an experiment. */
  indexOf(id: string): number {
    return this.sorted.findIndex((e) => e.id === id);
  }

  get canonical(): readonly GravityExperiment[] {
    return this.sorted;
  }

  /** Evaluate the time-dependent part for time t (idempotent within a step). */
  prepare(t: number): this {
    if (t === this.time) return this;
    this.time = t;
    const G = this.G;
    G[0] = 0; G[1] = -this.g0; G[2] = 0;
    this.globalOwner = -1;
    for (let k = this.sorted.length - 1; k >= 0; k--) {
      const e = this.sorted[k];
      if (!e.spec.global) continue;
      const b = experimentBlend(e, t);
      if (b === null) continue;
      globalVector(e.spec, this.from[k], b, G);
      this.globalOwner = k;
      break;
    }
    this.nLive = 0;
    this.adds.length = 0;
    this.replaces.length = 0;
    for (let k = 0; k < this.sorted.length; k++) {
      const e = this.sorted[k];
      if (!e.spec.sources.length) continue;
      const b = experimentBlend(e, t);
      if (b === null) continue;
      for (const src of e.spec.sources) {
        const f = src.followProfile ? b : 1;
        if (f === 0) continue;
        const l = this.slot();
        this.fill(l, src, f, k);
        (l.replace ? this.replaces : this.adds).push(l);
      }
    }
    const byKey = (a: Live, b: Live) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.owner - b.owner);
    this.adds.sort(byKey);
    this.replaces.sort(byKey);
    this.points.prepare(t);
    this.uniform = this.nLive === 0 && this.points.live.length === 0;
    this.potentialDefined = this.adds.every((l) => l.src.kind === 'radial') && this.replaces.length === 0;
    return this;
  }

  private slot(): Live {
    if (this.nLive === this.live.length) this.live.push({} as Live);
    return this.live[this.nLive++];
  }

  private fill(l: Live, src: GravitySourceSpec, f: number, owner: number) {
    l.src = src; l.f = f; l.owner = owner; l.key = canon(src);
    l.cx = src.center[0]; l.cy = src.center[1]; l.cz = src.center[2];
    l.R = src.radius; l.R2 = src.radius * src.radius;
    l.falloff = FALL[src.falloff];
    l.edge = l.falloff === 0 ? 0 : Math.min(src.radius, src.edge ?? 0.2 * src.radius);
    l.inner = l.R - l.edge;
    l.shape = src.shape === 'column' ? 1 : 0;
    l.replace = src.kind === 'region' && src.mode === 'replace';
    if (src.kind === 'region') {
      const a = src.accel ?? [0, 0, 0];
      l.ax = a[0] * (l.replace ? 1 : f); l.ay = a[1] * (l.replace ? 1 : f); l.az = a[2] * (l.replace ? 1 : f);
      l.S = 0; l.law = 0; l.r0 = 1; l.eps2 = 0; l.edgeInt = 0;
    } else {
      l.ax = l.ay = l.az = 0;
      l.S = (src.strength ?? 0) * f;
      l.law = LAW[src.law ?? 'inverseSquare'];
      l.r0 = src.r0 ?? 1;
      l.eps2 = (src.softening ?? 0) ** 2;
      l.edgeInt = edgeIntegral(l, l.inner, l.R);
    }
  }

  /** g at a point (m/s², written into out). Attribution of the sources acting there, if asked. */
  sample(x: number, y: number, z: number, out: Vec3, attr?: GravityAttribution): Vec3 {
    this.sampleBase(x, y, z, out, attr);
    if (this.points.live.length) this.points.addSample(x, y, z, out);
    return out;
  }

  /** g of the Phase 31 part only (global + local sources, without the celestial point sources). */
  sampleBase(x: number, y: number, z: number, out: Vec3, attr?: GravityAttribution): Vec3 {
    out[0] = this.G[0]; out[1] = this.G[1]; out[2] = this.G[2];
    if (attr) { attr.global = this.globalOwner; attr.local = 0; }
    if (this.nLive === 0) return out;
    for (let k = 0; k < this.adds.length; k++) {
      const l = this.adds[k];
      const dx = x - l.cx, dy = l.shape === 1 ? 0 : y - l.cy, dz = z - l.cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= l.R2) continue;
      const d = Math.sqrt(d2);
      const w = taper(l.falloff, d, l.R, l.edge);
      if (w === 0) continue;
      if (attr && l.owner < 31) attr.local |= 1 << l.owner;
      if (l.src.kind === 'region') { out[0] += w * l.ax; out[1] += w * l.ay; out[2] += w * l.az; continue; }
      if (d < 1e-12) continue;
      const a = (l.S * w * lawA(l.law, d, l.r0, l.eps2)) / d;
      out[0] -= a * dx; out[1] -= a * dy; out[2] -= a * dz;
    }
    for (let k = 0; k < this.replaces.length; k++) {
      const l = this.replaces[k];
      const dx = x - l.cx, dy = l.shape === 1 ? 0 : y - l.cy, dz = z - l.cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= l.R2) continue;
      const w = taper(l.falloff, Math.sqrt(d2), l.R, l.edge) * l.f;
      if (w === 0) continue;
      if (attr && l.owner < 31) attr.local |= 1 << l.owner;
      out[0] += w * (l.ax - out[0]); out[1] += w * (l.ay - out[1]); out[2] += w * (l.az - out[2]);
    }
    return out;
  }

  /** Whether a point lies inside a local source's radius (affected objects, overlays; celestial sources reach
   *  everywhere they are in force). */
  inSource(x: number, y: number, z: number): boolean {
    if (this.uniform) return false;
    if (this.points.live.length) return true;
    for (const l of this.adds) if (this.inside(l, x, y, z)) return true;
    for (const l of this.replaces) if (this.inside(l, x, y, z)) return true;
    return false;
  }

  private inside(l: Live, x: number, y: number, z: number) {
    const dx = x - l.cx, dy = l.shape === 1 ? 0 : y - l.cy, dz = z - l.cz;
    return dx * dx + dy * dy + dz * dz < l.R2;
  }

  /**
   * Potential Φ at a point (J/kg, g = −∇Φ; NaN when not defined — a region source acts). Gauge: Φ = −G·x for the
   * global part, 0 at and beyond a radial source's cut-off radius.
   */
  potential(x: number, y: number, z: number): number {
    if (!this.potentialDefined) return NaN;
    let phi = -(this.G[0] * x + this.G[1] * y + this.G[2] * z);
    for (let k = 0; k < this.adds.length; k++) {
      const l = this.adds[k];
      const dx = x - l.cx, dy = y - l.cy, dz = z - l.cz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d >= l.R) continue;
      // Φ(r) = −∫_r^R S·a·w dr'.
      const I = d >= l.inner ? edgeIntegral(l, d, l.R) : lawInt(l.law, l.inner, l.r0, l.eps2) - lawInt(l.law, d, l.r0, l.eps2) + l.edgeInt;
      phi -= l.S * I;
    }
    if (this.points.live.length) phi += this.points.potential(x, y, z);
    return phi;
  }

  /**
   * Gravity gradient ∂g_i/∂x_j at a point — row-major 3×3 into out: central differences (h m) of the Phase 31 local
   * sources (0 for a uniform field) plus the analytic tensor of the celestial point sources (Phase 32).
   */
  gradient(x: number, y: number, z: number, out: Float64Array | number[] = new Float64Array(9), h = 0.05): Float64Array | number[] {
    for (let i = 0; i < 9; i++) out[i] = 0;
    if (this.nLive > 0) {
      const a = this.tmp, b: Vec3 = [0, 0, 0];
      for (let j = 0; j < 3; j++) {
        this.sampleBase(x + (j === 0 ? h : 0), y + (j === 1 ? h : 0), z + (j === 2 ? h : 0), a);
        this.sampleBase(x - (j === 0 ? h : 0), y - (j === 1 ? h : 0), z - (j === 2 ? h : 0), b);
        for (let i = 0; i < 3; i++) out[3 * i + j] = (a[i] - b[i]) / (2 * h);
      }
    }
    if (this.points.live.length) this.points.addGradient(x, y, z, out);
    return out;
  }

  /** Tidal acceleration of a point at offset d from x relative to x: g(x + d) − g(x) (Phase 32 interface). */
  tidal(x: Readonly<Vec3>, d: Readonly<Vec3>, out: Vec3): Vec3 {
    const g1: Vec3 = [0, 0, 0];
    this.sample(x[0] + d[0], x[1] + d[1], x[2] + d[2], out);
    this.sample(x[0], x[1], x[2], g1);
    out[0] -= g1[0]; out[1] -= g1[1]; out[2] -= g1[2];
    return out;
  }

  /** Active local sources of this step (overlays / preview). */
  liveSources(): readonly { src: GravitySourceSpec; f: number; owner: number }[] {
    return [...this.adds, ...this.replaces];
  }

  /** Largest |g| in the experiments' plans (preview / validation; local sources bounded by their peak). */
  get magnitude(): number {
    return Math.hypot(this.G[0], this.G[1], this.G[2]);
  }
}

/** Ground-normal component g_n = −g·ŷ (positive presses onto a horizontal ground) and the horizontal part. */
export function groundComponents(g: Readonly<Vec3>): { gn: number; gx: number; gz: number } {
  return { gn: -g[1], gx: g[0], gz: g[2] };
}
