/**
 * Phase 31 — R1 / R2 in the simulation: roof snow (Phase 30 climate) fails spanning roof panels at normal gravity and,
 * at a lighter snow load, under a gravity increase; the snow on a failed panel rides with it (packet) and is set down
 * where the panel lands — never on the roof and the ground at once; climate water / energy ledgers stay closed.
 */
import { describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { SimulationController } from '@/simulation/SimulationController';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import type { EventSpec } from '@/events/specs';
import { defaultClimateSpec, type ClimateSpec } from '@/climate/types';
import { T_MELT } from '@/climate/constants';
import { MT_ROOF } from '@/structure/graph';
import { MS } from '@/structure/types';
import { gravity } from './testSpecs';

const S = () => useWorldStore.getState();
const tf = (x: number, z: number) => ({ position: [x, 0, z] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] });
const climate = (p: Partial<ClimateSpec> = {}): EventSpec => ({ ...defaultClimateSpec(), solar: 'off', precipitation: 0, scenario: 'custom', profile: 'constant', duration: 3600, humidityTarget: undefined, temperature: T_MELT - 5, target: T_MELT - 5, humidity: 0.8, blowingSnow: false, ...p } as EventSpec);

async function start(events: EventSpec[]) {
  S().setLocked(false);
  S().newDocument();
  S().doc.settings.simulation.seed = 11;
  S().applyEdit({ add: [{ type: 'building', building: createDesign(presetSpec('warehouse')!, 'warehouse'), seed: 3, transform: tf(0, 0) }] as never });
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(S().doc));
  for (const e of events) c.addEvent(e);
  return c;
}
const building = (c: SimulationController) => [...c.getRuntime()!.entities.values()].find((e) => e.source.type === 'building')!;
const roofState = (c: SimulationController) => {
  const m = building(c).modular!.structure?.model;
  if (!m) return { failed: 0, total: 0 };
  let failed = 0, total = 0;
  for (let i = 0; i < m.n; i++) if (m.g.type[i] === MT_ROOF && m.g.roofCap[i] > 0) { total++; if (m.state[i] >= MS.FAILED) failed++; }
  return { failed, total };
};

describe('R1 / R2 in the simulation', () => {
  it('light roof snow (0.4 m × 150 kg/m³ ≈ 0.6 kPa) at normal gravity: the roof holds', { timeout: 600_000 }, async () => {
    const c = await start([climate({ initialSnow: 0.4, initialSnowDensity: 150 })]);
    c.advance(20);
    expect(roofState(c).failed).toBe(0);
    expect(c.getEnvironment().climate.rt!.stats.waterResidual).toBeLessThan(1e-8);
    c.unload();
  });

  it('heavy roof snow (1.2 m × 300 kg/m³ ≈ 3.5 kPa) at normal gravity: the roof panels fail (R1); their snow falls with them and lands (R2)', { timeout: 600_000 }, async () => {
    const c = await start([climate({ initialSnow: 1.2, initialSnowDensity: 300 })]);
    c.advance(8);
    const rs = roofState(c);
    expect(rs.total).toBeGreaterThan(0);
    expect(rs.failed).toBe(rs.total);
    const r = c.getEnvironment().climate.rt!;
    const ev = c.getDamageEvents().filter((d) => d.eventType === 'FAILED' && d.memberType === 'roof');
    expect(ev.length).toBeGreaterThan(0);
    expect(ev[0].hazard).toBe('climate');
    expect(ev[0].cause).toBe('snowLoad');
    // The roof store gave its snow to the panels' packets; nothing is on the roof and the ground twice.
    const store = r.stores.find((s) => s.e.source.type === 'building')!;
    const onRoof = r.cw.sGone[store.k] ? 0 : r.cw.sM[store.k];
    expect(onRoof).toBeLessThan(1);
    c.advance(10);
    // Landed: every packet set down; mass conserved.
    expect(r.cw.packetMass()).toBe(0);
    expect(r.packets.length).toBe(0);
    expect(r.stats.waterResidual).toBeLessThan(1e-8);
    expect(r.stats.energyResidual).toBeLessThan(1e-8);
    c.unload();
  });

  it('moderate snow (≈ 1.2 kPa) holds at 1 g and fails under a gravity ramp to 2.5 g (hazard gravity, cause gravityLoad)', { timeout: 600_000 }, async () => {
    const c = await start([climate({ initialSnow: 0.6, initialSnowDensity: 200 }), gravity({ magnitude: 2.5 * 9.81, profile: 'linear', ramp: 6, duration: 30, end: 'hold', startTime: 3 })]);
    c.advance(3);
    expect(roofState(c).failed).toBe(0);
    const k1 = building(c).climate!.loadKPa;
    c.advance(2.2);
    // The reported roof pressure follows the gravity acting at its 5 s update (k ≈ 1.4; the mass unchanged).
    expect(roofState(c).failed).toBe(0);
    expect(building(c).climate!.loadKPa).toBeGreaterThan(1.3 * k1);
    c.advance(9.8);
    const rs = roofState(c);
    expect(rs.failed).toBe(rs.total);
    const ev = c.getDamageEvents().filter((d) => d.eventType === 'FAILED' && d.memberType === 'roof');
    expect(ev[0].hazard).toBe('gravity');
    expect(ev[0].cause).toBe('gravityLoad');
    expect(c.getEnvironment().gravity.rt!.roofFailures).toBeGreaterThan(0);
    c.unload();
  });

  it('the same snow mass at Moon-like gravity: the heavy roof snow does not fail the roof', { timeout: 600_000 }, async () => {
    const c = await start([climate({ initialSnow: 1.2, initialSnowDensity: 300 }), gravity({ magnitude: 1.62, startTime: 0 })]);
    c.advance(8);
    expect(roofState(c).failed).toBe(0);
    c.unload();
  });
});
