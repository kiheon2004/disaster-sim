/**
 * Heat source timing (Phase 26): output power / energy and prescribed temperature as exact functions
 * of the source's local time. Power input: P(t) = P₀·s(t). Energy input: P₀ = E / ∫s dt, so the
 * delivered total is exactly E whatever the profile (instant: E at t = 0).
 */
import { shapeAt, shapeIntegral, shapeTotal } from './profiles';
import { DEFAULT_RADIATIVE_FRACTION, type HeatSourceSpec } from './types';

/** P₀ (W) of a power-type source (instant: not a power — returns the energy J). */
export function amplitude(s: HeatSourceSpec): number {
  if (s.kind === 'temperature') return 0;
  if (s.input === 'power') return s.power ?? 0;
  const total = shapeTotal(s);
  return total > 0 ? (s.energy ?? 0) / total : 0;
}

/** Energy output over the local interval [a, b) (J). */
export function intervalEnergy(s: HeatSourceSpec, a: number, b: number): number {
  if (s.kind === 'temperature') return 0;
  return amplitude(s) * shapeIntegral(s, a, b);
}

/** Total output of the source (J). */
export function totalEnergy(s: HeatSourceSpec): number {
  return s.kind === 'temperature' ? 0 : amplitude(s) * shapeTotal(s);
}

/** Peak power of the source (W; instant: its energy over a 0.1 s step, informational). */
export function peakPower(s: HeatSourceSpec): number {
  if (s.kind === 'temperature') return 0;
  if (s.profile === 'instant') return (s.energy ?? 0) / 0.1;
  return amplitude(s);
}

/** Prescribed temperature over [a, b): the reference plus the profile-averaged excess (K). */
export function intervalTemperature(s: HeatSourceSpec, a: number, b: number, Tref: number): number {
  const T = s.temperature ?? Tref;
  const avg = b > a ? shapeIntegral(s, a, b) / (b - a) : shapeAt(s, a);
  return Tref + (T - Tref) * avg;
}

export const radiativeFraction = (s: HeatSourceSpec) => (s.kind === 'point' ? s.radiativeFraction ?? DEFAULT_RADIATIVE_FRACTION : 0);

/** Is the source delivering anything in [a, b)? */
export function activeIn(s: HeatSourceSpec, a: number, b: number): boolean {
  if (s.profile === 'instant') return a <= 0 && 0 < b;
  return b > 0 && a < s.duration;
}
