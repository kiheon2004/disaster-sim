import { beforeEach, describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { structuralIssues } from '@/roads/network';
import { buildEnvironment, ENVIRONMENT_PRESETS } from './presets';
import { lakeRimLow } from './hydrology';
import { featureLine, polygonDistance } from './features';
import { nearest } from '@/roads/curve';

const S = () => useWorldStore.getState();
beforeEach(() => {
  S().setLocked(false);
  S().newDocument();
});

describe('environment presets', { timeout: 300_000 }, () => {
  it('every preset is deterministic per seed and differs between seeds', () => {
    for (const k of ENVIRONMENT_PRESETS) {
      const a = buildEnvironment(k, 3), b = buildEnvironment(k, 3);
      expect(JSON.stringify({ f: a.features, r: a.roads, i: a.inputs }), k).toBe(JSON.stringify({ f: b.features, r: b.roads, i: b.inputs }));
      expect(Array.from(a.base.heights)).toEqual(Array.from(b.base.heights));
      const c = buildEnvironment(k, 4);
      expect(JSON.stringify(c.features)).not.toBe(JSON.stringify(a.features));
    }
  });

  it('applies as one undo step; lakes hold their water, trees stay out of them, roads are valid', () => {
    for (const k of ENVIRONMENT_PRESETS) {
      S().newDocument();
      const r = buildEnvironment(k, 2);
      S().applyEdit({ remove: [], roads: r.roads, landscape: { base: r.base, features: r.features, next: r.next }, add: r.inputs });
      expect(S().past.length, k).toBe(1);
      expect(structuralIssues(S().doc.roads), k).toEqual([]);
      expect(Object.keys(S().doc.objects).length, k).toBe(r.inputs.length);
      expect(r.inputs.length, k).toBeGreaterThan(10);
      for (const f of S().doc.landscape.features) {
        if (f.kind !== 'lake') continue;
        // The shore holds the water except where a river leaves the lake (its outlet).
        const rivers = S().doc.landscape.features.filter((g) => g.kind === 'river');
        const t = S().doc.terrain;
        let low = Infinity;
        for (let i = 0; i < f.points.length; i++) {
          const a = f.points[i], b = f.points[(i + 1) % f.points.length];
          for (let s = 0; s <= 1; s += 0.02) {
            const x = a[0] + (b[0] - a[0]) * s, z = a[1] + (b[1] - a[1]) * s;
            if (rivers.some((rv) => rv.kind === 'river' && nearest(featureLine(rv), x, z).dist < rv.width / 2 + rv.depth * rv.bankSlope + 2)) continue;
            low = Math.min(low, t.heights[Math.round(z - t.originZ) * t.nx + Math.round(x - t.originX)]);
          }
        }
        expect(low, `${k} ${f.id}`).toBeGreaterThanOrEqual(f.surface - 0.05);
        void lakeRimLow;
        for (const o of Object.values(S().doc.objects)) if (o.type === 'tree') expect(polygonDistance(f.points, o.transform.position[0], o.transform.position[2]).inside && o.transform.position[1] < f.surface).toBe(false);
      }
      S().undo();
      expect(S().doc.landscape.features, k).toHaveLength(0);
      expect(Object.keys(S().doc.objects), k).toHaveLength(0);
      expect(Array.from(S().doc.terrain.heights).every((v) => v === 0), k).toBe(true);
    }
  });
});
