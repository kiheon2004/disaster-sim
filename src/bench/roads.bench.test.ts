/**
 * Phase 18: cost of the road core (no rendering context): network construction, full bake,
 * intersections, meshes, and the latency of a single edit (dirty-rect re-bake + mesh pieces).
 *
 *   BENCH=1 npx vitest run src/bench/roads --silent=false
 */
import { describe, it } from 'vitest';
import { createFlatTerrain, fullRect } from '@/terrain/TerrainData';
import { generateTerrain } from '@/terrain/TerrainPresets';
import { TerrainSampler } from '@/terrain/TerrainSampler';
import { drawRoad, moveNode } from '@/roads/network';
import { bakeRegion, dirtyRect } from '@/roads/bake';
import { intersectionsOf } from '@/roads/intersections';
import { networkPieces, segmentPiece, intersectionPiece } from '@/roads/mesh';
import { blocksOf } from '@/roads/blocks';
import { defaultProfile, emptyNetwork, type RoadNetwork } from '@/roads/types';

/** A k×k street grid over the 200 m world → 2·k·(k−1) segments. */
export function gridNetwork(k: number, width = 6): RoadNetwork {
  const p = { ...defaultProfile(), width, sidewalkWidth: 1.5, lanes: 2 };
  let n = emptyNetwork();
  const span = 180, step = span / (k - 1);
  for (let i = 0; i < k; i++) {
    const c = -span / 2 + i * step;
    n = drawRoad(n, [[-span / 2, c], [span / 2, c]], { curved: false, profile: p }).network;
  }
  for (let i = 0; i < k; i++) {
    const c = -span / 2 + i * step;
    n = drawRoad(n, [[c, -span / 2], [c, span / 2]], { curved: false, profile: p }).network;
  }
  return n;
}

const ms = (fn: () => void) => { const t0 = performance.now(); fn(); return +(performance.now() - t0).toFixed(1); };

describe.skipIf(!process.env.BENCH)('road core cost', () => {
  it('50 / 200 / 500 segments', { timeout: 600_000 }, () => {
    const rows: Record<string, unknown>[] = [];
    for (const k of [6, 11, 16]) {
      let n = emptyNetwork();
      const tBuild = ms(() => { n = gridNetwork(k); });
      const segs = Object.keys(n.segments).length;
      const t = generateTerrain('gentleHills', 2, createFlatTerrain());
      let net = n;
      const tBake = ms(() => { const r = bakeRegion(t, emptyNetwork(), n, fullRect(t)); net = { ...n, underlay: r.underlay }; });
      const tInt = ms(() => intersectionsOf(net));
      const sampler = new TerrainSampler(t);
      let tris = 0;
      const tMesh = ms(() => { for (const p of networkPieces({ network: net, terrain: t, sampler }).values()) tris += p.surface.triangles + p.marking.triangles + p.walk.triangles; });
      const tBlocks = ms(() => blocksOf(net));
      // One edit: move an interior node by 3 m → dirty rect re-bake + affected pieces.
      const node = Object.values(net.nodes).find((x) => Math.abs(x.x) < 30 && Math.abs(x.z) < 30)!;
      const moved = moveNode(net, node.id, node.x + 3, node.z + 2);
      let rect = dirtyRect(t, net, moved)!;
      const tEdit = ms(() => {
        rect = dirtyRect(t, net, moved)!;
        bakeRegion(t, net, moved, rect);
        const ints = intersectionsOf(moved);
        const sm = new TerrainSampler(t);
        for (const s of Object.values(moved.segments)) if (s.a === node.id || s.b === node.id) segmentPiece({ network: moved, terrain: t, sampler: sm }, s);
        const ix = ints.get(node.id);
        if (ix) intersectionPiece({ network: moved, terrain: t, sampler: sm }, ix);
      });
      rows.push({ segments: segs, junctions: [...intersectionsOf(net).values()].filter((i) => i.junction).length, buildMs: tBuild, bakeMs: tBake, intersectionsMs: tInt, meshMs: tMesh, triangles: tris, blocks: blocksOf(net).length, blocksMs: tBlocks, editMs: tEdit, editRect: `${rect.x1 - rect.x0 + 1}×${rect.z1 - rect.z0 + 1}` });
    }
    console.table(rows);
    console.log(JSON.stringify(rows));
  });
});
