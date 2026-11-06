/**
 * Phase 35: parameters of the vehicle model — every coefficient with its unit, default, the range a user may set, the
 * source and the level: A = conservation law / rigid-body mechanics, B = textbook vehicle-dynamics model or measured order
 * of magnitude (Gillespie 1992, "Fundamentals of Vehicle Dynamics"; Pacejka 2012, "Tyre and Vehicle Dynamics"; Wong 2008,
 * "Theory of Ground Vehicles"), C = explicit educational assumption. Defaults per variant are generic model assumptions,
 * NOT the data of any manufacturer's vehicle.
 */

export type Level = 'A' | 'B' | 'C';
export interface ParamInfo { value: number; unit: string; range: [number, number]; level: Level; source: string }

export const VEHICLE_VARIANTS = ['sedan', 'suv', 'truck'] as const;
export type Variant = (typeof VEHICLE_VARIANTS)[number];
export type Drive = 'fwd' | 'rwd' | 'awd';

/** Per-variant geometry and powertrain (generic, educational). */
export interface VariantSpec {
  /** Wheelbase / body length, track / body width (1). */
  wheelbaseShare: number;
  trackShare: number;
  /** Wheel radius (m), wheel + tyre mass (kg) per wheel (part of the body mass), wheel spin inertia (kg·m²). */
  wheelRadius: number;
  wheelMass: number;
  wheelInertia: number;
  /** Suspension natural frequency of the sprung corner (Hz), damping ratio (1), travel (m) above / below the static position. */
  rideHz: number;
  damping: number;
  bump: number;
  rebound: number;
  /** Chassis collider bottom above the ground at static ride height (m). */
  clearance: number;
  /** Engine: peak torque (N·m), peak power (W), idle / maximum crankshaft speed (rad/s). */
  torque: number;
  power: number;
  idle: number;
  maxSpeed: number;
  /** Gear ratios (forward), reverse, final drive, driveline efficiency. */
  gears: number[];
  reverse: number;
  final: number;
  efficiency: number;
  drive: Drive;
  /** Aerodynamics: drag coefficient, side-force coefficient; frontal area = width × height × fill. */
  cd: number;
  cy: number;
  areaFill: number;
  /** Maximum road-wheel steering angle (rad), steering rate (rad/s). */
  steerMax: number;
  steerRate: number;
  /** Brake torque available per wheel at full pedal (N·m) as a share of m g R / 4 × this factor; front share of the brake torque. */
  brakeG: number;
  brakeFront: number;
}

export const VARIANTS: Record<Variant, VariantSpec> = {
  sedan: { wheelbaseShare: 0.6, trackShare: 0.86, wheelRadius: 0.31, wheelMass: 20, wheelInertia: 0.9, rideHz: 1.4, damping: 0.3, bump: 0.09, rebound: 0.12, clearance: 0.2,
    torque: 250, power: 110e3, idle: 85, maxSpeed: 650, gears: [3.6, 2.1, 1.4, 1.0, 0.8], reverse: 3.4, final: 3.9, efficiency: 0.9, drive: 'fwd',
    cd: 0.32, cy: 0.9, areaFill: 0.84, steerMax: 0.6, steerRate: 1.2, brakeG: 1.1, brakeFront: 0.65 },
  suv: { wheelbaseShare: 0.6, trackShare: 0.86, wheelRadius: 0.37, wheelMass: 25, wheelInertia: 1.4, rideHz: 1.3, damping: 0.3, bump: 0.11, rebound: 0.14, clearance: 0.26,
    torque: 350, power: 150e3, idle: 80, maxSpeed: 600, gears: [3.9, 2.3, 1.5, 1.1, 0.85], reverse: 3.6, final: 3.9, efficiency: 0.88, drive: 'awd',
    cd: 0.4, cy: 1.0, areaFill: 0.85, steerMax: 0.6, steerRate: 1.2, brakeG: 1.1, brakeFront: 0.65 },
  truck: { wheelbaseShare: 0.55, trackShare: 0.84, wheelRadius: 0.45, wheelMass: 60, wheelInertia: 5, rideHz: 1.8, damping: 0.25, bump: 0.1, rebound: 0.12, clearance: 0.3,
    torque: 900, power: 220e3, idle: 70, maxSpeed: 360, gears: [5.0, 3.0, 1.9, 1.3, 1.0, 0.8], reverse: 4.5, final: 4.1, efficiency: 0.88, drive: 'rwd',
    cd: 0.6, cy: 1.1, areaFill: 0.9, steerMax: 0.55, steerRate: 1.0, brakeG: 0.9, brakeFront: 0.6 },
};

/** Tyre / road model constants. */
export const TIRE = {
  /** Longitudinal slip stiffness per unit load C_κ / F_z (1) — passenger tyres ≈ 15–20 (Pacejka 2012 ch. 1, Wong 2008). */
  ckPerLoad: 16,
  /** Cornering stiffness per unit load C_α / F_z (1/rad) — ≈ 0.15–0.2 per degree (Gillespie 1992 ch. 6). */
  caPerLoad: 10,
  /** Kinetic (sliding) / peak friction (1): the friction falls once the patch slides fully — assumption, order of measured curves. */
  slideShare: 0.8,
  /** Relaxation lengths (m): longitudinal, lateral — transient tyre (Pacejka 2012 ch. 7: σ ≈ 0.3–0.7 m). */
  sigmaX: 0.35,
  sigmaY: 0.5,
  /** Speed below which the low-speed damping of the transient tyre acts (m/s). */
  vLow: 2,
  /** Tyre peak friction coefficient on each ground type (dry), with Wallman & Åström (2001) for paved roads and order-of-magnitude
   * values for unpaved ground (Wong 2008 ch. 2) — grass, soil, sand, asphalt, concrete, gravel, rock, mud, riverbed. */
  muGround: [0.45, 0.55, 0.4, 0.9, 0.85, 0.6, 0.7, 0.3, 0.5],
  /** Rolling-resistance coefficient on each ground type (1) — paved ≈ 0.01–0.015, gravel 0.02, firm soil 0.05, sand 0.1–0.3 (Wong 2008, Gillespie 1992). */
  crrGround: [0.06, 0.05, 0.15, 0.012, 0.012, 0.02, 0.015, 0.1, 0.06],
  /** Extra rolling resistance per metre of snow depth (1/m), capped depth (m) — order of magnitude, assumption. */
  crrSnowPerM: 0.6,
  snowCap: 0.3,
} as const;

/** Body density of the legacy car (kg/m³ of its bounding box) — kept, so a vehicle-mode car has the legacy mass. */
export const CAR_DENSITY = 120;
/** Air density (kg/m³) when no atmosphere experiment runs (reference — assumed). */
export const AIR_DENSITY = 1.225;

/** Parameter table (spec §50 style): the documented / exported list. */
export const PARAMS: Record<string, ParamInfo> = {
  ckPerLoad: { value: TIRE.ckPerLoad, unit: '1', range: [10, 25], level: 'B', source: 'longitudinal slip stiffness / load, passenger tyres (Pacejka 2012)' },
  caPerLoad: { value: TIRE.caPerLoad, unit: '1/rad', range: [6, 14], level: 'B', source: 'cornering stiffness / load (Gillespie 1992)' },
  slideShare: { value: TIRE.slideShare, unit: '1', range: [0.6, 1], level: 'C', source: 'sliding / peak friction — assumption' },
  sigmaX: { value: TIRE.sigmaX, unit: 'm', range: [0.2, 0.7], level: 'B', source: 'relaxation length (Pacejka 2012 ch. 7)' },
  sigmaY: { value: TIRE.sigmaY, unit: 'm', range: [0.3, 0.9], level: 'B', source: 'relaxation length (Pacejka 2012 ch. 7)' },
  vLow: { value: TIRE.vLow, unit: 'm/s', range: [1, 4], level: 'C', source: 'low-speed tyre damping blend — assumption' },
  crrSnowPerM: { value: TIRE.crrSnowPerM, unit: '1/m', range: [0.3, 1.2], level: 'C', source: 'snow rolling resistance per depth — assumption' },
  airDensity: { value: AIR_DENSITY, unit: 'kg/m³', range: [0.5, 1.4], level: 'A', source: 'ISA sea level; the atmosphere experiment overrides' },
};
