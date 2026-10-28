import { defineObject } from '../ObjectDefinition';

export interface StreetLightParams {
  [k: string]: number | string | boolean;
  height: number;
  armLength: number;
  color: string;
}

export const POLE_HALF = 0.11;

export const streetLightDefinition = defineObject<StreetLightParams>({
  type: 'streetLight',
  category: 'infrastructure',
  labelKey: 'object.streetLight',
  icon: 'streetLight',
  physicsProfile: 'anchoredUntilFailure',
  defaultParams: { height: 8, armLength: 1.6, color: '#5b6670' },
  paramSchema: [
    { key: 'height', labelKey: 'param.height', kind: 'number', min: 4, max: 14, step: 0.5, unit: 'm' },
    { key: 'armLength', labelKey: 'param.armLength', kind: 'number', min: 0.5, max: 3, step: 0.1, unit: 'm' },
    { key: 'color', labelKey: 'param.color', kind: 'color' },
  ],
  defaultPhysics: (p) => ({
    mass: Math.round(30 * p.height),
    friction: 0.8,
    restitution: 0.05,
    anchored: true,
    dragCoefficient: 1.0,
    windResistance: 55,
    durability: 70,
    breakThreshold: 1.8,
  }),
  getDimensions: (p) => [p.armLength + 0.5, p.height, 0.4],
  centerOfPressure: (p) => [0, p.height * 0.6, 0],
  frontalArea: (p) => POLE_HALF * 2 * p.height + 0.35,
  colliders: (p) => [
    { type: 'box', halfExtents: [POLE_HALF, p.height / 2, POLE_HALF], offset: [0, p.height / 2, 0], massFraction: 0.85 },
    { type: 'box', halfExtents: [p.armLength / 2, 0.08, 0.12], offset: [p.armLength / 2, p.height - 0.1, 0], massFraction: 0.15 },
  ],
  createComponents: (p) => [
    {
      id: 'structure', kind: 'structure', position: [0, p.height / 2, 0], size: [POLE_HALF * 2, p.height, POLE_HALF * 2],
      normal: null, mass: Math.round(25 * p.height), windResistance: 55, durability: 70, detachable: false, color: p.color,
    },
    {
      id: 'lamp', kind: 'exterior', position: [p.armLength, p.height - 0.2, 0], size: [0.7, 0.22, 0.34],
      normal: null, mass: 18, windResistance: 46, durability: 45, detachable: true, color: '#e9edf2',
    },
  ],
});
