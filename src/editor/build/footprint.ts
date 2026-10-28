/**
 * 2D footprints for placement checks (Phase 16): every object is an oriented rectangle on the
 * ground plane (x/z). Used by collision avoidance (brush / line / area / paste) and the
 * collision warning of the place tool. No Three.js, no React.
 */
import type { ObjectType, Vec3 } from '@/core/types';
import type { ObjectParams, WorldObject } from '@/core/model';
import { getDefinition } from '@/objects/registry';
import { yawOf } from '@/terrain/groundPlacement';

export interface Footprint {
  x: number;
  z: number;
  /** Half extents along the object's local x / z (m). */
  hx: number;
  hz: number;
  yaw: number;
}

/**
 * Footprint that counts for "these two objects overlap". Tree crowns may interlock (a forest),
 * so trees use about half their crown; ground-layer objects (roads) never collide — things
 * stand on them.
 */
export function collisionFootprint(type: ObjectType, params: ObjectParams, scale: Vec3, x: number, z: number, yaw: number): Footprint | null {
  const def = getDefinition(type);
  if (def.groundLayer) return null;
  const d = def.getDimensions(params);
  const k = type === 'tree' ? 0.45 : 1;
  return { x, z, hx: (d[0] * scale[0] * k) / 2, hz: (d[2] * scale[2] * k) / 2, yaw };
}

export function footprintOf(obj: Pick<WorldObject, 'type' | 'params' | 'transform'>): Footprint | null {
  const t = obj.transform;
  return collisionFootprint(obj.type, obj.params, t.scale, t.position[0], t.position[2], yawOf(t.rotation));
}

/** Radius of the circle that contains the footprint. */
export function boundRadius(f: Footprint): number {
  return Math.hypot(f.hx, f.hz);
}

/** Separating-axis test of two oriented rectangles (touching edges do not count). */
export function footprintsOverlap(a: Footprint, b: Footprint, margin = 0): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const r = boundRadius(a) + boundRadius(b) + margin;
  if (dx * dx + dz * dz >= r * r) return false;
  // Axes: local x of a, local z of a, local x of b, local z of b. Local x = (cos, −sin).
  const axes = [a.yaw, a.yaw + Math.PI / 2, b.yaw, b.yaw + Math.PI / 2];
  for (const yaw of axes) {
    const ax = Math.cos(yaw);
    const az = -Math.sin(yaw);
    const ra = projHalf(a, ax, az) + margin / 2;
    const rb = projHalf(b, ax, az) + margin / 2;
    if (Math.abs(dx * ax + dz * az) >= ra + rb - 1e-9) return false;
  }
  return true;
}

function projHalf(f: Footprint, ax: number, az: number): number {
  const c = Math.cos(f.yaw);
  const s = Math.sin(f.yaw);
  // Local x axis (c, −s), local z axis (s, c).
  return f.hx * Math.abs(c * ax - s * az) + f.hz * Math.abs(s * ax + c * az);
}

/**
 * Uniform grid over footprints for fast overlap queries. Insertion order is kept, so results
 * are deterministic.
 */
export class FootprintIndex {
  private cells = new Map<number, number[]>();
  readonly items: { f: Footprint; key: string }[] = [];

  constructor(private cell = 8) {}

  private cellKey(ix: number, iz: number) {
    return (ix + 4096) * 8192 + (iz + 4096);
  }

  add(f: Footprint, key = '') {
    const i = this.items.length;
    this.items.push({ f, key });
    const r = boundRadius(f);
    const x0 = Math.floor((f.x - r) / this.cell);
    const x1 = Math.floor((f.x + r) / this.cell);
    const z0 = Math.floor((f.z - r) / this.cell);
    const z1 = Math.floor((f.z + r) / this.cell);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const k = this.cellKey(ix, iz);
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(i);
      }
    }
  }

  /** Keys of the footprints overlapping `f` (each once, in insertion order). */
  query(f: Footprint, margin = 0): string[] {
    const r = boundRadius(f) + margin;
    const x0 = Math.floor((f.x - r) / this.cell);
    const x1 = Math.floor((f.x + r) / this.cell);
    const z0 = Math.floor((f.z - r) / this.cell);
    const z1 = Math.floor((f.z + r) / this.cell);
    const seen = new Set<number>();
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const list = this.cells.get(this.cellKey(ix, iz));
        if (list) for (const i of list) seen.add(i);
      }
    }
    return [...seen].sort((a, b) => a - b).filter((i) => footprintsOverlap(this.items[i].f, f, margin)).map((i) => this.items[i].key);
  }

  overlaps(f: Footprint, margin = 0): boolean {
    return this.query(f, margin).length > 0;
  }

  static fromObjects(objects: Iterable<Pick<WorldObject, 'id' | 'type' | 'params' | 'transform'>>, exclude?: ReadonlySet<string>): FootprintIndex {
    const idx = new FootprintIndex();
    for (const o of objects) {
      if (exclude?.has(o.id)) continue;
      const f = footprintOf(o);
      if (f) idx.add(f, o.id);
    }
    return idx;
  }
}
