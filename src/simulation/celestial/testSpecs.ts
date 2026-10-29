/** Celestial experiment specs for tests and benchmarks (Phase 32). */
import type { Vec3 } from '@/core/types';
import type { EventSpec } from '@/events/specs';
import { G_N } from '@/celestial/constants';
import { defaultCelestialSpec, defaultSource, type CelestialSourceSpec, type CelestialSpec, type ProbeSpec } from '@/celestial/types';

/** A celestial experiment from t = 0 for 600 s unless overridden. */
export const celestialSpec = (p: Partial<CelestialSpec> = {}): EventSpec => ({ ...defaultCelestialSpec(), scenario: 'custom', accretion: { visual: false, particles: 0, inner: 6, outer: 20, particleMass: 1 }, duration: 600, startTime: 0, ...p } as EventSpec);

/** μ = 5·10⁴ m³/s² at the laboratory centre (0, 60, 0), ε = 1 m, capture 1 m, no ramp. */
export const labSource = (p: Partial<CelestialSourceSpec> = {}): CelestialSourceSpec => ({ ...defaultSource(), center: [0, 60, 0], mass: 5e4 / G_N, softening: 1, capture: 1, ramp: 0, ...p });

export const probe = (position: Vec3, mode: ProbeSpec['mode'], factor: number, direction: Vec3, p: Partial<ProbeSpec> = {}): ProbeSpec => ({ position, mode, factor, direction, mass: 50, radius: 0.5, ...p });
