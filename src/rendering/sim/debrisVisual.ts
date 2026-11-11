/**
 * Phase 36 (render-only): debris looks by structural type (buildings/structuralType.ts `debrisSize`, `dust`).
 *
 *  - Dust puffs of a collapse carry a visual factor (Particle.k, the mass-weighted `dust` of the members involved — set at
 *    the three spawn sites of StructuralCollapseSystem without touching the particle count or the effects RNG): the
 *    renderer scales the puff by it. Masonry and concrete raise thick dust, steel, timber and light cladding little.
 *  - A structural fragment (one rigid body, exact member mass) is DRAWN as round(1 / debrisSize) chunks along its longest
 *    axis inside its own box — masonry breaks into small pieces, RC into a few, steel / timber / cladding stay whole. The
 *    body is never split: mass bookkeeping and the fragment budget do not change.
 * Neither is read by the simulation. No separate "count" / "shape" coefficient exists: the chunk count follows debrisSize.
 */
import { memberMaterial, type StructuralGraph } from '@/structure/graph';
import { STRUCTURAL_TYPES, typeOfMaterial } from '@/buildings/structuralType';

/** Most chunks a fragment is drawn as (masonry: 1 / 0.25). */
export const MAX_CHUNKS = 4;

/** `debrisSize` and `dust` of a member's structural type. */
export function debrisLook(g: StructuralGraph, i: number): { size: number; dust: number } {
  const p = STRUCTURAL_TYPES[typeOfMaterial(memberMaterial(g, i).id)];
  return { size: p.debrisSize, dust: p.dust };
}

/** Drawn size of a dust puff relative to the Phase 25 look (rc = 1; steel 0.6, masonry 1.2). */
export const dustScale = (k: number | undefined) => (k === undefined ? 1 : 0.5 + 0.5 * k);

export function chunkCount(debrisSize: number): number {
  return Math.max(1, Math.min(MAX_CHUNKS, Math.round(1 / Math.max(1e-3, debrisSize))));
}

/**
 * Chunks of a fragment box `size` (local): n pieces along its longest axis, each a little narrower and shorter than its
 * slot (deterministic per `seed`), so all lie inside the box. Writes [cx, cy, cz, sx, sy, sz] per chunk into `out`.
 */
export function debrisChunks(size: readonly number[], n: number, seed: number, out: Float32Array): number {
  const a = size[0] >= size[1] && size[0] >= size[2] ? 0 : size[1] >= size[2] ? 1 : 2;
  let h = (seed >>> 0) || 1;
  const rnd = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1000) / 1000; };
  for (let j = 0; j < n; j++) {
    const o = 6 * j;
    for (let d = 0; d < 3; d++) {
      if (d === a) {
        out[o + d] = (-0.5 + (j + 0.5) / n) * size[d];
        out[o + 3 + d] = (size[d] / n) * (n > 1 ? 0.9 : 1);
      } else {
        const f = n > 1 ? 0.75 + 0.25 * rnd() : 1;
        out[o + 3 + d] = size[d] * f;
        out[o + d] = (rnd() - 0.5) * (size[d] - out[o + 3 + d]);
      }
    }
  }
  return n;
}
