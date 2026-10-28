/**
 * Approximate spatial wind field (NOT a CFD solver).
 *
 *   global wind (events)  →  free stream: height profile + travelling gusts   (WindField)
 *                         →  obstacles:   wake deficit behind buildings, speed-up at corners
 *                         →  turbulence:  seeded, deterministic fluctuations in wakes/corners
 *                         =  local wind at a point
 *
 * The same `sample()` is used by physics, damage AND visualization, so what you see is what
 * the objects feel.
 *
 * Performance notes (results are bit-identical to a full scan):
 *  - obstacles are looked up in a flow-aligned spatial index (ObstacleIndex) that only lists
 *    obstacles whose wake / corner region can reach a cell;
 *  - static points keep their obstacle effect in a SampleCache, invalidated per index cell
 *    (a collapse only invalidates the cells its wake covered);
 *  - `sample(..., out)` writes into a caller-owned LocalWind (no allocation on hot paths).
 */
import type { EntityId, Vec3 } from '@/core/types';
import type { WindModelSettings } from '@/core/model';
import { DEFAULT_WIND_MODEL } from '@/core/model';
import { smoothstep } from '@/core/math';
import { Rng } from '@/core/random';
import type { WindField } from '../environment/WindField';
import { simProfiler } from '../profiling/SimProfiler';
import { ObstacleIndex } from './ObstacleIndex';
import type { WindObstacle } from './obstacles';

export interface LocalWind {
  /** Wind velocity vector (m/s). */
  velocity: Vec3;
  /** Local speed |velocity| (m/s). */
  speed: number;
  /** Undisturbed speed at this point (height profile + gusts, no obstacles). */
  freeStream: number;
  /** Global reference wind (10 m mean, from events). */
  global: number;
  /** Mean local/free-stream ratio from obstacles (<1 sheltered, >1 accelerated). */
  shelter: number;
  /** 0–1 turbulence intensity at the point. */
  turbulence: number;
  /** Obstacle casting the strongest shadow here (if any). */
  shadowSource: EntityId | null;
  /** True when the point is in a corner speed-up zone. */
  corner: boolean;
}

export function createLocalWind(): LocalWind {
  return { velocity: [0, 0, 0], speed: 0, freeStream: 0, global: 0, shelter: 1, turbulence: 0, shadowSource: null, corner: false };
}

const INSIDE_FACTOR = 0.3;
const MIN_SHELTER = 0.15;
const REBUILD_ANGLE = 1.5; // deg
/** Rotation allowance (rad) while the wind turns by less than REBUILD_ANGLE. */
const DRIFT_ANGLE = ((REBUILD_ANGLE + 0.5) * Math.PI) / 180;

/**
 * Per-caller cache for points that do not move (buildings, anchored trees, facade parts):
 * the obstacle effect only changes when the wind turns or an obstacle near the point changes.
 */
export interface SampleCache {
  version: number;
  fx: Effect | null;
  /** Index cell of the point and that cell's version when the effect was computed. */
  cell: number;
  cellVersion: number;
}

export function createSampleCache(): SampleCache {
  return { version: -1, fx: null, cell: 0, cellVersion: 0 };
}

interface Effect {
  factor: number;
  speedup: number;
  turbulence: number;
  source: EntityId | null;
  corner: boolean;
}

const newEffect = (): Effect => ({ factor: 1, speedup: 1, turbulence: 0, source: null, corner: false });

export class SpatialWindField {
  private obstacles: WindObstacle[] = [];
  private index: ObstacleIndex;
  private gridBearing = NaN;
  private dirty = true;
  /** The wind turned (by less than REBUILD_ANGLE) since the last full rebuild. */
  private drifted = false;
  /** Obstacles removed since the last query (applied lazily, like a rebuild would be). */
  private pendingRemovals: number[] = [];
  /** Incremented on every full rebuild (all cached effects become stale). */
  private version = 0;
  /** Seeded wave numbers / frequencies / phases of the turbulence noise, 3 per channel. */
  private noise: Float64Array[];
  private scratchFx = newEffect();

  constructor(
    readonly global: WindField,
    public params: WindModelSettings = DEFAULT_WIND_MODEL,
    seed = 1,
  ) {
    const rng = new Rng(seed).fork('turbulence');
    this.noise = [0, 1, 2].map(() => {
      const a = new Float64Array(9);
      for (let i = 0; i < 3; i++) {
        a[i * 3] = rng.range(0.05, 0.25) * (i + 1);
        a[i * 3 + 1] = rng.range(0.8, 3.5) * (i + 1);
        a[i * 3 + 2] = rng.range(0, Math.PI * 2);
      }
      return a;
    });
    this.index = new ObstacleIndex(params);
  }

  // ── Obstacle set (spatial index maintenance) ─────────────────────────────

  setObstacles(list: WindObstacle[]) {
    this.obstacles = list;
    this.pendingRemovals.length = 0;
    this.dirty = true;
  }

  /** A new obstacle (e.g. placed while simulating). */
  addObstacle(o: WindObstacle) {
    this.obstacles.push(o);
    if (!this.dirty) this.index.add(o, this.obstacles.length - 1);
  }

  /** An obstacle moved or changed size/height. */
  updateObstacle(id: EntityId, next: Omit<WindObstacle, 'id' | 'active'>) {
    const idx = this.obstacles.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const before = this.obstacles[idx];
    const after: WindObstacle = { ...before, ...next };
    this.obstacles[idx] = after;
    if (!this.dirty) this.index.update(before, after, idx);
  }

  removeObstacle(id: EntityId) {
    const idx = this.obstacles.findIndex((x) => x.id === id);
    const o = this.obstacles[idx];
    if (o && o.active) {
      o.active = false;
      this.pendingRemovals.push(idx);
    }
  }

  getObstacles(): readonly WindObstacle[] {
    return this.obstacles;
  }

  /** Candidate obstacle indices for the cell containing (x, z) (diagnostics / tests). */
  candidatesAt(x: number, z: number): readonly number[] {
    this.ensureGrid();
    return this.index.cells[this.index.cellAt(x, z)];
  }

  private ensureGrid() {
    const bearing = this.global.fromBearing;
    if (bearing === this.gridBearing && !this.dirty && this.pendingRemovals.length === 0) return;
    const turned = Math.abs(((bearing - this.gridBearing + 540) % 360) - 180) > REBUILD_ANGLE;
    if (this.pendingRemovals.length) {
      // A removal is equivalent to a full rebuild at the current bearing. When nothing else
      // changed since the last rebuild, only the removed obstacle's cells need updating.
      if (this.dirty || turned || this.drifted || bearing !== this.gridBearing) this.dirty = true;
      else for (const idx of this.pendingRemovals) this.index.remove(this.obstacles[idx], idx);
      this.pendingRemovals.length = 0;
    }
    if (this.dirty || turned) {
      this.dirty = false;
      this.drifted = false;
      this.gridBearing = bearing;
      this.version++;
      this.index.rebuild(this.obstacles, this.global.flow(), this.params);
      return;
    }
    if (bearing !== this.gridBearing && !this.drifted) {
      // Turning slowly: keep the frame (and every cached effect) but widen the regions.
      this.drifted = true;
      this.index.padForDrift(this.obstacles, DRIFT_ANGLE);
    }
  }

  // ── Obstacle effects ─────────────────────────────────────────────────────

  /** Combined effect of all nearby obstacles at point p. */
  obstacleEffect(p: Vec3, excludeId?: EntityId, out: Effect = newEffect()): Effect {
    out.factor = 1;
    out.speedup = 1;
    out.turbulence = 0;
    out.source = null;
    out.corner = false;
    if (!this.params.shelterEnabled || this.obstacles.length === 0) return out;
    this.ensureGrid();
    const cell = this.index.cells[this.index.cellAt(p[0], p[2])];
    if (cell.length === 0) return out;

    const f = this.global.flow();
    const n0 = -f[2];
    const n1 = f[0];
    const prm = this.params;
    const extD = this.index.extD;
    const extW = this.index.extW;
    let minFactor = 1;
    let maxCorner = 0;

    for (let k = 0; k < cell.length; k++) {
      const idx = cell[k];
      const o = this.obstacles[idx];
      if (!o.active || o.id === excludeId) continue;
      const H = o.height;
      const rx = p[0] - o.cx;
      const rz = p[2] - o.cz;
      const a = rx * f[0] + rz * f[2]; // along flow (+ = downstream)
      const c = Math.abs(rx * n0 + rz * n1); // across flow
      const D = extD[idx];
      const W = extW[idx];
      const y = p[1];

      // Inside the volume (e.g. debris resting on a roof edge cell)
      if (a > -D && a < D && c < W && y < H) {
        out.factor *= INSIDE_FACTOR;
        if (INSIDE_FACTOR < minFactor) { minFactor = INSIDE_FACTOR; out.source = o.id; }
        continue;
      }

      const vert = 1 - smoothstep(0.9 * H, 1.4 * H, y);
      if (vert <= 0) continue;

      // Wake behind the obstacle
      const d = a - D;
      const L = prm.wakeLength * H;
      if (d > 0 && d < L) {
        const w = W + prm.wakeSpread * d;
        const lat = 1 - smoothstep(0.75 * w, 1.15 * w, c);
        if (lat > 0) {
          const decay = Math.exp(-d / (prm.wakeRecovery * H)) * (1 - smoothstep(0.7 * L, L, d));
          const fac = 1 - prm.shadowStrength * decay * lat * vert;
          out.factor *= fac;
          out.turbulence += lat * vert * Math.exp(-d / (1.5 * prm.wakeRecovery * H));
          if (fac < minFactor) { minFactor = fac; out.source = o.id; }
        }
      }

      // Speed-up along the sides (flow separation at the corners)
      const band = 0.5 * H;
      if (a > -D && a < D + 0.5 * H && c >= W && c < W + band) {
        const edge = (1 - (c - W) / band) * vert;
        if (edge > maxCorner) maxCorner = edge;
        out.turbulence += 0.6 * edge;
        out.corner = true;
      }
    }
    out.factor = Math.max(MIN_SHELTER, out.factor);
    out.speedup = 1 + prm.cornerSpeedup * maxCorner;
    out.turbulence = Math.min(1, out.turbulence);
    return out;
  }

  /** Seeded smooth noise in about [-1, 1], advected with the flow. */
  private turb(channel: number, p: Vec3, t: number): number {
    const f = this.global.flow();
    const s = p[0] * f[0] + p[2] * f[2] - Math.max(this.global.baseSpeed, 3) * t;
    const q = p[0] * -f[2] + p[2] * f[0] + p[1] * 0.7;
    const nz = this.noise[channel];
    let v = 0;
    for (let i = 0; i < 9; i += 3) {
      const k = nz[i];
      v += Math.sin(s * k + q * k * 0.8 + t * nz[i + 1] + nz[i + 2]);
    }
    return v / 3;
  }

  // ── Sampling ─────────────────────────────────────────────────────────────

  /**
   * Full local-wind description at point p. `excludeId` skips the object's own wake.
   * Pass `cache` for points that never move and `out` to avoid allocating the result.
   */
  sample(p: Vec3, t: number, excludeId?: EntityId, cache?: SampleCache, out?: LocalWind): LocalWind {
    if (!simProfiler.enabled) return this.sampleImpl(p, t, excludeId, cache, out ?? createLocalWind());
    const t0 = performance.now();
    const r = this.sampleImpl(p, t, excludeId, cache, out ?? createLocalWind());
    simProfiler.windMs += performance.now() - t0;
    simProfiler.windSamples++;
    return r;
  }

  private sampleImpl(p: Vec3, t: number, excludeId: EntityId | undefined, cache: SampleCache | undefined, out: LocalWind): LocalWind {
    const g = this.global;
    const global = g.baseSpeed;
    const v = out.velocity;
    if (global <= 0.01) {
      v[0] = 0; v[1] = 0; v[2] = 0;
      out.speed = 0; out.freeStream = 0; out.global = 0; out.shelter = 1; out.turbulence = 0; out.shadowSource = null; out.corner = false;
      return out;
    }
    const free = g.speedAt(p, t);
    let fx: Effect;
    if (cache) {
      this.ensureGrid();
      const index = this.index;
      if (cache.version !== this.version || !cache.fx || index.cellVersion[cache.cell] !== cache.cellVersion) {
        cache.fx = this.obstacleEffect(p, excludeId, cache.fx ?? newEffect());
        cache.version = this.version;
        cache.cell = index.cellAt(p[0], p[2]);
        cache.cellVersion = index.cellVersion[cache.cell];
      }
      fx = cache.fx;
    } else {
      fx = this.obstacleEffect(p, excludeId, this.scratchFx);
    }
    const T = this.params.turbulence * fx.turbulence;
    const fluct = T > 0 ? 1 + T * 0.6 * this.turb(0, p, t) : 1;
    const speed = Math.max(0, free * fx.factor * fx.speedup * fluct);
    // Direction: free-stream gust wobble + turbulent veering
    const wobble = g.gustStrength * 0.12 * Math.sin(t * 0.7 + p[0] * 0.02 + p[2] * 0.017) + (T > 0 ? T * 0.7 * this.turb(1, p, t) : 0);
    const f = g.flow();
    const cs = Math.cos(wobble);
    const sn = Math.sin(wobble);
    v[0] = (f[0] * cs - f[2] * sn) * speed;
    v[1] = 0;
    v[2] = (f[0] * sn + f[2] * cs) * speed;
    out.speed = speed;
    out.freeStream = free;
    out.global = global;
    out.shelter = fx.factor * fx.speedup;
    out.turbulence = T;
    out.shadowSource = fx.source;
    out.corner = fx.corner;
    return out;
  }

  /** Speed only. */
  speedAt(p: Vec3, t: number, excludeId?: EntityId): number {
    return this.sample(p, t, excludeId).speed;
  }

  /** Velocity only (allocates; hot paths pass `out` to sample()). */
  velocityAt(p: Vec3, t: number, excludeId?: EntityId): Vec3 {
    return this.sample(p, t, excludeId).velocity;
  }
}
