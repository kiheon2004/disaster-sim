import { defineObject } from '../ObjectDefinition';

export interface CarParams {
  [k: string]: number | string | boolean;
  variant: 'sedan' | 'suv' | 'truck';
  length: number;
  width: number;
  height: number;
  color: string;
}

export const CAR_CLEARANCE = 0.32;

export const carDefinition = defineObject<CarParams>({
  type: 'car',
  category: 'vehicles',
  labelKey: 'object.car',
  icon: 'car',
  physicsProfile: 'dynamic',
  terrainFit: { align: 1, base: 'mean' },
  defaultParams: { variant: 'sedan', length: 4.5, width: 1.8, height: 1.45, color: '#3d6fd6' },
  paramSchema: [
    {
      key: 'variant',
      labelKey: 'param.variant',
      kind: 'select',
      options: [
        { value: 'sedan', labelKey: 'param.variant.sedan' },
        { value: 'suv', labelKey: 'param.variant.suv' },
        { value: 'truck', labelKey: 'param.variant.truck' },
      ],
    },
    { key: 'length', labelKey: 'param.length', kind: 'number', min: 2.5, max: 12, step: 0.1, unit: 'm' },
    { key: 'width', labelKey: 'param.width', kind: 'number', min: 1.4, max: 2.6, step: 0.05, unit: 'm' },
    { key: 'height', labelKey: 'param.height', kind: 'number', min: 1.1, max: 3.8, step: 0.05, unit: 'm' },
    { key: 'color', labelKey: 'param.color', kind: 'color' },
  ],
  defaultPhysics: (p) => ({
    mass: Math.round(p.length * p.width * p.height * 120),
    friction: 0.7,
    restitution: 0.1,
    anchored: false,
    dragCoefficient: 0.9,
    windResistance: p.variant === 'truck' ? 38 : p.variant === 'suv' ? 42 : 45,
    durability: 70,
    breakThreshold: 1.8,
  }),
  // Local frame: length along X, width along Z.
  getDimensions: (p) => [p.length, p.height, p.width],
  centerOfPressure: (p) => [0, CAR_CLEARANCE + (p.height - CAR_CLEARANCE) * 0.5, 0],
  colliders: (p) => {
    const chassisH = (p.height - CAR_CLEARANCE) * 0.5;
    const cabinH = p.height - CAR_CLEARANCE - chassisH;
    const cabinL = p.variant === 'truck' ? p.length * 0.98 : p.length * 0.55;
    return [
      // Chassis box reaches the ground so the car rests on it (wheels are visual).
      {
        type: 'box',
        halfExtents: [p.length / 2, (chassisH + CAR_CLEARANCE) / 2, p.width / 2],
        offset: [0, (chassisH + CAR_CLEARANCE) / 2, 0],
        massFraction: 0.85,
      },
      {
        type: 'box',
        halfExtents: [cabinL / 2, cabinH / 2, p.width * 0.45],
        offset: [p.variant === 'truck' ? 0 : -p.length * 0.05, CAR_CLEARANCE + chassisH + cabinH / 2, 0],
        massFraction: 0.15,
      },
    ];
  },
  createComponents: (p) => [
    {
      id: 'body',
      kind: 'structure',
      position: [0, p.height / 2, 0],
      size: [p.length, p.height, p.width],
      normal: null,
      mass: Math.round(p.length * p.width * p.height * 120),
      windResistance: 45,
      durability: 70,
      detachable: false,
      color: p.color,
    },
  ],
});
