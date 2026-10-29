/**
 * Solar and sky radiation (Phase 30) — a reduced clear-sky model, not radiative transfer.
 *
 *  sun position     declination δ = 23.44°·sin(360°·(284 + n)/365) (Cooper 1969), hour angle ω = 15°·(h − 12)
 *                   in LOCAL SOLAR time, sin β = sin φ sin δ + cos φ cos δ cos ω; direction in world axes
 *                   (+X east, +Y up, +Z south)
 *  air mass         Kasten & Young (1989): AM = 1 / (sin β + 0.50572·(β° + 6.07995)^−1.6364)
 *  direct normal    Meinel & Meinel (1976): I_b = 1361·0.7^(AM^0.678) (sea level, clear, "average" turbidity)
 *  diffuse          ≈ 10 % of the direct normal on a horizontal surface (clear sky rule of thumb)
 *  clouds           Kasten & Czeplak (1980): G = G_clear·(1 − 0.75·N^3.4); the direct beam is scaled by (1 − N)
 *                   and the rest of G is diffuse (N = cloud cover 0–1)
 *  sky longwave     Brutsaert (1975) clear-sky emissivity ε = 1.24·(e/T)^(1/7) (e in hPa), cloud factor
 *                   (1 + 0.22·N²) (Bolz 1949, as used e.g. in snow models), capped at 1; the sky is a black body
 *                   at T_sky = ε^(1/4)·T_air
 */
import { SOLAR_CONSTANT } from './constants';

const RAD = Math.PI / 180;

export interface SunState {
  /** Elevation angle (rad, < 0 below the horizon). */
  elevation: number;
  /** Unit vector toward the sun (world: +X east, +Y up, +Z south). */
  dir: [number, number, number];
  /** Direct normal irradiance (W/m²) and diffuse irradiance on a horizontal surface (W/m²), clouds included. */
  direct: number;
  diffuse: number;
}

/** Sun direction for latitude φ (deg), day of year n, local solar hour h (0–24). */
export function sunPosition(latDeg: number, day: number, hour: number): { elevation: number; dir: [number, number, number] } {
  const phi = latDeg * RAD;
  const delta = 23.44 * RAD * Math.sin((2 * Math.PI * (284 + day)) / 365);
  const omega = 15 * RAD * (hour - 12);
  const sinB = Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.cos(omega);
  const east = -Math.cos(delta) * Math.sin(omega);
  const north = Math.sin(delta) * Math.cos(phi) - Math.cos(delta) * Math.sin(phi) * Math.cos(omega);
  const n = Math.hypot(east, north, sinB) || 1;
  return { elevation: Math.asin(Math.max(-1, Math.min(1, sinB))), dir: [east / n, sinB / n, -north / n] };
}

/** Relative optical air mass (Kasten & Young 1989); Infinity below the horizon. */
export function airMass(elevation: number): number {
  if (elevation <= 0) return Infinity;
  const deg = elevation / RAD;
  return 1 / (Math.sin(elevation) + 0.50572 * Math.pow(deg + 6.07995, -1.6364));
}

/** Clear-sky direct normal irradiance (W/m², Meinel & Meinel 1976). */
export function clearDirect(elevation: number): number {
  const am = airMass(elevation);
  return Number.isFinite(am) ? SOLAR_CONSTANT * Math.pow(0.7, Math.pow(am, 0.678)) : 0;
}

/** Direct (normal) and diffuse (horizontal) irradiance under cloud cover N. */
export function irradiance(elevation: number, cloud: number): { direct: number; diffuse: number } {
  const Ib = clearDirect(elevation);
  if (Ib <= 0) return { direct: 0, diffuse: 0 };
  const sinB = Math.sin(elevation);
  const N = Math.max(0, Math.min(1, cloud));
  const Gclear = Ib * sinB + 0.1 * Ib;
  const G = Gclear * (1 - 0.75 * Math.pow(N, 3.4));
  const direct = Ib * (1 - N);
  return { direct, diffuse: Math.max(0, G - direct * sinB) };
}

/** Global horizontal irradiance (W/m²) of a sun state. */
export const globalHorizontal = (s: Pick<SunState, 'direct' | 'diffuse' | 'elevation'>) => s.direct * Math.max(0, Math.sin(s.elevation)) + s.diffuse;

/** Clear-sky emissivity (Brutsaert 1975) with a cloud factor, from air T (K) and vapour pressure e (Pa). */
export function skyEmissivity(T: number, e: number, cloud: number): number {
  const eps = 1.24 * Math.pow(Math.max(1e-6, e / 100) / T, 1 / 7);
  return Math.min(1, eps * (1 + 0.22 * cloud * cloud));
}

/** Effective sky temperature (K) of a black-body sky with the emissivity above. */
export const skyTemperature = (T: number, e: number, cloud: number) => Math.pow(skyEmissivity(T, e, cloud), 0.25) * T;
