import { describe, expect, it } from 'vitest';
import { createFlatTerrain } from '@/terrain/TerrainData';
import { TerrainSampler } from '@/terrain/TerrainSampler';
import { generateTerrain } from '@/terrain/TerrainPresets';
import { footprintOf } from '@/editor/build/footprint';
import { createWorldObject } from '@/world/WorldDocument';
import { drawRoad } from './network';
import { blockAt, blocksOf, setZone } from './blocks';
import { fillBlock, footprintOnRoad, infrastructureAlong, neighborhood, vehiclesAlong, DEFAULT_FILL, type CityContext } from './city';
import { defaultProfile, emptyNetwork, type RoadNetwork } from './types';

const P = defaultProfile();
const draw = (n: RoadNetwork, pts: [number, number][]) => drawRoad(n, pts, { curved: false, profile: P }).network;
const ctxOf = (network: RoadNetwork, terrain = createFlatTerrain()): CityContext => ({ terrain: new TerrainSampler(terrain), objects: {}, network });
const grid = () => {
  let n = draw(emptyNetwork(), [[-60, -40], [60, -40], [60, 40], [-60, 40], [-60, -40]]);
  n = draw(n, [[0, -40], [0, 40]]);
  return n;
};

describe('city blocks', () => {
  it('finds the enclosed blocks of a road grid; an open network has none', () => {
    expect(blocksOf(grid())).toHaveLength(2);
    expect(blocksOf(draw(draw(emptyNetwork(), [[0, 0], [50, 0]]), [[25, 0], [25, 40]]))).toHaveLength(0);
  });
  it('zones attach to blocks and are dropped when the block disappears', () => {
    const n = grid();
    const b = blockAt(n, -30, 0)!;
    expect(b).not.toBeNull();
    const z = setZone(n, b.id, 'commercial');
    expect(blocksOf(z).find((x) => x.id === b.id)!.zone).toBe('commercial');
    expect(blockAt(z, 30, 0)!.zone).toBeNull();
  });
});

describe('city placement', () => {
  it('block fill is deterministic, faces the road, never on a road, and links to roads', () => {
    const n = grid();
    const b = blockAt(n, -30, 0)!;
    const a = fillBlock(ctxOf(n), b, 'residential', { ...DEFAULT_FILL, seed: 5 });
    const c = fillBlock(ctxOf(n), b, 'residential', { ...DEFAULT_FILL, seed: 5 });
    expect(a.inputs.length).toBeGreaterThan(3);
    expect(JSON.stringify(a.inputs)).toBe(JSON.stringify(c.inputs));
    const d = fillBlock(ctxOf(n), b, 'residential', { ...DEFAULT_FILL, seed: 6 });
    expect(JSON.stringify(d.inputs)).not.toBe(JSON.stringify(a.inputs));
    const objs = a.inputs.map((i, k) => createWorldObject(i, k + 1));
    for (const o of objs) {
      expect(o.building).toBeDefined();
      expect(o.roadLink?.policy).toBe('follow');
      expect(footprintOnRoad(n, footprintOf(o)!)).toBe(false);
    }
    // No two buildings overlap.
    for (let i = 0; i < objs.length; i++) for (let j = i + 1; j < objs.length; j++) {
      const f = footprintOf(objs[i])!, g = footprintOf(objs[j])!;
      expect(Math.hypot(f.x - g.x, f.z - g.z)).toBeGreaterThan(0.5);
    }
  });
  it('designs of one preset and height are shared', () => {
    const n = grid();
    const p = fillBlock(ctxOf(n), blockAt(n, -30, 0)!, 'residential', { ...DEFAULT_FILL, seed: 2 });
    const designs = new Set(p.inputs.map((i) => i.building));
    expect(designs.size).toBeLessThan(p.inputs.length);
  });
  it('a slope limit rejects buildings on steep ground', () => {
    const t = generateTerrain('gentleHills', 3);
    const n = draw(emptyNetwork(), [[-60, -40], [60, -40], [60, 40], [-60, 40], [-60, -40]]);
    const b = blocksOf(n)[0];
    const flat = fillBlock(ctxOf(n, t), b, 'residential', { ...DEFAULT_FILL, slopeLimit: 90 });
    const strict = fillBlock(ctxOf(n, t), b, 'residential', { ...DEFAULT_FILL, slopeLimit: 3 });
    expect(strict.inputs.length).toBeLessThan(flat.inputs.length);
    expect(strict.rejected.slope).toBeGreaterThan(0);
  });
  it('infrastructure: lamps on sidewalks reach over the road, signals at junctions, signs at junction approaches', () => {
    const n = grid();
    const ids = Object.keys(n.segments);
    const lamps = infrastructureAlong(ctxOf(n), ids, { kind: 'streetLight', side: 'both', spacing: 25, seed: 1, policy: 'follow' });
    expect(lamps.inputs.length).toBeGreaterThan(10);
    const sig = infrastructureAlong(ctxOf(n), ids, { kind: 'signal', side: 'both', spacing: 0, seed: 1, policy: 'follow' });
    expect(sig.inputs.length).toBe(6); // two T-junctions × 3 approaches
    const signs = infrastructureAlong(ctxOf(n), ids, { kind: 'sign', side: 'both', spacing: 0, seed: 1, policy: 'follow' });
    expect(signs.inputs.length).toBe(6);
  });
  it('vehicles snap to lanes and face the direction of travel', () => {
    const n = draw(emptyNetwork(), [[-60, 0], [60, 0]]);
    const v = vehiclesAlong(ctxOf(n), Object.keys(n.segments), { spacing: 15, mode: 'lanes', seed: 3, policy: 'follow', presets: [{ type: 'car' }] });
    expect(v.inputs.length).toBeGreaterThan(6);
    for (const i of v.inputs) {
      const z = i.transform.position[2];
      expect(Math.abs(Math.abs(z) - 1.75)).toBeLessThan(0.01);
      // Right-hand traffic: +z (right of a→b along +x) drives east (yaw 0), −z west (yaw π).
      const yaw = i.transform.rotation[1];
      if (z > 0) expect(Math.abs(Math.sin(yaw))).toBeLessThan(1e-6);
      if (z > 0) expect(Math.cos(yaw)).toBeGreaterThan(0);
      else expect(Math.cos(yaw)).toBeLessThan(0);
    }
  });
  it('neighbourhood presets are deterministic and complete', () => {
    for (const kind of ['residentialStreet', 'commercialStreet', 'industrialBlock', 'parkBlock'] as const) {
      const a = neighborhood(ctxOf(emptyNetwork()), kind, 0, 0, 0.3, 11);
      const b = neighborhood(ctxOf(emptyNetwork()), kind, 0, 0, 0.3, 11);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(a.segments.length).toBeGreaterThan(0);
      expect(a.inputs.length, kind).toBeGreaterThan(4);
    }
  });
});
