/**
 * Experiment comparison (Phase 15): run several combinations of the experiment's phenomena on
 * the SAME initial world (same document snapshot, seed, terrain, initial water) and compare the
 * outcomes. Each scenario runs in its own headless SimulationController (never touches the UI
 * store), sequentially, advancing in 1 s chunks and yielding between chunks so the page stays
 * responsive. Deterministic: a scenario gives the same numbers every time.
 */
import type { WorldDocument } from '@/core/model';
import { SimulationController } from '@/simulation/SimulationController';
import type { Hazard } from '@/simulation/analysis/DamageEvent';
import type { WaterStateSnapshot } from '@/simulation/water/waterStateCodec';
import { isWaterEvent } from '@/events/specs';
import { resolveSchedule, type ScheduleIssue } from './schedule';
import type { PhenomenonInstance } from './types';

export interface ComparisonScenario {
  id: string;
  /** Instance ids run together in this scenario. */
  instanceIds: string[];
}

export interface ScenarioResult {
  id: string;
  instanceIds: string[];
  damagedObjects: number;
  collapsedBuildings: number;
  /** Free bodies moved more than 1 m from where they started. */
  displacedObjects: number;
  /** Peak flooded area (m², depth ≥ 0.1 m). */
  floodedArea: number;
  totalDamageEvents: number;
  eventsByHazard: Record<Hazard, number>;
  simTime: number;
  /** Wall-clock cost of the scenario (ms) and per simulated second. */
  wallMs: number;
  msPerSimSecond: number;
  issues: ScheduleIssue[];
}

/** Each enabled phenomenon alone, then all of them together (when there are ≥ 2). */
export function defaultScenarios(instances: readonly PhenomenonInstance[]): ComparisonScenario[] {
  const on = instances.filter((i) => i.enabled);
  const out: ComparisonScenario[] = on.map((i) => ({ id: i.id, instanceIds: [i.id] }));
  if (on.length >= 2) out.push({ id: 'all', instanceIds: on.map((i) => i.id) });
  return out;
}

/** Scenario subset: the chosen instances; references to instances outside it are kept by
 *  re-anchoring them in time (their resolved start in the full plan), so "B 10 s after A" still
 *  starts B at the same time when A is not part of the scenario. */
function subset(instances: readonly PhenomenonInstance[], ids: readonly string[], seed: number, doc: WorldDocument): PhenomenonInstance[] {
  const full = resolveSchedule(instances, { seed, terrain: doc.terrain, water: doc.settings.simulation.water });
  const startOf = new Map(full.items.map((r) => [r.instance.id, r.start]));
  return instances
    .filter((i) => ids.includes(i.id))
    .map((i) => ('after' in i.start && !ids.includes(i.start.after) && startOf.has(i.id) ? { ...i, start: { at: startOf.get(i.id)! } } : i));
}

export interface ComparisonOptions {
  /** Simulated seconds per scenario (0 / undefined = last end + settle, at most 600 s). */
  duration?: number;
  initialWater?: WaterStateSnapshot | null;
  onProgress?: (scenario: number, simTime: number, total: number) => void;
  /** Yield between chunks (browser); tests pass nothing. */
  yieldFn?: () => Promise<void>;
  /** Stop requested. */
  cancelled?: () => boolean;
}

export async function runComparison(
  doc: WorldDocument, instances: readonly PhenomenonInstance[], scenarios: readonly ComparisonScenario[], opts: ComparisonOptions = {},
): Promise<ScenarioResult[]> {
  const seed = doc.settings.simulation.seed;
  const ctx = { seed, terrain: doc.terrain, water: doc.settings.simulation.water };
  const results: ScenarioResult[] = [];
  for (let k = 0; k < scenarios.length; k++) {
    const sc = scenarios[k];
    const sched = resolveSchedule(subset(instances, sc.instanceIds, seed, doc), ctx);
    const water = sched.items.some((r) => isWaterEvent(r.spec));
    const last = Math.max(0, ...sched.items.map((r) => r.end));
    const total = Math.min(600, opts.duration && opts.duration > 0 ? opts.duration : last + (water ? 60 : 8));
    const c = new SimulationController({ headless: true });
    if (opts.initialWater) c.setInitialWaterState(opts.initialWater);
    const t0 = performance.now();
    await c.load(structuredClone(doc));
    for (const r of sched.items) c.addEvent(r.spec);
    let simTime = 0;
    while (simTime < total - 1e-9) {
      if (opts.cancelled?.()) break;
      const step = Math.min(1, total - simTime);
      c.advance(step);
      simTime += step;
      opts.onProgress?.(k, simTime, total);
      if (opts.yieldFn) await opts.yieldFn();
    }
    const wallMs = performance.now() - t0;
    const m = c.getMetrics()!;
    const events = c.getDamageEvents();
    const byHazard: Record<Hazard, number> = { wind: 0, earthquake: 0, flood: 0 };
    const collapsed = new Set<string>();
    for (const e of events) {
      byHazard[e.hazard]++;
      if (e.eventType === 'COLLAPSED' && e.objectType === 'building') collapsed.add(e.objectId);
    }
    let displaced = 0;
    for (const e of c.getRuntime()!.entities.values()) if (e.dynamic && e.displacement > 1) displaced++;
    results.push({
      id: sc.id, instanceIds: [...sc.instanceIds],
      damagedObjects: m.objectsDamaged + m.objectsDestroyed,
      collapsedBuildings: collapsed.size,
      displacedObjects: displaced,
      floodedArea: m.flood?.peakFloodedArea ?? 0,
      totalDamageEvents: m.totalDamageEvents,
      eventsByHazard: byHazard,
      simTime,
      wallMs,
      msPerSimSecond: simTime > 0 ? wallMs / simTime : 0,
      issues: sched.issues,
    });
    c.unload();
    if (opts.cancelled?.()) break;
  }
  return results;
}
