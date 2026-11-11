/**
 * Phase 36 (roads): width transitions are derived only at straight joints of two different cross-sections. Every network
 * without such a joint must bake EXACTLY the terrain it baked before (heights + ground bytes, the vehicle collider and the
 * water bed) and place exactly the same objects. The hashes below were recorded on the base commit 09009f5, before any
 * Phase 36 road change, for the default world, the classic sample town, every built-in template and every environment
 * preset.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TerrainData, WorldDocument } from '@/core/model';
import { createEmptyDocument } from '@/world/WorldDocument';
import { scratchWorld } from '@/world/worldStore';
import { defaultTownObjects, defaultTownRoads } from '@/world/defaultTown';
import { sampleTown } from '@/world/sampleScene';
import { worldFingerprint } from '@/world/fingerprint';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { BUILTIN_TEMPLATES, buildTemplate } from '@/templates/builtin';
import { buildEnvironment, ENVIRONMENT_PRESETS } from '@/landscape/presets';
import { transitionsOf } from './crossSection';

const NOW = '2026-10-11T00:00:00.000Z';

function terrainHash(t: TerrainData): string {
  const h = createHash('sha1');
  h.update(Buffer.from(t.heights.buffer, t.heights.byteOffset, t.heights.byteLength));
  h.update(Buffer.from(t.ground.buffer, t.ground.byteOffset, t.ground.byteLength));
  return h.digest('hex').slice(0, 16);
}

/** Object poses in insertion order (ids of hand-built documents are random). */
function posesHash(doc: WorldDocument): string {
  const h = createHash('sha1');
  for (const o of Object.values(doc.objects)) h.update(`${o.type}|${o.transform.position.join(',')}|${o.transform.rotation.join(',')}|${JSON.stringify(o.roadLink ?? null)}\n`);
  return h.digest('hex').slice(0, 16);
}

function defaultWorld(): WorldDocument {
  const st = scratchWorld(createEmptyDocument(''));
  st.getState().applyEdit({ roads: defaultTownRoads() });
  st.getState().addObjects(defaultTownObjects());
  return st.getState().doc;
}

function classicWorld(): WorldDocument {
  const st = scratchWorld(createEmptyDocument(''));
  st.getState().addObjects(sampleTown());
  return st.getState().doc;
}

function environmentWorld(kind: (typeof ENVIRONMENT_PRESETS)[number]): WorldDocument {
  const st = scratchWorld(createEmptyDocument(''));
  const r = buildEnvironment(kind, 3);
  st.getState().applyEdit({ roads: r.roads, landscape: { base: r.base, features: r.features, next: r.next }, add: r.inputs });
  return st.getState().doc;
}

/** Recorded on 09009f5 (before Phase 36): terrain = sha1(heights F32 + ground U8), objects = poses or fingerprint. */
const EXPECTED: Record<string, { terrain: string; objects: string }> = {
  'defaultTown': { terrain: '988a119c9e7c7f49', objects: '453d9d9062b2adf4' },
  'sampleTown': { terrain: 'ea4c42e2b98ad511', objects: 'a41dff8c62ccb80b' },
  'template:emptyFlat': { terrain: 'ea4c42e2b98ad511', objects: '2187e27c89bca846' },
  'template:smallTown': { terrain: '566d18cec3b20d09', objects: '548dbc30a45be2ed' },
  'template:denseCity': { terrain: '7bbb575b39cef5cf', objects: '37c8af2cd14b92a1' },
  'template:coastalCity': { terrain: '0ff565bedccb0e8a', objects: 'a776f2d7e01b384c' },
  'template:mountainVillage': { terrain: '5fa6daf2150cdb98', objects: '493122260b1eab49' },
  'template:riverValley': { terrain: '5b91d87b551a8fb1', objects: '4fcefdaefb69e80f' },
  'template:industrialDistrict': { terrain: '0a7d7a397a40587d', objects: '040ab4a6c25a5f71' },
  'template:forestLake': { terrain: 'a98eaea21ab01b69', objects: 'cc15ebf3fc7df756' },
  'environment:mountainValley': { terrain: '5fa6daf2150cdb98', objects: 'e138fc8d21776dbc' },
  'environment:riverBasin': { terrain: '5b91d87b551a8fb1', objects: 'af56c15da1ecdaaf' },
  'environment:coastalPlain': { terrain: '6a2e1a7d566c856b', objects: '8b0c2c10684b4a65' },
  'environment:forestedHills': { terrain: '5f5b472080bba049', objects: '03495c44997e766a' },
  'environment:lakeDistrict': { terrain: 'a98eaea21ab01b69', objects: 'b4bc385b1928e188' },
  'environment:mixedUrbanNatural': { terrain: '367d78e5052d9a20', objects: '1f2329e2052acacc' },
};

describe('Phase 36 roads: identity of every network without a width joint', { timeout: 600_000 }, () => {
  const got: Record<string, { terrain: string; objects: string }> = {};
  const check = (name: string, doc: WorldDocument, objects: string) => {
    expect(transitionsOf(doc.roads).size, `${name} has no straight width joint`).toBe(0);
    got[name] = { terrain: terrainHash(doc.terrain), objects };
    // The saved document reloads (v7: recompose + re-bake with the current code) to the same terrain.
    const r = parseDocument(serializeDocument(doc));
    expect(r.ok).toBe(true);
    if (r.ok) expect(terrainHash(r.doc.terrain), `${name} reload`).toBe(got[name].terrain);
    expect(got[name], name).toEqual(EXPECTED[name]);
  };

  it('default world and classic sample town', () => {
    const d = defaultWorld();
    check('defaultTown', d, posesHash(d));
    const c = classicWorld();
    check('sampleTown', c, posesHash(c));
  });

  it('every built-in template', () => {
    for (const kind of BUILTIN_TEMPLATES) {
      const d = buildTemplate(kind, 3, { now: NOW });
      check(`template:${kind}`, d, worldFingerprint(d));
    }
  });

  it('every environment preset', () => {
    for (const kind of ENVIRONMENT_PRESETS) {
      const d = environmentWorld(kind);
      check(`environment:${kind}`, d, posesHash(d));
    }
    if (process.env.PRINT_IDENTITY) writeFileSync(process.env.PRINT_IDENTITY, JSON.stringify(got, null, 1));
  });
});
