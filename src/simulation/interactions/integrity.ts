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
import { HAZARDS, type Hazard } from '../analysis/DamageEvent';
import { blastGovernsStructure, impactGovernsShaking } from '../seismic/SeismicState';
import { seismicDamageIndex } from '../damage/seismicLevels';

/** Strength degradation per unit damage index (same as StructuralModel: F_y·(1 − 0.3·D)). */
export const STRENGTH_LOSS = 0.3;

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
export function hazardDamage(e: RuntimeEntity): Record<Hazard, number> {
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
  const blast = Math.max(e.blast ? Math.min(1, e.blast.damage) : 0, byBlast ? earthquake : 0);
  return { wind: Math.max(0, wind), earthquake: shakeByImpact || byBlast ? 0 : earthquake, flood, ground: groundByImpact ? 0 : groundAll, impact, blast };
}

/**
 * Capacity factor (0.7–1] a hazard applies to the object's strength because of the damage the
 * other hazards caused. 1 exactly when nothing else damaged it (single-hazard runs unchanged).
 */
export function residualStrength(e: RuntimeEntity, hazard: Hazard): number {
  if (!e.seismic && !e.flood && !e.integrity && !e.ground && !e.impact && !e.blast) return 1;
  const d = hazardDamage(e);
  let worst = 0;
  for (const h of HAZARDS) if (h !== hazard && d[h] > worst) worst = d[h];
  return worst > 0 ? 1 - STRENGTH_LOSS * Math.min(1, worst) : 1;
}

export function recordStateChange(e: RuntimeEntity, time: number, hazard: Hazard, state: number) {
  const h = integrityOf(e).history;
  if (h.length < 64) h.push({ time, hazard, state });
}
