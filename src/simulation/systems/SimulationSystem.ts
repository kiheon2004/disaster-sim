import type { I18nMessage } from '@/i18n/i18n';
import type { EntityId } from '@/core/types';
import type { PhysicsEngine } from '@/physics/PhysicsEngine';
import type { EnvironmentState } from '../environment/EnvironmentState';
import type { RuntimeEntity, SimulationRuntime } from '../SimulationRuntime';
import type { Rng } from '@/core/random';
import type { DamageEventInput } from '../analysis/DamageEvent';
import type { ForceLedger } from '../forces/ForceLedger';

export interface SystemContext {
  env: Readonly<EnvironmentState>;
  runtime: SimulationRuntime;
  physics: PhysicsEngine;
  time: number;
  /** Fixed-step counter since the run started (0, 1, 2, …) — for deterministic staggering. */
  step: number;
  /** Seeded randomness — the only allowed source of randomness in the simulation core. */
  rng: Rng;
  /** Separate seeded stream for purely visual randomness (particles), so effects never shift decisions. */
  fxRng: Rng;
  log(entityId: EntityId | null, severity: 'info' | 'warn' | 'danger', message: I18nMessage): void;
  /** Append a structured damage event (time, wind and defaults are filled in from the entity). */
  recordDamage(e: RuntimeEntity, event: DamageEventInput): void;
  /** The only path for continuous forces into the physics engine (Phase 15). */
  forces: ForceLedger;
  /** Multi-hazard interaction models on (project setting, Phase 15; see docs/PHENOMENA.md §6). */
  interactions: boolean;
  /** Add an experiment timeline milestone (Phase 21; optional for headless helpers). */
  milestone?(m: import('../analysis/MilestoneRecorder').Milestone, onceKey?: string): void;
}

/**
 * Shared world state a system reads or writes (Phase 15). Declared on every system so the
 * pipeline order can be checked: within a phase, a writer of a key runs before its readers,
 * unless the reader declares the key in `lagged` (it intentionally uses the previous step).
 */
export type StateKey =
  | 'airflow' | 'groundMotion' | 'water' | 'forces' | 'poses' | 'structure' | 'damage' | 'exposure' | 'debris' | 'particles' | 'metrics'
  // Phase 21: the ground surface itself (heights, collider) — written only by the DeformationSystem.
  | 'terrain';

/**
 * A unit of simulation logic run on the fixed-step clock.
 * prePhysics systems apply forces; postPhysics systems read results (poses, damage, debris).
 *
 * Scheduling (see SimulationController.step): a system runs every `interval` fixed steps
 * (default 1 = 60 Hz) and then receives `dt × interval`. The schedule only depends on the step
 * counter, never on wall-clock time, so it is deterministic. Only systems whose output cannot
 * feed back into physics or damage may use interval > 1 (e.g. visual particles); finer-grained
 * staggering inside a system uses `ctx.step` (e.g. facade parts evaluated at 20 Hz in rounds).
 */
export interface SimulationSystem {
  readonly name: string;
  readonly phase: 'prePhysics' | 'postPhysics';
  /** Run every N fixed steps (default 1). */
  readonly interval?: number;
  readonly reads?: readonly StateKey[];
  readonly writes?: readonly StateKey[];
  /** Keys read from the previous step on purpose (no ordering constraint). */
  readonly lagged?: readonly StateKey[];
  /**
   * Cheap check: does the system have anything to do this step? The controller skips inactive
   * systems (a phenomenon that is not running costs nothing). Must be consistent with the
   * system's own early returns — skipping may never change a result.
   */
  isActive?(ctx: SystemContext): boolean;
  update(ctx: SystemContext, dt: number): void;
}
