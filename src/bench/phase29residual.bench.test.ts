/**
 * Phase 30 check of Phase 29 residuals (headless, BENCH-gated):
 *  1. lava crust surface temperature (stationary basalt column, the Phase 28 functions) when the sky is the
 *     Brutsaert clear sky instead of the reference temperature, with and without absorbed sunshine — does a climate
 *     run change the crust bias?  (Same Newton balance as volcano/crust.surfaceTemperature, with a shortwave term.)
 *  2. water near low pressure: boiling point (IF97) and the triple point; the climate's limited phase change.
 *
 *   BENCH=1 npx vitest run src/bench/phase29residual.bench --silent=false   (BENCH_OUT=file.json)
 */
import fs from 'node:fs';
import os from 'node:os';
import { describe, it } from 'vitest';
import { LAVA_MATERIALS } from '@/volcano/materials';
import { boundaryLayer, surfaceTemperature } from '@/volcano/crust';
import { hGround } from '@/thermal/convection';
import { SIGMA } from '@/thermal/units';
import { skyTemperature } from '@/climate/solar';
import { boilingPointWater, esWater, humidityFromRH, vapourPressure } from '@/climate/psychro';
import { boilingPoint } from '@/atmosphere/reference';

/** The crust balance with absorbed shortwave S (W/m²): G(Ti − Ts) + S = εσ(Ts⁴ − Tsky⁴) + h(Ts − Ta). */
function surfaceWithSun(Ti: number, d: number, k: number, eps: number, Tsky: number, hc: number, Ta: number, S: number): number {
  const G = k / d;
  let Ts = Ti;
  for (let it = 0; it < 40; it++) {
    const T3 = Ts * Ts * Ts;
    const f = G * (Ti - Ts) + S - eps * SIGMA * (T3 * Ts - Tsky ** 4) - hc * (Ts - Ta);
    const df = -G - 4 * eps * SIGMA * T3 - hc;
    const next = Ts - f / df;
    if (Math.abs(next - Ts) < 1e-6) { Ts = next; break; }
    Ts = next;
  }
  return Ts;
}

function crust() {
  const m = LAVA_MATERIALS.basalt, th = m.thermal;
  const Ti = 1150 + 273.15, Ta = 288.15;
  const q = humidityFromRH(0.5, Ta, 101325);
  const Tsky = skyTemperature(Ta, vapourPressure(q, 101325), 0);
  const kappa = th.k / (th.bulk * th.cp);
  const cases = [
    { id: 'phase28', note: 'sky = reference 15 °C, no sun (Phase 28 / 29 default)', sky: Ta, S: 0 },
    { id: 'brutsaert', note: `clear sky (Brutsaert, 15 °C, RH 50 % → T_sky ${(Tsky - 273.15).toFixed(1)} °C), no sun`, sky: Tsky, S: 0 },
    { id: 'sun800', note: 'clear sky + 800 W/m² absorbed (ε = α = 0.95 · 842 W/m²)', sky: Tsky, S: 800 },
  ];
  const times = [60, 180, 600, 1800, 3600];
  return cases.map((c) => {
    const Ts: Record<string, number> = {};
    for (const t of times) {
      const d = boundaryLayer(kappa, t, 2);
      let s = Ti;
      for (let it = 0; it < 40; it++) s = c.S === 0 && c.sky === Ta ? surfaceTemperature(Ti, d, th.k, th.emissivity, Ta, hGround(Math.max(s, Ta), Ta, 0), Ta, s) : surfaceWithSun(Ti, d, th.k, th.emissivity, c.sky, hGround(Math.max(s, Ta), Ta, 0), Ta, c.S);
      Ts[`${t}s`] = +(s - 273.15).toFixed(2);
    }
    return { id: c.id, note: c.note, TsC: Ts };
  });
}

function lowPressure() {
  return [101325, 70000, 50000, 20000, 10000, 5000, 2000, 1000, 700, 611.657, 400, 100].map((p) => ({
    p_Pa: p, boilingIF97_C: +(boilingPointWater(p) - 273.15).toFixed(2), boilingPhase29_C: +(boilingPoint(p) - 273.15).toFixed(2),
    liquidEquilibrium: p > 611.657, es15C_Pa: +esWater(288.15).toFixed(1),
  }));
}

describe.skipIf(!process.env.BENCH)('phase 29 residuals (Phase 30)', () => {
  it('runs', () => {
    const out = { date: new Date().toISOString(), node: process.version, load: os.loadavg().map((v) => +v.toFixed(1)), crust: crust(), lowPressure: lowPressure() };
    console.log(JSON.stringify(out, null, 1));
    if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify(out, null, 2));
  });
});
