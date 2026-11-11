/**
 * Phase 36 (audit buildings §7): what the "snow-loaded building" climate preset really does since Phase 31 — the
 * warehouse's spanning light roof panels are over their roof-system capacity under the preset's 0.8 m of dense snow from
 * the first load evaluation, fail at once and take their snow down with them; no snow mass is lost. The preset text says
 * exactly that (en/ko.climate.ts, en/ko.p36struct.ts).
 */
import { describe, expect, it } from 'vitest';
import { climatePreset } from '@/climate/presets';
import { createEmptyDocument, createWorldObject, nextSerial } from '@/world/WorldDocument';
import { SimulationController } from '../SimulationController';
import type { ClimateRuntime } from './runtime';

describe('snow-loaded building preset', { timeout: 600_000 }, () => {
  it('the warehouse roof panels fail within the first seconds under the climate load; the roof snow goes with them; water ledger closed', async () => {
    const p = climatePreset('snowLoadedBuilding');
    expect(p.assumptions).toEqual(['climate.preset.as.roofLoad', 'climate.preset.as.roofPanels', 'climate.preset.as.snowKept']);
    const d = createEmptyDocument('snow');
    for (const input of p.objects) {
      const o = createWorldObject(input, nextSerial(d.objects, input.type));
      d.objects[o.id] = o;
    }
    d.settings.simulation.seed = 42;
    const c = new SimulationController({ headless: true });
    await c.load(d);
    for (const e of p.events) c.addEvent(e);
    c.advance(1);
    const r: ClimateRuntime = c.getEnvironment().climate.rt!;
    expect(r.stats.waterResidual).toBeLessThan(1e-8);
    c.advance(9);
    const wh = [...c.getRuntime()!.entities.values()].find((e) => e.source.building?.preset === 'warehouse')!;
    const fails = c.getDamageEvents().filter((x) => x.objectId === wh.id && x.eventType === 'FAILED' && x.memberType === 'roof');
    expect(fails.length).toBeGreaterThan(0);
    expect(fails[0].hazard).toBe('climate');
    expect(fails[0].cause).toBe('snowLoad');
    expect(fails[0].time).toBeLessThan(10);
    // The roof store lost (almost all of) its snow to the failed panels — kept as mass, not dropped.
    const store = r.stores.find((s) => s.e === wh)!;
    const initial = 0.8 * 350 * r.cw.stores[store.k].area;
    expect(r.cw.sGone[store.k] ? 0 : r.cw.sM[store.k]).toBeLessThan(0.5 * initial);
    expect(r.stats.waterResidual).toBeLessThan(1e-8);
    c.unload();
  });
});
