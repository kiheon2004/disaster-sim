/**
 * Air-pressure wave from a virtual release of energy into the air (Phase 24). Like every event it
 * only WRITES a channel: at its start it builds the wave (tables, ground reflection) on the run's
 * current terrain and adds it to the pressure channel; the BlastSystem does the rest.
 */
import { blastBackground } from '@/simulation/atmosphere/runtime';
import { createId } from '@/core/id';
import type { I18nMessage } from '@/i18n/i18n';
import type { TerrainData } from '@/core/model';
import type { EventContext, SimulationEvent } from '../SimulationEvent';
import type { BlastSpec } from '@/blast/types';
import { planOfWave, waveOf, type BlastPlan } from '@/blast/plan';
import { AIR_DENSITY } from '@/core/units';

/** Structures keep vibrating after the wave has left (the structural model integrates 12 s more). */
const RING_DOWN = 12;
const FLAT_EXIT = 1;

/** Seconds from the release to the front leaving the world, plus the pulse and the ring-down. */
export function blastEventDuration(spec: BlastSpec, terrain: TerrainData | null): number {
  if (!terrain) return FLAT_EXIT + RING_DOWN;
  const plan = planOfWave(spec, waveOf(spec, terrain, { id: 'd', source: 'd', name: 'd', time: 0 }), terrain);
  return Math.ceil(plan.worldExit + 2 * plan.wave.sample(1e3).T + RING_DOWN);
}

export class BlastEvent implements SimulationEvent<BlastSpec> {
  readonly id = createId('evt');
  readonly type = 'blast' as const;
  readonly channel: string;
  readonly startTime: number;
  readonly duration: number;
  plan: BlastPlan | null = null;
  private prepared: BlastPlan | null = null;

  constructor(readonly spec: BlastSpec, now: number, terrain: TerrainData | null = null) {
    this.startTime = spec.startTime ?? now;
    this.duration = blastEventDuration(spec, terrain);
    // Several releases may coexist: each has its own channel (never supersede each other).
    this.channel = `blast:${this.id}`;
  }

  private build(terrain: TerrainData, airDensity: number): BlastPlan {
    const name = this.spec.name ?? this.id;
    const wave = waveOf(this.spec, terrain, { id: this.id, source: `blast:${name}`, name, time: this.startTime, airDensity });
    return planOfWave(this.spec, wave, terrain);
  }

  /** Tables built when scheduled (outside the clock); reused at the start while the ground is unchanged. */
  prepare(terrain: TerrainData) {
    this.prepared = this.build(terrain, AIR_DENSITY);
  }

  onStart({ env }: EventContext) {
    // Phase 29 (opt-in): an atmosphere experiment's local background state replaces the standard
    // ambient — unless the spec sets its own; outside the blast model's range the ambient is kept (logged).
    const bg = this.spec.ambientPressure === undefined && this.spec.ambientDensity === undefined ? blastBackground(env, this.spec.position[0], this.spec.position[1], 'blast') : null;
    if (bg && bg !== 'range') {
      const name = this.spec.name ?? this.id;
      const spec = { ...this.spec, ambientPressure: bg.p, ambientDensity: bg.rho };
      const wave = waveOf(spec, env.terrain.data, { id: this.id, source: `blast:${name}`, name, time: this.startTime });
      this.plan = planOfWave(spec, wave, env.terrain.data);
      this.prepared = null;
      env.blast.add(this.plan.wave, this.plan, this.startTime + this.plan.worldExit + 2 * this.plan.wave.sample(1e3).T + 0.1);
      return;
    }
    const reuse = this.prepared !== null && (env.deformation.engine?.rev ?? 0) === 0 && (this.spec.ambientDensity !== undefined || env.airDensity === AIR_DENSITY);
    const plan = (this.plan = reuse ? this.prepared! : this.build(env.terrain.data, env.airDensity));
    this.prepared = null;
    if (bg === 'range') plan.warnings.push({ key: 'atmos.warn.blastRange' } as BlastPlan['warnings'][number]);
    env.blast.add(plan.wave, plan, this.startTime + plan.worldExit + 2 * plan.wave.sample(1e3).T + 0.1);
  }

  update() {}

  intensityAt(t: number): number {
    return t < 0 ? 0 : Math.exp(-t / 0.5);
  }

  describe(): I18nMessage {
    return describeBlast(this.spec);
  }
}

export function describeBlast(s: BlastSpec): I18nMessage {
  const E = s.energy;
  return { key: 'event.blast.describe', params: { E: E >= 1e9 ? `${(E / 1e9).toFixed(2)} GJ` : E >= 1e6 ? `${(E / 1e6).toFixed(2)} MJ` : `${(E / 1e3).toFixed(1)} kJ`, h: s.height.toFixed(0) } };
}
