/**
 * Celestial presets (Phase 32). Every preset is an EDUCATIONAL compact mass (10¹³–10¹⁶ kg, μ = G·M of 10³–10⁶ m³/s²,
 * real G) sized to the 200 m sandbox — "Scaled Educational Gravity — Not a Real Astrophysical Black Hole" — except
 * "Scientific Comparison", which runs in the physical mode and lists what a real stellar black hole would give at
 * the same place (computed, not simulated). The orbit laboratories need the uniform gravity off: their demo world
 * adds a Phase 31 gravity experiment (zero, constant, hold) — composition, not a second gravity.
 *
 * Each preset documents its expected phenomenon, initial conditions, time scale, expected result, model scope and
 * failure conditions (`PRESET_INFO`, i18n keys; numbers from celestial/outlook.ts).
 */
import type { Vec3 } from '@/core/types';
import { G_N } from './constants';
import { defaultCelestialSpec, type CelestialScenario, type CelestialSourceSpec, type CelestialSpec, type ProbeSpec } from './types';

const M = (mu: number) => mu / G_N;
const bh = (p: Partial<CelestialSourceSpec> = {}): CelestialSourceSpec => ({ kind: 'blackHole', center: [0, 30, 0], mass: M(5e4), softening: 2, capture: 1.5, influence: 0, massPolicy: 'fixed', motion: 'fixed', ramp: 2, ...p });
const probe = (position: Vec3, mode: ProbeSpec['mode'], factor: number, direction: Vec3, p: Partial<ProbeSpec> = {}): ProbeSpec => ({ position, mode, factor, direction, mass: 50, radius: 0.6, ...p });
const custom = (position: Vec3, velocity: Vec3, p: Partial<ProbeSpec> = {}): ProbeSpec => ({ position, mode: 'custom', factor: 1, direction: [1, 0, 0], velocity, mass: 50, radius: 0.6, ...p });
const noDisc = { visual: false, particles: 0, inner: 6, outer: 20, particleMass: 1 };
const disc = { ...noDisc, visual: true };

/** Scenarios whose demo world switches the uniform gravity off (orbit laboratories). */
export const ZERO_G_SCENARIOS: readonly CelestialScenario[] = ['gentleOrbit', 'circularOrbit', 'ellipticalOrbit', 'escape', 'flyby', 'tidalStretch', 'binary', 'accretion', 'comparison'];
/** Laboratory centre of the orbit presets (m). */
export const LAB: Vec3 = [0, 60, 0];

/** Spec fields a scenario sets (the editor applies them over the current spec). */
export function scenarioDefaults(s: CelestialScenario): Partial<CelestialSpec> {
  const base: Partial<CelestialSpec> = { scale: 'educational', probes: [], accretion: disc, end: 'restore', tidal: true, lensing: false, limitPolicy: 'warn' };
  const lab = (p: Partial<CelestialSourceSpec> = {}) => bh({ center: LAB, mass: M(5e4), softening: 1, capture: 1, ramp: 0, ...p });
  switch (s) {
    case 'compactWell': return { ...base, duration: 90, sources: [bh({ ramp: 4 })] };
    case 'gentleOrbit': return {
      ...base, duration: 120, sources: [bh({ center: [0, 50, 0], mass: M(2e4), softening: 3, capture: 1.5, ramp: 0 })],
      probes: [probe([15, 50, 0], 'circular', 1, [0, 0, 1]), probe([0, 75, 0], 'circular', 1, [1, 0, 0]), probe([-35, 50, 0], 'circular', 1, [0, 0.5, -1])],
    };
    case 'circularOrbit': return { ...base, duration: 120, sources: [lab()], probes: [probe([30, 60, 0], 'circular', 1, [0, 0, 1])] };
    case 'ellipticalOrbit': return { ...base, duration: 120, sources: [lab()], probes: [probe([40, 60, 0], 'circular', 0.7, [0, 0, 1])] };
    case 'escape': return {
      ...base, duration: 90, sources: [lab()],
      probes: [probe([20, 60, 0], 'escape', 0.9, [0, 0, 1]), probe([0, 60, 20], 'escape', 1.05, [-1, 0, 0]), probe([-20, 60, 0], 'escape', 1.3, [0, 0, -1])],
    };
    case 'flyby': return { ...base, duration: 60, sources: [lab()], probes: [custom([-180, 60, 20], [40, 0, 0]), custom([-180, 60, 40], [40, 0, 0])] };
    case 'tidalStretch': return { ...base, duration: 90, sources: [bh({ center: [-10, 20, 6], mass: M(3e4), softening: 2, capture: 1, ramp: 6 })] };
    case 'tidalFailure': return { ...base, duration: 120, sources: [bh({ center: [0, 45, 0], mass: M(3e5), softening: 4, capture: 3, ramp: 20 })] };
    case 'capture': return { ...base, duration: 60, sources: [bh({ center: [-10, 12, 8], softening: 2, capture: 2.5, ramp: 3 })] };
    case 'growing': return {
      ...base, duration: 90, sources: [bh({ center: [-10, 12, 8], softening: 2, capture: 2.5, ramp: 3, massPolicy: 'grow' })],
      accretion: { visual: true, particles: 600, inner: 4, outer: 14, particleMass: 1000, spread: 0.45 },
    };
    case 'moving': return {
      ...base, duration: 90, sources: [bh({ center: [-90, 25, -20], mass: M(8e4), softening: 2.5, capture: 2, ramp: 4, motion: 'path', path: [[0, -90, 25, -20], [30, 0, 25, 0], [60, 90, 25, 20]] })],
    };
    case 'binary': return {
      ...base, duration: 120, sources: [lab({ center: [-25, 60, 0], mass: M(3e4), softening: 2, capture: 1.5 }), lab({ center: [25, 60, 0], mass: M(3e4), softening: 2, capture: 1.5 })],
      probes: [custom([70, 60, 0], [0, 0, Math.sqrt(6e4 / 70)]), custom([0, 60, 0.5], [0, 0, 5])],
    };
    case 'accretion': return {
      ...base, duration: 120, sources: [bh({ center: [0, 50, 0], ramp: 0 })],
      accretion: { visual: true, particles: 1500, inner: 5, outer: 25, particleMass: 1, spread: 0.3 },
    };
    case 'nearCity': return { ...base, duration: 150, sources: [bh({ center: [0, 60, 0], mass: M(2e5), softening: 3, capture: 2.5, ramp: 30 })] };
    case 'nearMountain': return { ...base, duration: 120, sources: [bh({ center: [40, 55, 0], mass: M(1e5), softening: 3, capture: 2.5, ramp: 10 })] };
    case 'nearLake': return { ...base, duration: 120, sources: [bh({ center: [60, 80, 28], mass: M(5e4), softening: 3, capture: 2, ramp: 10 })] };
    case 'meteor': return { ...base, duration: 90, sources: [bh({ center: [-20, 40, -10], mass: M(1e5), softening: 3, capture: 2.5, ramp: 5 })] };
    case 'collapse': return { ...base, duration: 120, sources: [bh({ center: [30, 50, 30], mass: M(1.5e5), softening: 3, capture: 2.5, ramp: 15 })] };
    case 'stress': return {
      ...base, duration: 300, limitPolicy: 'warn',
      sources: [
        bh({ center: [0, 45, 0], mass: M(1e5), softening: 3, capture: 2.5, ramp: 10, massPolicy: 'grow' }),
        bh({ center: [-60, 30, -40], mass: M(5e4), softening: 2, capture: 1.5, ramp: 5, motion: 'velocity', velocity: [1.5, 0, 1] }),
        bh({ center: [60, 35, 40], mass: M(5e4), softening: 2, capture: 1.5, ramp: 5, motion: 'path', path: [[0, 60, 35, 40], [100, -60, 35, 40], [200, 60, 35, -40]] }),
        bh({ kind: 'compact', center: [0, 80, -60], mass: M(2e4), softening: 3, capture: 0, ramp: 5 }),
      ],
      probes: Array.from({ length: 16 }, (_, k) => probe([30 * Math.cos(k * 0.3927), 45 + (k % 4) * 4, 30 * Math.sin(k * 0.3927)], 'circular', 0.8 + 0.03 * k, [-Math.sin(k * 0.3927), 0.2, Math.cos(k * 0.3927)], { source: 0 })),
      accretion: { visual: true, particles: 2000, inner: 5, outer: 30, particleMass: 10, spread: 0.4 },
    };
    case 'comparison': return {
      ...base, scale: 'physical', duration: 120,
      // 10¹⁴ kg: a small-asteroid mass compressed to a point (μ = 6674 m³/s²). Two probes: far outside the softening
      // (Kepler period 2π√(r³/μ)) and inside it (Plummer core: harmonic, period 2π(r² + ε²)^{3/4}/√μ).
      sources: [bh({ kind: 'compact', center: LAB, mass: 1e14, softening: 4, capture: 0, ramp: 0 })],
      probes: [probe([40, 60, 0], 'circular', 1, [0, 0, 1]), probe([0, 60, 2], 'circular', 1, [1, 0, 0])],
      accretion: noDisc,
    };
    case 'custom': return {};
  }
}

/** A complete spec of a scenario. */
export function presetSpec(s: CelestialScenario): CelestialSpec {
  return { ...defaultCelestialSpec(), ...scenarioDefaults(s), scenario: s } as CelestialSpec;
}

/** Documentation keys of a preset (i18n: celestial.info.<scenario>.<field>). */
export const PRESET_FIELDS = ['expect', 'initial', 'scale', 'result', 'scope', 'failure'] as const;
