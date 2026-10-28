import type { ComponentSpec } from '@/core/model';
import type { Vec3 } from '@/core/types';
import { seededRandom } from '@/core/math';
import { defineObject } from '../ObjectDefinition';

export interface BuildingParams {
  [k: string]: number | string | boolean;
  floors: number;
  width: number;
  depth: number;
  floorHeight: number;
  color: string;
  sign: boolean;
  rooftopUnits: number;
}

export const PARAPET_HEIGHT = 0.7;
const WINDOW_SPACING = 2.6;
const WINDOW_SIZE: [number, number] = [1.3, 1.45];

export function buildingHeight(p: BuildingParams) {
  return p.floors * p.floorHeight;
}

interface Facade {
  name: 'n' | 's' | 'e' | 'w';
  normal: Vec3;
  length: number;
  /** distance of facade plane from center */
  offset: number;
}

export function facades(p: BuildingParams): Facade[] {
  return [
    { name: 's', normal: [0, 0, 1], length: p.width, offset: p.depth / 2 },
    { name: 'n', normal: [0, 0, -1], length: p.width, offset: p.depth / 2 },
    { name: 'e', normal: [1, 0, 0], length: p.depth, offset: p.width / 2 },
    { name: 'w', normal: [-1, 0, 0], length: p.depth, offset: p.width / 2 },
  ];
}

/** Map a facade-local coordinate (along, y) to object local space. */
function onFacade(f: Facade, along: number, y: number, out: number): Vec3 {
  const d = f.offset + out;
  switch (f.name) {
    case 's': return [along, y, d];
    case 'n': return [-along, y, -d];
    case 'e': return [d, y, -along];
    case 'w': return [-d, y, along];
  }
}

function facadeSize(f: Facade, w: number, h: number, thickness: number): Vec3 {
  return f.name === 's' || f.name === 'n' ? [w, h, thickness] : [thickness, h, w];
}

export const buildingDefinition = defineObject<BuildingParams>({
  type: 'building',
  category: 'buildings',
  labelKey: 'object.building',
  icon: 'building',
  physicsProfile: 'static',
  terrainFit: { align: 0, base: 'min' },
  defaultParams: {
    floors: 4,
    width: 10,
    depth: 8,
    floorHeight: 3.2,
    color: '#c9b79c',
    sign: true,
    rooftopUnits: 2,
  },
  paramSchema: [
    { key: 'floors', labelKey: 'param.floors', kind: 'number', min: 1, max: 30, step: 1 },
    { key: 'width', labelKey: 'param.width', kind: 'number', min: 4, max: 40, step: 0.5, unit: 'm' },
    { key: 'depth', labelKey: 'param.depth', kind: 'number', min: 4, max: 40, step: 0.5, unit: 'm' },
    { key: 'floorHeight', labelKey: 'param.floorHeight', kind: 'number', min: 2.6, max: 5, step: 0.1, unit: 'm' },
    { key: 'color', labelKey: 'param.color', kind: 'color' },
    { key: 'sign', labelKey: 'param.sign', kind: 'boolean' },
    { key: 'rooftopUnits', labelKey: 'param.rooftopUnits', kind: 'number', min: 0, max: 6, step: 1 },
  ],
  defaultPhysics: (p) => ({
    mass: Math.round(p.width * p.depth * buildingHeight(p) * 250),
    friction: 0.8,
    restitution: 0.05,
    anchored: true,
    dragCoefficient: 1.3,
    windResistance: 80,
    durability: 100,
    breakThreshold: 1.5,
  }),
  getDimensions: (p) => [p.width, buildingHeight(p) + PARAPET_HEIGHT, p.depth],
  centerOfPressure: (p) => [0, buildingHeight(p) * 0.55, 0],
  colliders: (p) => [
    { type: 'box', halfExtents: [p.width / 2, buildingHeight(p) / 2, p.depth / 2], offset: [0, buildingHeight(p) / 2, 0] },
  ],
  createComponents: (p, seed) => {
    const rnd = seededRandom(seed);
    const vary = (base: number, pct: number) => base * (1 + (rnd() * 2 - 1) * pct);
    const H = buildingHeight(p);
    const out: ComponentSpec[] = [];

    out.push({
      id: 'structure',
      kind: 'structure',
      position: [0, H / 2, 0],
      size: [p.width, H, p.depth],
      normal: null,
      mass: Math.round(p.width * p.depth * H * 250),
      windResistance: 80,
      durability: 100,
      detachable: false,
      color: p.color,
    });

    // Windows: one per bay, per floor, per facade.
    for (const f of facades(p)) {
      const count = Math.max(1, Math.floor((f.length - 0.8) / WINDOW_SPACING));
      const span = (count - 1) * WINDOW_SPACING;
      for (let floor = 0; floor < p.floors; floor++) {
        for (let i = 0; i < count; i++) {
          const along = -span / 2 + i * WINDOW_SPACING;
          // Ground floor south facade gets a wider shop window.
          const isShop = floor === 0 && f.name === 's';
          const w = isShop ? Math.min(WINDOW_SPACING - 0.3, 2.2) : WINDOW_SIZE[0];
          const h = isShop ? 2.1 : WINDOW_SIZE[1];
          const y = floor * p.floorHeight + (isShop ? 1.25 : p.floorHeight * 0.55);
          out.push({
            id: `win-${f.name}-${floor}-${i}`,
            kind: 'window',
            position: onFacade(f, along, y, 0.03),
            size: facadeSize(f, w, h, 0.08),
            normal: f.normal,
            mass: Math.round(w * h * 25),
            windResistance: vary(isShop ? 42 : 46, 0.12),
            durability: 40,
            detachable: false,
            color: '#8fb8d8',
          });
        }
      }
    }

    // Projecting shop sign on the south facade.
    if (p.sign) {
      const f = facades(p)[0];
      const w = Math.min(p.width * 0.6, 6);
      out.push({
        id: 'sign',
        kind: 'sign',
        position: onFacade(f, 0, Math.min(H - 0.8, 3.0), 0.22),
        size: facadeSize(f, w, 1.1, 0.25),
        normal: f.normal,
        mass: Math.round(w * 14),
        windResistance: vary(30, 0.08),
        durability: 35,
        detachable: true,
        color: '#e8483b',
      });
    }

    // Roof deck panels — edge panels see higher suction and are weaker.
    const nx = Math.max(1, Math.ceil(p.width / 4));
    const nz = Math.max(1, Math.ceil(p.depth / 4));
    const pw = p.width / nx;
    const pd = p.depth / nz;
    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        const edge = ix === 0 || iz === 0 || ix === nx - 1 || iz === nz - 1;
        out.push({
          id: `roof-${ix}-${iz}`,
          kind: 'roof',
          position: [-p.width / 2 + pw * (ix + 0.5), H + 0.06, -p.depth / 2 + pd * (iz + 0.5)],
          size: [pw - 0.06, 0.12, pd - 0.06],
          normal: [0, 1, 0],
          mass: Math.round(pw * pd * 22),
          windResistance: vary(edge ? 46 : 54, 0.1),
          durability: 60,
          detachable: true,
          color: '#77797d',
        });
      }
    }

    // Parapet segments (≤ 4 m long).
    for (const f of facades(p)) {
      const segs = Math.max(1, Math.ceil(f.length / 4));
      const segLen = f.length / segs;
      for (let i = 0; i < segs; i++) {
        const along = -f.length / 2 + segLen * (i + 0.5);
        out.push({
          id: `wall-${f.name}-${i}`,
          kind: 'wall',
          position: onFacade(f, along, H + PARAPET_HEIGHT / 2, -0.1),
          size: facadeSize(f, segLen - 0.04, PARAPET_HEIGHT, 0.2),
          normal: f.normal,
          mass: Math.round(segLen * PARAPET_HEIGHT * 0.2 * 600),
          windResistance: vary(64, 0.08),
          durability: 70,
          detachable: true,
          color: p.color,
        });
      }
    }

    // Rooftop exterior units (A/C condensers, tanks …).
    const units = Math.max(0, Math.min(6, Math.round(p.rooftopUnits)));
    for (let i = 0; i < units; i++) {
      const x = (rnd() - 0.5) * Math.max(0, p.width - 3);
      const z = (rnd() - 0.5) * Math.max(0, p.depth - 3);
      out.push({
        id: `ext-${i}`,
        kind: 'exterior',
        position: [x, H + 0.12 + 0.5, z],
        size: [1.4, 1.0, 1.0],
        normal: null,
        mass: 110,
        windResistance: vary(40, 0.12),
        durability: 50,
        detachable: true,
        color: '#d9dcdf',
      });
    }
    return out;
  },
});
