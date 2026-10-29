/**
 * From pressure (Pa) to force (N) and impulse (N·s) on objects (Phase 24) — never using a pressure as
 * a force:
 *
 *  - every object is its oriented bounding box; each exposed face f (four sides and the top; the
 *    bottom rests on the ground) gets the pressure of every wave arriving AT ITS OWN CENTRE (so the
 *    front face is loaded before the back face — the diffraction phase — and the net push follows from
 *    the transit time across the object), reflected on faces turned toward the wave (factor
 *    C = 1 + (C_r − 1)·cos θ with clearing over t_c = 3S/c), side-on on faces along the wave, and on
 *    shadowed faces the pressure builds up from (1 − |cos θ|)·p to p over the rise time 4S/c while
 *    the wave wraps around the object (simplified rear-face idealization of blast-load engineering;
 *    same closed form as the clearing);
 *  - the mechanical impulse of a face over a step is J_f = −n_f·A_f·∫p_f dt (exact, pulse.ts); the
 *    object's net impulse ΣJ_f and its moment about the box centre give the force through the
 *    ForceLedger (impulse / Δt, applied at the centre of pressure — the moment is kept);
 *  - drag of the blast wind (dynamic pressure): F = ½·ρ₂·C_d·A·|u − v|·(u − v), with the Rankine–
 *    Hugoniot particle velocity u and post-shock density ρ₂ at the peak (so ½ρ₂u² is the exact R–H
 *    dynamic pressure 5Δp²/(2(Δp + 7p₀)) for γ = 1.4), u following the pressure history (exact time
 *    integral between the pulse breakpoints);
 *  - porous / slender objects use the existing frontal-area ratio (areaFactor) on their side faces.
 *
 * SDOF elements (facade parts, trees): an undamped elastic oscillator x'' + ω²x = ω²·load/capacity,
 * advanced with exact solutions over sub-steps short against its period (ωh ≤ 0.25) — the load in
 * each sub-step is its exact time average, so short pulses keep their impulse. Failure when the peak
 * |x| reaches x_f = √(2μ − 1) (elastic–plastic energy equivalence, Newmark & Hall; μ = ductility,
 * 1 = brittle glass). After the pulse has passed the free-vibration amplitude √(x² + (v/ω)²) decides.
 */
import type { Quat, Vec3 } from '@/core/types';
import { qRotate } from '@/core/math';
import { breakpoints, faceImpulse, integratePiecewise, pressure, span } from './pulse';
import { GAMMA, reflectionFactor } from './source';
import type { Contribution } from './wave';

export interface Faces {
  n: Vec3[];
  c: Vec3[];
  A: number[];
  /** Clearing size S (m) per face. */
  S: number[];
  /** Box centre (world). */
  center: Vec3;
}

const LOCAL: { n: Vec3; axis: 0 | 1 | 2 }[] = [
  { n: [1, 0, 0], axis: 0 }, { n: [-1, 0, 0], axis: 0 }, { n: [0, 0, 1], axis: 2 }, { n: [0, 0, -1], axis: 2 }, { n: [0, 1, 0], axis: 1 }, { n: [0, -1, 0], axis: 1 },
];

/**
 * Exposed faces of an oriented box standing on its base point `base` (local y from 0 to dims[1]).
 * Side faces are scaled by `areaFactor` (frontal area / silhouette). `bottom`: the underside is
 * loaded too — free bodies (vehicles with ground clearance, people, debris): the wave reaches under
 * them within milliseconds, so the roof pressure is not a net downward blow (without it a vehicle
 * was driven into the ground and bounced out of it). Structures fixed to the ground: no underside.
 */
export function boxFaces(base: Readonly<Vec3>, dims: Readonly<Vec3>, q: Readonly<Quat>, areaFactor = 1, bottom = false): Faces {
  const [w, h, d] = dims;
  const up = qRotate(q as Quat, [0, h / 2, 0]);
  const center: Vec3 = [base[0] + up[0], base[1] + up[1], base[2] + up[2]];
  const out: Faces = { n: [], c: [], A: [], S: [], center };
  for (const f of LOCAL) {
    if (f.n[1] < 0 && !bottom) continue;
    const n = qRotate(q as Quat, f.n);
    const off = qRotate(q as Quat, [f.n[0] * w / 2, f.n[1] * h / 2, f.n[2] * d / 2]);
    out.n.push(n);
    out.c.push([center[0] + off[0], center[1] + off[1], center[2] + off[2]]);
    if (f.axis === 0) { out.A.push(d * h * areaFactor); out.S.push(Math.min(h, d / 2)); }
    else if (f.axis === 2) { out.A.push(w * h * areaFactor); out.S.push(Math.min(h, w / 2)); }
    else { out.A.push(w * d); out.S.push(Math.min(w, d) / 2); }
  }
  return out;
}

/** One wave on one face: its arrival there, reflection factor and clearing time. */
export interface FaceLoad {
  face: number;
  a: Contribution;
  C: number;
  tc: number;
}

/**
 * Pressure factor at the arrival on a face with outward normal n for a wave travelling along k:
 * > 1 reflected (front), 1 side-on, < 1 shadowed (rear: builds up to side-on over the rise time).
 */
export function faceFactor(n: Readonly<Vec3>, a: Readonly<Contribution>): number {
  const cos = -(n[0] * a.k[0] + n[1] * a.k[1] + n[2] * a.k[2]);
  return cos > 0 ? 1 + (reflectionFactor(a.dp, a.p) - 1) * cos : 1 + cos;
}

/** Relief time of a face (s): clearing 3S/c for reflected faces, rise 4S/c for shadowed ones. */
export const reliefTime = (C: number, S: number, c: number) => ((C >= 1 ? 3 : 4) * S) / c;

/**
 * Arrivals of all contributions at every face (contributions computed at each face centre by
 * `at(point, out)`). Returns the latest end time of any of them (absolute s).
 */
export function faceLoads(faces: Faces, at: (p: Vec3, out: Contribution[]) => void, c: number, out: FaceLoad[]): number {
  out.length = 0;
  let end = -Infinity;
  const tmp: Contribution[] = [];
  for (let f = 0; f < faces.n.length; f++) {
    tmp.length = 0;
    at(faces.c[f], tmp);
    for (const a of tmp) {
      if (a.dp <= 0) continue;
      const C = faceFactor(faces.n[f], a);
      const tc = reliefTime(C, faces.S[f], c);
      out.push({ face: f, a, C, tc });
      end = Math.max(end, a.t + span(a) + tc);
    }
  }
  return end;
}

/** Earliest arrival among face loads (absolute s). */
export const firstArrival = (loads: readonly FaceLoad[]) => loads.reduce((m, l) => Math.min(m, l.a.t), Infinity);

/**
 * Net impulse (N·s, world) and its moment about the box centre (N·m·s) delivered over [t0, t1].
 * `horizontalOnly` drops the vertical part (structures: the ground carries it).
 */
export function netImpulse(faces: Faces, loads: readonly FaceLoad[], t0: number, t1: number, J: Vec3, L: Vec3, horizontalOnly = false) {
  J[0] = J[1] = J[2] = 0;
  L[0] = L[1] = L[2] = 0;
  for (const l of loads) {
    const I = faceImpulse(l.a, l.C, l.tc, t0, t1);
    if (I === 0) continue;
    const n = faces.n[l.face], A = faces.A[l.face], c = faces.c[l.face];
    const fx = -n[0] * A * I, fy = horizontalOnly ? 0 : -n[1] * A * I, fz = -n[2] * A * I;
    J[0] += fx; J[1] += fy; J[2] += fz;
    const rx = c[0] - faces.center[0], ry = c[1] - faces.center[1], rz = c[2] - faces.center[2];
    L[0] += ry * fz - rz * fy;
    L[1] += rz * fx - rx * fz;
    L[2] += rx * fy - ry * fx;
  }
}

/**
 * Point on the central axis of (J, L) nearest the centre, clamped into the box: applying J there
 * reproduces the moment component perpendicular to J (the twisting part along J is dropped).
 */
export function pressureCentre(faces: Faces, dims: Readonly<Vec3>, J: Readonly<Vec3>, L: Readonly<Vec3>, out: Vec3): Vec3 {
  const j2 = J[0] * J[0] + J[1] * J[1] + J[2] * J[2];
  const c = faces.center;
  if (j2 < 1e-18) { out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return out; }
  let x = (J[1] * L[2] - J[2] * L[1]) / j2, y = (J[2] * L[0] - J[0] * L[2]) / j2, z = (J[0] * L[1] - J[1] * L[0]) / j2;
  const r = Math.hypot(x, y, z), lim = 0.5 * Math.hypot(dims[0], dims[1], dims[2]);
  if (r > lim) { x *= lim / r; y *= lim / r; z *= lim / r; }
  out[0] = c[0] + x; out[1] = c[1] + y; out[2] = c[2] + z;
  return out;
}

/** Projected area of a box (dims, local) onto the plane normal to the local unit direction d. */
export function projectedArea(dims: Readonly<Vec3>, d: Readonly<Vec3>): number {
  return Math.abs(d[0]) * dims[1] * dims[2] + Math.abs(d[1]) * dims[0] * dims[2] + Math.abs(d[2]) * dims[0] * dims[1];
}

/** Post-shock / ambient density ratio (Rankine–Hugoniot, γ = 1.4). */
export function densityRatio(dp: number, p: number): number {
  const x = dp / p;
  return (1 + ((GAMMA + 1) / (2 * GAMMA)) * x) / (1 + ((GAMMA - 1) / (2 * GAMMA)) * x);
}

/** Rankine–Hugoniot particle velocity per unit overpressure at peak Δp (m/s per Pa). */
function velocityPerPa(dp: number, p: number, rho: number): number {
  const c = Math.sqrt((GAMMA * p) / rho);
  return 1 / (rho * c * Math.sqrt(1 + ((GAMMA + 1) / (2 * GAMMA)) * (dp / p)));
}

/**
 * Drag impulse of the blast wind over [t0, t1] on a body of drag area Cd·A (m²) moving at v (m/s),
 * from the contributions at its centre. Written into J (N·s).
 */
export function dragImpulse(waves: readonly Contribution[], cdA: number, rho: number, v: Readonly<Vec3>, t0: number, t1: number, J: Vec3) {
  J[0] = J[1] = J[2] = 0;
  if (cdA <= 0 || !waves.length) return;
  const bps: number[] = [];
  const kv = waves.map((w) => velocityPerPa(w.dp, w.p, rho));
  // Post-shock density of the strongest wave (the compressed air that blows past the body).
  const main = waves.reduce((a, b) => (b.dp > a.dp ? b : a));
  const r2 = rho * densityRatio(main.dp, main.p);
  for (const w of waves) breakpoints(w, 0, bps);
  for (let axis = 0; axis < 3; axis++) {
    J[axis] = integratePiecewise((t) => {
      let ux = -v[0], uy = -v[1], uz = -v[2];
      for (let i = 0; i < waves.length; i++) {
        const u = pressure(waves[i], t) * kv[i];
        ux += u * waves[i].k[0]; uy += u * waves[i].k[1]; uz += u * waves[i].k[2];
      }
      const s = Math.hypot(ux, uy, uz);
      return 0.5 * r2 * cdA * s * (axis === 0 ? ux : axis === 1 ? uy : uz);
    }, t0, t1, bps);
  }
}

// ── SDOF elements ─────────────────────────────────────────────

export interface Sdof {
  /** Normalized displacement (1 = elastic limit under the static capacity) and velocity (1/s). */
  x: number;
  v: number;
  /** Peak |x| so far. */
  peak: number;
  omega: number;
  /** Displacement at failure x_f = √(2μ − 1). */
  xFail: number;
}

export const newSdof = (period: number, ductility: number): Sdof => ({ x: 0, v: 0, peak: 0, omega: (2 * Math.PI) / period, xFail: Math.sqrt(Math.max(1, 2 * ductility - 1)) });

/**
 * Advance over [t0, t1]. `drive(a, b)` returns ∫ load/capacity dt over [a, b] (s). Exact for a load
 * constant in each sub-step.
 */
export function advanceSdof(s: Sdof, drive: (a: number, b: number) => number, t0: number, t1: number, cumulative?: (t: number) => number) {
  const dt = t1 - t0;
  if (dt <= 0) return;
  const w = s.omega;
  const m = Math.min(256, Math.max(1, Math.ceil((w * dt) / 0.4)));
  const h = dt / m, cw = Math.cos(w * h), sw = Math.sin(w * h);
  let x = s.x, v = s.v, peak = s.peak;
  // With a cumulative integral the sub-step loads cost one evaluation per boundary (not two per sub-step).
  let prev = cumulative ? cumulative(t0) : 0;
  for (let k = 0; k < m; k++) {
    const a = t0 + k * h;
    let I: number;
    if (cumulative) { const next = cumulative(a + h); I = next - prev; prev = next; }
    else I = drive(a, a + h);
    const xs = I / h;
    const e = x - xs;
    x = xs + e * cw + (v / w) * sw;
    v = -e * w * sw + v * cw;
    const ax = x < 0 ? -x : x;
    if (ax > peak) peak = ax;
  }
  s.x = x; s.v = v; s.peak = peak;
}

/**
 * Upper bound of the peak response of an undamped oscillator (x'' + ω²x = ω²f) to loads that never
 * exceed f_max in magnitude and whose |f| integrates to F: |x| ≤ min(4·f_max, ω·F) (a single
 * reversal at most doubles the static-step bound of 2; the impulse bound holds for any shape).
 * Parts whose bound stays below their damage threshold are never integrated (rigorous pruning).
 */
export function responseBound(s: Sdof, fMax: number, F: number): number {
  return Math.min(4 * fMax, s.omega * F);
}

/** Free-vibration amplitude (the peak the element will still reach with no further load). */
export const freeAmplitude = (s: Sdof) => Math.hypot(s.x, s.v / s.omega);
