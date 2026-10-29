/**
 * Depth-averaged granular flow of mobile sediment (Phase 22) — the runout of landslides and the
 * infill of collapse pits. Conservative finite volumes on the terrain's vertex grid with face
 * fluxes (the local-inertial form also used by the Phase 14 water solver, Bates et al. 2010):
 *
 *   q ← q·min(1, h_f / h_f,prev)                   momentum stays with the mass (a draining face keeps u, not q)
 *   q ← q − g·h_f·∂s/∂x·cos²β·Δt                  pressure + gravity (s = ground + mobile thickness;
 *                                                horizontal projection of the along-slope terms)
 *   Coulomb basal friction: |q| reduced by μ·g·h_f·cos²β·Δt, never reversed. A MOVING face uses
 *     μ = tan φ'cv (critical state); a face AT REST (q = 0) must exceed the restart friction
 *     μ_s = tan(φ'cv + ~2°) (granular hysteresis between the angle of maximum stability and the
 *     angle of repose) — so settled debris stops instead of creeping at the repose slope;
 *   (single-μ form, μ_s = μ, as before:) a layer at rest stays
 *     at rest while |∂s/∂x| ≤ μ  →  it stops at a surface slope of tan⁻¹μ (angle of repose);
 *     a thin uniform layer on a plane accelerates horizontally at g·cosβ·(sinβ − μ·cosβ)
 *   Voellmy turbulent term: q ← q / (1 + g·|q|·Δt / (ξ·h_f²))
 *   h_i ← h_i − Δt/Δx · Σ q_out + Δt/Δx · Σ q_in   (each face moves volume between two cells)
 *
 * This is the Voellmy rheology used by depth-averaged runout codes (e.g. RAMMS::Debris Flow,
 * DAN3D; Hungr 1995; Christen et al. 2010) in its simplest explicit form: isotropic earth
 * pressure (k = 1), no entrainment along the path, no separate fluid phase. μ = tan of the basal
 * friction angle reduced by the pore-pressure ratio of the moving mass (effective stress); ξ
 * (m/s²) is the turbulence coefficient, an EMPIRICAL calibration parameter (typ. 100–1000).
 *
 * Exactness: every face flux is subtracted from one cell and added to its neighbour, and
 * outflows are limited to the volume a cell holds (positivity), so volume and mass are conserved
 * to round-off; open edges record what leaves. A cell whose faces are all at rest for REST_TIME
 * (or creep below U_REST) becomes static deposit (the surface does not change).
 */
import type { GeoField } from './GeoField';

export const XI_DEFAULT = 400;
/** Flow-depth threshold for moving across a face (m). */
const H_MIN = 1e-3;
/** A layer at rest this long becomes deposit (s). */
export const REST_TIME = 0.5;
/**
 * Below this speed a face counts as at rest (m/s): creep at the repose slope (flux ~1e-5 m²/s
 * that never quite reaches zero in the explicit friction update) must not keep a settled pit
 * "moving" — and the terrain / collider updating — indefinitely.
 */
export const U_REST = 0.01;
const G = 9.81;
const CFL = 0.4;

export interface FlowOptions {
  /** Ground height (without the mobile layer) of vertex i: base terrain + the field's bed. */
  ground: (i: number) => number;
  xi?: number;
  /** World edges: closed (nothing leaves) or open (outflow recorded). */
  boundary?: 'closed' | 'open';
}

export interface FlowStats {
  substeps: number;
  maxSpeed: number;
  cells: number;
}

/**
 * Advance the mobile layer by `duration` seconds (substeps by CFL). `ground(i)` must not change
 * during the call (it reads the pre-update terrain; the field's own `bed` is applied on top by
 * the caller's closure).
 */
export function flowStep(f: GeoField, duration: number, opt: FlowOptions): FlowStats {
  const stats: FlowStats = { substeps: 0, maxSpeed: 0, cells: 0 };
  const a = f.active;
  if (a.x1 < a.x0) return stats;
  const { nx, nz, dx, h, mass, mu, qx, qz, rest } = f;
  const xi = opt.xi ?? XI_DEFAULT;
  const open = opt.boundary === 'open';
  const A = dx * dx;
  let t = 0;
  // Work window: the active box + 2 (material moves at most one cell per substep).
  let x0 = Math.max(0, a.x0 - 2), x1 = Math.min(nx - 1, a.x1 + 2), z0 = Math.max(0, a.z0 - 2), z1 = Math.min(nz - 1, a.z1 + 2);
  const s = new Float64Array((x1 - x0 + 1) * (z1 - z0 + 1));
  const ww = x1 - x0 + 1;
  while (t < duration - 1e-9) {
    // Surface and CFL.
    let vmax = 0;
    for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) {
      const i = iz * nx + ix;
      s[(iz - z0) * ww + (ix - x0)] = opt.ground(i) + h[i];
      // Speed at the right / lower face of the cell: the flux over the DEEPER side's depth (the
      // donor of a front). Dividing by the receiving cell's (near-zero) depth would report
      // spurious km/s speeds at wetting fronts and collapse the time step.
      let u = 0;
      if (ix < nx - 1) u = Math.abs(qx[iz * (nx - 1) + ix]) / Math.max(H_MIN, h[i], h[i + 1]);
      if (iz < nz - 1) u = Math.max(u, Math.abs(qz[iz * nx + ix]) / Math.max(H_MIN, h[i], h[i + nx]));
      if (u > stats.maxSpeed) stats.maxSpeed = u;
      if (h[i] > H_MIN || u > 0) {
        const v = u + Math.sqrt(G * h[i]);
        if (v > vmax) vmax = v;
      }
    }
    if (vmax <= 0) {
      // Nothing can move: everything left is at rest → deposit.
      for (let iz = z0; iz <= z1; iz++) for (let i = iz * nx + x0, e = iz * nx + x1; i <= e; i++) if (h[i] > 0) f.deposit(i);
      break;
    }
    const dt = Math.min(duration - t, (CFL * dx) / vmax);
    const S = (ix: number, iz: number) => s[(iz - z0) * ww + (ix - x0)];
    // Face fluxes (x faces between ix and ix+1).
    for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix < x1; ix++) {
      const i = iz * nx + ix, j = i + 1, k = iz * (nx - 1) + ix;
      qx[k] = faceFlux(qx[k], f.hfx, k, S(ix, iz), S(ix + 1, iz), opt.ground(i), opt.ground(j), h[i], h[j], qx[k] === 0 ? f.muS[i] : mu[i], qx[k] === 0 ? f.muS[j] : mu[j], dx, dt, xi);
    }
    for (let iz = z0; iz < z1; iz++) for (let ix = x0; ix <= x1; ix++) {
      const i = iz * nx + ix, j = i + nx, k = iz * nx + ix;
      qz[k] = faceFlux(qz[k], f.hfz, k, S(ix, iz), S(ix, iz + 1), opt.ground(i), opt.ground(j), h[i], h[j], qz[k] === 0 ? f.muS[i] : mu[i], qz[k] === 0 ? f.muS[j] : mu[j], dx, dt, xi);
    }
    // Positivity: scale the outflows of a cell to what it holds.
    for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) {
      const i = iz * nx + ix;
      let out = 0;
      if (ix < nx - 1 && qx[iz * (nx - 1) + ix] > 0) out += qx[iz * (nx - 1) + ix];
      if (ix > 0 && qx[iz * (nx - 1) + ix - 1] < 0) out -= qx[iz * (nx - 1) + ix - 1];
      if (iz < nz - 1 && qz[iz * nx + ix] > 0) out += qz[iz * nx + ix];
      if (iz > 0 && qz[(iz - 1) * nx + ix] < 0) out -= qz[(iz - 1) * nx + ix];
      const edgeOut = open ? edgeOutflow(f, ix, iz, i, dt) : 0;
      out += edgeOut;
      const vol = out * dt / dx; // as a thickness
      if (vol > h[i] && vol > 0) {
        const r = h[i] / vol;
        if (ix < nx - 1 && qx[iz * (nx - 1) + ix] > 0) qx[iz * (nx - 1) + ix] *= r;
        if (ix > 0 && qx[iz * (nx - 1) + ix - 1] < 0) qx[iz * (nx - 1) + ix - 1] *= r;
        if (iz < nz - 1 && qz[iz * nx + ix] > 0) qz[iz * nx + ix] *= r;
        if (iz > 0 && qz[(iz - 1) * nx + ix] < 0) qz[(iz - 1) * nx + ix] *= r;
        edgeQ[0] = edgeOut * r;
      } else edgeQ[0] = edgeOut;
      if (edgeQ[0] > 0) {
        // Leaves through the open edge (volume and the donor's mass fraction).
        const dh = (edgeQ[0] * dt) / dx;
        const frac = h[i] > 0 ? Math.min(1, dh / h[i]) : 0;
        const dm = mass[i] * frac;
        h[i] -= dh;
        mass[i] -= dm;
        f.budget.outflow += dh * A;
        f.budget.outflowMass += dm;
        if (h[i] < 0) h[i] = 0;
      }
    }
    // Transport: volume, mass and μ·h move with the face fluxes (donor-cell values).
    for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix < x1; ix++) {
      const k = iz * (nx - 1) + ix, q = qx[k];
      if (q !== 0) move(f, q > 0 ? iz * nx + ix : iz * nx + ix + 1, q > 0 ? iz * nx + ix + 1 : iz * nx + ix, (Math.abs(q) * dt) / dx);
    }
    for (let iz = z0; iz < z1; iz++) for (let ix = x0; ix <= x1; ix++) {
      const k = iz * nx + ix, q = qz[k];
      if (q !== 0) move(f, q > 0 ? iz * nx + ix : (iz + 1) * nx + ix, q > 0 ? (iz + 1) * nx + ix : iz * nx + ix, (Math.abs(q) * dt) / dx);
    }
    t += dt;
    stats.substeps++;
    // Every vertex of the window may have gained / lost mobile thickness (terrain contribution).
    f.touch(x0, z0, x1, z1);
    // Rest bookkeeping and the new active box.
    let nx0 = nx, nx1 = -1, nz0 = nz, nz1 = -1;
    for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) {
      const i = iz * nx + ix;
      if (h[i] <= 0) continue;
      // Moving = a face carries more than creep (U_REST over the deeper side's depth).
      const lim = (j: number) => U_REST * Math.max(H_MIN, h[i], h[j]);
      const moving = (ix < nx - 1 && Math.abs(qx[iz * (nx - 1) + ix]) > lim(i + 1)) || (ix > 0 && Math.abs(qx[iz * (nx - 1) + ix - 1]) > lim(i - 1))
        || (iz < nz - 1 && Math.abs(qz[iz * nx + ix]) > lim(i + nx)) || (iz > 0 && Math.abs(qz[(iz - 1) * nx + ix]) > lim(i - nx));
      if (moving) {
        rest[i] = 0;
      } else if ((rest[i] += dt) >= REST_TIME || h[i] < 1e-4) {
        f.deposit(i);
        continue;
      }
      if (ix < nx0) nx0 = ix;
      if (ix > nx1) nx1 = ix;
      if (iz < nz0) nz0 = iz;
      if (iz > nz1) nz1 = iz;
    }
    a.x0 = nx0; a.x1 = nx1; a.z0 = nz0; a.z1 = nz1;
    if (a.x1 < a.x0) break;
    // The window follows the flow (rebuild the surface buffer when it grows).
    const nx0w = Math.max(0, a.x0 - 2), nx1w = Math.min(nx - 1, a.x1 + 2), nz0w = Math.max(0, a.z0 - 2), nz1w = Math.min(nz - 1, a.z1 + 2);
    if (nx0w < x0 || nx1w > x1 || nz0w < z0 || nz1w > z1) {
      x0 = Math.min(x0, nx0w); x1 = Math.max(x1, nx1w); z0 = Math.min(z0, nz0w); z1 = Math.max(z1, nz1w);
      return continueWith(f, duration - t, opt, stats);
    }
  }
  stats.cells = a.x1 < a.x0 ? 0 : (a.x1 - a.x0 + 1) * (a.z1 - a.z0 + 1);
  f.rev++;
  return stats;
}

function continueWith(f: GeoField, remaining: number, opt: FlowOptions, stats: FlowStats): FlowStats {
  f.rev++;
  if (remaining <= 1e-9) return stats;
  const more = flowStep(f, remaining, opt);
  stats.substeps += more.substeps;
  stats.maxSpeed = Math.max(stats.maxSpeed, more.maxSpeed);
  stats.cells = more.cells;
  return stats;
}

const edgeQ = [0];

/** Outflow (m²/s, ≥ 0) of an edge vertex through the open world boundary (free fall beyond). */
function edgeOutflow(f: GeoField, ix: number, iz: number, i: number, dt: number): number {
  const { nx, nz, dx, h } = f;
  if (h[i] <= H_MIN) return 0;
  const onEdge = ix === 0 || iz === 0 || ix === nx - 1 || iz === nz - 1;
  if (!onEdge) return 0;
  // Beyond the edge the ground continues at the edge height; the layer spreads out with its own
  // pressure gradient h/dx and Coulomb friction (no driving slope → stops when thin).
  const grad = h[i] / dx;
  const drive = G * h[i] * grad, fric = f.mu[i] * G * h[i];
  if (drive <= fric) return 0;
  return Math.min((h[i] * dx) / dt, (drive - fric) * dt);
}

/** Face flux update (see the header); bed slope for cosβ from the two ground heights. */
function faceFlux(q: number, hfs: Float32Array, k: number, si: number, sj: number, gi: number, gj: number, hi: number, hj: number, mui: number, muj: number, dx: number, dt: number, xi: number): number {
  const hf = Math.max(si, sj) - Math.max(gi, gj);
  const hfPrev = hfs[k];
  hfs[k] = hf > H_MIN ? hf : 0;
  if (hf <= H_MIN || (hi <= H_MIN && hj <= H_MIN)) return 0;
  // q = h·u is carried between substeps: when the flowing depth at the face dropped (the donor
  // drained), the remaining layer keeps its velocity, not its flux — otherwise thin trailing
  // films would inherit the flux of the bulk and run at unphysical speeds.
  if (hfPrev > hf) q *= hf / hfPrev;
  const slope = (sj - si) / dx;
  const bed = (gj - gi) / dx;
  // Horizontal fluxes on an inclined bed: driving g·sinβ and normal force g·cosβ act along the
  // slope; their horizontal projections are g·sinβ·cosβ = g·tanβ·cos²β and μ·g·cos²β.
  const cos2 = 1 / (1 + bed * bed);
  // Donor μ: the side the material comes from.
  const mu = sj < si ? mui : muj;
  let nq = q - G * hf * slope * cos2 * dt;
  const fric = mu * G * hf * cos2 * dt;
  if (Math.abs(nq) <= fric) return 0;
  nq -= Math.sign(nq) * fric;
  nq /= 1 + (G * Math.abs(nq) * dt) / (xi * hf * hf);
  // Only material that exists can move: a face never draws from an empty donor.
  if ((nq > 0 && hi <= H_MIN) || (nq < 0 && hj <= H_MIN)) return 0;
  return nq;
}

/** Move a thickness `dh` (as volume / A) from cell a to b with a's mass and μ. */
function move(f: GeoField, a: number, b: number, dh: number) {
  const { h, mass, mu, muS, rest } = f;
  if (dh <= 0 || h[a] <= 0) return;
  const take = Math.min(dh, h[a]);
  const frac = take / h[a];
  const dm = mass[a] * frac;
  const muA = mu[a], musA = muS[a];
  h[a] -= take;
  mass[a] -= dm;
  mu[b] = h[b] > 0 ? (mu[b] * h[b] + muA * take) / (h[b] + take) : muA;
  muS[b] = h[b] > 0 ? (muS[b] * h[b] + musA * take) / (h[b] + take) : musA;
  h[b] += take;
  mass[b] += dm;
  // Rest is decided by the cell's own faces (bookkeeping after transport): receiving a creeping
  // trickle must not keep a settled column "mobile" (Phase 22 residual — settling time).
  if (h[b] === take) rest[b] = 0;
  f.grow(b);
}
