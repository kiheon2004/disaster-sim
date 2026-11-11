/**
 * Phase 36 (render-only): debris looks by structural type — fragment chunks inside the one body box, dust puff factors.
 * The particle count / effects RNG are covered bit for bit by simulation/structure/colliders.identity.test.ts (PARTICLES).
 */
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@/core/types';
import type { EventSpec } from '@/events/specs';
import { createDesign } from '@/buildings/design';
import { defaultSpec } from '@/buildings/spec';
import { STRUCTURAL_TYPES } from '@/buildings/structuralType';
import { createEmptyDocument, createWorldObject, nextSerial } from '@/world/WorldDocument';
import { SimulationController } from '@/simulation/SimulationController';
import { chunkCount, debrisChunks, dustScale, MAX_CHUNKS } from './debrisVisual';

describe('debris looks by structural type (render-only)', { timeout: 300_000 }, () => {
  it('a fragment is drawn as round(1 / debrisSize) chunks, every one inside its body box', () => {
    const n = Object.fromEntries(Object.entries(STRUCTURAL_TYPES).map(([k, p]) => [k, chunkCount(p.debrisSize)]));
    expect(n).toEqual({ steel: 1, rc: 2, masonry: 4, timber: 1, light: 1 });
    expect(Math.max(...Object.values(n))).toBeLessThanOrEqual(MAX_CHUNKS);
    const size = [0.3, 3, 4];
    const out = new Float32Array(6 * MAX_CHUNKS);
    for (const c of [1, 2, 4]) {
      expect(debrisChunks(size, c, 12345, out)).toBe(c);
      let along = 0;
      for (let j = 0; j < c; j++) {
        for (let d = 0; d < 3; d++) {
          const lo = out[6 * j + d] - out[6 * j + 3 + d] / 2, hi = out[6 * j + d] + out[6 * j + 3 + d] / 2;
          expect(lo).toBeGreaterThanOrEqual(-size[d] / 2 - 1e-6);
          expect(hi).toBeLessThanOrEqual(size[d] / 2 + 1e-6);
        }
        along += out[6 * j + 5];
      }
      // Split along the longest axis (z here) — never longer than the box.
      expect(along).toBeLessThanOrEqual(size[2] + 1e-6);
    }
    expect([dustScale(undefined), dustScale(1), dustScale(STRUCTURAL_TYPES.steel.dust)]).toEqual([1, 1, 0.6]);
  });

  it('collapse dust carries the dust factor of the members it came from (masonry walls, concrete floors)', async () => {
    const d = createEmptyDocument('p36-dust');
    const spec = { ...defaultSpec(), system: 'masonry' as const, structureMaterial: 'masonry' as const, slabMaterial: 'reinforcedConcrete' as const, claddingMaterial: 'masonry' as const, foundation: 'spread' as const, bay: 4, width: 12, depth: 10, floors: 3 };
    const o = createWorldObject({ type: 'building', building: createDesign(spec), seed: 11, transform: { position: [0, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 } }, nextSerial(d.objects, 'building'));
    d.objects[o.id] = o;
    d.settings.simulation.seed = 42;
    const c = new SimulationController({ headless: true });
    await c.load(d);
    c.addEvent({ event: 'earthquake', magnitude: 7.5, pga: 1.0, duration: 20, seed: 3 } as EventSpec);
    let seen = 0, high = 0;
    for (let k = 0; k < 24; k++) {
      c.advance(0.5);
      for (const p of c.getRuntime()!.particles) {
        if (p.kind !== 'dust') continue;
        seen++;
        expect(p.k).toBeGreaterThanOrEqual(STRUCTURAL_TYPES.light.dust);
        expect(p.k).toBeLessThanOrEqual(STRUCTURAL_TYPES.masonry.dust);
        if (p.k! > 1) high++;
      }
    }
    expect(seen).toBeGreaterThan(0);
    // Masonry walls dominate some puffs (factor > the RC floors' 1).
    expect(high).toBeGreaterThan(0);
    c.unload();
  });
});
