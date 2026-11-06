/**
 * Unified damage state (Phase 15).
 *
 * Each hazard keeps measuring damage in its own physical terms — wind: fatigue of the design
 * capacity (1 − remaining life), earthquake: Park–Ang-style structural damage index, flood:
 * lateral-load damage index — and the shared health stays min() of the channels (Phase 13–14).
 *
 * What is new is how one hazard sees the others' damage:
 *  - residual strength: the capacity a hazard compares its load with is reduced by the damage
 *    the OTHER hazards already caused, with the structural model's own degradation law
 *    F_y,eff = F_y·(1 − 0.3·D) and D = max over the other hazards (an envelope — damage indices
 *    of different hazards measure the same physical degradation and are never added);
 *  - each hazard accumulates only its own channel (with interactions on, wind fatigue no longer
 *    continues from a health that already contains earthquake damage — that was a hidden sum);
 *  - every state change is kept in order with its hazard (history), so the inspector can show
 *    "earthquake 12 s DAMAGED → wind 40 s CRITICAL".
 */
import type { RuntimeEntity } from '../SimulationRuntime';
import { HAZARDS, type Hazard, type HazardRecord } from '../analysis/DamageEvent';
import { blastGovernsStructure, gravityGovernsStructure, impactGovernsShaking } from '../seismic/SeismicState';
import { seismicDamageIndex } from '../damage/seismicLevels';

/** Strength degradation per unit damage index (same as StructuralModel: F_y·(1 − 0.3·D)). */
import { STRENGTH_LOSS } from '@/structure/policy';
export { STRENGTH_LOSS };

export interface IntegrityState {
  /** Wind fatigue health of the structure, tracked on its own (1 → 0). */
  windHealth: number;
  /** State changes in order: time, hazard, new state. */
  history: { time: number; hazard: Hazard; state: number }[];
}

export function integrityOf(e: RuntimeEntity): IntegrityState {
  // Wind fatigue starts intact: it is only ever integrated by the wind (coupled paths).
  return (e.integrity ??= { windHealth: 1, history: [] });
}

/** Damage index 0–1 each hazard has caused to the object's structure so far. */
export function hazardDamage(e: RuntimeEntity): HazardRecord {
  const wind = e.integrity ? 1 - e.integrity.windHealth : 0;
  const earthquake = e.seismic ? Math.min(1, seismicDamageIndex(e.seismic)) : 0;
  const flood = e.flood ? Math.min(1, e.flood.damage) : 0;
  const groundAll = e.ground ? Math.min(1, e.ground.damage) : 0;
  // Phase 23: damage whose cause is an impact (crater, ejecta, burial, its ground shock) is the
  // impact's — the same physical channels, attributed to the phenomenon that drove them.
  const groundByImpact = e.ground?.source?.startsWith('impact:') === true;
  const shakeByImpact = impactGovernsShaking(e.seismic);
  const impact = Math.max(e.impact ? Math.min(1, e.impact.damage) : 0, groundByImpact ? groundAll : 0, shakeByImpact ? earthquake : 0);
  // Phase 24: structural damage driven by air-pressure loads (when they govern the structure's
  // response) and the blast's own channel (base-moment oscillators) are the blast's.
  const byBlast = blastGovernsStructure(e.seismic);
  // Phase 32: structural damage of the storey model driven by a celestial source's lateral field is gravity's.
  const byGravity = gravityGovernsStructure(e.seismic);
  const blast = Math.max(e.blast ? Math.min(1, e.blast.damage) : 0, byBlast ? earthquake : 0);
  return { wind: Math.max(0, wind), earthquake: shakeByImpact || byBlast || byGravity ? 0 : earthquake, flood, ground: groundByImpact ? 0 : groundAll, impact, blast,
    // Phase 26: heat has no damage index — its effect is the separate material factor of the members
    // (temperature-dependent strength), never a second damage index (no double counting).
    thermal: 0, fire: 0,
    // Phase 28: lateral lava load (its own damage index; burial, contact and ash are separate records).
    volcano: e.volcano ? Math.min(1, e.volcano.damage) : 0,
    // Phase 30: snow / ice load breakage of crowns (structural snow loads act through the collapse model).
    climate: e.climate ? Math.min(1, e.climate.damage) : 0,
    // Phase 31: gravity loads act through the collapse model (member failures with hazard 'gravity'), not a second index.
    gravity: byGravity ? earthquake : 0,
    // Phase 35: a vehicle's own damage index (collisions, rollover) — vehicle-mode cars only.
    ...(e.vehicle ? { vehicle: e.vehicle.damage.index } : {}) };
}

/**
 * Capacity factor (0.7–1] a hazard applies to the object's strength because of the damage the
 * other hazards caused. 1 exactly when nothing else damaged it (single-hazard runs unchanged).
 */
export function residualStrength(e: RuntimeEntity, hazard: Hazard): number {
  if (!e.seismic && !e.flood && !e.integrity && !e.ground && !e.impact && !e.blast && !e.volcano && !e.climate) return 1;
  const d = hazardDamage(e);
  let worst = 0;
  for (const h of HAZARDS) { const v = d[h] ?? 0; if (h !== hazard && v > worst) worst = v; }
  return worst > 0 ? 1 - STRENGTH_LOSS * Math.min(1, worst) : 1;
}

export function recordStateChange(e: RuntimeEntity, time: number, hazard: Hazard, state: number) {
  const h = integrityOf(e).history;
  if (h.length < 64) h.push({ time, hazard, state });
}
