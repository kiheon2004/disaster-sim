/**
 * ForceLedger (Phase 15): the single path for continuous forces into Rapier.
 *
 * Every system that pushes a body (wind drag, earthquake inertial load, buoyancy / water drag,
 * a future gravity field) calls `ledger.force*()` with its SOURCE instead of the physics engine
 * directly. The ledger forwards the call unchanged (same arguments, same order → bit-identical
 * physics) and
 *  - rejects a second application of the same source to the same body in the same fixed step
 *    (no duplicate physics: e.g. a phenomenon registered twice, or a system run twice), counting
 *    it in `duplicates`;
 *  - remembers the magnitude per source and body for the last step it was applied, so the
 *    inspector can show how wind, ground motion and water share the load on one object.
 *
 * Impulses (knock-downs, debris spawning) are discrete and may legitimately repeat; they keep
 * going through PhysicsEngine directly.
 */
import type { Vec3 } from '@/core/types';
import type { BodyHandle, PhysicsEngine } from '@/physics/PhysicsEngine';

export const FORCE_SOURCES = ['wind', 'groundMotion', 'water', 'gravityField'] as const;
export type ForceSource = (typeof FORCE_SOURCES)[number];
const SOURCE_BIT: Record<ForceSource, number> = { wind: 1, groundMotion: 2, water: 4, gravityField: 8 };
const SOURCE_INDEX: Record<ForceSource, number> = { wind: 0, groundMotion: 1, water: 2, gravityField: 3 };

/** Per-entity record: [|F| per source …, step of that value per source …]. */
export type ForceRecord = Float64Array;

export interface ForceOwner {
  forces?: ForceRecord;
}

export class ForceLedger {
  private readonly applied = new Map<BodyHandle, number>();
  /** Rejected duplicate applications since the run started. */
  duplicates = 0;
  /** Fixed step the ledger is collecting for. */
  step = 0;

  constructor(private readonly physics: PhysicsEngine) {}

  beginStep(step: number) {
    this.step = step;
    if (this.applied.size) this.applied.clear();
  }

  private claim(source: ForceSource, h: BodyHandle): boolean {
    const bit = SOURCE_BIT[source];
    const mask = this.applied.get(h) ?? 0;
    if (mask & bit) {
      this.duplicates++;
      return false;
    }
    this.applied.set(h, mask | bit);
    return true;
  }

  private note(source: ForceSource, f: Readonly<Vec3>, owner?: ForceOwner) {
    if (!owner) return;
    const r = (owner.forces ??= new Float64Array(FORCE_SOURCES.length * 2).fill(-1));
    const i = SOURCE_INDEX[source];
    r[i] = Math.sqrt(f[0] * f[0] + f[1] * f[1] + f[2] * f[2]);
    r[FORCE_SOURCES.length + i] = this.step;
  }

  /** Force at a world point for this step. Returns false when rejected as a duplicate. */
  forceAtPoint(source: ForceSource, h: BodyHandle, f: Vec3, p: Vec3, owner?: ForceOwner, wake = true): boolean {
    if (!this.claim(source, h)) return false;
    this.physics.addForceAtPoint(h, f, p, wake);
    this.note(source, f, owner);
    return true;
  }

  /** Force through the center of mass for this step. */
  force(source: ForceSource, h: BodyHandle, f: Vec3, owner?: ForceOwner): boolean {
    if (!this.claim(source, h)) return false;
    this.physics.addForce(h, f);
    this.note(source, f, owner);
    return true;
  }
}

/** Force magnitudes an owner received in a given step (−1 = none), by source. */
export function forcesAt(owner: ForceOwner, step: number): Record<ForceSource, number> {
  const out = { wind: -1, groundMotion: -1, water: -1, gravityField: -1 } as Record<ForceSource, number>;
  const r = owner.forces;
  if (!r) return out;
  FORCE_SOURCES.forEach((s, i) => {
    if (r[FORCE_SOURCES.length + i] >= step) out[s] = r[i];
  });
  return out;
}
