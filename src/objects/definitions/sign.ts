import { defineObject } from '../ObjectDefinition';

export interface SignParams {
  [k: string]: number | string | boolean;
  height: number;
  panelWidth: number;
  panelHeight: number;
  color: string;
}

export const signDefinition = defineObject<SignParams>({
  type: 'sign',
  category: 'infrastructure',
  labelKey: 'object.sign',
  icon: 'sign',
  physicsProfile: 'anchoredUntilFailure',
  terrainFit: { align: 0, base: 'min' },
  defaultParams: { height: 3.2, panelWidth: 2.4, panelHeight: 1.4, color: '#2f7d4f' },
  paramSchema: [
    { key: 'height', labelKey: 'param.height', kind: 'number', min: 1.5, max: 8, step: 0.1, unit: 'm' },
    { key: 'panelWidth', labelKey: 'param.panelWidth', kind: 'number', min: 0.6, max: 8, step: 0.1, unit: 'm' },
    { key: 'panelHeight', labelKey: 'param.panelHeight', kind: 'number', min: 0.4, max: 4, step: 0.1, unit: 'm' },
    { key: 'color', labelKey: 'param.color', kind: 'color' },
  ],
  defaultPhysics: (p) => ({
    mass: Math.round(40 + p.panelWidth * p.panelHeight * 20),
    friction: 0.8,
    restitution: 0.05,
    anchored: true,
    dragCoefficient: 1.2,
    windResistance: 42,
    durability: 55,
    breakThreshold: 1.7,
  }),
  getDimensions: (p) => [p.panelWidth, p.height, 0.2],
  centerOfPressure: (p) => [0, p.height - p.panelHeight / 2, 0],
  frontalArea: (p) => p.panelWidth * p.panelHeight + 0.12 * (p.height - p.panelHeight),
  colliders: (p) => [
    { type: 'box', halfExtents: [0.06, p.height / 2, 0.06], offset: [0, p.height / 2, 0], massFraction: 0.5 },
    { type: 'box', halfExtents: [p.panelWidth / 2, p.panelHeight / 2, 0.04], offset: [0, p.height - p.panelHeight / 2, 0.08], massFraction: 0.5 },
  ],
  createComponents: (p) => [
    {
      id: 'structure', kind: 'structure', position: [0, p.height / 2, 0], size: [0.12, p.height, 0.12],
      normal: null, mass: 40, windResistance: 42, durability: 55, detachable: false, color: '#9aa3ad',
    },
    {
      id: 'panel', kind: 'sign', position: [0, p.height - p.panelHeight / 2, 0.08], size: [p.panelWidth, p.panelHeight, 0.06],
      normal: [0, 0, 1], mass: Math.round(p.panelWidth * p.panelHeight * 20), windResistance: 33, durability: 40, detachable: true, color: p.color,
    },
  ],
});
