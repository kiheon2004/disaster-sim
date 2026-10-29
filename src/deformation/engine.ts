/**
 * Runtime Terrain Deformation Layer (Phase 21).
 *
 *   Original Composed Terrain  H₀   copy of the run's terrain at load (never written)
 *   Runtime Deformation Field  W(t) = Σ wᵢ(t)        linear superposition of every source
 *   Effective Simulation Terrain H(t) = H₀ + W(t)    the runtime TerrainData, written in place
 *
 * The runtime TerrainData is the simulation's own copy (SimulationController builds it from the
 * snapshot); the world document and the snapshot are never touched, so a reset rebuilds the
 * original exactly and blueprints / saves never contain runtime deformation.
 *
 * Superposition policy: contributions ADD. Two subsidences overlapping by half produce the sum
 * where they overlap (vertical displacements of independent causes are additive in the linear
 * small-strain picture). There is no clamping between sources — the validation warns about the
 * result instead (steep / large), never silently alters it.
 *
 * Update policy: a source is re-sampled only when its `version` changed (its time factor);
 * only the union rectangle of changed sources is rewritten. Each update returns that rectangle
 * so every consumer (collider, water bed, objects, roads, renderer) refreshes exactly the same
 * region.
 */
import type { TerrainData } from '@/core/model';
import { unionRect, type GridRect } from '@/terrain/TerrainData';
import { amplitude, eventDuration, shapeAt, shapeGrid, timeFactor } from './field';
import type { DeformationSource, ModelClass, TerrainDeformationSpec } from './types';

/** A deformation applied by an update: the region and the change of W there. */
export interface DeformationUpdate {
  rect: GridRect;
  /** Largest |ΔW| in this update (m). */
  maxDelta: number;
  /** W after the update over `rect` minus W before (row-major over rect). */
  delta: Float32Array;
  /** At least one source was a step change (instant / stage). */
  discontinuous: boolean;
}

export interface DeformationRecord {
  time: number;
  /** max |W| over the grid (m) and the net volume change Σ W·A (m³). */
  maxAbs: number;
  volume: number;
}

/** The separable prescribed source of a TerrainDeformationSpec. */
export class PrescribedSource implements DeformationSource {
  readonly model: ModelClass = 'prescribed';
  readonly kind: string;
  readonly duration: number;
  readonly rect: GridRect;
  private readonly values: Float32Array;
  private readonly volume: number;

  constructor(readonly id: string, readonly phenomenon: string, readonly spec: TerrainDeformationSpec, readonly startTime: number, t: TerrainData, private readonly seed: number) {
    this.kind = spec.kind;
    this.duration = eventDuration(spec);
    const g = shapeGrid(spec, t, seed);
    this.rect = g?.rect ?? { x0: 0, z0: 0, x1: -1, z1: -1 };
    this.values = g?.values ?? new Float32Array(0);
    let v = 0;
    for (const x of this.values) v += x;
    this.volume = v * t.cellSize * t.cellSize;
  }

  version(tau: number) {
    return timeFactor(this.spec, tau);
  }

  sample(tau: number, out: Float32Array) {
    const f = timeFactor(this.spec, tau);
    for (let i = 0; i < this.values.length; i++) out[i] = this.values[i] * f;
  }

  /** Displacement at a point (inspector; exact shape, not the grid). */
  at(x: number, z: number, tau: number) {
    return amplitude(this.spec) * shapeAt(this.spec, x, z, this.seed) * timeFactor(this.spec, tau);
  }

  support(x: number, z: number, tau: number) {
    const loss = this.spec.supportLoss ?? 0;
    if (loss <= 0) return 1;
    // Support loss follows the source's own extent and time profile (normalized shape).
    const s = this.spec.kind === 'prescribed' ? (Math.abs(this.at(x, z, Infinity)) > 0 ? 1 : 0) : shapeAt(this.spec, x, z, this.seed);
    return 1 - loss * s * timeFactor(this.spec, tau);
  }

  netVolume(tau: number) {
    return this.volume * timeFactor(this.spec, tau);
  }
}

interface Entry {
  source: DeformationSource;
  version: number;
  contrib: Float32Array;
}

export class DeformationEngine {
  /** Original composed terrain heights (copy at load). */
  readonly original: Float32Array;
  /** Total displacement W per vertex (m). */
  readonly field: Float32Array;
  private entries: Entry[] = [];
  /** Sources added since the last update that start with a step (applied without waiting). */
  private pendingStep = false;
  readonly history: DeformationRecord[] = [];
  /** Number of updates applied and their total vertex count (stats). */
  updates = 0;
  verticesWritten = 0;
  /** Bumped on every applied update (renderers / inspectors compare it). */
  rev = 0;
  maxAbs = 0;
  /** Changed rectangles of the last updates (renderers catch up with dirtySince). */
  private recent: { rev: number; rect: GridRect }[] = [];

  constructor(readonly terrain: TerrainData) {
    this.original = terrain.heights.slice();
    this.field = new Float32Array(terrain.heights.length);
  }

  get sources(): readonly DeformationSource[] {
    return this.entries.map((e) => e.source);
  }

  get active(): boolean {
    return this.entries.length > 0;
  }

  add(source: DeformationSource) {
    if (source.rect.x1 < source.rect.x0) return; // entirely outside the grid
    const w = source.rect.x1 - source.rect.x0 + 1, h = source.rect.z1 - source.rect.z0 + 1;
    this.entries.push({ source, version: NaN, contrib: new Float32Array(w * h) });
    this.pendingStep = true;
  }

  /** Whether an update would change something at time t (cheap). */
  wants(time: number): boolean {
    for (const e of this.entries) if (e.source.version(time - e.source.startTime) !== e.version) return true;
    return false;
  }

  /** A newly started source must be applied in the step it starts (instant deformation). */
  get urgent(): boolean {
    return this.pendingStep;
  }

  /**
   * Bring W and the terrain heights to time t. Returns the changed region, or null when nothing
   * changed. Heights are written as H₀ + W only inside the changed rectangle.
   */
  update(time: number): DeformationUpdate | null {
    this.pendingStep = false;
    let rect: GridRect | null = null;
    const changed: Entry[] = [];
    let discontinuous = false;
    for (const e of this.entries) {
      const tau = time - e.source.startTime;
      const v = e.source.version(tau);
      if (v === e.version) continue;
      // A jump of more than 5 % of the final state in one update (instant start, a stage).
      if (Math.abs(v - (Number.isNaN(e.version) ? 0 : e.version)) > 0.05) discontinuous = true;
      changed.push(e);
      rect = unionRect(rect, e.source.rect);
    }
    if (!rect) return null;
    const t = this.terrain;
    const W = this.field;
    const rw = rect.x1 - rect.x0 + 1, rh = rect.z1 - rect.z0 + 1;
    const delta = new Float32Array(rw * rh);
    for (const e of changed) {
      const tau = time - e.source.startTime;
      const next = new Float32Array(e.contrib.length);
      e.source.sample(tau, next);
      const r = e.source.rect;
      const w = r.x1 - r.x0 + 1;
      for (let i = 0; i < next.length; i++) {
        const d = next[i] - e.contrib[i];
        if (d === 0) continue;
        const ix = r.x0 + (i % w), iz = r.z0 + Math.floor(i / w);
        W[iz * t.nx + ix] += d;
        delta[(iz - rect.z0) * rw + (ix - rect.x0)] += d;
      }
      e.contrib = next;
      e.version = e.source.version(tau);
    }
    let maxDelta = 0;
    for (let iz = rect.z0; iz <= rect.z1; iz++) for (let ix = rect.x0; ix <= rect.x1; ix++) {
      const i = iz * t.nx + ix;
      t.heights[i] = this.original[i] + W[i];
      const d = Math.abs(delta[(iz - rect.z0) * rw + (ix - rect.x0)]);
      if (d > maxDelta) maxDelta = d;
    }
    t.revision++;
    this.updates++;
    this.verticesWritten += rw * rh;
    this.rev++;
    this.recent.push({ rev: this.rev, rect });
    if (this.recent.length > 64) this.recent.shift();
    // Summary record (whole grid: cheap at 10 Hz on 40 k vertices).
    let maxAbs = 0, vol = 0;
    for (let i = 0; i < W.length; i++) {
      const v = W[i];
      vol += v;
      if (v > maxAbs) maxAbs = v;
      else if (-v > maxAbs) maxAbs = -v;
    }
    this.maxAbs = maxAbs;
    this.history.push({ time, maxAbs, volume: vol * t.cellSize * t.cellSize });
    if (this.history.length > 4000) this.history.splice(0, this.history.length - 4000);
    return { rect, maxDelta, delta, discontinuous };
  }

  /**
   * Union of the rectangles changed after revision `rev` (null = nothing changed). A consumer
   * that fell further behind than the kept history gets the whole grid.
   */
  dirtySince(rev: number): GridRect | null {
    if (rev >= this.rev) return null;
    if (!this.recent.length || this.recent[0].rev > rev + 1) return { x0: 0, z0: 0, x1: this.terrain.nx - 1, z1: this.terrain.nz - 1 };
    let r: GridRect | null = null;
    for (const e of this.recent) if (e.rev > rev) r = unionRect(r, e.rect);
    return r;
  }

  /** Displacement at a point (bilinear on W; 0 outside the grid). */
  displacementAt(x: number, z: number): number {
    const t = this.terrain;
    const gx = (x - t.originX) / t.cellSize, gz = (z - t.originZ) / t.cellSize;
    if (gx < 0 || gz < 0 || gx > t.nx - 1 || gz > t.nz - 1) return 0;
    const ix = Math.min(t.nx - 2, Math.floor(gx)), iz = Math.min(t.nz - 2, Math.floor(gz));
    const ax = gx - ix, az = gz - iz, i = iz * t.nx + ix, W = this.field;
    return (W[i] * (1 - ax) + W[i + 1] * ax) * (1 - az) + (W[i + t.nx] * (1 - ax) + W[i + t.nx + 1] * ax) * az;
  }

  /** Original (pre-deformation) elevation at a point. */
  originalAt(x: number, z: number): number {
    const t = this.terrain;
    const gx = (x - t.originX) / t.cellSize, gz = (z - t.originZ) / t.cellSize;
    if (gx < 0 || gz < 0 || gx > t.nx - 1 || gz > t.nz - 1) return 0;
    const ix = Math.min(t.nx - 2, Math.floor(gx)), iz = Math.min(t.nz - 2, Math.floor(gz));
    const ax = gx - ix, az = gz - iz, i = iz * t.nx + ix, H = this.original;
    return (H[i] * (1 - ax) + H[i + 1] * ax) * (1 - az) + (H[i + t.nx] * (1 - ax) + H[i + t.nx + 1] * ax) * az;
  }

  /** Ground support multiplier at a point (product over sources that state a support loss). */
  supportAt(x: number, z: number, time: number): number {
    let s = 1;
    for (const e of this.entries) if (e.source.support) s *= e.source.support(x, z, time - e.source.startTime);
    return s;
  }

  /** Sources with a non-zero contribution at a point now (inspector: "deformation source"). */
  sourcesAt(x: number, z: number, time: number): { source: DeformationSource; value: number }[] {
    const out: { source: DeformationSource; value: number }[] = [];
    for (const e of this.entries) {
      const s = e.source;
      const v = s instanceof PrescribedSource ? s.at(x, z, time - s.startTime) : 0;
      if (Math.abs(v) > 1e-4) out.push({ source: s, value: v });
    }
    return out.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  }
}
