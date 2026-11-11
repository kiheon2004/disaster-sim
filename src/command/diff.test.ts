/**
 * Phase 37 (§9) — what counts as a difference between two documents: a pose that only changed the numbers it is written
 * with is not a move, an object written again with the same content is not a change.
 */
import { describe, expect, it } from 'vitest';
import { sameOrientation } from '@/core/math';
import type { Vec3 } from '@/core/types';
import { createEmptyDocument } from '@/world/WorldDocument';
import { scratchWorld } from '@/world/worldStore';
import { diffDocuments, samePose } from './diff';

describe('sameOrientation', () => {
  it('a full turn, the other Euler form and a last-bit difference are the same orientation; a real turn is not', () => {
    expect(sameOrientation([0, 5.5, 0], [0, 5.5 - 2 * Math.PI, 0])).toBe(true);
    expect(sameOrientation([0, 2, 0], [Math.PI, Math.PI - 2, Math.PI])).toBe(true);
    expect(sameOrientation([0, 1.5707963267948966, 0], [0, 1.5707963267948963, 0])).toBe(true);
    expect(sameOrientation([0.1, 0.2, 0.3], [0.1, 0.2, 0.3])).toBe(true);
    expect(sameOrientation([0, 1, 0], [0, 1 + 1e-6, 0])).toBe(false);
    expect(sameOrientation([0, 1, 0], [0.001, 1, 0])).toBe(false);
    expect(sameOrientation([0, 0, 0], [0, Math.PI, 0])).toBe(false);
  });
});

describe('diffDocuments — moved, changed, written again', () => {
  const world = () => {
    const st = scratchWorld(createEmptyDocument());
    const ids = st.getState().addObjects(['a', 'b', 'c', 'd', 'e'].map((name, k) => ({ type: 'tree' as const, name, transform: { position: [k * 5, 0, 0] as Vec3, rotation: [0, 5.5, 0] as Vec3, scale: [1, 1, 1] as Vec3 } })));
    return { doc: st.getState().doc, ids };
  };

  it('sorts every rewritten object into exactly one of: moved, changed, written again', () => {
    const { doc, ids } = world();
    const [a, b, c, d, e] = ids.map((id) => doc.objects[id]);
    const turn = 5.5 - 2 * Math.PI;
    const after = {
      ...doc,
      objects: {
        ...doc.objects,
        // the same heading written as another number → written again
        [a.id]: { ...a, transform: { ...a.transform, rotation: [0, turn, 0] as Vec3 } },
        // really turned → moved
        [b.id]: { ...b, transform: { ...b.transform, rotation: [0, 1, 0] as Vec3 } },
        // the same pose in other numbers AND renamed → changed (not moved)
        [c.id]: { ...c, name: 'renamed', transform: { ...c.transform, rotation: [0, turn, 0] as Vec3 } },
        // a new object with equal content → written again
        [d.id]: { ...d, transform: { ...d.transform, position: [...d.transform.position] as Vec3 } },
        // 1 mm → moved (far above the noise limit)
        [e.id]: { ...e, transform: { ...e.transform, position: [e.transform.position[0] + 0.001, 0, 0] as Vec3 } },
      },
    };
    const diff = diffDocuments(doc, after);
    expect(diff.moved.map((m) => m.after.id).sort()).toEqual([b.id, e.id].sort());
    expect(diff.changed.map((m) => m.after.id)).toEqual([c.id]);
    expect(diff.rewritten).toBe(2);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.any).toBe(true);
    expect(samePose(a, after.objects[a.id])).toBe(true);
    expect(samePose(b, after.objects[b.id])).toBe(false);
  });

  it('objects only written again are no difference at all', () => {
    const { doc, ids } = world();
    const a = doc.objects[ids[0]];
    const after = { ...doc, objects: { ...doc.objects, [a.id]: { ...a, transform: { ...a.transform, rotation: [0, 5.5 - 2 * Math.PI, 0] as Vec3 } } } };
    const diff = diffDocuments(doc, after);
    expect(diff.rewritten).toBe(1);
    expect(diff.moved).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.any).toBe(false);
  });
});
