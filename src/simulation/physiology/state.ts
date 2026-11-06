/**
 * Phase 34: runtime physiology of one extended-model person (`e.physio`) and of the run (`runtime.physiology`). Built from
 * the settings at load; never part of the WorldDocument (reset rebuilds it).
 */
import type { Vec3 } from '@/core/types';
import { createPhysioState, type PhysioConfig, type PhysioState } from '@/physiology/engine';
import { moduleOn, PHYSIO_MODULES, type PhysiologySettings } from '@/physiology/settings';
import type { Compartment } from './zones';
import type { Provenance } from './sampler';

/** Chart series of the first SERIES_PEOPLE people: one sample per SERIES_DT s, halved (every second kept) at SERIES_MAX. */
export const SERIES_PEOPLE = 32;
export const SERIES_DT = 1;
export const SERIES_MAX = 4000;
export const SERIES_KEYS = ['core', 'skin', 'air', 'heatIn', 'heatOut', 'strain', 'breathing', 'supply', 'smoke', 'airway', 'deficit', 'fatigue', 'capacity'] as const;
export type SeriesKey = (typeof SERIES_KEYS)[number];
export interface PhysioSeries { dt: number; t: number[]; v: Record<SeriesKey, number[]> }

export interface PhysioEntity {
  cfg: PhysioConfig;
  s: PhysioState;
  provenance: Provenance;
  /** Last sample's display values (null before the first update). */
  sample: { airT: number; qFire: number; qSolar: number; immersed: number; airway: Vec3; buried: boolean } | null;
  /** What the Phase 33 posture control reads: ankle-moment factor and whether stance may be regained / kept. */
  couple: { balance: number; canStand: boolean };
  series: PhysioSeries | null;
  /** Captured by a celestial source: updates stopped, state kept. */
  frozen: boolean;
  primed: boolean;
}

export interface PhysiologyRuntime {
  settings: PhysiologySettings;
  /** Confined compartments by zone index (created at the first update). */
  compartments: Map<number, Compartment>;
  initialized: boolean;
  /** Simulation time of the last physiology sample (s; null before the first). */
  lastTime: number | null;
}

export function createPhysioEntity(objectId: string, mass: number, height: number, settings: PhysiologySettings, withSeries: boolean): PhysioEntity {
  const person = settings.people?.[objectId] ?? {};
  const intakeLh = person.waterIntake ?? settings.waterIntake ?? 0;
  const cfg: PhysioConfig = {
    mass, height,
    activity: person.activity ?? settings.activity ?? 'resting',
    clothing: person.clothing ?? settings.clothing ?? 'normal',
    intake: intakeLh / 3600, // 1 L of water = 1 kg
    modules: Object.fromEntries(PHYSIO_MODULES.map((m) => [m, moduleOn(settings, m)])) as PhysioConfig['modules'],
  };
  return {
    cfg, s: createPhysioState(cfg), provenance: {}, sample: null, couple: { balance: 1, canStand: true },
    series: withSeries ? { dt: SERIES_DT, t: [], v: Object.fromEntries(SERIES_KEYS.map((k) => [k, []])) as unknown as Record<SeriesKey, number[]> } : null,
    frozen: false, primed: false,
  };
}
