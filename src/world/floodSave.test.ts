import { describe, expect, it } from 'vitest';
import { createEmptyDocument, createWorldObject, nextSerial, SCHEMA_VERSION } from './WorldDocument';
import { parseDocument, serializeDocument } from './serialization';
import { sampleTown } from './sampleScene';
import { defaultFloodScenario, defaultWaterSettings } from '@/core/model';
import { generateTerrain } from '@/terrain/TerrainPresets';
import { TerrainSampler } from '@/terrain/TerrainSampler';
import { WaterField } from '@/simulation/water/WaterField';
import { applyWaterState, captureWaterState, parseWaterState, serializeWaterState } from '@/simulation/water/waterStateCodec';

function town() {
  const d = createEmptyDocument('flood-save');
  for (const input of sampleTown().slice(0, 12)) {
    const o = createWorldObject(input, nextSerial(d.objects, input.type));
    d.objects[o.id] = o;
  }
  return d;
}

describe('save / load (schema v4: water settings + flood scenario)', () => {
  it('round-trips water settings, boundary conditions and every flood event', () => {
    const d = town();
    d.settings.simulation.water = {
      ...defaultWaterSettings(),
      boundaries: { N: { type: 'closed' }, E: { type: 'open' }, S: { type: 'fixedLevel', level: 0.8 }, W: { type: 'auto' } },
      drainageCapacity: 45, infiltrationScale: 0.5, roughnessScale: 1.4, infiltration: false, initialFromReference: false,
    };
    d.scenario.flood = {
      rain: { event: 'rain', intensity: 80, duration: 1800, area: { center: [10, -5], radius: 40 } },
      risingWater: { event: 'risingWater', boundary: 'S', level: 2, riseRate: 0.3, duration: 900 },
      sources: [{ event: 'waterSource', position: [0, 0], rate: 5, duration: 600, radius: 3 }],
      enabled: { rain: true, risingWater: true, sources: false },
    };
    const res = parseDocument(serializeDocument(d));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(4);
    expect(res.doc.settings.simulation.water).toEqual(d.settings.simulation.water);
    expect(res.doc.scenario.flood).toEqual(d.scenario.flood);
  });

  it('migrates v1–v3 projects: default water settings, empty flood scenario, everything else unchanged', () => {
    const d = town();
    d.terrain = generateTerrain('coastal', 2);
    const raw = JSON.parse(serializeDocument(d));
    for (const v of [3, 2]) {
      raw.schemaVersion = v;
      delete raw.settings.simulation.water;
      delete raw.scenario.flood;
      if (v === 2) delete raw.scenario;
      const res = parseDocument(JSON.stringify(raw));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.doc.settings.simulation.water).toEqual(defaultWaterSettings());
      expect(res.doc.scenario.flood).toEqual(defaultFloodScenario());
      expect(res.doc.terrain.heights).toEqual(d.terrain.heights);
      expect(res.doc.terrain.settings.waterLevel).toBe(0); // the static reference level is kept
      expect(Object.keys(res.doc.objects)).toEqual(Object.keys(d.objects));
    }
  });

  it('invalid flood events and settings are dropped / defaulted instead of failing the file', () => {
    const raw = JSON.parse(serializeDocument(town()));
    raw.scenario.flood = {
      rain: { event: 'rain', intensity: -5, duration: 10 },
      risingWater: { event: 'risingWater', boundary: 'X', level: 2 },
      sources: [{ event: 'waterSource', position: [0, 0], rate: 1, duration: 60 }, { event: 'waterSource', rate: 'lots' }],
    };
    raw.settings.simulation.water = { boundaries: { N: { type: 'weird' } }, drainageCapacity: 30 };
    const res = parseDocument(JSON.stringify(raw));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.scenario.flood.rain).toBeNull();
    expect(res.doc.scenario.flood.risingWater).toBeNull();
    expect(res.doc.scenario.flood.sources).toHaveLength(1);
    expect(res.doc.settings.simulation.water.boundaries.N.type).toBe('auto');
  });

  it('the lowland preset round-trips with its reference (river) level', () => {
    const d = town();
    d.terrain = generateTerrain('lowland', 4);
    const res = parseDocument(serializeDocument(d));
    expect(res.ok && res.doc.terrain.settings).toMatchObject({ preset: 'lowland', seed: 4, waterLevel: -0.6 });
  });
});

describe('water state (mid-simulation snapshot, separate from the project file)', () => {
  it('round-trips depth and soil saturation to 0.01 mm, and only on the same terrain', () => {
    const t = generateTerrain('gentleHills', 1);
    const f = new WaterField(new TerrainSampler(t), defaultWaterSettings());
    for (let i = 0; i < f.count; i += 7) f.h[i] = (i % 113) / 37;
    f.infiltrated[5] = 0.0421;
    const json = serializeWaterState(captureWaterState(f, 123.4));
    expect(json.length).toBeLessThan(400_000);
    const back = parseWaterState(json, t);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.state.time).toBe(123.4);
    const g = new WaterField(new TerrainSampler(t), defaultWaterSettings());
    applyWaterState(g, back.state);
    for (let i = 0; i < f.count; i++) expect(Math.abs(g.h[i] - f.h[i])).toBeLessThanOrEqual(5e-6);
    expect(g.infiltrated[5]).toBeCloseTo(0.0421, 5);
    // Another terrain → refused.
    expect(parseWaterState(json, generateTerrain('valley', 1)).ok).toBe(false);
    expect(parseWaterState('{"kind":"x"}', t).ok).toBe(false);
  });

  it('is not part of the project file', () => {
    const json = serializeDocument(town());
    expect(json).not.toMatch(/water-state|"infiltrated"|"terrainHash"/);
  });
});
