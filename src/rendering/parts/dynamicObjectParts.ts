/**
 * Phase 35 Level 1 passive objects as voxel box parts (editor views and the simulation adapter draw the same lists).
 * The silhouettes follow the colliders: boxes are the collider boxes; a drum (cylinder) is three squares rotated by 30°
 * (12-point outline between 0.82 r and 1.16 r) and a ball is three crossed slabs plus a core cube.
 */
import type { Vec3 } from '@/core/types';
import type { ObjectParams } from '@/core/model';
import {
  CONTAINERS, DRUM, NJ_BANDS, sofaBoxes, tableBoxes,
  type BallParams, type ContainerParams, type CrateParams, type FurnitureParams, type RoadBarrierParams,
} from '@/objects/definitions/dynamicObjects';
import { shade } from '../materials';
import type { BoxPart, PartMat } from './objectParts';

export interface PassiveParts {
  body: BoxPart[];
  /** Far LOD: the main shape only. */
  lod: BoxPart[];
  mat: PartMat;
}

/** Part list of a passive object type; null for any other type. */
export function passiveParts(type: string, params: ObjectParams): PassiveParts | null {
  switch (type) {
    case 'crate': return crateParts(params as CrateParams);
    case 'barrel': return barrelParts(params as { color: string });
    case 'container': return containerParts(params as ContainerParams);
    case 'furniture': return furnitureParts(params as FurnitureParams);
    case 'roadBarrier': return barrierParts(params as RoadBarrierParams);
    case 'ball': return ballParts(params as BallParams);
    default: return null;
  }
}

function crateParts(p: CrateParams): PassiveParts {
  const { length: L, height: H, width: W } = p;
  const main: BoxPart = { size: [L, H, W], position: [0, H / 2, 0], color: p.color };
  const band = Math.min(0.08, H * 0.12);
  const edge = shade(p.color, -0.12);
  const body: BoxPart[] = [
    main,
    // Frame boards around the bottom and top edges.
    { size: [L + 0.02, band, W + 0.02], position: [0, band / 2, 0], color: edge },
    { size: [L + 0.02, band, W + 0.02], position: [0, H - band / 2, 0], color: edge },
  ];
  return { body, lod: [main], mat: p.material === 'steel' ? 'car' : 'standard' };
}

/** Three squares rotated 0 / 30 / 60° about Y: a 12-point stand-in for a cylinder of radius r. */
function drum(r: number, h: number, y: number, color: string): BoxPart[] {
  const s = 1.64 * r;
  return [0, 30, 60].map((deg) => ({ size: [s, h, s] as Vec3, position: [0, y, 0] as Vec3, rotation: [0, (deg * Math.PI) / 180, 0] as Vec3, color }));
}

function barrelParts(p: { color: string }): PassiveParts {
  const { radius: r, height: h } = DRUM;
  const shell = drum(r, h, h / 2, p.color);
  const hoop = shade(p.color, -0.15);
  const body = [...shell, ...drum(r * 1.03, 0.03, h / 3, hoop), ...drum(r * 1.03, 0.03, (2 * h) / 3, hoop), ...drum(r * 0.98, 0.012, h + 0.006, shade(p.color, 0.08))];
  return { body, lod: shell, mat: 'car' };
}

function containerParts(p: ContainerParams): PassiveParts {
  const c = CONTAINERS[p.size] ?? CONTAINERS['20ft'];
  const { length: L, height: H, width: W } = c;
  const main: BoxPart = { size: [L, H, W], position: [0, H / 2, 0], color: p.color };
  const rib = shade(p.color, -0.1);
  const body: BoxPart[] = [main];
  // Corrugation ribs along both long sides (every ≈ 0.6 m), corner posts, door end.
  const n = Math.max(2, Math.round(L / 0.6));
  for (let i = 0; i < n; i++) {
    const x = -L / 2 + ((i + 0.5) * L) / n;
    for (const s of [-1, 1]) body.push({ size: [0.12, H * 0.9, 0.03], position: [x, H / 2, s * (W / 2 + 0.01)], color: rib });
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) body.push({ size: [0.16, H, 0.16], position: [sx * (L / 2 - 0.07), H / 2, sz * (W / 2 - 0.07)], color: shade(p.color, -0.18) });
  body.push({ size: [0.02, H * 0.88, W * 0.9], position: [L / 2 + 0.01, H / 2, 0], color: rib });
  return { body, lod: [main], mat: 'car' };
}

function furnitureParts(p: FurnitureParams): PassiveParts {
  const { length: L, height: H, width: W } = p;
  if (p.kind === 'table') {
    const t = tableBoxes(p);
    const top: BoxPart = { size: t.top.size, position: t.top.centre, color: p.color };
    const legs = t.legs.map<BoxPart>((l) => ({ size: l.size, position: l.centre, color: shade(p.color, -0.1) }));
    return { body: [top, ...legs], lod: [top, ...legs], mat: 'standard' };
  }
  if (p.kind === 'sofa') {
    const s = sofaBoxes(p);
    const seat: BoxPart = { size: s.seat.size, position: s.seat.centre, color: shade(p.color, -0.06) };
    const back: BoxPart = { size: s.back.size, position: s.back.centre, color: p.color };
    const arms = s.arms.map<BoxPart>((a) => ({ size: a.size, position: a.centre, color: p.color }));
    // Cushions: a lighter layer on the seat between the arms.
    const cushionL = L - 2 * s.arms[0].size[0];
    const cushion: BoxPart = { size: [cushionL * 0.98, 0.04, s.arms[0].size[2] * 0.96], position: [0, s.seat.size[1] + 0.02, s.arms[0].centre[2]], color: shade(p.color, 0.08) };
    return { body: [seat, back, ...arms, cushion], lod: [seat, back, ...arms], mat: 'standard' };
  }
  const main: BoxPart = { size: [L, H, W], position: [0, H / 2, 0], color: p.color };
  const line = shade(p.color, -0.2);
  return {
    body: [
      main,
      { size: [0.01, H * 0.9, 0.01], position: [0, H / 2, W / 2 + 0.005], color: line },
      { size: [0.03, 0.18, 0.03], position: [-0.06, H * 0.55, W / 2 + 0.015], color: '#6b6b6b' },
      { size: [0.03, 0.18, 0.03], position: [0.06, H * 0.55, W / 2 + 0.015], color: '#6b6b6b' },
    ],
    lod: [main],
    mat: 'standard',
  };
}

function barrierParts(p: RoadBarrierParams): PassiveParts {
  const body = NJ_BANDS.map<BoxPart>((b, i) => ({ size: [p.length, b.y1 - b.y0, b.width], position: [0, (b.y0 + b.y1) / 2, 0], color: shade(p.color, i === 0 ? -0.06 : 0) }));
  return { body, lod: body, mat: 'standard' };
}

function ballParts(p: BallParams): PassiveParts {
  const r = p.radius;
  const d = 2 * r;
  const body: BoxPart[] = [
    { size: [d * 0.8, d * 0.8, d * 0.8], position: [0, r, 0], color: p.color },
    { size: [d, d * 0.55, d * 0.55], position: [0, r, 0], color: p.color },
    { size: [d * 0.55, d, d * 0.55], position: [0, r, 0], color: shade(p.color, -0.08) },
    { size: [d * 0.55, d * 0.55, d], position: [0, r, 0], color: p.color },
  ];
  return { body, lod: body.slice(0, 1), mat: 'standard' };
}
