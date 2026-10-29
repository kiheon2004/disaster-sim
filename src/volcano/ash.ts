/**
 * Volcanic ash (Phase 28) — a separate material from fire smoke (Phase 27 soot tracer): its own state,
 * its own ledger, never merged with the smoke variables. Lagrangian PUFFS, not a plume solution:
 *
 *  release   every RELEASE_PERIOD each vent emits the ash share of what it erupted since the last
 *            release as one puff per size class, at `plumeHeight` above the vent (the plume's rise is
 *            prescribed, not computed), initial spread σ₀ = 0.15·H (assumed)
 *  advection the mean wind at the puff height, U(y) = U₁₀·(y/10)^0.14 (the Phase 26 air-layer profile)
 *  settling  terminal velocity of a sphere, drag C_d = 24/Re·(1 + 0.15·Re^0.687) (Schiller–Naumann,
 *            Re < 1000; 0.44 above), particle density 2000 kg/m³ (assumed, vesicular glass 1000–2500)
 *  spreading σ² grows by 2·K·dt, K = 1 m²/s (assumed horizontal eddy diffusivity at these scales)
 *  rain      wet removal with a scavenging coefficient Λ = 1·10⁻⁴·I^0.8 s⁻¹ (I in mm/h; the usual
 *            power form for below-cloud scavenging of particles, coefficients assumed)
 *  landing   when the puff reaches the ground its mass is spread over a Gaussian footprint (2.5 σ,
 *            normalized over the whole footprint; the part beyond the world's edge is outflow)
 *  outflow   puffs whose centre leaves the world (or rises above CEILING) — booked, not dropped
 * Size classes (assumed split, a third each): 0.063 mm (fine ash), 0.25 mm, 1 mm (coarse ash).
 */
import { GRAVITY } from '@/core/units';

export const RELEASE_PERIOD = 1;
export const ASH_PARTICLE_DENSITY = 2000;
export const EDDY_K = 1;
export const CEILING = 2000;
export const ASH_CLASSES = [
  { d: 0.063e-3, share: 1 / 3 },
  { d: 0.25e-3, share: 1 / 3 },
  { d: 1e-3, share: 1 / 3 },
] as const;

const MU_AIR = 1.81e-5;

/**
 * Terminal settling velocity (m/s) of a sphere of diameter d (m), density ρp, in air of density ρa.
 * Phase 29: viscosity μ (Pa·s) and the Cunningham slip correction Cc (rarefied air: the drag of the
 * Stokes regime divided by Cc) as optional inputs — the defaults are the Phase 28 values exactly.
 */
export function settlingVelocity(d: number, rhoP = ASH_PARTICLE_DENSITY, rhoA = 1.2, mu = MU_AIR, slip = 1): number {
  const MU = mu;
  if (!(rhoA > 0)) return Infinity;
  let v = ((rhoP - rhoA) * GRAVITY * d * d * slip) / (18 * MU); // Stokes start
  for (let it = 0; it < 60; it++) {
    const Re = (rhoA * v * d) / MU;
    const Cd = (Re < 1000 ? (24 / Math.max(Re, 1e-9)) * (1 + 0.15 * Re ** 0.687) : 0.44) / slip;
    const next = Math.sqrt((4 * (rhoP - rhoA) * GRAVITY * d) / (3 * Cd * rhoA));
    if (Math.abs(next - v) < 1e-7 * v) { v = next; break; }
    v = 0.5 * (v + next);
  }
  return v;
}

export const VS = ASH_CLASSES.map((c) => settlingVelocity(c.d));

export interface Puff {
  vent: number;
  cls: number;
  x: number;
  y: number;
  z: number;
  mass: number;
  sigma: number;
  born: number;
}

/** Wet scavenging coefficient (1/s) for a rain intensity (mm/h). */
export const scavenging = (I: number) => (I > 0 ? 1e-4 * I ** 0.8 : 0);

/** Wind speed at a height above the ground (m/s) from the 10 m wind. */
export const windAt = (u10: number, y: number) => u10 * Math.pow(Math.max(0.5, y) / 10, 0.14);

export interface AshGrid {
  nx: number;
  nz: number;
  dx: number;
  originX: number;
  originZ: number;
}

/**
 * Footprint weights of a Gaussian (σ) at (x, z): vertex → share of the mass; `outside` is the share that
 * falls beyond the grid. Shares sum to 1 exactly (normalized over every sample of the truncated disc).
 */
export function footprint(g: AshGrid, x: number, z: number, sigma: number): { cells: number[]; w: number[]; outside: number } {
  const s = Math.max(sigma, 0.5 * g.dx);
  const R = 2.5 * s;
  const r = Math.ceil(R / g.dx);
  const cx = Math.round((x - g.originX) / g.dx), cz = Math.round((z - g.originZ) / g.dx);
  const cells: number[] = [], w: number[] = [];
  let tot = 0, out = 0;
  for (let jz = cz - r; jz <= cz + r; jz++) for (let jx = cx - r; jx <= cx + r; jx++) {
    const px = g.originX + jx * g.dx, pz = g.originZ + jz * g.dx;
    const d2 = (px - x) ** 2 + (pz - z) ** 2;
    if (d2 > R * R) continue;
    const v = Math.exp(-d2 / (2 * s * s));
    tot += v;
    if (jx < 0 || jz < 0 || jx >= g.nx || jz >= g.nz) { out += v; continue; }
    cells.push(jz * g.nx + jx);
    w.push(v);
  }
  if (tot <= 0) return { cells: [], w: [], outside: 1 };
  for (let k = 0; k < w.length; k++) w[k] /= tot;
  return { cells, w, outside: out / tot };
}
