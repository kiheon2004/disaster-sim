import { defineObject } from '../ObjectDefinition';

export interface WallParams {
  [k: string]: number | string | boolean;
  length: number;
  height: number;
  thickness: number;
  color: string;
}

export const WALL_DENSITY = 1800; // kg/m³ (masonry)

export const wallDefinition = defineObject<WallParams>({
  type: 'wall',
  category: 'infrastructure',
  labelKey: 'object.wall',
  icon: 'wall',
  physicsProfile: 'anchoredUntilFailure',
  terrainFit: { align: 0, base: 'min' },
  defaultParams: { length: 6, height: 2, thickness: 0.25, color: '#b9a689' },
  paramSchema: [
    { key: 'length', labelKey: 'param.length', kind: 'number', min: 1, max: 40, step: 0.5, unit: 'm' },
    { key: 'height', labelKey: 'param.height', kind: 'number', min: 0.5, max: 5, step: 0.1, unit: 'm' },
    { key: 'thickness', labelKey: 'param.thickness', kind: 'number', min: 0.1, max: 0.6, step: 0.05, unit: 'm' },
    { key: 'color', labelKey: 'param.color', kind: 'color' },
  ],
  defaultPhysics: (p) => ({
    mass: Math.round(p.length * p.height * p.thickness * WALL_DENSITY),
    friction: 0.8,
    restitution: 0.02,
    anchored: true,
    dragCoefficient: 1.3,
    windResistance: 40,
    durability: 60,
    breakThreshold: 1.6,
  }),
  getDimensions: (p) => [p.length, p.height, p.thickness],
  centerOfPressure: (p) => [0, p.height * 0.5, 0],
  colliders: (p) => [{ type: 'box', halfExtents: [p.length / 2, p.height / 2, p.thickness / 2], offset: [0, p.height / 2, 0] }],
  createComponents: (p) => [
    {
      id: 'structure', kind: 'structure', position: [0, p.height / 2, 0], size: [p.length, p.height, p.thickness],
      normal: [0, 0, 1], mass: Math.round(p.length * p.height * p.thickness * WALL_DENSITY), windResistance: 40, durability: 60,
      detachable: false, color: p.color,
    },
  ],
});
