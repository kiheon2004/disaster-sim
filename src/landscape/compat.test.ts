import { beforeEach, describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { worldFingerprint } from '@/world/fingerprint';
import { serializeDocument } from '@/world/serialization';
import { SimulationController } from '@/simulation/SimulationController';
import { samplerFor } from '@/terrain/TerrainSampler';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import { foundationContact } from '@/buildings/foundation';
import { drawRoad } from '@/roads/network';
import { defaultProfile } from '@/roads/types';
import { segmentLine } from '@/roads/network';
import type { EventSpec } from '@/events/specs';
import type { PeakFeature, RiverFeature } from './types';

const S = () => useWorldStore.getState();
const mountain = (x: number, z: number, height = 12, radius = 40): PeakFeature => ({ id: 'f1', kind: 'mountain', x, z, radius, height, roughness: 0, seed: 1 });
const river: RiverFeature = {
  id: 'f2', kind: 'river', points: [[-99, 40], [0, 50], [99, 45]], width: 6, depth: 1.5, bankSlope: 2, material: 8,
  meander: { amplitude: 0, wavelength: 60, seed: 1 }, grading: 'downhill', crossing: 'culvert', water: { fill: 0.6, inflow: 3, downstream: 'open' },
};

beforeEach(() => {
  S().setLocked(false);
  S().newDocument();
});

describe('nature edits and existing buildings / roads', () => {
  it('foundation policies: refit buildings follow the new ground, preserved ones keep their place', () => {
    const house = createDesign(presetSpec('house')!, 'house');
    const kept = { ...house, options: { ...house.options, foundationPolicy: 'preserve' as const } };
    const [refit, preserve] = S().applyEdit({ add: [
      { type: 'building', building: house, transform: { position: [8, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      { type: 'building', building: kept, transform: { position: [-8, 0, 30], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    ] });
    S().setFeatures([mountain(0, 10)], 2);
    const a = S().doc.objects[refit], b = S().doc.objects[preserve];
    expect(a.transform.position[1]).toBeGreaterThan(5); // re-fitted up onto the mountain
    expect(b.transform.position[1]).toBe(0); // world position kept
    // The Phase 17 check sees the preserved building partly buried by the new ground.
    const c = foundationContact(b, samplerFor(S().doc.terrain));
    expect(c.buried || c.contact < 1).toBe(true);
  });

  it('road elevation policies on a new mountain: follow roads take the ground, graded roads smooth it', () => {
    S().applyEdit({ roads: drawRoad(S().doc.roads, [[-80, 0], [80, 0]], { curved: false, profile: { ...defaultProfile(), elevation: 'follow', sidewalk: 'none' } }).network });
    S().applyEdit({ roads: drawRoad(S().doc.roads, [[-80, 60], [80, 60]], { curved: false, profile: { ...defaultProfile(), elevation: 'graded', sidewalk: 'none' } }).network });
    S().setFeatures([{ ...mountain(0, 0, 14, 45), id: 'f1' }, { ...mountain(0, 60, 14, 45), id: 'f3' }], 4);
    const t = S().doc.terrain, nat = S().doc.landscape.natural.heights;
    const i = (x: number, z: number) => Math.round(z - t.originZ) * t.nx + Math.round(x - t.originX);
    expect(t.heights[i(0, 0)]).toBeCloseTo(nat[i(0, 0)], 1); // follow: on the mountain
    expect(t.heights[i(0, 60)]).toBeLessThan(nat[i(0, 60)] - 0.3); // graded: cuts the summit (16 m averaging)
  });
});

describe('original world preservation and determinism on a natural landscape', { timeout: 300_000 }, () => {
  it('mountain + river + roads + buildings + trees: flood / quake runs leave the world identical and repeat identically', async () => {
    S().setFeatures([mountain(-50, -50, 20, 45), river], 3);
    S().applyEdit({ roads: drawRoad(S().doc.roads, [[-90, 20], [90, 25]], { curved: false, profile: defaultProfile() }).network });
    const house = createDesign(presetSpec('house')!, 'house');
    S().applyEdit({ add: [
      ...[-40, 0, 40].map((x) => ({ type: 'building' as const, building: house, transform: { position: [x, 0, 33] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] } })),
      ...[-70, -60, -50].map((x) => ({ type: 'tree' as const, transform: { position: [x, 0, -10] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] } })),
    ] });
    const doc = S().doc;
    const fp = worldFingerprint(doc);
    const json = serializeDocument(doc);
    const specs: EventSpec[] = [{ event: 'rain', intensity: 120, duration: 600 }, { event: 'earthquake', magnitude: 6.5, pga: 0.35, duration: 8, seed: 4 }];
    const run = async () => {
      const c = new SimulationController();
      await c.load(doc);
      for (const s of specs) c.addEvent(s);
      c.advance(20);
      const f = (c as unknown as { env: { flood: { field: { totalVolume(): number; budget: { error: number } } } } }).env.flood.field;
      const out = { volume: f.totalVolume(), error: f.budget.error, events: c.getDamageEvents().map((e) => `${e.time.toFixed(3)}:${e.objectId}:${e.eventType}`), roads: JSON.stringify(c.getRuntime()!.roads?.segments.map((s) => [s.crack, s.maxDepth])) };
      c.unload();
      return out;
    };
    const a = await run();
    const b = await run();
    expect(a.volume).toBeGreaterThan(100); // river water + rain
    expect(Math.abs(a.error)).toBeLessThan(1e-6 * a.volume);
    expect(b).toEqual(a);
    expect(worldFingerprint(S().doc)).toBe(fp);
    expect(serializeDocument(S().doc)).toBe(json);
    // The roads cross the river on a culvert opening: the water passes.
    const seg = Object.values(S().doc.roads.segments)[0];
    expect(segmentLine(S().doc.roads, seg).length).toBeGreaterThan(100);
  });
});
