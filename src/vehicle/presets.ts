/**
 * Vehicle presets (Phase 35): 32 small EDUCATIONAL experiments of the wheeled-vehicle model — rest and suspension, straight
 * acceleration and speed hold, braking with and without ABS, steering at low / high speed, a circle, a slalom, the drive
 * layouts on a low-friction surface, braking on dry / wet / icy / snowy roads, slopes (hold, start, brake), rollover, crashes
 * (frontal, side, car-to-car, oblique wall, a person) and the hazards of the project (crosswind, earthquake, flood, debris flow,
 * blast, low gravity, a combined scene). Each documents its purpose, scene, the expected physical phenomenon, the verification
 * criterion (numbers, with the hand formula where one applies) and the limits of the model (i18n keys
 * vehiclePresets.<id>.<field>), runs for a fixed time with a fixed seed and builds its own world (demos.ts).
 *
 * Surfaces come from the project's models (ground type, flood water film, climate cover); where a preset relies on an
 * explicit boundary condition (the wet road's water film held by a reference water level, the time-compressed freezing rain
 * of the icy road) its scene and limits say so. Generic educational vehicles — no manufacturer data, no crash-test ratings,
 * no injury prediction.
 */
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { VEHICLE_PRESET_IDS, vehicleDemo, type VehiclePresetId } from './demos';

export type { VehiclePresetId } from './demos';
export { VEHICLE_PRESET_IDS } from './demos';

/** Documentation fields of a preset (i18n: vehiclePresets.<id>.<field>; labels: vehiclePresets.field.<field>). */
export const VEHICLE_PRESET_FIELDS = ['purpose', 'scene', 'expected', 'criterion', 'limits'] as const;
export type VehiclePresetField = (typeof VEHICLE_PRESET_FIELDS)[number];

export interface VehiclePreset {
  id: VehiclePresetId;
  /** Simulation seed (settings.simulation.seed). */
  seed: number;
  /** Simulated time the experiment is meant to run (s). */
  seconds: number;
  /** i18n keys. */
  keys: { name: string } & Record<VehiclePresetField, string>;
  /** A fresh world (vehicle dynamics on) and the events to add to it. */
  build(): { doc: WorldDocument; events: EventSpec[] };
}

export const VEHICLE_SECONDS: Record<VehiclePresetId, number> = {
  stationary: 30, suspensionDrop: 6, constantThrottle: 10, constantSpeed: 14, hardBraking: 10, lowSpeedSteer: 15, highSpeedSteer: 10,
  circle: 25, slalom: 25, fwd: 10, rwd: 10, awd: 10, dryAsphalt: 10, wetRoad: 10, icyRoad: 80, snowyRoad: 12, slopeHold: 15,
  slopeStart: 12, slopeBrake: 12, rollover: 8, frontalCrash: 6, sideCrash: 7, carToCar: 6, carToWall: 8, carToPerson: 8,
  crosswind: 12, earthquake: 18, flood: 60, debrisFlow: 25, blast: 6, lowGravity: 10, combined: 14,
};

function preset(id: VehiclePresetId, k: number): VehiclePreset {
  const seed = 3501 + k;
  const key = (f: string) => `vehiclePresets.${id}.${f}`;
  return {
    id, seed, seconds: VEHICLE_SECONDS[id],
    keys: { name: key('name'), purpose: key('purpose'), scene: key('scene'), expected: key('expected'), criterion: key('criterion'), limits: key('limits') },
    build: () => vehicleDemo(id, seed),
  };
}

export const VEHICLE_PRESETS: readonly VehiclePreset[] = VEHICLE_PRESET_IDS.map(preset);

export const vehiclePreset = (id: VehiclePresetId): VehiclePreset | undefined => VEHICLE_PRESETS.find((p) => p.id === id);
