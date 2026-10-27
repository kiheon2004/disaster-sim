import { defineObject } from '../ObjectDefinition';

export interface TreeParams {
  [k: string]: number | string | boolean;
  species: 'broadleaf' | 'conifer';
  height: number;
  canopyRadius: number;
  trunkRadius: number;
}

/** Height of the visible trunk below the canopy. */
export function trunkHeight(p: TreeParams) {
  return p.species === 'conifer' ? p.height * 0.22 : Math.max(1, p.height - p.canopyRadius * 1.7);
}

/** Where the trunk snaps when the tree fails (fraction of total height). */
export const SNAP_FRACTION = 0.18;

export const treeDefinition = defineObject<TreeParams>({
  type: 'tree',
  category: 'nature',
  labelKey: 'object.tree',
  icon: 'tree',
  physicsProfile: 'anchoredUntilFailure',
  defaultParams: { species: 'broadleaf', height: 8, canopyRadius: 2.6, trunkRadius: 0.3 },
  paramSchema: [
    {
      key: 'species',
      labelKey: 'param.species',
      kind: 'select',
      options: [
        { value: 'broadleaf', labelKey: 'param.species.broadleaf' },
        { value: 'conifer', labelKey: 'param.species.conifer' },
      ],
    },
    { key: 'height', labelKey: 'param.height', kind: 'number', min: 3, max: 25, step: 0.5, unit: 'm' },
    { key: 'canopyRadius', labelKey: 'param.canopyRadius', kind: 'number', min: 0.8, max: 7, step: 0.1, unit: 'm' },
    { key: 'trunkRadius', labelKey: 'param.trunkRadius', kind: 'number', min: 0.1, max: 1, step: 0.05, unit: 'm' },
  ],
  defaultPhysics: (p) => ({
    mass: Math.round(Math.PI * p.trunkRadius ** 2 * p.height * 650 + p.canopyRadius ** 3 * 18),
    friction: 0.9,
    restitution: 0.05,
    anchored: true,
    dragCoefficient: 0.6,
    windResistance: p.species === 'conifer' ? 33 : 30,
    durability: 50,
    breakThreshold: 1.6,
  }),
  getDimensions: (p) => [p.canopyRadius * 2, p.height, p.canopyRadius * 2],
  centerOfPressure: (p) => [0, p.height - p.canopyRadius * (p.species === 'conifer' ? 1.6 : 0.95), 0],
  frontalArea: (p) => {
    // Porous canopy (≈ 70 % solid) + trunk.
    const canopy = p.species === 'conifer'
      ? p.canopyRadius * (p.height - trunkHeight(p)) * 0.75
      : Math.PI * p.canopyRadius ** 2 * 0.7;
    return canopy + 2 * p.trunkRadius * trunkHeight(p);
  },
  colliders: (p) => {
    const th = trunkHeight(p);
    return [
      { type: 'box', halfExtents: [p.trunkRadius, p.height / 2, p.trunkRadius], offset: [0, p.height / 2, 0], massFraction: 0.75 },
      {
        type: 'box',
        halfExtents: [p.canopyRadius * 0.8, (p.height - th) / 2, p.canopyRadius * 0.8],
        offset: [0, th + (p.height - th) / 2, 0],
        massFraction: 0.25,
      },
    ];
  },
  createComponents: (p) => {
    const th = trunkHeight(p);
    return [
      {
        id: 'trunk',
        kind: 'trunk',
        position: [0, p.height / 2, 0],
        size: [p.trunkRadius * 2, p.height, p.trunkRadius * 2],
        normal: null,
        mass: Math.round(Math.PI * p.trunkRadius ** 2 * p.height * 650),
        windResistance: p.species === 'conifer' ? 33 : 30,
        durability: 50,
        detachable: false,
        color: '#6b4a2f',
      },
      {
        id: 'canopy',
        kind: 'canopy',
        position: [0, th + (p.height - th) / 2, 0],
        size: [p.canopyRadius * 2, p.height - th, p.canopyRadius * 2],
        normal: null,
        mass: Math.round(p.canopyRadius ** 3 * 18),
        windResistance: 22,
        durability: 30,
        detachable: false,
        color: p.species === 'conifer' ? '#2f6b3a' : '#4f8f3a',
      },
    ];
  },
  randomizeParams: (p, rnd) => {
    const k = 0.85 + rnd() * 0.3;
    return {
      height: Math.round(p.height * k * 10) / 10,
      canopyRadius: Math.round(p.canopyRadius * (0.88 + rnd() * 0.24) * 10) / 10,
    };
  },
});
