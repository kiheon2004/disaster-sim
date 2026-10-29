/**
 * Damage attribution (Phase 22, Phase 21 residual): every damage event is attributed to a hazard
 * that is actually acting, and the record keeps the per-hazard damage at that moment
 * (`contributors`) so the original cause and the final trigger can be told apart.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { SimulationController } from '@/simulation/SimulationController';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import { defaultWaterSettings } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import type { Hazard } from './DamageEvent';
import { WaterField } from '@/simulation/water/WaterField';
import { captureWaterState } from '@/simulation/water/waterStateCodec';
import { samplerFor } from '@/terrain/TerrainSampler';

const S = () => useWorldStore.getState();
const tf = (x: number, z: number) => ({ position: [x, 0, z] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] });

/** A row of modular buildings of different strengths (timber house, apartment) and a few plain objects. */
function town() {
  S().setLocked(false);
  S().newDocument();
  const house = createDesign(presetSpec('house')!, 'house');
  const apt = createDesign(presetSpec('apartment')!, 'apartment');
  const add = [];
  for (let k = 0; k < 6; k++) add.push({ type: 'building' as const, building: k % 2 ? apt : house, seed: k + 1, transform: tf(-30 + k * 12, 0) });
  add.push({ type: 'car' as const, seed: 20, transform: tf(-10, 12) }, { type: 'streetLight' as const, seed: 21, transform: tf(5, 10) }, { type: 'tree' as const, seed: 22, transform: tf(15, -12) });
  S().applyEdit({ add });
  const d = structuredClone(S().doc);
  d.settings.simulation.water = { ...defaultWaterSettings(), infiltration: false };
  return d;
}

async function run(events: EventSpec[], seconds: number, water = 0) {
  const c = new SimulationController({ headless: true });
  const d = town();
  if (water > 0) {
    // Standing water on every cell (a saved water state on this ground) — started by the flood event.
    const f = new WaterField(samplerFor(d.terrain), d.settings.simulation.water);
    f.h.fill(water);
    c.setInitialWaterState(captureWaterState(f, 0));
  }
  await c.load(d);
  for (const e of events) c.addEvent(e);
  c.advance(seconds);
  const ev = c.getDamageEvents().slice();
  c.unload();
  return ev;
}

const flood: EventSpec = { event: 'risingWater', boundary: 'S', level: 3.5, riseRate: 0.5 } as EventSpec;
const quake: EventSpec = { event: 'earthquake', magnitude: 7.2, pga: 0.6, duration: 20 } as EventSpec;
const wind: EventSpec = { event: 'wind', speed: 45, direction: 'E', duration: 40, gustStrength: 0.3, rampDuration: 2 } as EventSpec;
const subsidence: EventSpec = { event: 'terrainDeformation', kind: 'subsidence', center: [0, 0], radius: 25, amount: 1.6, duration: 4, profile: 'smooth', falloff: 'smooth' } as EventSpec;

const hazardsOf = (ev: { hazard: Hazard }[]) => new Set(ev.map((e) => e.hazard));

beforeEach(() => {
  S().setLocked(false);
  S().newDocument();
});

describe('damage attribution', { timeout: 300_000 }, () => {
  it('no wind + flood: nothing is attributed to wind', async () => {
    const ev = await run([flood], 40, 2.5);
    expect(ev.length).toBeGreaterThan(0);
    expect(hazardsOf(ev).has('wind')).toBe(false);
    expect(ev.every((e) => e.contributors.wind === 0)).toBe(true);
  });

  it('no wind + earthquake: nothing is attributed to wind', async () => {
    const ev = await run([quake], 25);
    expect(ev.length).toBeGreaterThan(0);
    expect(hazardsOf(ev).has('wind')).toBe(false);
  });

  it('no wind + ground subsidence: only ground', async () => {
    const ev = await run([subsidence], 8);
    expect(ev.length).toBeGreaterThan(0);
    expect([...hazardsOf(ev)]).toEqual(['ground']);
  });

  it('wind + earthquake + flood: every event names an acting hazard; contributors keep the history', async () => {
    const ev = await run([wind, quake, flood], 40, 2.5);
    const hz = hazardsOf(ev);
    for (const h of hz) expect(['wind', 'earthquake', 'flood']).toContain(h);
    // The record carries every channel's damage at that moment; the origin is the most damaging one.
    for (const e of ev) {
      const max = Math.max(...Object.values(e.contributors));
      if (max > 0) expect(e.contributors[e.origin]).toBe(max);
      expect(e.contributors.ground).toBe(0);
    }
  });
});
