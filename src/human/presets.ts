/**
 * Human-response presets (Phase 33): 20 small EDUCATIONAL experiments of the extended human model — standing, wind,
 * slopes, drops, debris, earthquake, flood, blast, building collapse, changed / reversed / sideways gravity and celestial
 * sources. Each documents its purpose, initial conditions, physical assumptions, expected phenomena and model limits
 * (i18n keys humanPresets.<id>.<field>), runs for a fixed time with a fixed seed and builds its own world (demos.ts).
 *
 * The injury figures of these runs are an educational risk index of a reduced rigid-body model — no probabilities, no
 * diagnoses, nothing about a real person.
 */
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { HUMAN_PRESET_IDS, humanDemo, type HumanPresetId } from './demos';

export type { HumanPresetId } from './demos';
export { HUMAN_PRESET_IDS } from './demos';

/** Documentation fields of a preset (i18n: humanPresets.<id>.<field>; labels: humanPresets.field.<field>). */
export const HUMAN_PRESET_FIELDS = ['purpose', 'conditions', 'assumptions', 'expected', 'limits'] as const;
export type HumanPresetField = (typeof HUMAN_PRESET_FIELDS)[number];

export interface HumanPreset {
  id: HumanPresetId;
  /** Simulation seed (settings.simulation.seed). */
  seed: number;
  /** Simulated time the experiment is meant to run (s). */
  seconds: number;
  /** i18n keys. */
  keys: { name: string } & Record<HumanPresetField, string>;
  /** A fresh world (extended human model on) and the events to add to it. */
  build(): { doc: WorldDocument; events: EventSpec[] };
}

const SECONDS: Record<HumanPresetId, number> = {
  standStill: 10, weakWind: 12, strongGust: 12, slopeSlide: 10, lowFriction: 10, drop1m: 4, drop3m: 4, drop10m: 5, rotatingFall: 5,
  debrisHit: 4, quakeBalance: 15, floodPush: 20, blastWave: 6, buildingCollapse: 20, lowGravityFall: 6, highGravityFall: 4,
  reversedGravity: 5, horizontalGravity: 8, celestialTides: 10, celestialCapture: 8,
};

function preset(id: HumanPresetId, k: number): HumanPreset {
  const seed = 3301 + k;
  const key = (f: string) => `humanPresets.${id}.${f}`;
  return {
    id, seed, seconds: SECONDS[id],
    keys: { name: key('name'), purpose: key('purpose'), conditions: key('conditions'), assumptions: key('assumptions'), expected: key('expected'), limits: key('limits') },
    build: () => humanDemo(id, seed),
  };
}

export const HUMAN_PRESETS: readonly HumanPreset[] = HUMAN_PRESET_IDS.map(preset);

export const humanPreset = (id: HumanPresetId): HumanPreset | undefined => HUMAN_PRESETS.find((p) => p.id === id);
