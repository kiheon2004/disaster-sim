import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, createWorldObject, nextSerial, SCHEMA_VERSION } from './WorldDocument';
import { parseDocument, serializeDocument } from './serialization';
import { sampleTown } from './sampleScene';
import { generateTerrain } from '@/terrain/TerrainPresets';
import { reseat } from '@/terrain/groundPlacement';
import { TerrainSampler } from '@/terrain/TerrainSampler';
import { SimulationController } from '@/simulation/SimulationController';
import type { WorldDocument } from '@/core/model';
import { defaultSeismic } from '@/simulation/seismic/structuralProps';

function town(): WorldDocument {
  const d = createEmptyDocument('save');
  for (const input of sampleTown()) {
    const o = createWorldObject(input, nextSerial(d.objects, input.type));
    d.objects[o.id] = o;
  }
  return d;
}

/** The same document written by Phase 12 (schema v2): no soil, no seismic properties, no scenario. */
function asV2(doc: WorldDocument): string {
  const raw = JSON.parse(serializeDocument(doc));
  raw.schemaVersion = 2;
  delete raw.scenario;
  delete raw.terrain.soil;
  for (const o of Object.values(raw.objects) as Record<string, unknown>[]) delete o.seismic;
  return JSON.stringify(raw);
}

async function windFingerprint(d: WorldDocument) {
  const c = new SimulationController();
  await c.load(d);
  c.addEvent({ event: 'wind', speed: 46, direction: 'S', duration: 30, gustStrength: 0.3, rampDuration: 4 });
  c.advance(8);
  const index = new Map(Object.keys(d.objects).map((id, i) => [id, i]));
  const lines = c.getDamageEvents().map((e) => [e.time, index.get(e.objectId), e.componentId, e.eventType, e.force, e.damageAfter].join('|'));
  const ents = [...c.getRuntime()!.entities.values()].map((e) => [index.get(e.id), e.state, e.health, ...e.pose.position].join('|'));
  c.unload();
  return createHash('sha256').update(lines.join('\n') + '#' + ents.join('\n')).digest('hex');
}

describe('save / load (schema v3)', () => {
  it('round-trips the earthquake scenario, soil profile layer and foundation properties', () => {
    const d = town();
    d.terrain = generateTerrain('coastal', 5);
    d.scenario.earthquake = { event: 'earthquake', magnitude: 7.1, pga: 0.42, duration: 35, epicenter: [12000, -3000], depth: 18, direction: 30, seed: 9 };
    const b = Object.values(d.objects).find((o) => o.type === 'building')!;
    b.seismic!.foundation = { type: 'pile', stiffness: 1.7, damping: 0.12, anchorage: 1.1, groundContact: 0.8, failureThreshold: 1.5 };
    b.seismic!.structure.system = 'masonry';
    const res = parseDocument(serializeDocument(d));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.schemaVersion).toBe(3);
    expect(res.doc.scenario.earthquake).toEqual(d.scenario.earthquake);
    expect(res.doc.terrain.soil).toEqual(d.terrain.soil);
    expect(new Set(res.doc.terrain.soil).size).toBeGreaterThan(1);
    expect(res.doc.objects[b.id].seismic).toEqual(b.seismic);
  });

  it('an all-default soil layer is not stored vertex by vertex', () => {
    const json = JSON.parse(serializeDocument(createEmptyDocument('x')));
    expect(json.terrain.soil).toBeNull();
    expect(json.scenario).toEqual({ earthquake: null });
  });

  it('invalid seismic values are clamped / defaulted instead of failing the file', () => {
    const d = town();
    const raw = JSON.parse(serializeDocument(d));
    const id = Object.keys(raw.objects).find((k) => raw.objects[k].type === 'building')!;
    raw.objects[id].seismic = { structure: { system: 'adobe', dampingRatio: 9 }, foundation: { anchorage: -1 } };
    raw.scenario = { earthquake: { event: 'earthquake', magnitude: 42 } };
    const res = parseDocument(JSON.stringify(raw));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const s = res.doc.objects[id].seismic!;
    expect(s.structure.system).toBe('rcFrame');
    expect(s.structure.dampingRatio).toBeLessThanOrEqual(0.3);
    expect(s.foundation.anchorage).toBeGreaterThan(0);
    expect(res.doc.scenario.earthquake).toBeNull();
  });
});

describe('legacy migration (Phase 0–12 files)', () => {
  it('a schema-v2 project loads with default soil, seismic properties and an empty scenario', () => {
    const d = town();
    d.terrain = generateTerrain('valley', 2);
    const res = parseDocument(asV2(d));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(res.doc.scenario.earthquake).toBeNull();
    expect(new TerrainSampler(res.doc.terrain).uniformSoil).toBe(true);
    expect(res.doc.terrain.heights).toEqual(d.terrain.heights);
    expect(res.doc.terrain.ground).toEqual(d.terrain.ground);
    for (const o of Object.values(res.doc.objects)) {
      expect(o.transform).toEqual(d.objects[o.id].transform);
      expect(o.physics).toEqual(d.objects[o.id].physics);
      if (o.type === 'building') expect(o.seismic).toEqual(defaultSeismic('building'));
      else expect(o.seismic).toBeUndefined();
    }
  });

  it('wind results of a migrated v2 project are unchanged (bit-exact)', async () => {
    const d = town();
    const migrated = parseDocument(asV2(d));
    if (!migrated.ok) throw new Error(migrated.error);
    expect(await windFingerprint(migrated.doc)).toBe(await windFingerprint(d));
  }, 120_000);

  it('buildings placed on a slope by Phase 12 (lowest corner) keep their position and stay grounded', () => {
    const d = town();
    d.terrain = generateTerrain('gentleHills', 4);
    const s = new TerrainSampler(d.terrain);
    const b = Object.values(d.objects).find((o) => o.type === 'building')!;
    // Phase 12 rule: origin on the lowest corner.
    const yaw = 0;
    const p = reseat(b, s);
    const legacyY = Math.min(...[[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([sx, sz]) =>
      s.sampleHeight(b.transform.position[0] + sx * Number(b.params.width) / 2, b.transform.position[2] + sz * Number(b.params.depth) / 2)), s.sampleHeight(b.transform.position[0], b.transform.position[2]));
    b.transform.position = [b.transform.position[0], legacyY, b.transform.position[2]];
    void yaw;
    void p;
    const res = parseDocument(asV2(d));
    if (!res.ok) throw new Error(res.error);
    expect(res.doc.objects[b.id].transform.position[1]).toBe(legacyY);
  });
});
