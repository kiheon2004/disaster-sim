/**
 * Local ↔ world coordinates of blueprints (Phase 20). One convention everywhere:
 *
 *   world = T + R(yaw) · local,   R(θ)(u, v) = (u·cosθ + v·sinθ, −u·sinθ + v·cosθ)
 *
 * — a turn by θ about +y (three.js, right-handed), the rotation Phase 16 paste and Phase 18
 * road paste already used, so objects, road nodes / control points, natural feature points,
 * noise frames and terrain grids all turn together.
 */
import type { P2 } from '@/landscape/types';
import type { Feature, NoiseFrame } from '@/landscape/types';

export interface Placement {
  /** Anchor position in the world (m). */
  x: number;
  z: number;
  /** Turn about +y (rad). */
  yaw: number;
}

export function rotate(u: number, v: number, yaw: number): P2 {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [u * c + v * s, -u * s + v * c];
}

/** Inverse of `rotate`. */
export function unrotate(x: number, z: number, yaw: number): P2 {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [x * c - z * s, x * s + z * c];
}

export function toWorld(p: Placement, u: number, v: number): P2 {
  const [a, b] = rotate(u, v, p.yaw);
  return [p.x + a, p.z + b];
}

export function toLocal(p: Placement, x: number, z: number): P2 {
  return unrotate(x - p.x, z - p.z, p.yaw);
}

/** Coordinates written to blueprints / placed features: 1 mm steps (compact, exact on reload). */
export const roundMm = (v: number) => Math.round(v * 1000) / 1000;
export const roundCm = (v: number) => Math.round(v * 100) / 100;

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * A natural feature mapped point-wise by `map`, turned by `yaw`, with absolute elevations
 * shifted by `dy` (lake surfaces) and its noise frame carried along: the relief of a moved /
 * turned landform is exactly the source relief (see NoiseFrame).
 *
 * `frameMap(o)` maps the frame origin like a point. A frame that ends up at the identity is
 * dropped, so a feature captured and placed back where it came from is the same value.
 */
export function mapFeature(f: Feature, id: string, map: (x: number, z: number) => P2, yaw: number, dy: number): Feature {
  const pts = (list: readonly P2[]): P2[] => list.map(([x, z]) => { const [a, b] = map(x, z); return [roundMm(a), roundMm(b)]; });
  const frame = (fr: NoiseFrame | undefined): NoiseFrame | undefined => {
    const [ox, oz] = map(fr?.x ?? 0, fr?.z ?? 0);
    const out = { x: ox, z: oz, yaw: wrapAngle((fr?.yaw ?? 0) + yaw) };
    return out.x === 0 && out.z === 0 && out.yaw === 0 ? undefined : out;
  };
  const withFrame = <T extends { frame?: NoiseFrame }>(g: T, fr: NoiseFrame | undefined): T => {
    const { frame: _drop, ...rest } = g;
    void _drop;
    return (fr ? { ...rest, frame: fr } : rest) as T;
  };
  switch (f.kind) {
    case 'mountain':
    case 'hill': {
      const [x, z] = map(f.x, f.z);
      return withFrame({ ...f, id, x: roundMm(x), z: roundMm(z) }, frame(f.frame));
    }
    case 'ridge':
    case 'valley':
    case 'canyon':
      return withFrame({ ...f, id, points: pts(f.points) }, frame(f.frame));
    case 'river':
      return { ...f, id, points: pts(f.points) };
    case 'lake':
      return { ...f, id, points: pts(f.points), surface: roundCm(f.surface + dy) };
    case 'coast':
      return { ...f, id, points: pts(f.points) };
  }
}

/** World map of a placement for features: frame origins are points too (o'' = T + R·o'). */
export function placementMap(p: Placement): (x: number, z: number) => P2 {
  return (u, v) => toWorld(p, u, v);
}

// ── Grids ────────────────────────────────────────────────────────────────────

export interface LocalGrid {
  x0: number;
  z0: number;
  nx: number;
  nz: number;
  cell: number;
}

/** Bilinear sample of a local grid (null outside it). */
export function sampleBilinear(g: LocalGrid, data: Float32Array, u: number, v: number): number | null {
  const fx = (u - g.x0) / g.cell, fz = (v - g.z0) / g.cell;
  if (fx < -1e-6 || fz < -1e-6 || fx > g.nx - 1 + 1e-6 || fz > g.nz - 1 + 1e-6) return null;
  const ix = Math.min(g.nx - 2, Math.max(0, Math.floor(fx))), iz = Math.min(g.nz - 2, Math.max(0, Math.floor(fz)));
  if (g.nx === 1 || g.nz === 1) return data[Math.round(Math.max(0, fz)) * g.nx + Math.round(Math.max(0, fx))];
  const ax = Math.min(1, Math.max(0, fx - ix)), az = Math.min(1, Math.max(0, fz - iz));
  const i = iz * g.nx + ix;
  return (data[i] * (1 - ax) + data[i + 1] * ax) * (1 - az) + (data[i + g.nx] * (1 - ax) + data[i + g.nx + 1] * ax) * az;
}

/** Nearest vertex index of a local grid (−1 outside). */
export function nearestIndex(g: LocalGrid, u: number, v: number): number {
  const ix = Math.round((u - g.x0) / g.cell), iz = Math.round((v - g.z0) / g.cell);
  if (ix < 0 || iz < 0 || ix >= g.nx || iz >= g.nz) return -1;
  return iz * g.nx + ix;
}
