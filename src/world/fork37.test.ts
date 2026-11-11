/**
 * Phase 37: a forked document can be edited without touching the original; the id-normalised fingerprint does not
 * depend on the random object / group ids.
 */
import { describe, expect, it } from 'vitest';
import { identityTransform, type Vec3 } from '@/core/types';
import { drawRoad } from '@/roads/network';
import { defaultProfile } from '@/roads/types';
import { createEmptyDocument } from './WorldDocument';
import { canonicalFingerprint, terrainBitsHash, worldFingerprint } from './fingerprint';
import { forkDocument } from './fork';
import { scratchWorld } from './worldStore';

const at = (x: number, z: number) => ({ ...identityTransform(), position: [x, 0, z] as Vec3 });

function build(order: 'a' | 'b') {
  const st = scratchWorld(createEmptyDocument());
  const S = () => st.getState();
  S().applyEdit({ roads: drawRoad(S().doc.roads, [[-40, 0], [40, 0]], { curved: false, profile: defaultProfile() }).network });
  const trees = S().applyEdit({ add: [{ type: 'tree', transform: at(5, 10), seed: 11 }, { type: 'tree', transform: at(9, 10), seed: 12 }] });
  const car = S().applyEdit({ add: [{ type: 'car', transform: at(0, 1.75), seed: 13 }] })[0];
  const group = order === 'a' ? 'grp_first' : 'grp_zzz_other';
  S().applyEdit({ update: trees.map((id) => ({ ...S().doc.objects[id], group })) });
  S().setGroupName(group, 'Grove');
  S().updateSimulationSettings({ vehicles: { model: 'dynamics', cars: { [car]: { drive: 'awd' } } } as never });
  S().beginTerrainStroke();
  for (let k = 0; k < 5; k++) S().terrainDab({ op: 'raise', x: 30, z: 30, brush: { radius: 6, strength: 1 }, dt: 0.05 });
  S().endTerrainStroke();
  return st;
}

describe('forkDocument', () => {
  it('edits on a fork leave the original untouched, bit for bit', () => {
    const st = build('a');
    const doc = st.getState().doc;
    const before = { fp: worldFingerprint(doc), bits: terrainBitsHash(doc), objects: doc.objects };
    const fork = scratchWorld(forkDocument(doc));
    const F = () => fork.getState();
    F().beginTerrainStroke();
    for (let k = 0; k < 8; k++) F().terrainDab({ op: 'lower', x: 0, z: -30, brush: { radius: 9, strength: 1 }, dt: 0.05 });
    F().endTerrainStroke();
    F().applyEdit({ roads: drawRoad(F().doc.roads, [[0, 0], [0, 60]], { curved: false, profile: defaultProfile() }).network });
    F().applyEdit({ remove: Object.keys(F().doc.objects).slice(0, 1) });
    expect(terrainBitsHash(F().doc)).not.toBe(before.bits);
    expect(worldFingerprint(doc)).toBe(before.fp);
    expect(terrainBitsHash(doc)).toBe(before.bits);
    expect(doc.objects).toBe(before.objects);
    // The fork starts from the same world.
    expect(worldFingerprint(forkDocument(doc))).toBe(before.fp);
    expect(terrainBitsHash(forkDocument(doc))).toBe(before.bits);
  });
});

describe('canonicalFingerprint', () => {
  it('the same world built twice has other ids and another fingerprint — and the same canonical fingerprint', () => {
    const a = build('a').getState().doc, b = build('b').getState().doc;
    expect(Object.keys(a.objects).sort()).not.toEqual(Object.keys(b.objects).sort());
    expect(worldFingerprint(a)).not.toBe(worldFingerprint(b));
    expect(canonicalFingerprint(a)).toBe(canonicalFingerprint(b));
  });

  it('it still tells different worlds apart: a moved object, another group name, another car setting, other terrain', () => {
    const base = canonicalFingerprint(build('a').getState().doc);
    const moved = build('a');
    const tree = Object.values(moved.getState().doc.objects).find((o) => o.type === 'tree')!;
    moved.getState().updateTransform(tree.id, { position: [5.5, 0, 10] });
    expect(canonicalFingerprint(moved.getState().doc)).not.toBe(base);
    const renamed = build('a');
    renamed.getState().setGroupName('grp_first', 'Orchard');
    expect(canonicalFingerprint(renamed.getState().doc)).not.toBe(base);
    const car = build('a');
    const id = Object.values(car.getState().doc.objects).find((o) => o.type === 'car')!.id;
    car.getState().updateSimulationSettings({ vehicles: { model: 'dynamics', cars: { [id]: { drive: 'fwd' } } } as never });
    expect(canonicalFingerprint(car.getState().doc)).not.toBe(base);
    const dug = build('a');
    dug.getState().beginTerrainStroke();
    dug.getState().terrainDab({ op: 'lower', x: -30, z: -30, brush: { radius: 6, strength: 1 }, dt: 0.05 });
    dug.getState().endTerrainStroke();
    expect(canonicalFingerprint(dug.getState().doc)).not.toBe(base);
  });
});
