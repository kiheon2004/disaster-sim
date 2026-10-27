import type { I18nMessage } from '@/i18n/i18n';
import type { EntityId } from '@/core/types';
import type { PhysicsEngine } from '@/physics/PhysicsEngine';
import type { EnvironmentState } from '../environment/EnvironmentState';
import type { SimulationRuntime } from '../SimulationRuntime';

export interface SystemContext {
  env: Readonly<EnvironmentState>;
  runtime: SimulationRuntime;
  physics: PhysicsEngine;
  time: number;
  log(entityId: EntityId | null, severity: 'info' | 'warn' | 'danger', message: I18nMessage): void;
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
