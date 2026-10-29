/**
 * Outlook of a celestial experiment (Phase 32; editor, preview, HUD, results): the numbers a spec implies before it
 * runs — per source μ, r_s (reference), the peak acceleration, the substeps the integrator needs down to its resolved
 * radius, the escape speed there; per probe the predicted orbit of the single-source field (circular period, conic
 * periapsis / apoapsis / period or the hyperbolic deflection); which models stay valid, are limited or unsupported;
 * the limitation keys to show.
 *
 * Predictions are those of an unsoftened single source with no uniform field (the conic of Kepler's problem): they are
 * labelled `exact: false` when softening, a uniform part, several sources, motion or growth make them approximate.
 */
import type { Vec3 } from '@/core/types';
import { G_N, C_LIGHT, M_SUN, schwarzschildRadius } from './constants';
import { elements, circularSpeed, escapeSpeed, launchVelocity, circularPeriod } from './orbit';
import { CELESTIAL_LIMITS, plummerPeak, sourceRegime, type CelestialSpec } from './types';

export type Support = 'full' | 'scaled' | 'limited' | 'unsupported';
export const CELESTIAL_MODELS = [
  'orbits', 'rigid', 'contact', 'vehicles', 'people', 'debris', 'structureVertical', 'structureLateral', 'structureUplift',
  'capture', 'accretion', 'flood', 'atmosphere', 'fire', 'ground', 'meteor', 'relativity',
] as const;
export type CelestialModel = (typeof CELESTIAL_MODELS)[number];

export interface SourceOutlook {
  mu: number;
  mass: number;
  rs: number;
  peak: number;
  substeps: number;
  vEsc: number;
  within: boolean;
  relativistic: boolean;
  /** Radius where the source's pull equals the project gravity g₀ (m). */
  rEarth: number;
  /** Free-fall time from 20 m to the capture radius / centre (s, unsoftened). */
  fall20: number;
}

export interface ProbeOutlook {
  speed: number;
  kind: string;
  periapsis: number;
  apoapsis: number;
  period: number;
  /** Hyperbolic deflection angle (rad, NaN when bound). */
  deflection: number;
  /** Circular period at the start radius (s). */
  circular: number;
  exact: boolean;
  /** The predicted periapsis lies inside the capture radius (the probe will be captured). */
  captured: boolean;
}

export interface CelestialOutlook {
  sources: SourceOutlook[];
  probes: ProbeOutlook[];
  support: Record<CelestialModel, Support>;
  limits: string[];
  /** A real stellar black hole of 10 M☉ at the first source's distance scale (computed reference, not simulated). */
  real: { mass: number; rs: number; accel20: number; tidal20: number; vEsc20: number };
}

/** Outlook of a spec; `uniformZero`: the plan switches the uniform gravity off (orbit predictions are then exact up to
 *  softening). */
export function celestialOutlook(spec: CelestialSpec, g0 = 9.81, uniformZero = false): CelestialOutlook {
  const sources = spec.sources.map((s): SourceOutlook => {
    const reg = sourceRegime(s);
    const mu = G_N * s.mass;
    const r1 = s.kind === 'blackHole' ? s.capture : 0;
    const r0 = 20;
    const x = r1 / r0;
    const fall20 = r1 < r0 ? Math.sqrt(r0 ** 3 / (2 * mu)) * (Math.sqrt(x * (1 - x)) + Math.acos(Math.sqrt(x))) : 0;
    return { mu, mass: s.mass, rs: schwarzschildRadius(s.mass), peak: plummerPeak(mu, s.softening), substeps: reg.substeps, vEsc: reg.vEsc, within: reg.within, relativistic: reg.relativistic, rEarth: Math.sqrt(mu / g0), fall20 };
  });
  const single = spec.sources.length === 1;
  const probes = spec.probes.map((p): ProbeOutlook => {
    const s = spec.sources[p.source ?? 0];
    const c = s.motion === 'path' && s.path ? [s.path[0][1], s.path[0][2], s.path[0][3]] as Vec3 : s.center;
    const r: Vec3 = [p.position[0] - c[0], p.position[1] - c[1], p.position[2] - c[2]];
    const rm = Math.hypot(...r);
    const mu = G_N * s.mass;
    const v: Vec3 = p.mode === 'custom' ? [...(p.velocity ?? [0, 0, 0])] as Vec3
      : launchVelocity(r, p.direction, p.factor * (p.mode === 'circular' ? circularSpeed(mu, rm, s.softening) : escapeSpeed(mu, rm, s.softening)), p.mode === 'circular');
    const el = elements(mu, r, v, 0);
    const deflection = el.kind === 'hyperbolic' ? 2 * Math.asin(Math.min(1, 1 / el.e)) : NaN;
    const exact = single && uniformZero && s.motion === 'fixed' && s.massPolicy !== 'grow' && el.periapsis > 5 * s.softening && (s.ramp ?? 0) === 0;
    return { speed: Math.hypot(...v), kind: el.kind, periapsis: el.periapsis, apoapsis: el.apoapsis, period: el.period, deflection, circular: circularPeriod(mu, rm, s.softening), exact, captured: s.kind === 'blackHole' && el.periapsis <= s.capture };
  });
  const anyMoving = spec.sources.some((s) => s.motion !== 'fixed');
  const support: Record<CelestialModel, Support> = {
    orbits: sources.every((s) => s.within) ? 'full' : 'limited',
    rigid: 'full', contact: 'full', debris: 'full',
    vehicles: 'limited', people: 'limited',
    structureVertical: 'scaled',
    structureLateral: spec.tidal ? 'limited' : 'unsupported',
    structureUplift: spec.tidal ? 'limited' : 'unsupported',
    capture: 'limited',
    accretion: spec.accretion.particles > 0 ? 'limited' : 'unsupported',
    flood: 'limited', atmosphere: 'unsupported', fire: 'limited', ground: 'limited', meteor: 'limited',
    relativity: 'unsupported',
  };
  const limits: string[] = ['celestial.lim.newtonian', 'celestial.lim.softening', 'celestial.lim.capture', 'celestial.lim.noGR'];
  if (spec.scale === 'educational') limits.push('celestial.lim.scaled');
  if (spec.sources.length > 1) limits.push('celestial.lim.external');
  if (anyMoving) limits.push('celestial.lim.moving');
  if (spec.sources.some((s) => s.massPolicy === 'grow')) limits.push('celestial.lim.growth');
  if (spec.accretion.visual) limits.push('celestial.lim.discVisual');
  if (spec.accretion.particles > 0) limits.push('celestial.lim.particles');
  if (spec.lensing) limits.push('celestial.lim.lens');
  if (spec.tidal) limits.push('celestial.lim.structure');
  limits.push('celestial.lim.vertical', 'celestial.lim.vehicles');
  if (sources.some((s) => !s.within)) limits.push(sources.some((s) => s.relativistic) ? 'celestial.lim.relativistic' : 'celestial.lim.substeps');
  if (spec.sources.some((s) => s.influence > 0)) limits.push('celestial.lim.influence');
  if (!uniformZero && spec.probes.length) limits.push('celestial.lim.uniformOrbit');
  const mReal = 10 * M_SUN, muR = G_N * mReal;
  return {
    sources, probes, support, limits,
    real: { mass: mReal, rs: schwarzschildRadius(mReal), accel20: muR / 400, tidal20: (2 * muR) / 8000, vEsc20: Math.min(C_LIGHT, Math.sqrt((2 * muR) / 20)) },
  };
}


/** Numerical limits shown in the editor (docs §19). */
export const LIMIT_ROWS = CELESTIAL_LIMITS;
