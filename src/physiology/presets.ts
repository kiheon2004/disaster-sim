/**
 * Human physiology presets (Phase 34): 24 small EDUCATIONAL experiments of the reduced physiology on top of the Phase 33
 * extended human model — a calm baseline, cold air / wind / water, heat and humidity, activity, water balance, fire heat
 * and smoke, CO, low oxygen, low pressure, airway submersion, burial and a combined earthquake + fire scene. Each documents
 * its purpose, initial conditions, assumptions, expected phenomena and model limits (i18n keys
 * physioPresets.<id>.<field>), runs for a fixed time with a fixed seed and builds its own world (demos.ts).
 *
 * Where a preset uses a physiology zone, the zone is an experimental boundary condition (stated in its conditions /
 * limits), not a result of the environment simulation. The figures of these runs are an educational model — no
 * diagnosis, no time of death, no survival probability, nothing about a real person.
 */
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { PHYSIO_PRESET_IDS, physioDemo, type PhysioPresetId } from './demos';

export type { PhysioPresetId } from './demos';
export { PHYSIO_PRESET_IDS } from './demos';

/** Documentation fields of a preset (i18n: physioPresets.<id>.<field>; labels: physioPresets.field.<field>). */
export const PHYSIO_PRESET_FIELDS = ['purpose', 'conditions', 'assumptions', 'expected', 'limits'] as const;
export type PhysioPresetField = (typeof PHYSIO_PRESET_FIELDS)[number];

export interface PhysioPreset {
  id: PhysioPresetId;
  /** Simulation seed (settings.simulation.seed). */
  seed: number;
  /** Simulated time the experiment is meant to run (s). */
  seconds: number;
  /** i18n keys. */
  keys: { name: string } & Record<PhysioPresetField, string>;
  /** A fresh world (extended human model + physiology on) and the events to add to it. */
  build(): { doc: WorldDocument; events: EventSpec[] };
}

export const PHYSIO_SECONDS: Record<PhysioPresetId, number> = {
  stableBaseline: 1800, coldIndoor: 3600, coldOutdoor: 1800, coldWind: 1800, coldWaterPartial: 1800, coldWaterFull: 1800,
  hotIndoor: 3600, heatwave: 1800, hotHumid: 1800, hotDry: 1800, highActivity: 1800, longActivity: 3600, recovery: 3600,
  dehydration: 3600, fireRadiant: 300, fireHotAir: 300, smoke: 300, carbonMonoxide: 1800, hypoxia: 600, lowPressure: 1200,
  airwayIntermittent: 70, airwayContinuous: 240, buriedExposure: 600, quakeFireIncapacitated: 600,
};

function preset(id: PhysioPresetId, k: number): PhysioPreset {
  const seed = 3401 + k;
  const key = (f: string) => `physioPresets.${id}.${f}`;
  return {
    id, seed, seconds: PHYSIO_SECONDS[id],
    keys: { name: key('name'), purpose: key('purpose'), conditions: key('conditions'), assumptions: key('assumptions'), expected: key('expected'), limits: key('limits') },
    build: () => physioDemo(id, seed),
  };
}

export const PHYSIO_PRESETS: readonly PhysioPreset[] = PHYSIO_PRESET_IDS.map(preset);

export const physioPreset = (id: PhysioPresetId): PhysioPreset | undefined => PHYSIO_PRESETS.find((p) => p.id === id);
