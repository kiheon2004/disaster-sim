import { defineObject } from '../ObjectDefinition';

export interface RoadParams {
  [k: string]: number | string | boolean;
  length: number;
  width: number;
  lanes: number;
}

export const ROAD_THICKNESS = 0.04;

export const roadDefinition = defineObject<RoadParams>({
  type: 'road',
  category: 'environment',
  labelKey: 'object.road',
  icon: 'road',
  physicsProfile: 'static',
  terrainFit: { align: 0, base: 'center' },
  inert: true,
  groundLayer: true,
  defaultParams: { length: 20, width: 7, lanes: 2 },
  paramSchema: [
    { key: 'length', labelKey: 'param.length', kind: 'number', min: 4, max: 200, step: 1, unit: 'm' },
    { key: 'width', labelKey: 'param.width', kind: 'number', min: 3, max: 30, step: 0.5, unit: 'm' },
    { key: 'lanes', labelKey: 'param.lanes', kind: 'number', min: 1, max: 6, step: 1 },
  ],
  defaultPhysics: () => ({
    mass: 1,
    friction: 0.9,
    restitution: 0,
    anchored: true,
    dragCoefficient: 0.01,
    windResistance: 150,
    durability: 100,
    breakThreshold: 5,
  }),
  getDimensions: (p) => [p.length, ROAD_THICKNESS, p.width],
  centerOfPressure: () => [0, 0, 0],
  colliders: () => [],
  createComponents: () => [],
});
