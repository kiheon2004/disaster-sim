/**
 * Phase 18 (Phase 17 residual B): project file size / time with many modular buildings.
 * v5-style serialization (inline designs + derived components, as before Phase 18) vs v6
 * (shared design table, no derived components). Both must load to the same world.
 *
 *   BENCH=1 npx vitest run src/bench/saveSize --silent=false
 */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, createWorldObject } from '@/world/WorldDocument';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { encodeTerrain } from '@/terrain/terrainCodec';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import type { WorldDocument } from '@/core/model';
import { worldFingerprint } from '@/world/fingerprint';

function city(n: number, unique: boolean): WorldDocument {
  const d = createEmptyDocument('bench');
  const house = createDesign({ ...presetSpec('house')!, floors: 2 }, 'house');
  const block = createDesign({ ...presetSpec('apartment')!, floors: 4, width: 14, depth: 10 }, 'apartment');
  for (let i = 0; i < n; i++) {
    const x = -95 + (i % 32) * 6, z = -95 + Math.floor(i / 32) * 6;
    const design = unique ? createDesign({ ...presetSpec(i % 2 ? 'apartment' : 'house')!, floors: 1 + (i % 6), width: 8 + (i % 7) }, 'x') : i % 2 ? block : house;
    const o = createWorldObject({ type: 'building', building: design, seed: i + 1, transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] } }, i + 1);
    d.objects[o.id] = o;
  }
  return d;
}

/** The file as Phase 17 (schema v5) wrote it: designs inline in every object, components included. */
const v5Json = (doc: WorldDocument) => JSON.stringify({ ...doc, schemaVersion: 5, terrain: encodeTerrain(doc.terrain), roads: undefined });

const time = (fn: () => void) => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

describe.skipIf(!process.env.BENCH)('save size', () => {
  it('1000 modular buildings: v5-style vs v6', { timeout: 120_000 }, () => {
    const rows: Record<string, unknown>[] = [];
    for (const unique of [false, true]) {
      const doc = city(1000, unique);
      let v5 = '', v6 = '';
      const t5 = time(() => { v5 = v5Json(doc); });
      const t6 = time(() => { v6 = serializeDocument(doc, false); });
      const res: ReturnType<typeof parseDocument>[] = [];
      const p5 = time(() => { res[0] = parseDocument(v5); });
      const p6 = time(() => { res[1] = parseDocument(v6); });
      const [r5, r6] = res;
      expect(r5.ok && r6.ok).toBe(true);
      // Same world after loading either file (lossless).
      if (r5.ok && r6.ok) expect(worldFingerprint(r6.doc)).toBe(worldFingerprint(r5.doc));
      rows.push({ designs: unique ? 'unique' : 'shared (2)', v5MB: +(v5.length / 1048576).toFixed(2), v6MB: +(v6.length / 1048576).toFixed(2), saveMs: `${t5.toFixed(0)} → ${t6.toFixed(0)}`, loadMs: `${p5.toFixed(0)} → ${p6.toFixed(0)}` });
    }
    console.table(rows);
    console.log(JSON.stringify(rows));
  });
});
