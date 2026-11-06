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
  /**
   * Phase 33: per-source sums of this step's applied forces for the standing-balance model of extended people —
   * HUM_STRIDE floats per source (FORCE_SOURCES order): Σ F at points (3), Σ p × F (3), Σ F through the COM (3). The
   * owner resets it after reading. 'gravityField' is never accumulated (the balance model takes gravity from the field).
   */
  hum?: Float64Array;
}

export const HUM_STRIDE = 9;
export const newHumAccumulator = () => new Float64Array(FORCE_SOURCES.length * HUM_STRIDE);

function accumulate(a: Float64Array, source: ForceSource, f: Readonly<Vec3>, p: Readonly<Vec3> | null) {
  if (source === 'gravityField') return;
  const o = SOURCE_INDEX[source] * HUM_STRIDE;
  if (p) {
    a[o] += f[0]; a[o + 1] += f[1]; a[o + 2] += f[2];
    a[o + 3] += p[1] * f[2] - p[2] * f[1];
    a[o + 4] += p[2] * f[0] - p[0] * f[2];
    a[o + 5] += p[0] * f[1] - p[1] * f[0];
  } else {
    a[o + 6] += f[0]; a[o + 7] += f[1]; a[o + 8] += f[2];
  }
}

/**
 * Phase 35: contact channels of vehicles — NOT environment sources (they are not in FORCE_SOURCES, so no per-entity record,
 * balance accumulator or attribution changes). 'wheels' = the four tyre / suspension contact forces of a vehicle on its own
 * chassis, 'wheelReaction' = their reactions on a dynamic body under the wheels. Each is ONE claim per body and step that
 * applies several points at once (four calls of one source would be rejected as duplicates).
 */
export const CONTACT_CHANNELS = ['wheels', 'wheelReaction'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];
const CHANNEL_BIT: Record<ContactChannel, number> = { wheels: 1, wheelReaction: 2 };

export class ForceLedger {
  /** Bodies without an owner record (fallback; every current caller passes an owner). */
  private readonly applied = new Map<BodyHandle, number>();
  /** Phase 35: contact-channel claims of this step (body → channel bits). */
  private readonly contact = new Map<BodyHandle, number>();
  /** Rejected duplicate applications since the run started. */
  duplicates = 0;
  /** Fixed step the ledger is collecting for. */
  step = 0;

  constructor(private readonly physics: PhysicsEngine) {}

  beginStep(step: number) {
    this.step = step;
    if (this.applied.size) this.applied.clear();
    if (this.contact.size) this.contact.clear();
  }

  /**
   * Phase 35: several contact forces (world, at world points) on one body under ONE claim of a contact channel for this step.
   * Returns false (nothing applied, counted as a duplicate) when the channel was already claimed for the body this step.
   */
  contactForces(channel: ContactChannel, h: BodyHandle, fs: readonly Readonly<Vec3>[], ps: readonly Readonly<Vec3>[], wake = true): boolean {
    const bit = CHANNEL_BIT[channel];
    const mask = this.contact.get(h) ?? 0;
    if (mask & bit) {
      this.duplicates++;
      return false;
    }
    this.contact.set(h, mask | bit);
    for (let i = 0; i < fs.length; i++) {
      const f = fs[i];
      if (f[0] !== 0 || f[1] !== 0 || f[2] !== 0) this.physics.addForceAtPoint(h, f as Vec3, ps[i] as Vec3, wake);
    }
    return true;
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
    if (owner?.hum) accumulate(owner.hum, source, f, p);
    return true;
  }

  /** Force through the center of mass for this step. */
  force(source: ForceSource, h: BodyHandle, f: Vec3, owner?: ForceOwner, wake = true): boolean {
    if (!this.claim(source, h, owner)) return false;
    if (wake) this.physics.addForce(h, f);
    else this.physics.addForce(h, f, false);
    this.note(source, f, owner);
    if (owner?.hum) accumulate(owner.hum, source, f, null);
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

