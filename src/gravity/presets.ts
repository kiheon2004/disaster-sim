/**
 * Gravity presets (Phase 31). The Moon / Mars presets take the surface gravity MAGNITUDE only (1.62 / 3.71 m/s²) —
 * the air, the ground and the climate stay those of the project; nothing here claims to be the real body.
 */
import type { GravityScenario, GravitySourceSpec, GravitySpec } from './types';
import { EARTH_G } from './types';

const DOWN: [number, number, number] = [0, -1, 0];

/** Spec fields a scenario sets (the editor applies them over the current spec). */
export function scenarioDefaults(s: GravityScenario): Partial<GravitySpec> {
  const base = { global: true, direction: DOWN, transition: 'vector' as const, end: 'restore' as const, sources: [] as GravitySourceSpec[], stages: undefined, windows: undefined, period: undefined, pulseWidth: undefined };
  switch (s) {
    case 'earth': return { ...base, magnitude: EARTH_G, profile: 'constant', duration: 60, ramp: undefined };
    case 'moon': return { ...base, magnitude: 1.62, profile: 'smooth', ramp: 10, duration: 120 };
    case 'mars': return { ...base, magnitude: 3.71, profile: 'smooth', ramp: 10, duration: 120 };
    case 'high': return { ...base, magnitude: 1.5 * EARTH_G, profile: 'smooth', ramp: 10, duration: 120 };
    case 'double': return { ...base, magnitude: 2 * EARTH_G, profile: 'smooth', ramp: 10, duration: 120 };
    case 'zero': return { ...base, magnitude: 0, profile: 'smooth', ramp: 5, duration: 60 };
    case 'reverse': return { ...base, magnitude: EARTH_G, direction: [0, 1, 0], profile: 'smooth', ramp: 4, duration: 30 };
    case 'sideways': return { ...base, magnitude: EARTH_G, direction: [1, 0, 0], transition: 'rotate', profile: 'smooth', ramp: 6, duration: 30 };
    case 'ramp': return { ...base, magnitude: 3 * EARTH_G, profile: 'linear', ramp: 120, duration: 180, end: 'hold' };
    case 'pulse': return { ...base, magnitude: 0, profile: 'pulse', period: 10, pulseWidth: 4, ramp: 0.5, duration: 60 };
    case 'well': return { ...base, global: false, magnitude: EARTH_G, profile: 'smooth', ramp: 3, duration: 60, sources: [{ kind: 'radial', center: [0, 2, 0], radius: 25, falloff: 'smooth', edge: 8, strength: 15, r0: 5, law: 'inverseSquare', softening: 3, followProfile: true }] };
    case 'repulsor': return { ...base, global: false, magnitude: EARTH_G, profile: 'smooth', ramp: 3, duration: 60, sources: [{ kind: 'radial', center: [0, 0, 0], radius: 20, falloff: 'smooth', edge: 6, strength: -12, r0: 5, law: 'inverseSquare', softening: 3, followProfile: true }] };
    case 'radial': return { ...base, magnitude: 0, profile: 'smooth', ramp: 5, duration: 90, sources: [{ kind: 'radial', center: [0, 10, 0], radius: 80, falloff: 'smooth', edge: 20, strength: EARTH_G, r0: 20, law: 'linear', softening: 1, followProfile: true }] };
    case 'highSnow': return { ...base, magnitude: 2 * EARTH_G, profile: 'linear', ramp: 60, duration: 180, end: 'hold' };
    case 'highCollapse': return { ...base, magnitude: 4 * EARTH_G, profile: 'linear', ramp: 90, duration: 180, end: 'hold' };
    case 'custom': return {};
  }
}

/** A complete spec of a scenario. */
export function presetSpec(s: GravityScenario): GravitySpec {
  const d = scenarioDefaults(s);
  return { event: 'gravity', scenario: s, global: true, magnitude: EARTH_G, direction: DOWN, transition: 'vector', profile: 'constant', duration: 60, end: 'restore', sources: [], ...d } as GravitySpec;
}

/** Scenarios that need a snow cover to show their point (the editor adds a matching climate experiment). */
export const SNOW_SCENARIOS: readonly GravityScenario[] = ['highSnow'];
