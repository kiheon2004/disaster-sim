/**
 * Phase 31 — Phase 30 audit residuals under variable gravity:
 *  R3  liquid inflow below a sub-zero reference enters at the melting point (no instant freezing of supercooled
 *      inflow), also when gravity changes the flow (more edge inflow at higher g); ledgers closed
 *  R4  thin covers / films under low, high, zero, reversed and fast-changing gravity: no temperature run-away, the
 *      safety floor never acts, every ledger closed
 */
import { describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { SimulationController } from '@/simulation/SimulationController';
import type { EventSpec } from '@/events/specs';
import { defaultClimateSpec, type ClimateSpec } from '@/climate/types';
import { T_MELT } from '@/climate/constants';
import type { WorldDocument } from '@/core/model';
import type { ClimateRuntime } from '@/simulation/climate/runtime';
import { gravity } from './testSpecs';

const S = () => useWorldStore.getState();
const K = (c: number) => c + T_MELT;
const climate = (p: Partial<ClimateSpec> = {}): EventSpec => ({ ...defaultClimateSpec(), solar: 'off', precipitation: 0, scenario: 'custom', profile: 'constant', duration: 3600, humidityTarget: undefined, blowingSnow: false, ...p } as EventSpec);

function flat(): WorldDocument {
  S().setLocked(false);
  S().newDocument();
  S().doc.settings.simulation.seed = 5;
  return structuredClone(S().doc);
}
async function run(doc: WorldDocument, events: EventSpec[], seconds: number) {
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(doc));
  for (const e of events) c.addEvent(e);
  c.advance(seconds);
  return c;
}
const crt = (c: SimulationController): ClimateRuntime => c.getEnvironment().climate.rt!;
function ledgersClosed(c: SimulationController) {
  const s = crt(c).stats;
  expect(s.waterResidual).toBeLessThan(1e-8);
  expect(s.energyResidual).toBeLessThan(1e-8);
  expect(s.thermalResidual).toBeLessThan(1e-8);
}

describe('R3 — inflow below a sub-zero reference', { timeout: 900_000 }, () => {
  it('a water source at −10 °C: the inflow is liquid at 0 °C (no instant 12.5 % freezing); ledgers closed', async () => {
    const d = flat();
    const src = { event: 'waterSource', position: [0, 0], rate: 2, duration: 60, radius: 3 } as EventSpec;
    const c = await run(d, [climate({ temperature: K(-10), target: K(-10) }), src], 3);
    const r = crt(c);
    // The first seconds: the water arrived at the melting point, freezing proceeds at the rate its heat loss allows.
    const added = 2 * 3;
    expect(r.cw.totals.frozenWater).toBeLessThan(0.02 * added * 1000);
    ledgersClosed(c);
    c.unload();
  });

  it('the same under 3 g (more edge / source flow per second): no amplification of instant freezing; ledgers closed', async () => {
    const d = flat();
    const src = { event: 'waterSource', position: [0, 0], rate: 2, duration: 60, radius: 3 } as EventSpec;
    const c = await run(d, [climate({ temperature: K(-10), target: K(-10) }), src, gravity({ magnitude: 3 * 9.81 })], 3);
    expect(crt(c).cw.totals.frozenWater).toBeLessThan(0.02 * 6 * 1000);
    ledgersClosed(c);
    c.unload();
  });
});

describe('R4 — thin covers and films under variable gravity', { timeout: 900_000 }, () => {
  const cases: [string, EventSpec[], Partial<ClimateSpec>][] = [
    ['low gravity + thin water film (warm sun)', [gravity({ magnitude: 1.62 }), { event: 'rain', intensity: 0.5, duration: 30 } as EventSpec], { temperature: K(2), target: K(2), solar: 'constant', irradiance: 900 }],
    ['high gravity + thin water film', [gravity({ magnitude: 3 * 9.81 }), { event: 'rain', intensity: 0.5, duration: 30 } as EventSpec], { temperature: K(2), target: K(2), solar: 'constant', irradiance: 900 }],
    ['zero gravity + ice', [gravity({ magnitude: 0 })], { temperature: K(-3), target: K(1), profile: 'linear', ramp: 60, initialIce: 0.002, solar: 'constant', irradiance: 800 }],
    ['reversed gravity + snow', [gravity({ magnitude: 9.81, direction: [0, 1, 0] })], { temperature: K(-2), target: K(-2), initialSnow: 0.01, initialSnowDensity: 120 }],
    ['fast gravity change + melt', [gravity({ magnitude: 0, profile: 'pulse', period: 4, pulseWidth: 2, ramp: 0, duration: 60 })], { temperature: K(4), target: K(4), initialSnow: 0.005, initialSnowDensity: 150, solar: 'constant', irradiance: 900 }],
  ];
  for (const [name, events, cl] of cases) {
    it(name, async () => {
      const c = await run(flat(), [climate(cl), ...events], 40);
      const s = crt(c).stats;
      expect(s.floorClamps).toBe(0);
      expect(Number.isFinite(s.maxSurfaceT) && Number.isFinite(s.minSurfaceT)).toBe(true);
      expect(s.maxSurfaceT).toBeLessThan(K(80));
      expect(s.minSurfaceT).toBeGreaterThan(K(-60));
      ledgersClosed(c);
      c.unload();
    });
  }
});
