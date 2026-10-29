/** Phase 19: full-map composition with a complex coastline (BENCH=1). */
import { it } from 'vitest';
import { createFlatTerrain } from '@/terrain/TerrainData';
import { composeAll, createLandscape } from '@/landscape/compose';
import { nearest } from '@/roads/curve';
import { featureLine } from '@/landscape/features';
import type { CoastFeature } from '@/landscape/types';

it.skipIf(!process.env.BENCH)('complex coast composition', () => {
  const t = createFlatTerrain();
  const pts: [number, number][] = [];
  for (let k = 0; k < 12; k++) pts.push([-99 + k * 18, 30 + 18 * Math.sin(k * 1.3)]);
  const f: CoastFeature = { id: 'f1', kind: 'coast', points: pts, seaSide: 1, beachSlope: 0.05, beachWidth: 15, offshoreSlope: 0.08, maxDepth: 6, material: 2 };
  const land = createLandscape(t);
  land.features = [f];
  composeAll(land, t, 0);
  const reps = 5;
  let t0 = performance.now();
  for (let r = 0; r < reps; r++) composeAll(land, t, 0);
  const fast = (performance.now() - t0) / reps;
  const line = featureLine(f);
  t0 = performance.now();
  let s = 0;
  for (let i = 0; i < t.heights.length; i++) s += nearest(line, (i % t.nx) - 100, Math.floor(i / t.nx) - 100).dist;
  const exhaustive = performance.now() - t0;
  console.log(JSON.stringify({ samples: line.samples.length, composeMs: +fast.toFixed(1), exhaustiveNearestMs: +exhaustive.toFixed(1), s: Math.round(s) }));
});
