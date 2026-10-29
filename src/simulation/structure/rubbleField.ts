/**
 * Rubble on the ground of the scene (Phase 25): the piles collapsed buildings leave (computed by
 * each building's collapse model, rubble.ts geometry) and fragments aggregated over the active-body
 * budget. Mass is exact; the shape is the approximate mound at the angle of repose.
 *
 * World frame. Each heap is a rectangle (centre, half extents, yaw) with its mound height; height
 * queries (road blockage, burial, rendering) go through a coarse bucket grid.
 */
import type { EntityId } from '@/core/types';
import type { BodyHandle } from '@/physics/PhysicsEngine';
import { moundHeight, moundReach, moundHeightAt } from '@/structure/rubble';

export interface RubbleHeap {
  id: number;
  /** Building it came from (null: aggregated fragments of several). */
  owner: EntityId | null;
  /** Pile index inside the owner's model (−1: aggregated fragments). */
  pile: number;
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  /** Rotation about +y (rad) of the footprint rectangle. */
  yaw: number;
  /** Ground level under the heap (world y). */
  y: number;
  mass: number;
  /** Bulk volume (m³) and mound height (m). */
  volume: number;
  height: number;
  /** Primary hazard of what built it (first contributor). */
  hazard: string;
  /** Fixed collider of the heap's core (null when below the collider height). */
  body: BodyHandle | null;
  /** Height the collider was built for. */
  bodyHeight: number;
  /** Bumped when it changes (renderers, effects). */
  rev: number;
}

const BUCKET = 8;
/** Cell of the aggregated-heap lookup (m). */
const AGG_CELL = 4;
/** An aggregated heap takes a fragment landing within this distance of its footprint (m). */
const AGG_MARGIN = 0.5;
const cellKey = (bx: number, bz: number) => bx * 100003 + bz;

/** Insert k into an ascending list once (lists stay in heap order, as a full scan would visit them). */
function insertSorted(list: number[], k: number) {
  let lo = 0, hi = list.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (list[m] < k) lo = m + 1; else hi = m; }
  if (list[lo] !== k) list.splice(lo, 0, k);
}

/**
 * Heaps are only appended (id = index) and changed in place through this class, so every lookup is
 * indexed instead of scanned — a 1000-house blast aggregates thousands of facade pieces, and a scan
 * per piece (plus a full re-index per change) grew with the square of the heap count:
 *   - piles by (owner, pile);
 *   - aggregated heaps by a 4 m grid over their footprint + margin (they only ever grow);
 *   - height queries by an 8 m grid over each heap's reach, updated for the changed heap only.
 * Lookups return exactly what a scan in heap order returns (first match, same visiting order).
 */
export class RubbleField {
  readonly heaps: RubbleHeap[] = [];
  /** Bumped on any change. */
  rev = 0;
  private buckets = new Map<number, number[]>();
  private piles = new Map<string, RubbleHeap>();
  private aggregated = new Map<number, number[]>();

  /** Add a heap or grow an existing one (same owner + pile). Returns it. */
  upsert(h: Omit<RubbleHeap, 'id' | 'body' | 'bodyHeight' | 'rev' | 'height'>): RubbleHeap {
    const key = h.pile >= 0 ? `${h.owner}|${h.pile}` : null;
    let heap = key !== null ? this.piles.get(key) : undefined;
    if (!heap) {
      heap = { ...h, id: this.heaps.length, body: null, bodyHeight: 0, rev: 0, height: 0 };
      this.heaps.push(heap);
      if (key !== null) this.piles.set(key, heap);
    } else Object.assign(heap, h);
    heap.height = moundHeight(2 * heap.hx, 2 * heap.hz, heap.volume);
    heap.rev++;
    this.rev++;
    this.changed(heap);
    return heap;
  }

  /** Index a new or changed heap (its old cells stay listed — a heap that no longer reaches a point adds nothing there). */
  private changed(h: RubbleHeap) {
    const r = this.reach(h);
    for (let bx = Math.floor((h.cx - r) / BUCKET); bx <= Math.floor((h.cx + r) / BUCKET); bx++)
      for (let bz = Math.floor((h.cz - r) / BUCKET); bz <= Math.floor((h.cz + r) / BUCKET); bz++) {
        const key = cellKey(bx, bz);
        insertSorted(this.buckets.get(key) ?? this.buckets.set(key, []).get(key)!, h.id);
      }
    if (h.pile >= 0) return;
    const ex = h.hx + AGG_MARGIN + 1e-6, ez = h.hz + AGG_MARGIN + 1e-6; // (cover rounding at cell edges; the test below is exact)
    for (let bx = Math.floor((h.cx - ex) / AGG_CELL); bx <= Math.floor((h.cx + ex) / AGG_CELL); bx++)
      for (let bz = Math.floor((h.cz - ez) / AGG_CELL); bz <= Math.floor((h.cz + ez) / AGG_CELL); bz++) {
        const key = cellKey(bx, bz);
        insertSorted(this.aggregated.get(key) ?? this.aggregated.set(key, []).get(key)!, h.id);
      }
  }

  /**
   * Aggregate a fragment (no physics body) at a ground point: a small square heap of its own
   * footprint, merged with an aggregated heap already covering the point.
   */
  addPoint(x: number, z: number, y: number, size: number, mass: number, volume: number, hazard: string): RubbleHeap {
    // The first aggregated heap (in heap order) whose footprint + margin covers the point.
    let near: RubbleHeap | undefined;
    for (const k of this.aggregated.get(cellKey(Math.floor(x / AGG_CELL), Math.floor(z / AGG_CELL))) ?? []) {
      const h = this.heaps[k];
      if (Math.abs(h.cx - x) <= h.hx + AGG_MARGIN && Math.abs(h.cz - z) <= h.hz + AGG_MARGIN) { near = h; break; }
    }
    if (near) {
      const x0 = Math.min(near.cx - near.hx, x - size / 2), x1 = Math.max(near.cx + near.hx, x + size / 2);
      const z0 = Math.min(near.cz - near.hz, z - size / 2), z1 = Math.max(near.cz + near.hz, z + size / 2);
      near.cx = (x0 + x1) / 2; near.cz = (z0 + z1) / 2; near.hx = (x1 - x0) / 2; near.hz = (z1 - z0) / 2;
      near.mass += mass;
      near.volume += volume;
      near.height = moundHeight(2 * near.hx, 2 * near.hz, near.volume);
      near.rev++;
      this.rev++;
      this.changed(near);
      return near;
    }
    const h = Math.max(0.25, size / 2);
    return this.upsert({ owner: null, pile: -1, cx: x, cz: z, hx: h, hz: h, yaw: 0, y, mass, volume, hazard });
  }

  /** Horizontal reach of a heap (footprint half diagonal + slopes). */
  reach(h: RubbleHeap): number {
    return Math.hypot(h.hx, h.hz) + moundReach(h.height);
  }

  /** Rubble thickness above the ground at a world point (m; max over heaps). */
  heightAt(x: number, z: number): { height: number; heap: RubbleHeap | null } {
    const list = this.buckets.get(cellKey(Math.floor(x / BUCKET), Math.floor(z / BUCKET)));
    let best = 0, heap: RubbleHeap | null = null;
    if (!list) return { height: 0, heap: null };
    for (const k of list) {
      const h = this.heaps[k];
      const c = Math.cos(h.yaw), s = Math.sin(h.yaw);
      const dx = x - h.cx, dz = z - h.cz;
      // World → heap frame (yaw about +y: local x = ( c, −s), local z = (s, c)).
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      const ox = Math.max(0, Math.abs(lx) - h.hx), oz = Math.max(0, Math.abs(lz) - h.hz);
      const d = ox > 0 && oz > 0 ? Math.hypot(ox, oz) : Math.max(ox, oz);
      const v = moundHeightAt(h.height, d);
      if (v > best) { best = v; heap = h; }
    }
    return { height: best, heap };
  }

  totalMass(): number {
    let m = 0;
    for (const h of this.heaps) m += h.mass;
    return m;
  }
}
