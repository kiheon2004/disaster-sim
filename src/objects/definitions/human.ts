import { defineObject } from '../ObjectDefinition';

export interface HumanParams {
  [k: string]: number | string | boolean;
  height: number;
  shirtColor: string;
  pantsColor: string;
}

export const HUMAN_RADIUS = 0.22;

export const humanDefinition = defineObject<HumanParams>({
  type: 'human',
  category: 'people',
  labelKey: 'object.human',
  icon: 'human',
  physicsProfile: 'upright',
  defaultParams: { height: 1.75, shirtColor: '#2fa39a', pantsColor: '#34406b' },
  paramSchema: [
    { key: 'height', labelKey: 'param.height', kind: 'number', min: 1, max: 2.1, step: 0.01, unit: 'm' },
    { key: 'shirtColor', labelKey: 'param.shirtColor', kind: 'color' },
    { key: 'pantsColor', labelKey: 'param.pantsColor', kind: 'color' },
  ],
  defaultPhysics: (p) => ({
    mass: Math.round(40 * p.height),
    friction: 0.6,
    restitution: 0.02,
    anchored: false,
    dragCoefficient: 1.1,
    windResistance: 20,
    durability: 40,
    breakThreshold: 1.6,
  }),
  getDimensions: (p) => [0.5, p.height, 0.3],
  centerOfPressure: (p) => [0, p.height * 0.6, 0],
  frontalArea: (p) => 0.4 * p.height,
  colliders: (p) => [
    { type: 'capsule', radius: HUMAN_RADIUS, halfHeight: Math.max(0.1, p.height / 2 - HUMAN_RADIUS), offset: [0, p.height / 2, 0] },
  ],
  createComponents: (p) => [
    {
      id: 'body',
      kind: 'structure',
      position: [0, p.height / 2, 0],
      size: [0.5, p.height, 0.3],
      normal: null,
      mass: Math.round(40 * p.height),
      windResistance: 20,
      durability: 40,
      detachable: false,
    },
  ],
  randomizeParams: (_p, rnd) => {
    const shirts = ['#2fa39a', '#d9534f', '#f0ad4e', '#5b7bd5', '#8e5bd5', '#e0e0e0', '#3b3b3b', '#c46b9b'];
    const pants = ['#34406b', '#2b2b2b', '#5a4632', '#6b6f78', '#24324f'];
    return {
      height: Math.round((1.55 + rnd() * 0.35) * 100) / 100,
      shirtColor: shirts[Math.floor(rnd() * shirts.length)],
      pantsColor: pants[Math.floor(rnd() * pants.length)],
    };
  },
});
