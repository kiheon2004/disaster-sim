import type { CreateObjectInput } from './WorldDocument';
import { seededRandom } from '@/core/math';
import type { ObjectParams } from '@/core/model';
import { PALETTE } from '@/objects/palette';
import { getDefinition } from '@/objects/registry';

const preset = (id: string) => PALETTE.find((p) => p.id === id)!;

function place(id: string, x: number, z: number, yaw = 0, extra: Record<string, number | string | boolean> = {}, rnd?: () => number): CreateObjectInput {
  const item = preset(id);
  const def = getDefinition(item.type);
  let params = { ...def.defaultParams, ...(item.params ?? {}), ...extra };
  if (rnd && item.randomize && def.randomizeParams) params = { ...params, ...(def.randomizeParams(params, rnd) as ObjectParams) };
  return {
    type: item.type,
    params,
    seed: Math.floor((rnd ?? Math.random)() * 2 ** 31),
    transform: { position: [x, 0, z], rotation: [0, yaw, 0], scale: [1, 1, 1] },
  };
}

/** A small deterministic town: a main street lined with buildings, trees, parked cars and people. */
export function sampleTown(): CreateObjectInput[] {
  const rnd = seededRandom(20261007);
  const out: CreateObjectInput[] = [];

  // North side (facing the street to the south)
  out.push(place('building.lowrise', -32, -17, 0, { floors: 3, color: '#c9b79c' }, rnd));
  out.push(place('building.office', -14, -19, 0, { floors: 9, color: '#8d9db2' }, rnd));
  out.push(place('building.house', 2, -15.5, 0, { color: '#e6d6bb' }, rnd));
  out.push(place('building.lowrise', 16, -17, 0, { floors: 5, color: '#b88f7a', sign: true }, rnd));
  out.push(place('building.office', 35, -20, 0, { floors: 14, width: 14, depth: 14, color: '#9aa7b8' }, rnd));
  // South side (rotated to face north)
  out.push(place('building.lowrise', -26, 17, Math.PI, { floors: 4, color: '#d8c9a6' }, rnd));
  out.push(place('building.house', -8, 15.5, Math.PI, { color: '#d4c2a1' }, rnd));
  out.push(place('building.lowrise', 10, 17, Math.PI, { floors: 2, width: 12, color: '#c7a98d' }, rnd));

  // Street trees
  for (let x = -40; x <= 44; x += 9) {
    out.push(place('tree.broadleaf', x + (rnd() - 0.5), -7.5, rnd() * 6, {}, rnd));
    if (x % 2 === 0) out.push(place('tree.broadleaf', x + 4 + (rnd() - 0.5), 7.5, rnd() * 6, {}, rnd));
  }
  // A small park with conifers
  for (let i = 0; i < 9; i++) {
    out.push(place(i % 3 === 0 ? 'tree.broadleaf' : 'tree.conifer', 26 + (i % 3) * 6 + rnd() * 2, 16 + Math.floor(i / 3) * 6 + rnd() * 2, rnd() * 6, {}, rnd));
  }

  // Parked cars (length along X = along the street)
  const carColors = ['#3d6fd6', '#d64545', '#e9e9e6', '#2d2f33', '#3c8f5a', '#c9a227'];
  [-28, -16, -2, 12].forEach((x, i) => out.push(place('car.sedan', x, -3.2, 0, { color: carColors[i % carColors.length] }, rnd)));
  out.push(place('car.suv', 22, -3.2, 0, { color: '#e9e9e6' }, rnd));
  [-20, -6, 6].forEach((x, i) => out.push(place('car.sedan', x, 3.2, Math.PI, { color: carColors[(i + 3) % carColors.length] }, rnd)));
  out.push(place('car.truck', 30, 3.4, Math.PI, {}, rnd));

  // People on the sidewalks
  for (let i = 0; i < 12; i++) {
    const side = i % 2 === 0 ? -9.5 : 9.5;
    out.push(place('human.adult', -36 + i * 6.5 + rnd() * 2, side + (rnd() - 0.5) * 1.5, rnd() * Math.PI * 2, {}, rnd));
  }
  return out;
}
