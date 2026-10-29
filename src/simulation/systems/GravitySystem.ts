import type { SimulationSystem, SystemContext } from './SimulationSystem';
import { GravityRuntime } from '../gravity/runtime';
import { simProfiler as P } from '../profiling/SimProfiler';

/**
 * Gravity field (Phase 31), FIRST of the prePhysics systems: prepares the field for the step's time so every later
 * system of the step samples the same g(x, t), sets the Rapier world's uniform gravity, applies the per-body field
 * differences (ForceLedger 'gravityField') and wakes bodies when gravity changed. Idle — skipped, nothing allocated —
 * until a gravity experiment starts.
 */
export class GravitySystem implements SimulationSystem {
  readonly name = 'gravity';
  readonly phase = 'prePhysics' as const;
  readonly reads = [] as const;
  readonly writes = ['forces'] as const;

  isActive(ctx: SystemContext) {
    return ctx.env.gravity.field !== null;
  }

  update(ctx: SystemContext) {
    const ch = ctx.env.gravity;
    if (!ch.field) return;
    const t0 = P.now();
    (ch.rt ??= new GravityRuntime(ch)).pre(ctx);
    P.add('gravity.field', t0);
  }
}

/**
 * Gravity ledger (Phase 31), FIRST of the postPhysics systems (before any system removes or spawns a body): work and
 * impulse of gravity over the step just integrated, kinetic / potential energy, momentum (gravity/ledger.ts).
 */
export class GravityLedgerSystem implements SimulationSystem {
  readonly name = 'gravityLedger';
  readonly phase = 'postPhysics' as const;
  readonly reads = [] as const;
  readonly writes = ['metrics'] as const;

  isActive(ctx: SystemContext) {
    return ctx.env.gravity.rt !== null;
  }

  update(ctx: SystemContext, dt: number) {
    const rt = ctx.env.gravity.rt;
    if (!rt) return;
    const t0 = P.now();
    rt.post(ctx, dt);
    P.add('gravity.ledger', t0);
  }
}
