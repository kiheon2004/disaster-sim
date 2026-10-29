/**
 * Field of the celestial point sources (Phase 32) — pure, allocation-free per sample, deterministic and independent of
 * the order the sources were created in (they are summed in a canonical order of their parameters).
 *
 * Per source (μ = G·M, ε softening, w(r) the optional influence taper — 1 when unbounded):
 *   g(x)   = −μ·w(r)·r⃗/(r² + ε²)^{3/2}                       (Plummer; ε = 0 is the Newtonian point mass)
 *   Φ(r)   = −μ/√(r² + ε²)                     unbounded       (g = −∇Φ, Φ → 0 at infinity)
 *            −∫_r^∞ a(r′)·w(r′) dr′             tapered         (closed form inside the taper, Simpson on the edge)
 *   T_ij   = ∂g_i/∂x_j = μ·w·(3·r_i·r_j/q^{5/2} − δ_ij/q^{3/2}) + g_i·w′(r)·r_j/(r·w)     (analytic, q = r² + ε²)
 * The trace of T is −μ·3ε²/q^{5/2} (Poisson: −4πGρ of the Plummer sphere's density) and 0 for ε = 0 away from the
 * centre — a test of the tensor independent of its formula.
 *
 * Sources are held on prescribed paths; the field of a step is frozen at the step's time (one sample time per step,
 * as the Phase 31 field) — a moving source changes Φ between steps, booked as the work of the changing field.
 */
import type { Vec3 } from '@/core/types';
import { G_N } from './constants';
import type { CelestialSourceSpec, CelestialSpec } from './types';

/** smootherstep and its derivative. */
const sm = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (6 * x - 15) + 10));
const dsm = (x: number) => (x <= 0 || x >= 1 ? 0 : 30 * x * x * (x - 1) * (x - 1));

/** A prepared source of this step. */
export interface PointLive {
  /** Experiment index (canonical order) and source index inside it. */
  owner: number;
  index: number;
  spec: CelestialSourceSpec;
  /** Centre (m), velocity of the prescribed motion (m/s). */
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** μ of this step (m³/s²: (M₀ + grown)·G × ramp), ε², influence radius / inner taper radius (Infinity unbounded). */
  mu: number;
  eps2: number;
  R: number;
  inner: number;
  /** ∫ over the taper of a·w per unit μ (potential offset). */
  edgeInt: number;
  /** Capture radius² (0 = none). */
  cap2: number;
  key: string;
}

export interface PointEntry {
  owner: number;
  index: number;
  spec: CelestialSourceSpec;
  /** Absolute start of the experiment and window [start + s.start, start + s.end); hold keeps the source after it. */
  t0: number;
  on: number;
  off: number;
  hold: boolean;
  /** Mass added by captures (kg, grow policy) — runtime state, reset with the run. */
  grown: number;
  key: string;
}

const keyOf = (s: CelestialSourceSpec, t0: number) => JSON.stringify([t0, s.kind, s.center, s.mass, s.softening, s.capture, s.influence, s.massPolicy, s.motion, s.velocity ?? [], s.path ?? [], s.start ?? 0, s.end ?? -1, s.ramp ?? 0]);

/** Position of a prescribed motion at local time τ since the source's start (m) and its velocity (a path starts at
 *  its first waypoint — `center` is not used by it). */
export function motionAt(s: CelestialSourceSpec, tau: number, out: Vec3, vel?: Vec3): Vec3 {
  if (s.motion === 'velocity' && s.velocity) {
    const v = s.velocity;
    out[0] = s.center[0] + v[0] * tau; out[1] = s.center[1] + v[1] * tau; out[2] = s.center[2] + v[2] * tau;
    if (vel) { vel[0] = v[0]; vel[1] = v[1]; vel[2] = v[2]; }
    return out;
  }
  if (s.motion === 'path' && s.path && s.path.length >= 2) {
    const p = s.path;
    let k = 0;
    while (k < p.length - 2 && tau >= p[k + 1][0]) k++;
    const a = p[k], b = p[k + 1];
    const u = Math.max(0, Math.min(1, (tau - a[0]) / (b[0] - a[0])));
    out[0] = a[1] + u * (b[1] - a[1]); out[1] = a[2] + u * (b[2] - a[2]); out[2] = a[3] + u * (b[3] - a[3]);
    if (vel) {
      // Held before the first and after the last waypoint (velocity 0 there).
      const d = tau >= a[0] && tau < b[0] ? 1 / (b[0] - a[0]) : 0;
      vel[0] = (b[1] - a[1]) * d; vel[1] = (b[2] - a[2]) * d; vel[2] = (b[3] - a[3]) * d;
    }
    return out;
  }
  out[0] = s.center[0]; out[1] = s.center[1]; out[2] = s.center[2];
  if (vel) { vel[0] = 0; vel[1] = 0; vel[2] = 0; }
  return out;
}

/** a(r)·w(r) per unit μ (radial magnitude). */
function aw(r: number, eps2: number, R: number, inner: number): number {
  const q = r * r + eps2;
  const a = r / (q * Math.sqrt(q));
  if (r <= inner) return a;
  if (r >= R) return 0;
  return a * sm((R - r) / (R - inner));
}

/** ∫ₐᵇ a·w dr per unit μ, composite Simpson (128 panels; the taper is C² on the edge). */
function edgeIntegral(a: number, b: number, eps2: number, R: number, inner: number): number {
  if (b <= a) return 0;
  const n = 128, h = (b - a) / n;
  let s = 0;
  for (let k = 0; k <= n; k++) s += (k === 0 || k === n ? 1 : k % 2 ? 4 : 2) * aw(a + k * h, eps2, R, inner);
  return (s * h) / 3;
}

export class PointField {
  readonly entries: PointEntry[] = [];
  /** Sources in force this step (canonical order). */
  readonly live: PointLive[] = [];
  private pool: PointLive[] = [];
  time = -Infinity;
  /** Bumped whenever the live sources change (prepare, growth) — the key of field caches (Phase 32.1). */
  epoch = 0;
  private readonly tmp: Vec3 = [0, 0, 0];
  private readonly vtmp: Vec3 = [0, 0, 0];

  /** Register the sources of an experiment (index `owner` in the caller's canonical order). */
  add(spec: CelestialSpec, t0: number, owner: number) {
    spec.sources.forEach((s, index) => {
      this.entries.push({ owner, index, spec: s, t0, on: t0 + (s.start ?? 0), off: t0 + (s.end ?? spec.duration), hold: spec.end === 'hold', grown: 0, key: keyOf(s, t0) });
    });
    this.entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.owner - b.owner || a.index - b.index));
    this.time = -Infinity;
  }

  get empty(): boolean {
    return this.entries.length === 0;
  }

  /** Evaluate positions and μ for time t (idempotent within a step). */
  prepare(t: number): this {
    if (t === this.time) return this;
    this.time = t;
    this.epoch++;
    this.live.length = 0;
    let n = 0;
    for (const e of this.entries) {
      if (t < e.on || (!e.hold && t >= e.off)) continue;
      const s = e.spec;
      const tau = Math.min(t, e.hold ? Infinity : e.off) - e.on;
      const ramp = s.ramp ?? 0;
      const f = ramp > 0 ? sm(tau / ramp) : 1;
      if (f === 0) continue;
      const l = (this.pool[n] ??= {} as PointLive);
      n++;
      motionAt(s, tau, this.tmp, this.vtmp);
      // After a held source's path ends it stays where it is (the velocity of a hold beyond `off` is 0).
      const moving = e.hold && t >= e.off ? 0 : 1;
      l.owner = e.owner; l.index = e.index; l.spec = s; l.key = e.key;
      l.x = this.tmp[0]; l.y = this.tmp[1]; l.z = this.tmp[2];
      l.vx = this.vtmp[0] * moving; l.vy = this.vtmp[1] * moving; l.vz = this.vtmp[2] * moving;
      l.mu = G_N * (s.mass + e.grown) * f;
      l.eps2 = s.softening * s.softening;
      l.R = s.influence > 0 ? s.influence : Infinity;
      l.inner = s.influence > 0 ? 0.8 * s.influence : Infinity;
      l.edgeInt = s.influence > 0 ? edgeIntegral(l.inner, l.R, l.eps2, l.R, l.inner) : 0;
      l.cap2 = s.kind === 'blackHole' ? s.capture * s.capture : 0;
      this.live.push(l);
    }
    return this;
  }

  /** Mass captured into a 'grow' source (kg): μ follows at once (the field of the rest of this step included). */
  grow(owner: number, index: number, m: number) {
    const e = this.entries.find((x) => x.owner === owner && x.index === index);
    if (!e) return;
    e.grown += m;
    this.epoch++;
    const l = this.live.find((x) => x.owner === owner && x.index === index);
    if (l) l.mu = (l.mu / (G_N * (e.spec.mass + e.grown - m))) * G_N * (e.spec.mass + e.grown);
  }

  /** Current mass of a source (kg, without the ramp). */
  massOf(owner: number, index: number): number {
    const e = this.entries.find((x) => x.owner === owner && x.index === index);
    return e ? e.spec.mass + e.grown : NaN;
  }

  /** Adds Σ g of the live sources at a point into out (m/s²). */
  addSample(x: number, y: number, z: number, out: Vec3): Vec3 {
    for (let k = 0; k < this.live.length; k++) {
      const l = this.live[k];
      const dx = x - l.x, dy = y - l.y, dz = z - l.z;
      const r2 = dx * dx + dy * dy + dz * dz;
      if (r2 >= l.R * l.R) continue;
      const q = r2 + l.eps2;
      if (!(q > 0)) continue;
      let a = l.mu / (q * Math.sqrt(q));
      if (r2 > l.inner * l.inner) a *= sm((l.R - Math.sqrt(r2)) / (l.R - l.inner));
      out[0] -= a * dx; out[1] -= a * dy; out[2] -= a * dz;
    }
    return out;
  }

  /** Σ Φ of the live sources (J/kg, 0 at infinity / beyond the influence radius). */
  potential(x: number, y: number, z: number): number {
    let phi = 0;
    for (let k = 0; k < this.live.length; k++) {
      const l = this.live[k];
      const dx = x - l.x, dy = y - l.y, dz = z - l.z;
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (r >= l.R) continue;
      if (l.R === Infinity) { phi -= l.mu / Math.sqrt(r * r + l.eps2); continue; }
      const I = r >= l.inner
        ? edgeIntegral(r, l.R, l.eps2, l.R, l.inner)
        : 1 / Math.sqrt(r * r + l.eps2) - 1 / Math.sqrt(l.inner * l.inner + l.eps2) + l.edgeInt;
      phi -= l.mu * I;
    }
    return phi;
  }

  /** Adds Σ T_ij (∂g_i/∂x_j, row-major 3×3, 1/s²) of the live sources into out. */
  addGradient(x: number, y: number, z: number, out: Float64Array | number[]): Float64Array | number[] {
    for (let k = 0; k < this.live.length; k++) {
      const l = this.live[k];
      const d0 = x - l.x, d1 = y - l.y, d2 = z - l.z;
      const r2 = d0 * d0 + d1 * d1 + d2 * d2;
      if (r2 >= l.R * l.R) continue;
      const q = r2 + l.eps2;
      if (!(q > 0)) continue;
      const q32 = q * Math.sqrt(q), q52 = q32 * q;
      let w = 1, dw = 0;
      if (r2 > l.inner * l.inner) {
        const r = Math.sqrt(r2), e = l.R - l.inner, u = (l.R - r) / e;
        w = sm(u);
        dw = -dsm(u) / e / r; // w′(r)/r
      }
      const d = [d0, d1, d2];
      for (let i = 0; i < 3; i++) {
        const gi = (-l.mu * d[i]) / q32; // untapered g_i
        for (let j = 0; j < 3; j++) {
          out[3 * i + j] += l.mu * w * ((3 * d[i] * d[j]) / q52 - (i === j ? 1 / q32 : 0)) + gi * dw * d[j];
        }
      }
    }
    return out;
  }

  /**
   * Shortest dynamical time scale on the straight segment x + v·s, s ∈ [0, dt] (s): per source, at the segment's
   * closest approach (q = r² + ε²), min(q^{3/4}/√μ, √q/|v|) — the free-fall / orbital time and the time the body takes
   * to cross the region where the field turns. The field is frozen in a step, so v is the body's own velocity.
   * Infinity without sources (the uniform part needs no substeps: KDK is exact for a constant g).
   */
  segmentTimescale(x: number, y: number, z: number, vx: number, vy: number, vz: number, dt: number): number {
    let tau = Infinity;
    const v2 = vx * vx + vy * vy + vz * vz, v = Math.sqrt(v2);
    for (let k = 0; k < this.live.length; k++) {
      const l = this.live[k];
      const dx = x - l.x, dy = y - l.y, dz = z - l.z;
      let s = v2 > 0 ? -(dx * vx + dy * vy + dz * vz) / v2 : 0;
      s = s < 0 ? 0 : s > dt ? dt : s;
      const cx = dx + s * vx, cy = dy + s * vy, cz = dz + s * vz;
      const r2 = cx * cx + cy * cy + cz * cz;
      if (r2 >= l.R * l.R) continue;
      const q = r2 + l.eps2;
      const sq = Math.sqrt(q);
      const t1 = (sq * Math.sqrt(sq)) / Math.sqrt(l.mu);
      const t2 = v > 0 ? sq / v : Infinity;
      if (t1 < tau) tau = t1;
      if (t2 < tau) tau = t2;
    }
    return tau;
  }

  /** The first source whose capture sphere contains the point (index into live), −1 = none. */
  captureAt(x: number, y: number, z: number): number {
    for (let k = 0; k < this.live.length; k++) {
      const l = this.live[k];
      if (l.cap2 === 0) continue;
      const dx = x - l.x, dy = y - l.y, dz = z - l.z;
      if (dx * dx + dy * dy + dz * dz <= l.cap2) return k;
    }
    return -1;
  }

  /** Distance to the nearest live source centre (m; Infinity without any) and its index. */
  nearest(x: number, y: number, z: number): { d: number; k: number } {
    let d = Infinity, kk = -1;
    for (let k = 0; k < this.live.length; k++) {
      const l = this.live[k];
      const r = Math.hypot(x - l.x, y - l.y, z - l.z);
      if (r < d) { d = r; kk = k; }
    }
    return { d, k: kk };
  }
}
