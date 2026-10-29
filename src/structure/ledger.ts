/**
 * Mass, energy and momentum ledger of the structural destruction engine (Phase 25).
 *
 * Every kilogram of a building is in exactly one account at any time; mass only MOVES between
 * accounts (`move`), so the total stays the original mass exactly (up to float rounding of the
 * sums — `residual()` is checked by the tests and shown in the inspector):
 *
 *   structure   members still part of the structure (intact / damaged)
 *   falling     members of a falling block inside the building (engine kinematics)
 *   resting     fallen members resting on a lower part of the building
 *   bodies      rigid fragments simulated by the physics engine
 *   rubble      aggregated rubble: piles on the ground, fragments merged after settling or over the
 *               active-body budget (mass and footprint kept; no physics body)
 *   fines       glass shards / dust — visual-only particles; their mass lies at the facade foot
 *   left        fragments that left the world (recorded, not lost)
 *   captured    fragments captured by a celestial source (Phase 32; recorded in its capture ledger, not lost)
 *   unresolved  anything a simplification could not place (should stay 0; reported if not)
 *
 * Energy (J): potential released by falling blocks, dissipated in collisions, absorbed by the
 * structure, dissipated at the ground. Momentum (kg·m/s): horizontal momentum given to fragments,
 * by origin — inherited from the structure's motion, impulse of an air-pressure wave — never
 * created otherwise.
 */
export const ACCOUNTS = ['structure', 'falling', 'resting', 'bodies', 'rubble', 'fines', 'left', 'unresolved', 'captured'] as const;
export type Account = (typeof ACCOUNTS)[number];

export interface EnergyLedger {
  /** Potential energy released by falling blocks (J). */
  released: number;
  /** Kinetic energy dissipated in block–floor collisions (J). */
  collision: number;
  /** Work absorbed by struck floors (J). */
  absorbed: number;
  /** Kinetic energy dissipated where blocks landed on the ground (J). */
  ground: number;
  /** Kinetic energy still in falling blocks (J). */
  kinetic: number;
}

export interface MomentumLedger {
  /** Horizontal momentum of fragments from the structure's own motion at detachment (kg·m/s). */
  inherited: number;
  /** From the impulse of a wave / impact that detached them (kg·m/s). */
  impulse: number;
}

export class MassLedger {
  readonly original: number;
  readonly mass: Record<Account, number>;
  readonly energy: EnergyLedger = { released: 0, collision: 0, absorbed: 0, ground: 0, kinetic: 0 };
  readonly momentum: MomentumLedger = { inherited: 0, impulse: 0 };

  constructor(original: number) {
    this.original = original;
    this.mass = { structure: original, falling: 0, resting: 0, bodies: 0, rubble: 0, fines: 0, left: 0, unresolved: 0, captured: 0 };
  }

  move(from: Account, to: Account, kg: number) {
    if (kg === 0 || from === to) return;
    this.mass[from] -= kg;
    this.mass[to] += kg;
  }

  /** Original − Σ accounts (kg); exactly 0 up to rounding. */
  residual(): number {
    let s = 0;
    for (const a of ACCOUNTS) s += this.mass[a];
    return this.original - s;
  }

  /** Mass that has left the structure (kg). */
  detached(): number {
    return this.original - this.mass.structure;
  }
}

/** Sum of several ledgers (scene totals). */
export function sumLedgers(list: readonly MassLedger[]) {
  const mass = Object.fromEntries(ACCOUNTS.map((a) => [a, 0])) as Record<Account, number>;
  const energy: EnergyLedger = { released: 0, collision: 0, absorbed: 0, ground: 0, kinetic: 0 };
  const momentum: MomentumLedger = { inherited: 0, impulse: 0 };
  let original = 0, residual = 0;
  for (const l of list) {
    original += l.original;
    residual += l.residual();
    for (const a of ACCOUNTS) mass[a] += l.mass[a];
    for (const k of Object.keys(energy) as (keyof EnergyLedger)[]) energy[k] += l.energy[k];
    momentum.inherited += l.momentum.inherited;
    momentum.impulse += l.momentum.impulse;
  }
  return { original, residual, mass, energy, momentum };
}
