/**
 * ForceLedger (Phase 15): the single path for continuous forces into Rapier.
 *
 * Every system that pushes a body (wind drag, earthquake inertial load, buoyancy / water drag,
 * moving sediment drag (Phase 22), air-pressure waves (Phase 24), a future gravity field) calls `ledger.force*()` with its SOURCE instead of the physics engine
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

export const FORCE_SOURCES = ['wind', 'groundMotion', 'water', 'gravityField', 'sediment', 'impact', 'blast'] as const;
export type ForceSource = (typeof FORCE_SOURCES)[number];
const SOURCE_BIT: Record<ForceSource, number> = { wind: 1, groundMotion: 2, water: 4, gravityField: 8, sediment: 16, impact: 32, blast: 64 };
const SOURCE_INDEX: Record<ForceSource, number> = { wind: 0, groundMotion: 1, water: 2, gravityField: 3, sediment: 4, impact: 5, blast: 6 };

/** Per-entity record: [|F| per source …, step of that value per source …]. */
export type ForceRecord = Float64Array;

export function newForceRecord(): ForceRecord {
  return new Float64Array(FORCE_SOURCES.length * 2).fill(-1);
}

export interface ForceOwner {
  forces?: ForceRecord;
}

export class ForceLedger {
  /** Bodies without an owner record (fallback; every current caller passes an owner). */
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

  /**
   * Claim (body, source) for this step. With an owner the claim is a step stamp in the owner's
   * record (no hashing, no allocation in the hot loop); without one a per-step map is used.
   */
  private claim(source: ForceSource, h: BodyHandle, owner: ForceOwner | undefined): boolean {
    if (owner) {
      const r = (owner.forces ??= newForceRecord());
      const i = FORCE_SOURCES.length + SOURCE_INDEX[source];
      if (r[i] === this.step) {
        this.duplicates++;
        return false;
      }
      r[i] = this.step;
      return true;
    }
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
    if (owner) owner.forces![SOURCE_INDEX[source]] = Math.sqrt(f[0] * f[0] + f[1] * f[1] + f[2] * f[2]);
  }

  /** Force at a world point for this step. Returns false when rejected as a duplicate. */
  forceAtPoint(source: ForceSource, h: BodyHandle, f: Vec3, p: Vec3, owner?: ForceOwner, wake = true): boolean {
    if (!this.claim(source, h, owner)) return false;
    this.physics.addForceAtPoint(h, f, p, wake);
    this.note(source, f, owner);
    return true;
  }

  /** Force through the center of mass for this step. */
  force(source: ForceSource, h: BodyHandle, f: Vec3, owner?: ForceOwner, wake = true): boolean {
    if (!this.claim(source, h, owner)) return false;
    if (wake) this.physics.addForce(h, f);
    else this.physics.addForce(h, f, false);
    this.note(source, f, owner);
    return true;
  }
}

/** Force magnitudes an owner received in a given step (−1 = none), by source. */
export function forcesAt(owner: ForceOwner, step: number): Record<ForceSource, number> {
  const out = { wind: -1, groundMotion: -1, water: -1, gravityField: -1, sediment: -1, impact: -1, blast: -1 } as Record<ForceSource, number>;
  const r = owner.forces;
  if (!r) return out;
  FORCE_SOURCES.forEach((s, i) => {
    if (r[FORCE_SOURCES.length + i] >= step) out[s] = r[i];
  });
  return out;
}

/**
 * Whether moving ground pushed this body recently (Phase 22): sediment drag applied in the last
 * `window` steps at least as large as any wind force in that window. Used to attribute pushes and
 * impacts of bodies carried by a landslide to the ground hazard, never to a calm wind.
 */
export function pushedBySediment(owner: ForceOwner, step: number, window = 60): boolean {
  const f = forcesAt(owner, step - window);
  return f.sediment > 0 && f.sediment >= f.wind;
}

/** Whether an air-pressure wave pushed this body recently (Phase 24): its pushes and impacts are the blast's. */
export function pushedByBlast(owner: ForceOwner, step: number, window = 120): boolean {
  const f = forcesAt(owner, step - window);
  return f.blast > 0 && f.blast >= f.wind;
}

/** Whether impact ejecta hit this body recently (Phase 23): its pushes and impacts are the impact's. */
export function pushedByImpact(owner: ForceOwner, step: number, window = 120): boolean {
  const f = forcesAt(owner, step - window);
  return f.impact > 0 && f.impact >= f.wind;
}

