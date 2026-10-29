/**
 * Grid numerics of the atmosphere (Phase 29) on the Phase 26 air-layer columns (5 m, row-major
 * a = iz·nx + ix). Faces: x-faces (nx + 1)·nz, index iz·(nx + 1) + ix is the face on the WEST side
 * of column (ix, iz); z-faces nx·(nz + 1), index iz·nx + ix is the face on the NORTH side.
 *
 *  - pcg(): Jacobi-preconditioned conjugate gradients for the symmetric positive-definite
 *    5-point systems  (diag_a)·x_a + Σ_faces k_f·(x_a − x_b) = r_a  (fixed iteration order — deterministic)
 *  - advectFaces(): conservative donor-cell (upwind) transport of an extensive quantity (kg, J) by
 *    face velocities with CFL sub-steps (outgoing Courant sum ≤ 0.9 per column — positivity of
 *    non-negative fields); what crosses an open edge leaves, inflow at an edge carries nothing
 *    (ambient air: zero tracer, zero heat perturbation).
 */

export interface Grid {
  nx: number;
  nz: number;
  dx: number;
}

export const faceCountX = (g: Grid) => (g.nx + 1) * g.nz;
export const faceCountZ = (g: Grid) => g.nx * (g.nz + 1);

/**
 * Solve A·x = r with A_aa = diag_a + Σ k over its faces (interior faces couple two columns, boundary
 * faces with k > 0 only add to the diagonal — their ghost values are folded into r by the caller).
 * kx / kz: face coefficients (boundary faces included); x: initial guess (warm start), solution out.
 * Returns the iteration count.
 */
export function pcg(g: Grid, diag: Float64Array, kx: Float64Array, kz: Float64Array, r: Float64Array, x: Float64Array, work: Float64Array[], tol = 1e-12, maxIt = 400): number {
  const { nx, nz } = g;
  const n = nx * nz;
  const [res, z, p, q, dinv] = work;
  const mul = (v: Float64Array, out: Float64Array) => {
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const a = iz * nx + ix;
        const fw = iz * (nx + 1) + ix, fe = fw + 1, fn = a, fs = a + nx;
        const va = v[a];
        let s = diag[a] * va;
        s += kx[fw] * (ix > 0 ? va - v[a - 1] : va);
        s += kx[fe] * (ix < nx - 1 ? va - v[a + 1] : va);
        s += kz[fn] * (iz > 0 ? va - v[a - nx] : va);
        s += kz[fs] * (iz < nz - 1 ? va - v[a + nx] : va);
        out[a] = s;
      }
    }
  };
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
    const a = iz * nx + ix, fw = iz * (nx + 1) + ix;
    dinv[a] = 1 / (diag[a] + kx[fw] + kx[fw + 1] + kz[a] + kz[a + nx]);
  }
  mul(x, q);
  let rr = 0, bb = 0;
  for (let a = 0; a < n; a++) { res[a] = r[a] - q[a]; bb += r[a] * r[a]; }
  if (bb === 0) { x.fill(0); return 0; }
  let rz = 0;
  for (let a = 0; a < n; a++) { z[a] = res[a] * dinv[a]; p[a] = z[a]; rz += res[a] * z[a]; rr += res[a] * res[a]; }
  const stop = tol * tol * bb;
  let it = 0;
  while (rr > stop && it < maxIt) {
    mul(p, q);
    let pq = 0;
    for (let a = 0; a < n; a++) pq += p[a] * q[a];
    if (!(pq > 0)) break;
    const alpha = rz / pq;
    let rz2 = 0;
    rr = 0;
    for (let a = 0; a < n; a++) {
      x[a] += alpha * p[a];
      res[a] -= alpha * q[a];
      z[a] = res[a] * dinv[a];
      rz2 += res[a] * z[a];
      rr += res[a] * res[a];
    }
    const beta = rz2 / rz;
    rz = rz2;
    for (let a = 0; a < n; a++) p[a] = z[a] + beta * p[a];
    it++;
  }
  return it;
}

/** Largest outgoing Courant sum of a column for face velocities ux, uz (m/s) over dt. */
export function courant(g: Grid, ux: Float64Array, uz: Float64Array, dt: number): number {
  const { nx, nz, dx } = g;
  let m = 0;
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
    const a = iz * nx + ix, fw = iz * (nx + 1) + ix;
    const out = Math.max(0, -ux[fw]) + Math.max(0, ux[fw + 1]) + Math.max(0, -uz[a]) + Math.max(0, uz[a + nx]);
    if (out > m) m = out;
  }
  return (m * dt) / dx;
}

/**
 * Donor-cell transport of q (extensive, per column) by face velocities over dt with `n` sub-steps
 * (from courant()). Returns what left through the edges net of what came in (out) and what was moved
 * (|flux| summed). `ghost(a)`: the amount in the (virtual) cell outside the edge next to column a —
 * what inflow carries in; absent = 0 (ambient air brings no tracer / no heat perturbation).
 */
export function advectFaces(g: Grid, q: Float64Array, ux: Float64Array, uz: Float64Array, dt: number, n: number, tmp: Float64Array, ghost?: (a: number) => number): { out: number; moved: number } {
  const { nx, nz, dx } = g;
  const h = dt / n / dx;
  let out = 0, moved = 0;
  for (let s = 0; s < n; s++) {
    tmp.set(q);
    if (ghost) {
      for (let iz = 0; iz < nz; iz++) {
        const aw = iz * nx, ae = aw + nx - 1, fw = iz * (nx + 1);
        if (ux[fw] > 0) { const f = ghost(aw) * ux[fw] * h; q[aw] += f; out -= f; moved += Math.abs(f); }
        if (ux[fw + nx] < 0) { const f = ghost(ae) * -ux[fw + nx] * h; q[ae] += f; out -= f; moved += Math.abs(f); }
      }
      for (let ix = 0; ix < nx; ix++) {
        const an = ix, as = (nz - 1) * nx + ix;
        if (uz[ix] > 0) { const f = ghost(an) * uz[ix] * h; q[an] += f; out -= f; moved += Math.abs(f); }
        if (uz[nz * nx + ix] < 0) { const f = ghost(as) * -uz[nz * nx + ix] * h; q[as] += f; out -= f; moved += Math.abs(f); }
      }
    }
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const a = iz * nx + ix;
        const e = tmp[a];
        if (e === 0) continue;
        const fw = iz * (nx + 1) + ix;
        const uw = ux[fw], ue = ux[fw + 1], un = uz[a], us = uz[a + nx];
        if (uw < 0) { const f = e * -uw * h; q[a] -= f; moved += Math.abs(f); if (ix > 0) q[a - 1] += f; else out += f; }
        if (ue > 0) { const f = e * ue * h; q[a] -= f; moved += Math.abs(f); if (ix < nx - 1) q[a + 1] += f; else out += f; }
        if (un < 0) { const f = e * -un * h; q[a] -= f; moved += Math.abs(f); if (iz > 0) q[a - nx] += f; else out += f; }
        if (us > 0) { const f = e * us * h; q[a] -= f; moved += Math.abs(f); if (iz < nz - 1) q[a + nx] += f; else out += f; }
      }
    }
  }
  return { out, moved };
}

/** Sub-step count for a Courant number (≤ 0.9 per sub-step). */
export const substepsFor = (c: number) => (c > 0.9 ? Math.ceil(c / 0.9) : 1);

/** Bilinear interpolation of face velocities to a world point inside column grid coordinates (fx, fz in cells). */
export function velocityAt(g: Grid, ux: Float64Array, uz: Float64Array, fx: number, fz: number, out: [number, number]): [number, number] {
  const { nx, nz } = g;
  // x-velocity lives on x-faces at (ix, iz + ½); z-velocity on z-faces at (ix + ½, iz).
  const sample = (arr: Float64Array, w: number, h: number, u: number, v: number) => {
    const x = Math.max(0, Math.min(w - 1, u)), y = Math.max(0, Math.min(h - 1, v));
    const i = Math.min(w - 2, Math.floor(x)), j = Math.min(h - 2, Math.floor(y));
    if (w < 2 || h < 2) return arr[0] ?? 0;
    const tx = x - i, ty = y - j;
    const a = arr[j * w + i], b = arr[j * w + i + 1], c = arr[(j + 1) * w + i], d = arr[(j + 1) * w + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
  out[0] = sample(ux, nx + 1, nz, fx, fz - 0.5);
  out[1] = sample(uz, nx, nz + 1, fx - 0.5, fz);
  return out;
}
