/**
 * Outlook of an atmosphere experiment before it runs (Phase 29, pure): the reference state and what
 * the plan does to the air MASS, with the SAME relations the run uses (ISA default, ρ = p/RT,
 * hydrostatic columns, the planned path, the adiabatic exponent) — the initial pressure / density field
 * over the actual terrain, the removal rate, the end state with and without the expansion cooling,
 * the boiling point of water and the mean free path there. Not a prediction of flows or of damage.
 */
import type { TerrainData } from '@/core/model';
import { datumState } from '@/events/atmosphere/AtmosphereEvent';
import { G, KAPPA, R_AIR, boilingPoint, density, knudsen, meanFreePath, scaleHeight, soundSpeed } from './reference';
import { plannedPath, removalFinal } from './schedule';
import { atmosphereIssues, atmosphereWarnings, type AtmosphereSpec } from './types';

export interface AtmosOutlook {
  p0: number;
  T0: number;
  rho0: number;
  Hs: number;
  c: number;
  /** Column mass per area at the datum (kg/m²) and the world's air mass (kg). */
  sigma0: number;
  mass: number;
  /** Pressure range over the terrain (Pa) and the density range at 1 m (kg/m³). */
  pLow: number;
  pHigh: number;
  rhoLow: number;
  rhoHigh: number;
  /** Planned removal (kg) and its mean rate (kg/s); the end share. */
  removed: number;
  rate: number;
  endShare: number;
  /** End state at the datum: pressure, adiabatic temperature and density, isothermal density. */
  pEnd: number;
  TendAdiabatic: number;
  rhoEndAdiabatic: number;
  rhoEndIsothermal: number;
  boilingStart: number;
  boilingEnd: number;
  /** Mean free path at the end (m) and the Knudsen number of a 1 m object. */
  lambdaEnd: number;
  knEnd: number;
  /** Domain pressure-adjustment time (s). */
  adjust: number;
  path: [number, number][];
  issues: string[];
  warnings: string[];
}

export function atmosphereOutlook(spec: AtmosphereSpec, terrain: TerrainData, ground: (x: number, z: number) => number): AtmosOutlook {
  const { p: p0, T: T0 } = datumState(spec);
  const Hs = scaleHeight(T0);
  const W = (terrain.nx - 1) * terrain.cellSize, D = (terrain.nz - 1) * terrain.cellSize;
  let pLow = Infinity, pHigh = -Infinity, M = 0;
  const step = 5;
  for (let z = terrain.originZ + step / 2; z < terrain.originZ + D; z += step) for (let x = terrain.originX + step / 2; x < terrain.originX + W; x += step) {
    const p = p0 * Math.exp(-ground(x, z) / Hs);
    if (p < pLow) pLow = p;
    if (p > pHigh) pHigh = p;
    M += (p / G) * step * step;
  }
  const end = removalFinal(spec);
  const pEnd = p0 * end;
  const Tad = T0 * Math.pow(end, KAPPA);
  const removed = M * (1 - end);
  const dur = spec.removal === 'none' ? 0 : spec.duration ?? 0;
  return {
    p0, T0, rho0: density(p0, T0), Hs, c: soundSpeed(T0), sigma0: p0 / G, mass: M,
    pLow, pHigh, rhoLow: density(pLow, T0), rhoHigh: density(pHigh, T0),
    removed, rate: dur > 0 ? removed / dur : 0, endShare: end,
    pEnd, TendAdiabatic: Tad, rhoEndAdiabatic: pEnd / (R_AIR * Tad), rhoEndIsothermal: density(pEnd, T0),
    boilingStart: boilingPoint(p0), boilingEnd: boilingPoint(pEnd),
    lambdaEnd: meanFreePath(pEnd, T0), knEnd: knudsen(pEnd, T0, 1),
    adjust: Math.max(W, D) / soundSpeed(T0),
    path: plannedPath(spec),
    issues: atmosphereIssues(spec),
    warnings: atmosphereWarnings(spec, p0),
  };
}
