/**
 * Ground receivers of a heat source (Phase 26) — ONE function used by the simulation (the run's
 * receiver weights) and by the editor preview (the expected incident flux map), so the preview is
 * the model the run uses, not a picture of it.
 *
 *  point        absorbed share of a cell = f_rad·ε·A·cosθ/(4π·r²)   (cells with irradiance ≥ the floor)
 *  area         uniform: 1/N over the exposed cells of the disc
 *  surface      the ground part of the surface-heating sphere (cells whose ground lies inside it)
 *  temperature  immersed cells: radiation F = 1 + convection with gas at T_s; outside: ε·A·cosθ·(R/r)²
 * Objects shading the ground are applied by the run (it knows them); the preview says so.
 */
import { IRRADIANCE_FLOOR, type HeatSourceSpec } from './types';
import { amplitude, radiativeFraction } from './sources';
import { sphereViewFactor } from './radiation';
import { SIGMA } from './units';

export interface GroundGrid {
  nx: number;
  nz: number;
  cell: number;
  originX: number;
  originZ: number;
  /** Ground height at a point. */
  height(x: number, z: number): number;
  /** Cell is under a building (no exposure), optional. */
  covered?(c: number): boolean;
  /** Surface emissivity of a cell (wet cells: water). */
  emissivity(c: number): number;
}

export interface GroundReceiver {
  cell: number;
  /** Power sources: share of the output absorbed (0–1). Temperature sources: radiative area A·F (m²). */
  w: number;
  /** Temperature sources: immersed convective area (m²). */
  aConv: number;
  eps: number;
}

/** Horizontal reach of the direct heating of a source (m). */
export function sourceReach(spec: HeatSourceSpec, Tref: number): number {
  if (spec.kind === 'point') {
    const P0 = spec.profile === 'instant' ? (spec.energy ?? 0) : amplitude(spec);
    return Math.min(100, Math.sqrt((radiativeFraction(spec) * P0) / (4 * Math.PI * IRRADIANCE_FLOOR)));
  }
  if (spec.kind === 'temperature') {
    const E4 = SIGMA * Math.abs((spec.temperature ?? Tref) ** 4 - Tref ** 4);
    return Math.min(60, spec.radius * Math.sqrt(E4 / IRRADIANCE_FLOOR)) + spec.radius;
  }
  return spec.radius;
}

export function groundReceivers(spec: HeatSourceSpec, g: GroundGrid, Tref: number): GroundReceiver[] {
  const [sx, sz] = spec.position;
  const yg = g.height(sx, sz);
  const Py = yg + spec.height;
  const out: GroundReceiver[] = [];
  const reach = sourceReach(spec, Tref);
  const forCells = (r: number, f: (c: number, x: number, z: number, y: number) => void) => {
    const i0 = Math.max(0, Math.floor((sx - r - g.originX) / g.cell)), i1 = Math.min(g.nx - 1, Math.floor((sx + r - g.originX) / g.cell));
    const k0 = Math.max(0, Math.floor((sz - r - g.originZ) / g.cell)), k1 = Math.min(g.nz - 1, Math.floor((sz + r - g.originZ) / g.cell));
    for (let iz = k0; iz <= k1; iz++) for (let ix = i0; ix <= i1; ix++) {
      const x = g.originX + (ix + 0.5) * g.cell, z = g.originZ + (iz + 0.5) * g.cell;
      if ((x - sx) ** 2 + (z - sz) ** 2 > r * r) continue;
      const c = iz * g.nx + ix;
      if (g.covered?.(c)) continue;
      f(c, x, z, g.height(x, z));
    }
  };
  const A = g.cell * g.cell;
  switch (spec.kind) {
    case 'point': {
      if (Py - yg <= 0.01) break;
      const frac = radiativeFraction(spec);
      const P0 = Math.max(1e-9, spec.profile === 'instant' ? (spec.energy ?? 0) : amplitude(spec));
      forCells(reach, (c, x, z, y) => {
        const dy = Py - y;
        if (dy <= 0) return;
        const r = Math.hypot(x - sx, dy, z - sz);
        const f = (frac * A * (dy / r)) / (4 * Math.PI * r * r);
        if ((f * P0) / A < IRRADIANCE_FLOOR) return;
        const eps = g.emissivity(c);
        out.push({ cell: c, w: f * eps, aConv: 0, eps });
      });
      break;
    }
    case 'area': {
      forCells(spec.radius, (c) => out.push({ cell: c, w: 0, aConv: 0, eps: g.emissivity(c) }));
      for (const r of out) r.w = 1 / out.length;
      break;
    }
    case 'surface': {
      forCells(spec.radius, (c, _x, _z, y) => { if (Math.abs(y - Py) <= spec.radius) out.push({ cell: c, w: A, aConv: 0, eps: g.emissivity(c) }); });
      break;
    }
    case 'temperature': {
      const R = spec.radius;
      forCells(reach, (c, x, z, y) => {
        const dy = Py - y;
        const r = Math.hypot(x - sx, dy, z - sz);
        const eps = g.emissivity(c);
        if (r <= R) { out.push({ cell: c, w: A, aConv: A, eps }); return; }
        if (dy <= 0) return;
        out.push({ cell: c, w: A * (dy / r) * sphereViewFactor(R, r), aConv: 0, eps });
      });
      break;
    }
    default:
      break;
  }
  return out;
}

/** Expected absorbed flux on each receiver at the source's peak output (W/m²) — preview. */
export function receiverFlux(spec: HeatSourceSpec, rs: readonly GroundReceiver[], cellArea: number, Tref: number, Tground = Tref): Float32Array {
  const out = new Float32Array(rs.length);
  if (spec.kind === 'temperature') {
    const T = spec.temperature ?? Tref;
    const d4 = SIGMA * (T ** 4 - Tground ** 4);
    rs.forEach((r, k) => { out[k] = (r.eps * d4 * r.w) / cellArea + (r.aConv > 0 ? 10 * (T - Tground) : 0); });
    return out;
  }
  const P = spec.profile === 'instant' ? (spec.energy ?? 0) : amplitude(spec);
  let sum = 0;
  for (const r of rs) sum += r.w;
  rs.forEach((r, k) => { out[k] = spec.kind === 'surface' ? (P * r.w) / Math.max(1e-9, sum) / cellArea : (P * r.w) / cellArea; });
  return out;
}
