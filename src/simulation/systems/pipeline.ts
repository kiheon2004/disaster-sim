/**
 * Pipeline order check (Phase 15). The system list in systems/index.ts IS the execution order
 * (prePhysics systems, then the physics step, then postPhysics systems, every fixed step;
 * systems with `interval` run on steps divisible by it). This verifies the declared data flow:
 *
 *  - a system that reads a key written by a LATER system in the same step (later in the same
 *    phase, or any postPhysics writer for a prePhysics reader) must declare the key `lagged`
 *    (it intentionally uses last step's value);
 *  - every system declares its reads / writes.
 */
import type { SimulationSystem, StateKey } from './SimulationSystem';

export interface PipelineIssue {
  system: string;
  key: StateKey | null;
  problem: 'undeclared' | 'readsBeforeWrite';
  writer?: string;
}

export function validatePipeline(systems: readonly SimulationSystem[]): PipelineIssue[] {
  const ordered = [...systems.filter((s) => s.phase === 'prePhysics'), ...systems.filter((s) => s.phase === 'postPhysics')];
  const issues: PipelineIssue[] = [];
  ordered.forEach((s, i) => {
    if (!s.reads || !s.writes) {
      issues.push({ system: s.name, key: null, problem: 'undeclared' });
      return;
    }
    for (const key of s.reads) {
      if (s.lagged?.includes(key)) continue;
      const later = ordered.slice(i + 1).find((w) => w.writes?.includes(key));
      if (later) issues.push({ system: s.name, key, problem: 'readsBeforeWrite', writer: later.name });
    }
  });
  return issues;
}

/** Execution order as data (docs, UI, tests): phase, name, rate. */
export function describePipeline(systems: readonly SimulationSystem[]) {
  return systems.map((s) => ({ name: s.name, phase: s.phase, everySteps: s.interval ?? 1, reads: s.reads ?? [], writes: s.writes ?? [], lagged: s.lagged ?? [] }));
}
