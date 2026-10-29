/**
 * Meteoroid / asteroid impact event (Phase 23). Like every event it only WRITES channels: at its
 * start it computes the impact plan on the run's CURRENT terrain (earlier deformations, landslides
 * and craters included), adds the impact model to the ground-failure field, its ground shock to
 * the ground-motion field and — for an airburst — an atmospheric-blast source for Phase 24.
 * The event starts at the top of the atmosphere (or at the hand-over point in direct mode); the
 * impact happens after the computed flight time.
 */
import { createId } from '@/core/id';
import type { I18nMessage } from '@/i18n/i18n';
import type { EventContext, SimulationEvent } from '../SimulationEvent';
import type { ImpactSpec } from '@/impact/types';
import { planImpact, type ImpactPlan } from '@/impact/plan';
import { ImpactModel } from '@/impact/ImpactModel';
import { resolveProjectile } from '@/impact/projectile';
import { integrateEntry } from '@/impact/entry';

/** Shown as running from entry to a few seconds after the impact (its effects persist). */
export function impactEventDuration(spec: ImpactSpec): number {
  if (spec.entry === 'direct') return 15;
  const e = integrateEntry(resolveProjectile(spec), spec.speed, spec.angle);
  return Math.ceil((e.airburst ? e.airburst.time : e.time) + 15);
}

export class ImpactEvent implements SimulationEvent<ImpactSpec> {
  readonly id = createId('evt');
  readonly type = 'impact' as const;
  readonly channel: string;
  readonly startTime: number;
  readonly duration: number;
  model: ImpactModel | null = null;
  plan: ImpactPlan | null = null;

  constructor(readonly spec: ImpactSpec, now: number, private readonly seed: number) {
    this.startTime = spec.startTime ?? now;
    this.duration = impactEventDuration(spec);
    this.channel = `impact:${this.id}`;
  }

  /** Plan computed ahead on the run's initial terrain (see prepare()). */
  private prepared: ImpactPlan | null = null;

  /**
   * Computes the plan when the event is scheduled (before the clock runs). Valid only while the run's
   * terrain is still the initial one: onStart checks that no deformation has been applied yet.
   */
  prepare(terrain: import('@/core/model').TerrainData) {
    this.prepared = planImpact(this.spec, terrain, this.spec.seed ?? this.seed);
  }

  onStart({ env }: EventContext) {
    const name = this.spec.name ?? this.id;
    // Same function and inputs as computing it now — unless earlier phenomena already changed the ground.
    const unchanged = this.prepared !== null && (env.deformation.engine?.rev ?? 0) === 0;
    const plan = (this.plan = unchanged ? this.prepared! : planImpact(this.spec, env.terrain.data, this.spec.seed ?? this.seed));
    this.prepared = null;
    const ch = env.groundFailure;
    const f = ch.ensure();
    const model = (this.model = new ImpactModel(this.id, name, plan, this.startTime, f, ch.nextIndex()));
    ch.impacts.push(model);
    env.impact.models.push(model);
    if (plan.shock) {
      plan.shock.time += this.startTime;
      plan.shock.source = `impact:${name}`;
      env.groundMotion.shocks.push(plan.shock);
    }
    if (plan.entry?.airburst) {
      const [x, , z] = plan.arc.point;
      env.impact.blasts.push({ source: `impact:${name}`, position: [x, plan.entry.airburst.altitude, z], time: this.startTime + plan.entry.airburst.time, energy: plan.entry.airburst.energy, kind: 'airburst' });
    } else if (plan.crater) {
      env.impact.blasts.push({ source: `impact:${name}`, position: [...plan.arc.point], time: this.startTime + plan.timeToImpact, energy: plan.partition.blast, kind: 'surface' });
    }
  }

  update() {}

  intensityAt(t: number): number {
    const ti = this.plan?.timeToImpact ?? this.duration;
    return t < ti ? t / Math.max(1e-6, ti) : 1;
  }

  describe(): I18nMessage {
    return describeImpact(this.spec);
  }
}

export function describeImpact(s: ImpactSpec): I18nMessage {
  return { key: `event.impact.describe.${s.entry}.${s.material}`, params: { L: s.diameter.toFixed(1), v: (s.speed / 1000).toFixed(1), a: s.angle.toFixed(0) } };
}
