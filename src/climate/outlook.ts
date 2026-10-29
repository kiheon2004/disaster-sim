/**
 * Outlook of a climate experiment before it runs (Phase 30): the forcing path sampled from the SAME functions the run
 * uses (background temperature / humidity / dew point / wet bulb, precipitation and its phase, sun and shortwave,
 * sky temperature) and what it implies at most — precipitation total, the snow it would make on bare ground if
 * nothing melted (at the new-snow density), the open-water evaporation potential. A path of the FORCING, not a
 * prediction of the surface response (that needs the run: energy balance, melt, wind).
 */
import type { ClimateSpec } from './types';
import { climateIssues, climateWarnings } from './types';
import { ClimateForcing } from './forcing';
import { dewPoint, boilingPointWater, qSat } from './psychro';
import { freshSnowDensity } from './snow';
import { snowFraction } from './surfaceState';
import { globalHorizontal } from './solar';
import { hGround } from '@/thermal/convection';
import { CP_AIR, LEWIS } from './constants';

export interface ClimatePathPoint { t: number; T: number; RH: number; dew: number; Tw: number; P: number; snow: number; sunEl: number; G: number; Tsky: number }

export interface ClimateOutlook {
  path: ClimatePathPoint[];
  Tmin: number;
  Tmax: number;
  precipTotal: number;
  snowTotal: number;
  rainTotal: number;
  /** New-snow depth if nothing melted (m). */
  snowDepth: number;
  /** Open water at the air temperature: evaporation potential (mm/h) at the start / end. */
  evapStart: number;
  evapEnd: number;
  boiling: number;
  dewStart: number;
  issues: string[];
  warnings: string[];
}

export function climateOutlook(spec: ClimateSpec, p = 101325, n = 96): ClimateOutlook {
  const f = new ClimateForcing(spec, p);
  const path: ClimatePathPoint[] = [];
  let Tmin = Infinity, Tmax = -Infinity, snow = 0, rain = 0, depth = 0;
  const D = spec.duration;
  for (let k = 0; k <= n; k++) {
    const t = (D * k) / n;
    const bg = f.background(t, p);
    const sun = f.sun(t);
    const P = f.precipRate(t);
    const share = (spec.precipPhase ?? 'auto') === 'snow' ? 1 : spec.precipPhase === 'rain' ? 0 : snowFraction(bg.Tw);
    path.push({ t, T: bg.T, RH: bg.RH, dew: dewPoint(bg.e), Tw: bg.Tw, P, snow: share, sunEl: sun.elevation, G: sun.elevation > 0 ? globalHorizontal(sun) : 0, Tsky: bg.Tsky });
    if (bg.T < Tmin) Tmin = bg.T;
    if (bg.T > Tmax) Tmax = bg.T;
    if (k < n) {
      const t1 = (D * (k + 1)) / n;
      const m = f.precipitation(t, t1); // kg/m²
      snow += m * share;
      rain += m * (1 - share);
      depth += (m * share) / freshSnowDensity(bg.T);
    }
  }
  const evap = (T: number, q: number) => {
    const h = hGround(T, T - 0.01, 3 * Math.pow(0.2, 0.14));
    return Math.max(0, (h / (CP_AIR * Math.pow(LEWIS, 2 / 3))) * (qSat(T, p) - q)) * 3600;
  };
  const b0 = f.background(0, p), b1 = f.background(D, p);
  return {
    path, Tmin, Tmax, precipTotal: snow + rain, snowTotal: snow, rainTotal: rain, snowDepth: depth,
    evapStart: evap(b0.T, b0.q), evapEnd: evap(b1.T, b1.q), boiling: boilingPointWater(p), dewStart: dewPoint(b0.e),
    issues: climateIssues(spec), warnings: climateWarnings(spec),
  };
}
