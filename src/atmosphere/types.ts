/**
 * Atmosphere experiment spec (Phase 29) — saved in the experiment plan (schema v7, validated per
 * instance). It defines the reference state at the world datum (y = 0), the world's lateral boundary
 * and an optional change of the atmosphere's MASS:
 *
 *  removal   none | linear | exponential | scheduled | pressure
 *              linear / exponential / scheduled: a planned share of the initial air mass leaves over
 *              `duration` (constant rate, rate ∝ remaining mass, constant rate inside scheduled
 *              intervals); pressure: the mean surface pressure is driven along a linear path to
 *              target·p₀ — the mass removed each step is whatever that path requires (p = σ·g)
 *  extent    uniform: every column loses the same share (the surroundings follow the same plan, so an
 *              open boundary does not refill it); local: a near-surface sink in a disc (the
 *              surroundings keep the initial state, an open boundary refills)
 *  restore   none | reservoir (air at the reference temperature and composition injected the same way
 *              as the removal, along a linear pressure path) | boundary (the background pressure at an
 *              OPEN boundary recovers linearly; the air flows in through the edges)
 *  thermo    adiabatic: the air left behind expands (cools) / is compressed (warms) by the pressure
 *              work; isothermal: the same energy is supplied / taken by an external reservoir (booked)
 *
 * Density is never an input: ρ = p/(R·T) (an inconsistent triple cannot be entered).
 */
import { AMBIENT_LIMITS } from '@/thermal/units';

export type RemovalProfile = 'none' | 'linear' | 'exponential' | 'scheduled' | 'pressure';
export const REMOVAL_PROFILES: readonly RemovalProfile[] = ['none', 'linear', 'exponential', 'scheduled', 'pressure'];
export type RemovalExtent = 'uniform' | 'local';
export const REMOVAL_EXTENTS: readonly RemovalExtent[] = ['uniform', 'local'];
export type RestoreMode = 'none' | 'reservoir' | 'boundary';
export const RESTORE_MODES: readonly RestoreMode[] = ['none', 'reservoir', 'boundary'];
export type BoundaryMode = 'open' | 'closed';
export const BOUNDARY_MODES: readonly BoundaryMode[] = ['open', 'closed'];
export type ThermoMode = 'adiabatic' | 'isothermal';
export const THERMO_MODES: readonly ThermoMode[] = ['adiabatic', 'isothermal'];

export interface AtmosphereSpec {
  event: 'atmosphere';
  /** Altitude of the world datum (y = 0) above sea level (m) — default reference state from the ISA. */
  altitude: number;
  /** Pressure at the datum (Pa); omitted = ISA at the altitude. */
  pressure?: number;
  /** Air temperature at the datum (K); omitted = ISA at the altitude. Becomes the thermal reference. */
  temperature?: number;
  boundary: BoundaryMode;
  thermo?: ThermoMode;
  removal: RemovalProfile;
  extent?: RemovalExtent;
  /** Share of the initial air mass (world) left at the end of the removal (0–1). */
  target?: number;
  /** Removal duration (s). */
  duration?: number;
  /** scheduled: removal intervals [on, off) in instance-local seconds within the duration. */
  schedule?: [number, number][];
  /** local: disc centre [x, z] and radius (m). */
  position?: [number, number];
  radius?: number;
  restore?: RestoreMode;
  /** Restoration start (instance-local s) and duration (s). */
  restoreAt?: number;
  restoreDuration?: number;
  /** Share of the initial mass to restore to (0–1). */
  restoreTarget?: number;
  /** Opt-in: the blast model (Phase 24) takes the local background p, ρ at its start. */
  coupleBlast?: boolean;
  /** Opt-in: meteor entry (Phase 23) scales its atmosphere by the column mass. */
  coupleMeteor?: boolean;
  startTime?: number;
  name?: string;
}

export const ATMOS_LIMITS = {
  altitude: [-400, 8000],
  /** 100 Pa – 120 kPa at the datum. */
  pressure: [100, 120_000],
  temperature: AMBIENT_LIMITS,
  target: [0, 1],
  duration: [1, 21_600],
  radius: [2, 100],
  restoreAt: [0, 43_200],
  restoreDuration: [1, 21_600],
  restoreTarget: [0, 1],
} as const;

/** A removal faster than this (s) is shorter than ~10 pressure-adjustment times of the domain: warned. */
export const FAST_REMOVAL = 10;
/** Below this datum pressure (Pa) the fire relations (≈ 1 atm data, high-altitude fires to ~65 kPa) are flagged. */
export const FIRE_VALID_PRESSURE = 60_000;
/** Below this the blast model's ambient range (Phase 24) is exceeded. */
export const BLAST_MIN_PRESSURE = 30_000;
/** Smallest share of the initial column mass a column keeps (near vacuum; no negative mass). */
export const MASS_FLOOR = 1e-6;

/** Default spec (standard atmosphere at sea level, no change). */
export const defaultAtmosphereSpec = (): AtmosphereSpec => ({
  event: 'atmosphere', altitude: 0, boundary: 'open', thermo: 'adiabatic', removal: 'none', extent: 'uniform',
  target: 0.5, duration: 600, restore: 'none', restoreAt: 900, restoreDuration: 600, restoreTarget: 1,
  position: [0, 0], radius: 25,
});

/** Removal end (instance-local s); 0 without a removal. */
export const removalEnd = (s: AtmosphereSpec) => (s.removal === 'none' ? 0 : s.duration ?? 0);

/** Problems of a spec as i18n keys (empty = valid). Impossible input is explained, never silently fixed. */
export function atmosphereIssues(s: AtmosphereSpec): string[] {
  const out: string[] = [];
  const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const inRange = (v: number | undefined, [lo, hi]: readonly [number, number]) => fin(v) && v >= lo && v <= hi;
  if (!inRange(s.altitude, ATMOS_LIMITS.altitude)) out.push('atmos.invalid.altitude');
  if (s.pressure !== undefined && !inRange(s.pressure, ATMOS_LIMITS.pressure)) out.push(fin(s.pressure) && s.pressure <= 0 ? 'atmos.invalid.pressureSign' : 'atmos.invalid.pressure');
  if (s.temperature !== undefined && !inRange(s.temperature, ATMOS_LIMITS.temperature)) out.push(fin(s.temperature) && s.temperature <= 0 ? 'atmos.invalid.absoluteZero' : 'atmos.invalid.temperature');
  if (!BOUNDARY_MODES.includes(s.boundary)) out.push('atmos.invalid.boundary');
  if (s.thermo !== undefined && !THERMO_MODES.includes(s.thermo)) out.push('atmos.invalid.thermo');
  if (!REMOVAL_PROFILES.includes(s.removal)) out.push('atmos.invalid.removal');
  const removing = s.removal !== 'none';
  if (removing) {
    if (!inRange(s.target, ATMOS_LIMITS.target) || (s.target ?? 1) >= 1) out.push('atmos.invalid.target');
    if (!inRange(s.duration, ATMOS_LIMITS.duration)) out.push('atmos.invalid.duration');
    if (s.extent !== undefined && !REMOVAL_EXTENTS.includes(s.extent)) out.push('atmos.invalid.extent');
    if (s.removal === 'scheduled') {
      const sch = s.schedule ?? [];
      const D = s.duration ?? 0;
      let last = -Infinity;
      const ok = sch.length > 0 && sch.every(([a, b]) => fin(a) && fin(b) && a >= 0 && b > a && b <= D && a >= last && ((last = b), true));
      if (!ok) out.push('atmos.invalid.schedule');
    }
  }
  const local = s.extent === 'local';
  if ((removing && local) || (s.restore === 'reservoir' && local)) {
    if (!Array.isArray(s.position) || !fin(s.position[0]) || !fin(s.position[1])) out.push('atmos.invalid.position');
    if (!inRange(s.radius, ATMOS_LIMITS.radius)) out.push('atmos.invalid.radius');
  }
  const restore = s.restore ?? 'none';
  if (!RESTORE_MODES.includes(restore)) out.push('atmos.invalid.restore');
  else if (restore !== 'none') {
    if (!inRange(s.restoreAt, ATMOS_LIMITS.restoreAt)) out.push('atmos.invalid.restoreAt');
    else if (removing && fin(s.duration) && (s.restoreAt as number) < s.duration) out.push('atmos.invalid.restoreOverlap');
    if (!inRange(s.restoreDuration, ATMOS_LIMITS.restoreDuration)) out.push('atmos.invalid.restoreDuration');
    if (!inRange(s.restoreTarget, ATMOS_LIMITS.restoreTarget) || !(s.restoreTarget! > 0)) out.push('atmos.invalid.restoreTarget');
    else if (removing && fin(s.target) && s.restoreTarget! <= s.target) out.push('atmos.invalid.restoreBelow');
    if (restore === 'boundary' && s.boundary !== 'open') out.push('atmos.invalid.restoreClosed');
  }
  return out;
}

/** Non-blocking warnings (i18n keys): valid input outside the model's resolved range. */
export function atmosphereWarnings(s: AtmosphereSpec, p0: number): string[] {
  const out: string[] = [];
  if (s.removal !== 'none' && (s.duration ?? Infinity) < FAST_REMOVAL) out.push('atmos.warn.fastRemoval');
  if (s.restore && s.restore !== 'none' && (s.restoreDuration ?? Infinity) < FAST_REMOVAL) out.push('atmos.warn.fastRestore');
  const pEnd = s.removal !== 'none' ? p0 * (s.target ?? 1) : p0;
  if (pEnd < FIRE_VALID_PRESSURE) out.push('atmos.warn.fireRange');
  if (pEnd < 1) out.push('atmos.warn.rarefied');
  if (s.coupleBlast && pEnd < BLAST_MIN_PRESSURE) out.push('atmos.warn.blastRange');
  if (s.removal !== 'none' && s.extent === 'local' && s.boundary === 'open') out.push('atmos.warn.localOpen');
  return out;
}
