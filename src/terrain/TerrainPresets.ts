/**
 * TerrainPresetGenerator: deterministic starting terrains.
 *
 * Every random number comes from the seeded Rng (never Math.random), so the same preset +
 * seed always produces bit-identical heights. Presets keep the middle of the map (where the
 * sample town stands: |x| ≤ 55 m, |z| ≤ 30 m) gentle enough to build on.
 */
import type { TerrainData, TerrainPresetId } from '@/core/model';
import { smoothstep } from '@/core/math';
import { Rng } from '@/core/random';
import { createFlatTerrain, quantizeHeight } from './TerrainData';
import { DEFAULT_GROUND } from './GroundMaterials';

export const TERRAIN_PRESETS: TerrainPresetId[] = ['flat', 'gentleHills', 'valley', 'coastal'];

/** Smooth value noise on a seeded lattice, summed over octaves (fbm), roughly in [-1, 1]. */
class ValueNoise {
  private readonly size = 64;
  private readonly lattice: Float64Array;

  constructor(rng: Rng) {
    this.lattice = new Float64Array(this.size * this.size);
    for (let i = 0; i < this.lattice.length; i++) this.lattice[i] = rng.next() * 2 - 1;
  }

  private at(ix: number, iz: number): number {
    const s = this.size;
    return this.lattice[(((iz % s) + s) % s) * s + (((ix % s) + s) % s)];
  }

  noise(x: number, z: number): number {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fz = z - iz;
    const ux = fx * fx * (3 - 2 * fx);
    const uz = fz * fz * (3 - 2 * fz);
    const a = this.at(ix, iz);
    const b = this.at(ix + 1, iz);
    const c = this.at(ix, iz + 1);
    const d = this.at(ix + 1, iz + 1);
    return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
  }

  fbm(x: number, z: number, octaves: number): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let f = 1;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x * f + o * 17.3, z * f - o * 9.1);
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return sum / norm;
  }
}

/** 0 inside the town area, 1 well outside it. */
function townMask(x: number, z: number): number {
  const dx = Math.max(0, Math.abs(x) - 55);
  const dz = Math.max(0, Math.abs(z) - 30);
  return smoothstep(0, 30, Math.hypot(dx, dz));
}

type HeightFn = (x: number, z: number) => number;

function presetHeight(preset: TerrainPresetId, seed: number): HeightFn {
  const rng = new Rng(seed).fork(`terrain.${preset}`);
  const noise = new ValueNoise(rng);
  switch (preset) {
    case 'flat':
      return () => 0;
    case 'gentleHills':
      return (x, z) => {
        const n = noise.fbm(x / 55, z / 55, 4);
        // Rolling hills outside the town, softer swells inside it.
        return (2 + n * 7) * (0.25 + 0.75 * townMask(x, z)) - 0.5;
      };
    case 'valley':
      return (x, z) => {
        // East–west valley: floor follows the main street, slopes rise north and south;
        // the floor falls gently toward the east like a stream bed.
        const sides = 16 * smoothstep(32, 92, Math.abs(z));
        const floor = -0.03 * x;
        return floor + sides + noise.fbm(x / 40, z / 40, 3) * (0.6 + 3 * smoothstep(30, 80, Math.abs(z)));
      };
    case 'coastal':
      return (x, z) => {
        // Lowland rising inland (north); a sandy beach and shallow sea along the south edge.
        const coast = 62 + noise.fbm(x / 70, 3.7, 3) * 10;
        const land = 0.045 * (coast - z) + noise.fbm(x / 45, z / 45, 3) * 1.5 * smoothstep(0, 40, coast - z);
        const sea = -3.5 * smoothstep(coast - 4, coast + 22, z);
        return z < coast ? Math.max(0.15, land) : sea + 0.15 * (1 - smoothstep(coast, coast + 6, z));
      };
  }
}

/** Generate a preset into a fresh terrain with the same grid as `like` (default 200 m / 1 m). */
export function generateTerrain(preset: TerrainPresetId, seed: number, like?: Pick<TerrainData, 'nx' | 'cellSize'>): TerrainData {
  const t = createFlatTerrain(like ? (like.nx - 1) * like.cellSize : undefined, like?.cellSize);
  const f = presetHeight(preset, seed);
  const { nx, nz, cellSize: cs, originX, originZ } = t;
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const i = iz * nx + ix;
      const x = originX + ix * cs;
      const z = originZ + iz * cs;
      const h = quantizeHeight(f(x, z));
      t.heights[i] = h;
      t.ground[i] = DEFAULT_GROUND;
      if (preset === 'coastal' && h < 1.3) t.ground[i] = 2; // sand along the shore
    }
  }
  t.settings = { preset, seed, waterLevel: preset === 'coastal' ? 0 : null };
  return t;
}
