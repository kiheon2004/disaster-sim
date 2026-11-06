/**
 * Phase 35 Level 1 passive dynamic objects: explicit rigid-body mass properties from a part model.
 *
 * A part model is a list of simple homogeneous parts (solid box, thin plate, solid / thin-walled cylinder, solid / thin-shell
 * sphere), each with its mass and centroid in the object's local frame (origin at the base centre, Y up; boxes: X = length,
 * Y = height, Z = width). Parts are combined with the parallel-axis theorem; the result is the COM and the inertia tensor
 * about it, reduced to principal moments + the principal frame for Rapier (`BodyDesc.massProps`).
 *
 * Internally a part is stored by its mass, centroid and SECOND MOMENTS S_ij = ∫ r_i r_j dm about its own centroid —
 * the parallel-axis shift is then S_ij += m·d_i·d_j and the inertia tensor is I = tr(S)·1 − S
 * (e.g. I_xx = S_yy + S_zz). A non-uniform object scale k maps S_ij → k_i·k_j·S_ij exactly (affine stretch of the mass).
 *
 * Formulas (S along the part's own axes; cylinders and spheres: axis Y):
 *   solid box a×b×c          S = m·(a², b², c²)/12                    → I_xx = m(b² + c²)/12 …
 *   thin plate (one size 0)  same with that size = 0
 *   solid cylinder r, h      S_xx = S_zz = m r²/4,  S_yy = m h²/12    → I_yy = m r²/2, I_xx = m(3r² + h²)/12
 *   thin-walled tube r, h    S_xx = S_zz = m r²/2,  S_yy = m h²/12    → I_yy = m r²,   I_xx = m(6r² + h²)/12
 *   thin disc r              S_xx = S_zz = m r²/4,  S_yy = 0          → I_yy = m r²/2, I_xx = m r²/4
 *   solid sphere r           S = m r²/5                               → I = 2/5 m r²
 *   thin spherical shell r   S = m r²/3                               → I = 2/3 m r²
 */
import type { Quat, Vec3 } from '@/core/types';

/** Mass, centroid and second moments about the centroid [xx, yy, zz, xy, xz, yz] (kg·m²). */
export interface MassModel {
  mass: number;
  com: Vec3;
  S: [number, number, number, number, number, number];
}

/** What a body needs: local COM, principal moments (kg·m²) and the rotation of the principal axes in the body frame. */
export interface PrincipalMass {
  com: Vec3;
  inertia: Vec3;
  frame: Quat;
}

const part = (m: number, c: Vec3, sxx: number, syy: number, szz: number): MassModel => ({ mass: m, com: [c[0], c[1], c[2]], S: [sxx, syy, szz, 0, 0, 0] });

/** Solid homogeneous box of full size [x, y, z] (a size of 0 gives a thin plate). */
export const solidBox = (m: number, size: Vec3, c: Vec3): MassModel => part(m, c, (m * size[0] ** 2) / 12, (m * size[1] ** 2) / 12, (m * size[2] ** 2) / 12);

/** Solid cylinder, axis Y. */
export const solidCylinder = (m: number, r: number, h: number, c: Vec3): MassModel => part(m, c, (m * r * r) / 4, (m * h * h) / 12, (m * r * r) / 4);

/** Thin-walled open tube (lateral surface only), axis Y. */
export const thinTube = (m: number, r: number, h: number, c: Vec3): MassModel => part(m, c, (m * r * r) / 2, (m * h * h) / 12, (m * r * r) / 2);

/** Thin disc (end cap), normal Y. */
export const thinDisc = (m: number, r: number, c: Vec3): MassModel => part(m, c, (m * r * r) / 4, 0, (m * r * r) / 4);

/** Solid sphere / thin spherical shell. */
export const solidSphere = (m: number, r: number, c: Vec3): MassModel => part(m, c, (m * r * r) / 5, (m * r * r) / 5, (m * r * r) / 5);
export const sphericalShell = (m: number, r: number, c: Vec3): MassModel => part(m, c, (m * r * r) / 3, (m * r * r) / 3, (m * r * r) / 3);

/**
 * Closed thin-walled box (all six faces, uniform areal density) of outer size [x, y, z] centred at c: six thin plates,
 * each face's mass ∝ its area.
 */
export function boxShell(m: number, size: Vec3, c: Vec3): MassModel {
  const [a, b, d] = size;
  const area = 2 * (b * d + a * d + a * b);
  const plates: MassModel[] = [];
  for (const s of [-1, 1]) {
    plates.push(solidBox((m * b * d) / area, [0, b, d], [c[0] + (s * a) / 2, c[1], c[2]]));
    plates.push(solidBox((m * a * d) / area, [a, 0, d], [c[0], c[1] + (s * b) / 2, c[2]]));
    plates.push(solidBox((m * a * b) / area, [a, b, 0], [c[0], c[1], c[2] + (s * d) / 2]));
  }
  return combine(plates);
}

/** Composite of parts (parallel-axis theorem): total mass, COM, second moments about the COM. */
export function combine(parts: MassModel[]): MassModel {
  let m = 0;
  const c: Vec3 = [0, 0, 0];
  for (const p of parts) {
    m += p.mass;
    for (let k = 0; k < 3; k++) c[k] += p.mass * p.com[k];
  }
  if (m > 0) for (let k = 0; k < 3; k++) c[k] /= m;
  const S: MassModel['S'] = [0, 0, 0, 0, 0, 0];
  for (const p of parts) {
    const dx = p.com[0] - c[0], dy = p.com[1] - c[1], dz = p.com[2] - c[2];
    S[0] += p.S[0] + p.mass * dx * dx;
    S[1] += p.S[1] + p.mass * dy * dy;
    S[2] += p.S[2] + p.mass * dz * dz;
    S[3] += p.S[3] + p.mass * dx * dy;
    S[4] += p.S[4] + p.mass * dx * dz;
    S[5] += p.S[5] + p.mass * dy * dz;
  }
  return { mass: m, com: c, S };
}

/** Inertia tensor about the COM: [Ixx, Iyy, Izz, Ixy, Ixz, Iyz] (products with the usual minus sign: I_xy = −S_xy). */
export function inertiaTensor(mm: MassModel): [number, number, number, number, number, number] {
  const [xx, yy, zz, xy, xz, yz] = mm.S;
  return [yy + zz, xx + zz, xx + yy, -xy, -xz, -yz];
}

/** The same mass distribution with another total mass (shape unchanged: COM fixed, second moments ∝ mass). */
export function withMass(mm: MassModel, mass: number): MassModel {
  const k = mm.mass > 0 ? mass / mm.mass : 0;
  return { mass, com: [...mm.com] as Vec3, S: mm.S.map((s) => s * k) as MassModel['S'] };
}

/** The mass distribution stretched by an object scale k (COM_i·k_i, S_ij·k_i·k_j). */
export function scaled(mm: MassModel, k: Vec3): MassModel {
  const [xx, yy, zz, xy, xz, yz] = mm.S;
  return {
    mass: mm.mass,
    com: [mm.com[0] * k[0], mm.com[1] * k[1], mm.com[2] * k[2]],
    S: [xx * k[0] * k[0], yy * k[1] * k[1], zz * k[2] * k[2], xy * k[0] * k[1], xz * k[0] * k[2], yz * k[1] * k[2]],
  };
}

/**
 * Principal moments and axes of the inertia tensor (cyclic Jacobi rotations on the symmetric 3×3). A tensor that is
 * already diagonal (every symmetric part model) is returned exactly, with the identity frame.
 */
export function principal(mm: MassModel): PrincipalMass {
  const [ixx, iyy, izz, ixy, ixz, iyz] = inertiaTensor(mm);
  const A = [[ixx, ixy, ixz], [ixy, iyy, iyz], [ixz, iyz, izz]];
  const scale = Math.max(1e-12, Math.abs(ixx) + Math.abs(iyy) + Math.abs(izz));
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = Math.abs(A[0][1]) + Math.abs(A[0][2]) + Math.abs(A[1][2]);
    if (off <= 1e-14 * scale) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      if (Math.abs(A[p][q]) <= 1e-18 * scale) continue;
      const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = A[k][p], akq = A[k][q];
        A[k][p] = c * akp - s * akq;
        A[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = A[p][k], aqk = A[q][k];
        A[p][k] = c * apk - s * aqk;
        A[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = V[k][p], vkq = V[k][q];
        V[k][p] = c * vkp - s * vkq;
        V[k][q] = s * vkp + c * vkq;
      }
    }
  }
  // Right-handed frame (columns of V are the principal axes in the body frame).
  const det = V[0][0] * (V[1][1] * V[2][2] - V[1][2] * V[2][1]) - V[0][1] * (V[1][0] * V[2][2] - V[1][2] * V[2][0]) + V[0][2] * (V[1][0] * V[2][1] - V[1][1] * V[2][0]);
  if (det < 0) for (let k = 0; k < 3; k++) V[k][2] = -V[k][2];
  return { com: [...mm.com] as Vec3, inertia: [A[0][0], A[1][1], A[2][2]], frame: quatFromMatrix(V) };
}

/** Unit quaternion [x, y, z, w] of a rotation matrix (rows of m). */
function quatFromMatrix(m: number[][]): Quat {
  const tr = m[0][0] + m[1][1] + m[2][2];
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s; x = (m[2][1] - m[1][2]) / s; y = (m[0][2] - m[2][0]) / s; z = (m[1][0] - m[0][1]) / s;
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
    w = (m[2][1] - m[1][2]) / s; x = 0.25 * s; y = (m[0][1] + m[1][0]) / s; z = (m[0][2] + m[2][0]) / s;
  } else if (m[1][1] > m[2][2]) {
    const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
    w = (m[0][2] - m[2][0]) / s; x = (m[0][1] + m[1][0]) / s; y = 0.25 * s; z = (m[1][2] + m[2][1]) / s;
  } else {
    const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
    w = (m[1][0] - m[0][1]) / s; x = (m[0][2] + m[2][0]) / s; y = (m[1][2] + m[2][1]) / s; z = 0.25 * s;
  }
  const n = Math.hypot(x, y, z, w) || 1;
  return [x / n, y / n, z / n, w / n];
}

/** Body mass properties of a part model for the entity's total mass and object scale. */
export function bodyMassProps(mm: MassModel, mass: number, k: Vec3): PrincipalMass {
  return principal(scaled(withMass(mm, mass), k));
}
