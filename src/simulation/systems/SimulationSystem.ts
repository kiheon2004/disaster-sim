import type { I18nMessage } from '@/i18n/i18n';
import type { EntityId } from '@/core/types';
import type { PhysicsEngine } from '@/physics/PhysicsEngine';
import type { EnvironmentState } from '../environment/EnvironmentState';
import type { RuntimeEntity, SimulationRuntime } from '../SimulationRuntime';
import type { Rng } from '@/core/random';
import type { DamageEventInput } from '../analysis/DamageEvent';

export interface SystemContext {
  env: Readonly<EnvironmentState>;
  runtime: SimulationRuntime;
  physics: PhysicsEngine;
  time: number;
  /** Seeded randomness — the only allowed source of randomness in the simulation core. */
  rng: Rng;
  /** Separate seeded stream for purely visual randomness (particles), so effects never shift decisions. */
  fxRng: Rng;
  log(entityId: EntityId | null, severity: 'info' | 'warn' | 'danger', message: I18nMessage): void;
  /** Append a structured damage event (time, wind and defaults are filled in from the entity). */
  recordDamage(e: RuntimeEntity, event: DamageEventInput): void;
}

/**
 * A unit of simulation logic run every fixed step.
 * prePhysics systems apply forces; postPhysics systems read results (poses, damage, debris).
 */
export interface SimulationSystem {
  readonly name: string;
  readonly phase: 'prePhysics' | 'postPhysics';
  update(ctx: SystemContext, dt: number): void;
}
