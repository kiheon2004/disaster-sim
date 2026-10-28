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
 */
import type { EntityId, Vec3 } from '@/core/types';
import type { WindModelSettings } from '@/core/model';
import { DEFAULT_WIND_MODEL } from '@/core/model';
import { clamp, smoothstep } from '@/core/math';
import { Rng } from '@/core/random';
import { WORLD_HALF } from '@/core/units';
import type { WindField } from '../environment/WindField';
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

const CELL = 10; // m
const GRID_HALF = WORLD_HALF + 120;
const GRID_N = Math.ceil((GRID_HALF * 2) / CELL);
const INSIDE_FACTOR = 0.3;
const MIN_SHELTER = 0.15;
const REBUILD_ANGLE = 1.5; // deg

interface Effect {
  factor: number;
  speedup: number;
  turbulence: number;
  source: EntityId | null;
  corner: boolean;
}

export class SpatialWindField {
  private obstacles: WindObstacle[] = [];
  private grid: Int32Array[] = [];
  private gridBearing = NaN;
  private dirty = true;
  /** Seeded phases/frequencies for the turbulence noise. */
  private noise: { k: number; w: number; ph: number }[][];

  constructor(
    readonly global: WindField,
    public params: WindModelSettings = DEFAULT_WIND_MODEL,
    seed = 1,
  ) {
    const rng = new Rng(seed).fork('turbulence');
    this.noise = [0, 1, 2].map(() =>
      Array.from({ length: 3 }, (_, i) => ({ k: rng.range(0.05, 0.25) * (i + 1), w: rng.range(0.8, 3.5) * (i + 1), ph: rng.range(0, Math.PI * 2) })),
    );
  }

  setObstacles(list: WindObstacle[]) {
    this.obstacles = list;
    this.dirty = true;
  }

  removeObstacle(id: EntityId) {
    const o = this.obstacles.find((x) => x.id === id);
    if (o && o.active) {
      o.active = false;
      this.dirty = true;
    }
  }

  getObstacles(): readonly WindObstacle[] {
    return this.obstacles;
  }

  // ── Spatial acceleration grid ────────────────────────────────────────────

  private ensureGrid() {
    const bearing = this.global.fromBearing;
    const turned = Math.abs(((bearing - this.gridBearing + 540) % 360) - 180) > REBUILD_ANGLE;
    if (!this.dirty && !turned) return;
    this.dirty = false;
    this.gridBearing = bearing;
    const lists: number[][] = Array.from({ length: GRID_N * GRID_N }, () => []);
    const f = this.global.flow();
    const n: [number, number] = [-f[2], f[0]];
    const p = this.params;
    this.obstacles.forEach((o, idx) => {
      if (!o.active) return;
      const { D, W } = this.extents(o, f, n);
      const H = o.height;
      const L = p.wakeLength * H;
      const front = -D - 0.7 * H;
      const back = D + L;
      const side = W + p.wakeSpread * L + 0.7 * H;
      // AABB of the influence rectangle in world space
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const a of [front, back]) {
        for (const c of [-side, side]) {
          const x = o.cx + f[0] * a + n[0] * c;
          const z = o.cz + f[2] * a + n[1] * c;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
        }
      }
      const i0 = this.cellIndex(minX), i1 = this.cellIndex(maxX);
      const j0 = this.cellIndex(minZ), j1 = this.cellIndex(maxZ);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) lists[j * GRID_N + i].push(idx);
    });
    this.grid = lists.map((l) => Int32Array.from(l));
  }

  private cellIndex(v: number) {
    return clamp(Math.floor((v + GRID_HALF) / CELL), 0, GRID_N - 1);
  }

  /** Projected half-depth (along flow) and half-width (across flow) of an obstacle. */
  private extents(o: WindObstacle, f: Vec3, n: [number, number]) {
    const D = o.hx * Math.abs(o.ax[0] * f[0] + o.ax[1] * f[2]) + o.hz * Math.abs(o.az[0] * f[0] + o.az[1] * f[2]);
    const W = o.hx * Math.abs(o.ax[0] * n[0] + o.ax[1] * n[1]) + o.hz * Math.abs(o.az[0] * n[0] + o.az[1] * n[1]);
    return { D, W };
  }

  // ── Obstacle effects ─────────────────────────────────────────────────────

  /** Combined effect of all nearby obstacles at point p. */
  obstacleEffect(p: Vec3, excludeId?: EntityId): Effect {
    const out: Effect = { factor: 1, speedup: 1, turbulence: 0, source: null, corner: false };
    if (!this.params.shelterEnabled || this.obstacles.length === 0) return out;
    this.ensureGrid();
    const cell = this.grid[this.cellIndex(p[2]) * GRID_N + this.cellIndex(p[0])];
    if (!cell || cell.length === 0) return out;

    const f = this.global.flow();
    const n: [number, number] = [-f[2], f[0]];
    const prm = this.params;
    let minFactor = 1;
    let maxCorner = 0;

    for (let k = 0; k < cell.length; k++) {
      const o = this.obstacles[cell[k]];
      if (!o.active || o.id === excludeId) continue;
      const H = o.height;
      const rx = p[0] - o.cx;
      const rz = p[2] - o.cz;
      const a = rx * f[0] + rz * f[2]; // along flow (+ = downstream)
      const c = Math.abs(rx * n[0] + rz * n[1]); // across flow
      const { D, W } = this.extents(o, f, n);
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
    let v = 0;
    for (const o of this.noise[channel]) v += Math.sin(s * o.k + q * o.k * 0.8 + t * o.w + o.ph);
    return v / 3;
  }

  // ── Sampling ─────────────────────────────────────────────────────────────

  /** Full local-wind description at point p. `excludeId` skips the object's own wake. */
  sample(p: Vec3, t: number, excludeId?: EntityId): LocalWind {
    const g = this.global;
    const global = g.baseSpeed;
    if (global <= 0.01) {
      return { velocity: [0, 0, 0], speed: 0, freeStream: 0, global: 0, shelter: 1, turbulence: 0, shadowSource: null, corner: false };
    }
    const free = g.speedAt(p, t);
    const fx = this.obstacleEffect(p, excludeId);
    const T = this.params.turbulence * fx.turbulence;
    const fluct = T > 0 ? 1 + T * 0.6 * this.turb(0, p, t) : 1;
    const speed = Math.max(0, free * fx.factor * fx.speedup * fluct);
    // Direction: free-stream gust wobble + turbulent veering
    const wobble = g.gustStrength * 0.12 * Math.sin(t * 0.7 + p[0] * 0.02 + p[2] * 0.017) + (T > 0 ? T * 0.7 * this.turb(1, p, t) : 0);
    const f = g.flow();
    const cs = Math.cos(wobble);
    const sn = Math.sin(wobble);
    return {
      velocity: [(f[0] * cs - f[2] * sn) * speed, 0, (f[0] * sn + f[2] * cs) * speed],
      speed,
      freeStream: free,
      global,
      shelter: fx.factor * fx.speedup,
      turbulence: T,
      shadowSource: fx.source,
      corner: fx.corner,
    };
  }

  /** Speed only (hot path for building components). */
  speedAt(p: Vec3, t: number, excludeId?: EntityId): number {
    return this.sample(p, t, excludeId).speed;
  }

  /** Velocity only. */
  velocityAt(p: Vec3, t: number, excludeId?: EntityId): Vec3 {
    return this.sample(p, t, excludeId).velocity;
  }
}
