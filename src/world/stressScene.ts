import type { CreateObjectInput } from './WorldDocument';
import { Rng } from '@/core/random';
import { getDefinition } from '@/objects/registry';
import type { ObjectParams } from '@/core/model';
import type { ObjectType } from '@/core/types';
import { WORLD_HALF } from '@/core/units';

/** Mix of object types used for performance testing (fractions sum to 1). */
const MIX: [ObjectType, number][] = [
  ['building', 0.1],
  ['tree', 0.35],
  ['car', 0.15],
  ['human', 0.25],
  ['streetLight', 0.08],
  ['sign', 0.04],
  ['wall', 0.03],
];

/**
 * Deterministic stress-test scene with `count` objects spread over the world.
 * Buildings go on a coarse grid; everything else fills a fine grid between them.
 */
export function stressScene(count: number, seed = 99): CreateObjectInput[] {
  const rng = new Rng(seed);
  const out: CreateObjectInput[] = [];
  const nBuildings = Math.round(count * MIX[0][1]);
  const margin = 12;
  const span = WORLD_HALF * 2 - margin * 2;

  // Buildings on a coarse grid
  const bCols = Math.ceil(Math.sqrt(nBuildings));
  const bStep = span / Math.max(1, bCols);
  const taken = new Set<string>();
  for (let i = 0; i < nBuildings; i++) {
    const cx = -WORLD_HALF + margin + bStep * ((i % bCols) + 0.5);
    const cz = -WORLD_HALF + margin + bStep * (Math.floor(i / bCols) + 0.5);
    const floors = 2 + rng.int(9);
    const width = Math.min(bStep * 0.45, 8 + rng.int(6));
    out.push(make('building', { floors, width, depth: width * 0.8 }, cx, cz, rng.pick([0, Math.PI / 2]), rng));
    taken.add(`${Math.round(cx / 4)},${Math.round(cz / 4)}`);
  }

  // Everything else on a fine jittered grid, avoiding building footprints
  const rest = count - nBuildings;
  const kinds: ObjectType[] = [];
  for (const [type, frac] of MIX.slice(1)) for (let i = 0; i < Math.round(count * frac); i++) kinds.push(type);
  while (kinds.length < rest) kinds.push('tree');
  kinds.length = rest;
  const cols = Math.ceil(Math.sqrt(rest * 1.6));
  const step = span / cols;
  let k = 0;
  for (let gz = 0; gz < cols && k < rest; gz++) {
    for (let gx = 0; gx < cols && k < rest; gx++) {
      const x = -WORLD_HALF + margin + step * (gx + 0.5) + rng.spread(step * 0.2);
      const z = -WORLD_HALF + margin + step * (gz + 0.5) + rng.spread(step * 0.2);
      // Skip spots inside a building block.
      const nearB = out.some((o) => o.type === 'building' && Math.abs(o.transform.position[0] - x) < bStep * 0.3 && Math.abs(o.transform.position[2] - z) < bStep * 0.3);
      if (nearB) continue;
      out.push(make(kinds[k++], {}, x, z, rng.range(0, Math.PI * 2), rng));
    }
  }
  return out;
}

function make(type: ObjectType, params: ObjectParams, x: number, z: number, yaw: number, rng: Rng): CreateObjectInput {
  const def = getDefinition(type);
  let p: ObjectParams = { ...def.defaultParams, ...params };
  if (def.randomizeParams) p = { ...p, ...(def.randomizeParams(p, () => rng.next()) as ObjectParams) };
  return { type, params: p, seed: rng.int(2 ** 31), transform: { position: [x, 0, z], rotation: [0, yaw, 0], scale: [1, 1, 1] } };
}
