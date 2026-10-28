/**
 * Cost of the terrain building blocks (no rendering context needed).
 *
 *   BENCH=1 npx vitest run src/bench/terrainCost --silent=false
 */
import { describe, it } from 'vitest';
import { Rng } from '@/core/random';
import type { Vec3 } from '@/core/types';
import { RapierEngine } from '@/physics/RapierEngine';
import { createFlatTerrain } from '@/terrain/TerrainData';
import { generateTerrain } from '@/terrain/TerrainPresets';
import { TerrainSampler } from '@/terrain/TerrainSampler';
import { applyDab } from '@/terrain/TerrainEditor';
import { decodeTerrain, encodeTerrain } from '@/terrain/terrainCodec';
import { terrainColliderDesc } from '@/terrain/TerrainPhysicsAdapter';
import { TerrainSurface } from '@/rendering/terrain/TerrainSurface';

function time(fn: () => void, reps: number): number {
  fn();
  const t0 = performance.now();
  for (let i = 0; i < reps; i++) fn();
  return (performance.now() - t0) / reps;
}

describe.skipIf(!process.env.BENCH)('terrain cost', () => {
  it('building blocks', async () => {
    const rows: Record<string, string> = {};
    const hills = generateTerrain('gentleHills', 1);
    const pts = new Float64Array(200_000);
    const rng = new Rng(1);
    for (let i = 0; i < pts.length; i++) pts[i] = rng.range(-100, 100);
    for (const [name, t] of [['flat', createFlatTerrain()], ['hills', hills]] as const) {
      const s = new TerrainSampler(t);
      let acc = 0;
      const n: Vec3 = [0, 0, 0];
      const q = time(() => { for (let i = 0; i < pts.length; i += 2) acc += s.sampleHeight(pts[i], pts[i + 1]); }, 10);
      rows[`sampleHeight ns (${name})`] = ((q * 1e6) / (pts.length / 2)).toFixed(1);
      const qn = time(() => { for (let i = 0; i < pts.length; i += 2) acc += s.sampleNormal(pts[i], pts[i + 1], n)[1]; }, 10);
      rows[`sampleNormal ns (${name})`] = ((qn * 1e6) / (pts.length / 2)).toFixed(1);
      if (acc === 42) console.log('');
    }
    rows['generate preset ms'] = time(() => generateTerrain('valley', 3), 5).toFixed(2);
    const work = generateTerrain('gentleHills', 1);
    for (const r of [8, 30]) {
      for (const op of ['raise', 'smooth', 'paint'] as const) {
        rows[`dab ${op} r=${r} ms`] = time(() => applyDab(work, { op, x: 10, z: 5, brush: { radius: r, strength: 0.5 }, dt: 1 / 60, groundType: 3 }), 50).toFixed(3);
      }
    }
    const surface = new TerrainSurface(hills, 'surface');
    rows['mesh full build ms'] = time(() => new TerrainSurface(hills, 'surface').dispose(), 5).toFixed(2);
    rows['mesh full update ms'] = time(() => surface.update(null), 10).toFixed(2);
    rows['mesh dab update r=8 ms'] = time(() => surface.update({ x0: 92, z0: 92, x1: 108, z1: 108 }), 50).toFixed(3);
    rows['mesh dab update r=30 ms'] = time(() => surface.update({ x0: 70, z0: 70, x1: 130, z1: 130 }), 50).toFixed(3);
    const eng = new RapierEngine();
    await eng.init(9.81, null);
    rows['collider flat ms'] = time(() => eng.setTerrain(null), 20).toFixed(3);
    rows['collider heightfield ms'] = time(() => eng.setTerrain(terrainColliderDesc(hills)), 10).toFixed(2);
    eng.dispose();
    const enc = encodeTerrain(hills);
    rows['encode ms'] = time(() => encodeTerrain(hills), 10).toFixed(2);
    rows['decode ms'] = time(() => decodeTerrain(enc), 10).toFixed(2);
    rows['saved terrain KB (hills)'] = (JSON.stringify(enc).length / 1024).toFixed(1);
    rows['saved terrain KB (valley)'] = (JSON.stringify(encodeTerrain(generateTerrain('valley', 1))).length / 1024).toFixed(1);
    rows['saved terrain KB (flat)'] = (JSON.stringify(encodeTerrain(createFlatTerrain())).length / 1024).toFixed(2);
    console.log(JSON.stringify(rows, null, 1));
  }, 300_000);
});
