/**
 * Ground-material extension point of the deformation engine (Phase 21).
 *
 * What the engine does with the ground today: the displacement is PRESCRIBED (an input), and
 * the soil under a foundation enters only through the existing Phase 13 / 17 allowable bearing
 * pressure (soil profile × foundation type) — the static bearing ratio the foundation response
 * reports. No soil property changes the displacement field itself.
 *
 * What is NOT modeled, on purpose: consolidation (clay settlement over time), elastic-plastic
 * soil response, soil–structure interaction under the footprint, liquefaction-induced settlement.
 * Each needs calibrated parameters (compression index, preconsolidation, modulus, groundwater)
 * that this project does not have for its generic soil classes; inventing them would produce
 * precise-looking numbers with no basis. A future model plugs in here:
 *
 *   registerGroundResponse({ id, soils, modifySettlement(...) })
 *
 * and is applied by the foundation response to the plane-fitted settlement of each footprint
 * (and listed in the model info / assumptions like every other model). The registry is EMPTY in
 * this phase, so `groundResponseFor` returns null and nothing is altered.
 */
import type { SoilProfileId } from '@/core/model';
import type { MessageKey } from '@/i18n/i18n';

export interface GroundResponseInput {
  soil: SoilProfileId;
  /** Prescribed mean vertical displacement under the footprint (m, + up). */
  settlement: number;
  /** Bearing pressure / allowable (static, Phase 17). */
  bearingRatio: number;
  /** Seconds since the deformation started (time-dependent models, e.g. consolidation). */
  elapsed: number;
}

export interface GroundResponseModel {
  id: string;
  labelKey: MessageKey;
  /** Soil profiles it applies to. */
  soils: readonly SoilProfileId[];
  /** Additional vertical displacement (m, + up) beyond the prescribed one. */
  additionalSettlement(input: GroundResponseInput): number;
  /** Where its parameters come from (must be stated; no anonymous coefficients). */
  reference: string;
}

const registry: GroundResponseModel[] = [];

export function registerGroundResponse(m: GroundResponseModel) {
  if (registry.some((r) => r.id === m.id)) throw new Error(`ground response model ${m.id} already registered`);
  registry.push(m);
}

/** The model for a soil profile, or null (this phase: always null — none is implemented). */
export function groundResponseFor(soil: SoilProfileId): GroundResponseModel | null {
  return registry.find((m) => m.soils.includes(soil)) ?? null;
}

/** For tests: the registered models. */
export const groundResponseModels = (): readonly GroundResponseModel[] => registry;
