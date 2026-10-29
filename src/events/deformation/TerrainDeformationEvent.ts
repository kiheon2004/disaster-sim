/**
 * Terrain deformation event (Phase 21). Like every event it only WRITES its channel: on start it
 * registers a prescribed displacement source with the run's deformation engine; the
 * DeformationSystem applies it (terrain, collider, water bed, objects, roads). The deformation
 * persists after the event ends — the ground does not spring back unless the time profile
 * returns it (cyclic).
 */
import { createId } from '@/core/id';
import type { I18nMessage } from '@/i18n/i18n';
import type { EventContext, SimulationEvent } from '../SimulationEvent';
import type { TerrainDeformationSpec } from '@/deformation/types';
import { eventDuration, timeFactor } from '@/deformation/field';
import { PrescribedSource } from '@/deformation/engine';

export class TerrainDeformationEvent implements SimulationEvent<TerrainDeformationSpec> {
  readonly id = createId('evt');
  readonly type = 'terrainDeformation' as const;
  readonly channel: string;
  readonly startTime: number;
  readonly duration: number;

  constructor(readonly spec: TerrainDeformationSpec, now: number, private readonly seed: number) {
    this.startTime = spec.startTime ?? now;
    this.duration = eventDuration(spec);
    this.channel = `deform:${this.id}`;
  }

  onStart({ env }: EventContext) {
    const ch = env.deformation;
    const engine = ch.ensure();
    engine.add(new PrescribedSource(`src:${this.id}`, this.spec.name ?? this.id, this.spec, this.startTime, ch.terrain, this.spec.seed ?? this.seed));
  }

  update() {
    // The engine evaluates the time profile; nothing to integrate here.
  }

  intensityAt(t: number): number {
    return timeFactor(this.spec, t);
  }

  describe(): I18nMessage {
    return {
      key: 'event.deform.describe',
      params: { kind: this.spec.kind, m: (this.spec.kind === 'prescribed' ? 0 : this.spec.amount).toFixed(2), r: Math.round(this.spec.radius), s: Math.round(this.spec.profile === 'instant' ? 0 : this.spec.duration) },
    };
  }
}
