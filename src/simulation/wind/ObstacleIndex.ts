import type { WindModelSettings } from '@/core/model';
import { WORLD_HALF } from '@/core/units';
import type { WindObstacle } from './obstacles';

/** Cell size (m) of the flow-aligned grid. */
const CELL = 6;
/** Covers the world (any rotation) plus the longest wakes; points outside clamp to edge cells. */
const HALF = (WORLD_HALF + 120) * Math.SQRT2;
const N = Math.ceil((HALF * 2) / CELL);
/** Rasterization padding (m) that absorbs rounding differences between frames. */
const PAD = 0.05;

/**
 * Spatial index of wind obstacles, built in the FLOW frame (u = downwind, v = across).
 *
 * Each obstacle can only affect points inside its own footprint, the corner bands along its
 * sides, and a wake that widens linearly downwind. In the flow frame that region is a widening
 * strip, so it is rasterized row by row (instead of the axis-aligned bounding box of the whole
 * rotated rectangle). A query only tests obstacles whose region overlaps the point's cell.
 *
 * Every cell carries a version that is bumped whenever its obstacle list changes, so cached
 * per-point effects are only invalidated where the layout actually changed (e.g. a collapse).
 *
 * Lists are kept in ascending obstacle index, so effects are combined in exactly the same order
 * as a full scan (bit-identical results).
 */
export class ObstacleIndex {
  readonly cells: number[][] = Array.from({ length: N * N }, () => []);
  readonly cellVersion = new Uint32Array(N * N);
  /** Projected half-depth (along flow) / half-width (across flow) per obstacle. */
  extD = new Float64Array(0);
  extW = new Float64Array(0);
  /**
   * While the wind turns (less than the rebuild angle) queries use a slightly rotated frame;
   * `driftAngle` (rad) pads every region for that rotation so the index stays conservative.
   */
  private driftAngle = 0;
  /** Flow frame the index was built for. */
  private fx = 1;
  private fz = 0;
  private nx = 0;
  private nz = 1;

  constructor(private params: WindModelSettings) {}

  /** Full rebuild for a flow direction (flow = horizontal unit vector [x, 0, z]). */
  rebuild(obstacles: readonly WindObstacle[], flow: readonly number[], params: WindModelSettings) {
    this.params = params;
    this.driftAngle = 0;
    this.fx = flow[0];
    this.fz = flow[2];
    this.nx = -flow[2];
    this.nz = flow[0];
    for (let c = 0; c < this.cells.length; c++) {
      if (this.cells[c].length) {
        this.cells[c].length = 0;
        this.cellVersion[c]++;
      }
    }
    this.extD = new Float64Array(obstacles.length);
    this.extW = new Float64Array(obstacles.length);
    for (let i = 0; i < obstacles.length; i++) {
      this.computeExtents(obstacles[i], i);
      if (obstacles[i].active) this.insert(obstacles[i], i);
    }
  }

  /**
   * Re-rasterize in the SAME frame with regions padded for a rotation of up to `angle` rad.
   * Lists only grow (superset), cells keep their meaning, so cached effects stay valid.
   */
  padForDrift(obstacles: readonly WindObstacle[], angle: number) {
    if (angle <= this.driftAngle) return;
    this.driftAngle = angle;
    for (const list of this.cells) list.length = 0;
    for (let i = 0; i < obstacles.length; i++) if (obstacles[i].active) this.forEachCell(obstacles[i], i, (c) => this.cells[c].push(i));
  }

  get drifting() {
    return this.driftAngle > 0;
  }

  /** Append obstacle `idx` (must be the highest index so far). */
  add(o: WindObstacle, idx: number) {
    if (idx >= this.extD.length) {
      const d = new Float64Array(idx + 1);
      const w = new Float64Array(idx + 1);
      d.set(this.extD);
      w.set(this.extW);
      this.extD = d;
      this.extW = w;
    }
    this.computeExtents(o, idx);
    if (o.active) this.insert(o, idx);
  }

  /** Remove obstacle `idx` from every cell it was rasterized into. */
  remove(o: WindObstacle, idx: number) {
    this.forEachCell(o, idx, (c) => {
      const list = this.cells[c];
      const k = list.indexOf(idx);
      if (k >= 0) {
        list.splice(k, 1);
        this.cellVersion[c]++;
      }
    });
  }

  /** Obstacle `idx` moved/resized: `before` is its previous geometry. */
  update(before: WindObstacle, after: WindObstacle, idx: number) {
    this.remove(before, idx);
    this.computeExtents(after, idx);
    if (after.active) this.insert(after, idx);
  }

  cellAt(x: number, z: number): number {
    const u = x * this.fx + z * this.fz;
    const v = x * this.nx + z * this.nz;
    return cellOf(v) * N + cellOf(u);
  }

  private computeExtents(o: WindObstacle, idx: number) {
    const fx = this.fx, fz = this.fz, nx = this.nx, nz = this.nz;
    this.extD[idx] = o.hx * Math.abs(o.ax[0] * fx + o.ax[1] * fz) + o.hz * Math.abs(o.az[0] * fx + o.az[1] * fz);
    this.extW[idx] = o.hx * Math.abs(o.ax[0] * nx + o.ax[1] * nz) + o.hz * Math.abs(o.az[0] * nx + o.az[1] * nz);
  }

  private insert(o: WindObstacle, idx: number) {
    this.forEachCell(o, idx, (c) => {
      const list = this.cells[c];
      // Keep ascending order (usually idx is the largest → plain push).
      let k = list.length;
      while (k > 0 && list[k - 1] > idx) k--;
      if (list[k - 1] === idx) return;
      list.splice(k, 0, idx);
      this.cellVersion[c]++;
    });
  }

  /**
   * Cells overlapping the region where obstacle `idx` can change the wind (same conditions as
   * SpatialWindField.obstacleEffect: inside volume, corner bands, widening wake), padded.
   */
  private forEachCell(o: WindObstacle, idx: number, fn: (cell: number) => void) {
    const p = this.params;
    const D = this.extD[idx];
    const W = this.extW[idx];
    const H = o.height;
    const L = p.wakeLength * H;
    const band = 0.5 * H;
    const uc = o.cx * this.fx + o.cz * this.fz;
    const vc = o.cx * this.nx + o.cz * this.nz;
    // Rotation allowance: a point at distance r from the center moves by at most r·angle.
    const reach = Math.hypot(D + Math.max(L, band), 1.15 * (W + p.wakeSpread * L) + band);
    const pad = PAD + this.driftAngle * reach;
    const aMin = -D - pad;
    const aMax = D + Math.max(L, band) + pad;
    const i0 = cellOf(uc + aMin);
    const i1 = cellOf(uc + aMax);
    for (let i = i0; i <= i1; i++) {
      // Along-flow interval of this row relative to the obstacle (edge rows extend to infinity),
      // widened by the rotation allowance so neighbouring rows' regions are included.
      const lo = Math.max(aMin, (i === 0 ? -Infinity : -HALF + i * CELL - uc) - (pad - PAD));
      const hi = Math.min(aMax, (i === N - 1 ? Infinity : -HALF + (i + 1) * CELL - uc) + (pad - PAD));
      if (hi < lo) continue;
      let hw = 0;
      if (lo < D + band) hw = W + band; // footprint + corner bands
      if (hi > D) {
        const d = Math.min(hi, D + L) - D;
        hw = Math.max(hw, 1.15 * (W + p.wakeSpread * Math.max(0, d)));
      }
      hw += pad;
      const j0 = cellOf(vc - hw);
      const j1 = cellOf(vc + hw);
      for (let j = j0; j <= j1; j++) fn(j * N + i);
    }
  }
}

function cellOf(v: number): number {
  const c = Math.floor((v + HALF) / CELL);
  return c < 0 ? 0 : c >= N ? N - 1 : c;
}
