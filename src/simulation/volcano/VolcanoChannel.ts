/**
 * Volcano channel (Phase 28): what volcano scenarios write and the ThermalSystem reads. Dormant — no
 * arrays, no cost, results bit-identical to Phase 27 — until the first eruption is due. The volcano
 * state (VolcanoWorld + its adapter) lives on top of the run's thermal state; its deposits (solidified
 * lava, bombs, ash) reach the terrain through ONE non-separable DeformationSource of the Phase 21 engine,
 * so terrain, collider, water bed, foundations, roads and renderers follow them through the same atomic
 * update path as every other deformation. Mobile lava is NOT terrain (it is not a collider or a water bed).
 */
import type { DeformationSource } from '@/deformation/types';
import type { DeformationChannel } from '../deformation/DeformationChannel';
import type { LavaField } from '@/volcano/LavaField';
import type { VolcanoSpec } from '@/volcano/types';

/** Largest difference between the deposits and the terrain left unsynchronized (m), as Phase 22. */
export const SYNC_TOLERANCE = 0.001;
/** Deposit changes are published at most this often (s) unless they exceed BIG_CHANGE — the collider is rebuilt per publish. */
export const PUBLISH_PERIOD = 1;
export const BIG_CHANGE = 0.05;

export interface EruptionRecord {
  id: string;
  name: string;
  spec: VolcanoSpec;
  /** Absolute start time (s). */
  start: number;
  /** Started in the volcano world (or rejected with a reason). */
  done: boolean;
  reason: string | null;
}

/** The deposits' contribution to the terrain: the deposit thickness at each vertex. */
export class VolcanoSource implements DeformationSource {
  readonly id = 'src:volcano';
  readonly phenomenon = 'volcano';
  readonly kind = 'volcano';
  readonly model = 'physics' as const;
  readonly startTime = 0;
  readonly duration = Infinity;
  readonly rect: { x0: number; z0: number; x1: number; z1: number };
  private published = -1;
  private checked = -1;
  private lastPublish = -Infinity;
  /** Simulation time (set by the adapter before the deformation system reads the version). */
  now = 0;

  constructor(readonly field: LavaField) {
    this.rect = { x0: 0, z0: 0, x1: field.nx - 1, z1: field.nz - 1 };
  }

  version() {
    const f = this.field;
    if (f.rev !== this.checked) {
      const d = f.dirty;
      let drift = 0;
      for (let iz = d.z0; iz <= d.z1; iz++) for (let i = iz * f.nx + d.x0, e = iz * f.nx + d.x1; i <= e; i++) {
        const v = Math.abs(f.dep[i] - f.applied[i]);
        if (v > drift) drift = v;
      }
      if (drift > SYNC_TOLERANCE && (drift > BIG_CHANGE || this.now - this.lastPublish >= PUBLISH_PERIOD)) {
        this.checked = f.rev;
        this.published = f.rev;
        this.lastPublish = this.now;
      } else if (drift <= SYNC_TOLERANCE) this.checked = f.rev;
    }
    return this.published;
  }

  sample(_tau: number, out: Float32Array) {
    const f = this.field;
    out.set(f.dep);
    // The terrain carries these deposits from now on (the lava's bed stays exact: heights − applied + dep).
    f.applied.set(f.dep);
    f.clearDirty();
  }

  changedRect() {
    const d = this.field.dirty;
    return d.x1 < d.x0 ? null : { x0: d.x0, z0: d.z0, x1: d.x1, z1: d.z1 };
  }

  valueAt(x: number, z: number) {
    const i = this.field.index(x, z);
    return i < 0 ? 0 : this.field.dep[i];
  }

  /** All of it is material lying on the ground (foundations do not rise with it; burial and loads do). */
  overburdenAt(x: number, z: number) {
    const f = this.field;
    const gx = (x - f.originX) / f.dx, gz = (z - f.originZ) / f.dx;
    if (gx < 0 || gz < 0 || gx > f.nx - 1 || gz > f.nz - 1) return 0;
    const ix = Math.min(f.nx - 2, Math.floor(gx)), iz = Math.min(f.nz - 2, Math.floor(gz));
    const ax = gx - ix, az = gz - iz, i = iz * f.nx + ix;
    const v = (k: number) => f.applied[k];
    return (v(i) * (1 - ax) + v(i + 1) * ax) * (1 - az) + (v(i + f.nx) * (1 - ax) + v(i + f.nx + 1) * ax) * az;
  }

  netVolume() {
    const f = this.field;
    let v = 0;
    for (let i = 0; i < f.n; i++) v += f.applied[i];
    return v * f.area;
  }
}

export class VolcanoChannel {
  readonly eruptions: EruptionRecord[] = [];
  /** Adapter (simulation/volcano/runtime.ts), created with the first eruption. */
  rt: import('./runtime').VolcanoRuntime | null = null;
  source: VolcanoSource | null = null;
  /** Bumped when an eruption is added (renderers). */
  rev = 0;

  constructor(readonly deformation: DeformationChannel | null = null) {}

  get active(): boolean {
    return this.rt !== null || this.eruptions.length > 0;
  }

  add(spec: VolcanoSpec, start: number, id: string) {
    this.eruptions.push({ id, name: spec.name ?? id, spec, start, done: false, reason: null });
    this.rev++;
  }

  /** Register the deposits with the deformation engine (once, by the adapter). */
  attach(field: LavaField) {
    if (this.source || !this.deformation) return;
    this.source = new VolcanoSource(field);
    this.deformation.ensure().add(this.source);
  }
}
