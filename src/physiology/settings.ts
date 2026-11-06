/**
 * Phase 34 settings: `settings.simulation.physiology`. Absent = no physiology (bit-identical to Phase 33). It needs the
 * Phase 33 extended human model (segments, posture, airway) — a document with physiology but without `humans` loses the
 * physiology setting on load (validated, not fixed), the UI switches the extended model on with it.
 *
 * Reference values are the model's explicit, user-changeable assumptions for what no environment field provides
 * (humidity, pressure, gas composition, water temperature); every sample records where each value came from.
 * Zones are explicit EXPERIMENTAL BOUNDARY CONDITIONS (a box / sphere where given air, radiation, gas, smoke or water
 * values hold for the physiology) — they are never presented as results of the environment simulation, they exert no
 * force and add no heat or mass to the world; a `confined` zone is a well-mixed air volume whose O₂ / CO₂ the occupants
 * change (mass-conserving compartment, exchange with the reference air at the given air-change rate).
 */
import { z } from 'zod';
import type { Vec3 } from '@/core/types';
import { ACTIVITIES, CLOTHING, type Activity, type Clothing } from './thermal';

export const PHYSIO_MODULES = ['thermal', 'respiration', 'gas', 'submersion', 'hydration', 'fatigue'] as const;
export type PhysioModule = (typeof PHYSIO_MODULES)[number];

export interface PhysiologyReference {
  /** Relative humidity 0–1 (no humidity field outside a climate experiment). */
  humidity?: number;
  /** Ambient pressure (Pa) outside an atmosphere experiment. */
  pressure?: number;
  /** Dry-air mole fractions (mol/mol). */
  o2?: number;
  co2?: number;
  /** Water temperature (K) where the thermal model has no water temperature. */
  waterTemperature?: number;
}

export interface PhysiologyPerson {
  activity?: Activity;
  clothing?: Clothing;
  /** Explicit water intake (L/h). */
  waterIntake?: number;
}

export interface PhysiologyZone {
  id: string;
  name?: string;
  shape: 'box' | 'sphere';
  /** Centre (m) and full extents (box) / radius in size[0] (sphere). */
  center: Vec3;
  size: Vec3;
  /** Active from `start` to `end` (s); values ramp in linearly over `ramp` s from the surrounding values. */
  start?: number;
  end?: number;
  ramp?: number;
  airTemperature?: number;
  humidity?: number;
  pressure?: number;
  wind?: number;
  meanRadiantTemperature?: number;
  /** Directed radiant flux on the person (W/m²) — e.g. from a fire outside the scene. */
  radiantFlux?: number;
  surfaceTemperature?: number;
  o2?: number;
  co2?: number;
  co?: number;
  /** Smoke particle mass concentration (kg/m³). */
  smoke?: number;
  /** Water for the physiology only (no buoyancy, no flow force): surface height (m), oscillation amplitude (m) and period (s), temperature (K), relative speed (m/s). */
  water?: { level: number; amplitude?: number; period?: number; temperature?: number; speed?: number };
  /** Well-mixed confined air volume (m³) and its air-change rate with the reference air (1/h). */
  confined?: { volume: number; exchange: number };
}

export interface PhysiologySettings {
  model: 'reduced';
  activity?: Activity;
  clothing?: Clothing;
  waterIntake?: number;
  modules?: Partial<Record<PhysioModule, boolean>>;
  reference?: PhysiologyReference;
  people?: Record<string, PhysiologyPerson>;
  zones?: PhysiologyZone[];
}

export const PHYSIO_LIMITS = {
  waterIntake: [0, 2],
  humidity: [0, 1],
  pressure: [1000, 200000],
  o2: [0, 1],
  co2: [0, 0.3],
  co: [0, 0.1],
  smoke: [0, 0.05],
  waterTemperature: [271.15, 333.15],
  airTemperature: [173.15, 1473.15],
  radiantFlux: [0, 2e5],
  wind: [0, 60],
  volume: [0.1, 1e6],
  exchange: [0, 100],
} as const;

const range = (k: keyof typeof PHYSIO_LIMITS) => z.number().min(PHYSIO_LIMITS[k][0]).max(PHYSIO_LIMITS[k][1]);
const vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const physiologyZoneSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  shape: z.enum(['box', 'sphere']),
  center: vec3,
  size: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
  start: z.number().min(0).optional(),
  end: z.number().min(0).optional(),
  ramp: z.number().min(0).max(3600).optional(),
  airTemperature: range('airTemperature').optional(),
  humidity: range('humidity').optional(),
  pressure: range('pressure').optional(),
  wind: range('wind').optional(),
  meanRadiantTemperature: range('airTemperature').optional(),
  radiantFlux: range('radiantFlux').optional(),
  surfaceTemperature: range('airTemperature').optional(),
  o2: range('o2').optional(),
  co2: range('co2').optional(),
  co: range('co').optional(),
  smoke: range('smoke').optional(),
  water: z.object({ level: z.number(), amplitude: z.number().min(0).max(10).optional(), period: z.number().positive().max(600).optional(), temperature: range('waterTemperature').optional(), speed: z.number().min(0).max(10).optional() }).optional(),
  confined: z.object({ volume: range('volume'), exchange: range('exchange') }).optional(),
});

export const physiologySchema = z.object({
  model: z.literal('reduced'),
  activity: z.enum(ACTIVITIES).optional(),
  clothing: z.enum(CLOTHING).optional(),
  waterIntake: range('waterIntake').optional(),
  modules: z.object(Object.fromEntries(PHYSIO_MODULES.map((m) => [m, z.boolean().optional()])) as Record<PhysioModule, z.ZodOptional<z.ZodBoolean>>).optional(),
  reference: z.object({ humidity: range('humidity').optional(), pressure: range('pressure').optional(), o2: range('o2').optional(), co2: range('co2').optional(), waterTemperature: range('waterTemperature').optional() }).optional(),
  people: z.record(z.string(), z.object({ activity: z.enum(ACTIVITIES).optional(), clothing: z.enum(CLOTHING).optional(), waterIntake: range('waterIntake').optional() })).optional(),
  // An invalid zone is dropped on its own (the others stay).
  zones: z.array(physiologyZoneSchema.nullable().catch(null)).optional(),
});

/** Parsed value → the normalized settings (undefined parts left out, invalid zones removed). */
export function normalizePhysiology(p: z.infer<typeof physiologySchema>): PhysiologySettings {
  const zones = (p.zones ?? []).filter((x): x is PhysiologyZone => x !== null);
  return {
    model: 'reduced',
    ...(p.activity ? { activity: p.activity } : {}),
    ...(p.clothing ? { clothing: p.clothing } : {}),
    ...(p.waterIntake !== undefined ? { waterIntake: p.waterIntake } : {}),
    ...(p.modules ? { modules: { ...p.modules } } : {}),
    ...(p.reference ? { reference: { ...p.reference } } : {}),
    ...(p.people ? { people: structuredClone(p.people) } : {}),
    ...(zones.length ? { zones: structuredClone(zones) } : {}),
  };
}

export const DEFAULT_REFERENCE = { humidity: 0.5, pressure: 101325, o2: 0.2095, co2: 0.0004, waterTemperature: 288.15 } as const;
export const moduleOn = (s: PhysiologySettings, m: PhysioModule) => s.modules?.[m] !== false;
