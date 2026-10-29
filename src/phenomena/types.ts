/**
 * Universal Phenomenon Engine — shared vocabulary (Phase 15).
 *
 *   PhenomenonDefinition   what a phenomenon IS: its parameters (typed per phenomenon, validated by
 *                          its own zod schema), the physical effect channels it writes, the models
 *                          it relies on, and how an instance becomes a scheduled SimulationEvent
 *   PhenomenonInstance     one configured occurrence in an experiment: parameters + timing
 *                          (absolute or relative to another instance) + seed + on/off
 *   PhenomenonRegistry     lookup by type; implemented AND planned phenomena (planned ones are
 *                          recognized, documented and never executed)
 *   Lifecycle              unchanged from Phase 3: SimulationEvent onStart / update / onEnd on the
 *                          fixed-step clock (EventScheduler) — a phenomenon only WRITES its effect
 *                          channels; systems turn channels into forces, damage and exposure
 *
 * Parameters are NOT forced into one structure: an earthquake has a magnitude and a PGA, rain an
 * intensity in mm/h. Each definition owns its spec type; the registry erases it only at the
 * boundary (`AnyPhenomenonDefinition`).
 */
import type { ZodType } from 'zod';
import type { I18nMessage, MessageKey } from '@/i18n/i18n';
import type { EventSpec } from '@/events/specs';
import type { SimulationEvent } from '@/events/SimulationEvent';
import type { TerrainData, WaterSettings } from '@/core/model';

/**
 * Physical effect channels: WHAT a phenomenon does to the world, independent of its name.
 * A typhoon and a tornado both write `airflow`; a meteor would write `mechanicalForce`,
 * `pressure`, `temperature` and `terrainDeformation`.
 */
export type ChannelId =
  | 'mechanicalForce'
  | 'airflow'
  | 'groundMotion'
  | 'water'
  | 'pressure'
  | 'temperature'
  | 'gravity'
  | 'terrainDeformation'
  | 'groundSupport'
  | 'sediment'
  | 'atmosphere';

/**
 * Scientific level of a model (shown in the UI next to every phenomenon and result):
 *  - physics:      physics-based approximation (conservation laws / mechanics, simplified)
 *  - empirical:    empirical relation or engineering rule of thumb (fitted / code-like values)
 *  - hypothetical: experimental / hypothetical scenario (no real-world counterpart to validate)
 *  - visual:       visual effect only — never feeds back into the calculation
 */
export type ModelLevel = 'physics' | 'empirical' | 'hypothetical' | 'visual';

export interface ModelInfo {
  id: string;
  labelKey: MessageKey;
  level: ModelLevel;
  /** Main simplifying assumptions. */
  assumptions: MessageKey[];
  /** Units of the main inputs / outputs. */
  units: string[];
  /** Valid input range (human-readable, e.g. "PGA 0.01–2 g"). */
  validRange: string;
  limitations: MessageKey[];
  /** Where the model is documented (repo path + section). */
  reference: string;
  /** No model in this project has been validated against measurements. */
  validated: false;
}

/**
 * A parameter edited in the generic phenomenon editor (stored value = shown / scale). Numeric by
 * default; `options` makes it a choice. `get` / `set` map nested or non-numeric spec fields
 * (e.g. a compass direction shown as a bearing, a position [x, z]).
 */
export interface ParamField {
  key: string;
  options?: { value: string; labelKey: MessageKey }[];
  get?: (spec: EventSpec) => number | string | undefined;
  set?: (spec: EventSpec, v: number | string | undefined) => EventSpec;
  labelKey: MessageKey;
  unit: string;
  min: number;
  max: number;
  step: number;
  precision: number;
  /** Display = stored × scale (e.g. seconds shown in minutes: 1/60). */
  scale?: number;
  /** May be left undefined (resolved as a documented assumption). */
  optional?: boolean;
  /** Shown only when it applies to the spec (e.g. stages only for a staged profile). */
  visible?: (spec: EventSpec) => boolean;
}

/** Context a definition may need to resolve defaults (frozen terrain, water settings, seed). */
export interface PhenomenonContext {
  seed: number;
  terrain: TerrainData | null;
  water?: WaterSettings;
}

export type PhenomenonStatus = 'implemented' | 'planned';

interface DefinitionBase {
  /** Registry key; for implemented phenomena equal to the event type of its spec. */
  type: string;
  labelKey: MessageKey;
  icon: string;
  status: PhenomenonStatus;
  /** Effect channels it writes. */
  channels: ChannelId[];
  /** Model ids (see models.ts) its effects rely on. */
  models: string[];
  /** Words that name it in commands (Korean + English, lower-case normalized text). */
  keywords: RegExp;
}

export interface ImplementedPhenomenon<S extends EventSpec = EventSpec> extends DefinitionBase {
  status: 'implemented';
  schema: ZodType<S>;
  /** A valid default instance (the "Add" button). */
  defaults: () => S;
  fields: ParamField[];
  /** Whether the spec carries its own random seed (earthquake waveform). */
  seeded: boolean;
  createEvent(spec: S, now: number, ctx: PhenomenonContext): SimulationEvent;
  /** Total duration in seconds once defaults are resolved. */
  duration(spec: S, ctx: PhenomenonContext): number;
  /** Assumptions applied to this spec (listed in the UI and the command preview). */
  assumptions(spec: S, ctx: PhenomenonContext): I18nMessage[];
  describe(spec: S, ctx: PhenomenonContext): I18nMessage;
}

export interface PlannedPhenomenon extends DefinitionBase {
  status: 'planned';
  /** Physical systems that do not exist yet. */
  missing: MessageKey[];
  /** Existing systems it would reuse. */
  reuses: MessageKey[];
}

export type AnyPhenomenonDefinition = ImplementedPhenomenon<EventSpec> | PlannedPhenomenon;

/** When an instance starts: at a time, or relative to another instance's start / end. */
export type InstanceStart =
  | { at: number }
  | { after: string; anchor: 'start' | 'end'; offset: number };

/**
 * One phenomenon in an experiment (saved with the project, schema v5). `spec` never carries a
 * startTime — timing lives in `start` and is resolved by resolveSchedule().
 */
export interface PhenomenonInstance {
  /** Stable id within the experiment ("p1", "p2" …), referenced by `start.after`. */
  id: string;
  type: string;
  spec: EventSpec;
  enabled: boolean;
  start: InstanceStart;
  /** Overrides the project seed for seeded phenomena (earthquake waveform). */
  seed?: number;
  /** Draw this phenomenon's visualization layers. */
  visualize: boolean;
}

/** Saved experiment plan (schema v5). */
export interface ExperimentSettings {
  instances: PhenomenonInstance[];
  notes: string;
  /** Simulated seconds per scenario in a comparison (0 = until the last phenomenon ends + settle). */
  compareDuration: number;
}

export function defaultExperiment(): ExperimentSettings {
  return { instances: [], notes: '', compareDuration: 0 };
}
