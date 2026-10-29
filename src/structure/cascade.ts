/**
 * Static cascade (Phase 25): apply failures round by round until the structure is stable.
 *
 * Used by the editor's removal preview (alternate-path check of a member removed suddenly) and by
 * tests. The simulation runs the same rounds one per fixed step (StructureRuntime), and adds the
 * time evolution — members that lose support FALL and strike what is below (falling.ts); this
 * helper only reports the gravity redistribution itself.
 */
import type { FailCause } from './types';
import type { StructuralSolver } from './solver';

export interface CascadeStep {
  round: number;
  i: number;
  /** Member index whose loss / failure triggered this one (−1: removed by the caller). */
  trigger: number;
  cause: FailCause;
  /** Amplified utilization at failure (0 for lost support). */
  u: number;
}

export interface CascadeResult {
  steps: CascadeStep[];
  rounds: number;
  /** Connections broken (edge indices). */
  edges: number[];
}

/** Remove `members` suddenly and resolve the redistribution until nothing else fails. */
export function staticCascade(s: StructuralSolver, members: number[], maxRounds = 200): CascadeResult {
  const steps: CascadeStep[] = [];
  const edges: number[] = [];
  for (const i of members) {
    if (!s.alive[i]) continue;
    steps.push({ round: 0, i, trigger: -1, cause: 'support', u: 0 });
    s.kill(i, i);
  }
  let round = 0;
  while (s.pending && round < maxRounds) {
    round++;
    const r = s.propagate(true);
    for (const l of r.lost) steps.push({ round, i: l.i, trigger: l.trigger, cause: 'support', u: 0 });
    for (const f of r.failed) {
      if (!s.alive[f.i]) continue;
      steps.push({ round, i: f.i, trigger: f.trigger, cause: f.cause, u: f.u });
      s.kill(f.i, f.i);
    }
    for (const e of r.edges) {
      edges.push(e.e);
      s.killEdge(e.e, e.trigger >= 0 ? e.trigger : s.g.eFrom[e.e]);
    }
  }
  return { steps, rounds: round, edges };
}
