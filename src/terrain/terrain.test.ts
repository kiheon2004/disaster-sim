import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Vec3 } from '@/core/types';
import type { TerrainData } from '@/core/model';
import { qRotate, quatFromEuler, radToDeg } from '@/core/math';
import { createEmptyDocument, createWorldObject, SCHEMA_VERSION } from '@/world/WorldDocument';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { useWorldStore } from '@/world/worldStore';
import { createFlatTerrain, quantizeHeight } from './TerrainData';
import { TerrainSampler } from './TerrainSampler';
import { applyDab } from './TerrainEditor';
import { generateTerrain, TERRAIN_PRESETS } from './TerrainPresets';
import { decodeTerrain, encodeTerrain } from './terrainCodec';
import { foundationPlinth, groundPose, isGrounded, reseat } from './groundPlacement';

/** 21 × 21 m test grid centered on the origin (1 m cells) filled from f(x, z). */
function grid(f: (x: number, z: number) => number, size = 20): TerrainData {
  const t = createFlatTerrain(size, 1);
  for (let iz = 0; iz < t.nz; iz++) for (let ix = 0; ix < t.nx; ix++) t.heights[iz * t.nx + ix] = quantizeHeight(f(t.originX + ix, t.originZ + iz));
  t.revision++;
  return t;
}

describe('terrain sampling', () => {
  it('height: exact at vertices, linear on a plane, 0 outside the grid', () => {
    const s = new TerrainSampler(grid((x, z) => 0.5 * x + 0.25 * z + 3));
    expect(s.sampleHeight(2, -3)).toBeCloseTo(0.5 * 2 + 0.25 * -3 + 3, 5);
    expect(s.sampleHeight(1.37, 4.81)).toBeCloseTo(0.5 * 1.37 + 0.25 * 4.81 + 3, 5);
    expect(s.sampleHeight(-7.5, 7.9)).toBeCloseTo(0.5 * -7.5 + 0.25 * 7.9 + 3, 5);
    expect(s.sampleHeight(50, 0)).toBe(0);
    expect(s.heightAboveGround([1, 10, 1])).toBeCloseTo(10 - (0.5 + 0.25 + 3), 5);
  });

  it('flat terrain short-circuits to 0', () => {
    const s = new TerrainSampler(createFlatTerrain());
    expect(s.flat).toBe(true);
    expect(s.sampleHeight(12.3, -45.6)).toBe(0);
    expect(s.sampleNormal(1, 1)).toEqual([-0, 1, -0]);
    expect(s.sampleSlope(1, 1)).toBe(0);
  });

  it('normal and slope of a tilted plane', () => {
    const s = new TerrainSampler(grid((x) => 0.5 * x));
    const n = s.sampleNormal(3.3, -2.2, [0, 0, 0]);
    const k = 1 / Math.hypot(0.5, 1);
    expect(n[0]).toBeCloseTo(-0.5 * k, 6);
    expect(n[1]).toBeCloseTo(k, 6);
    expect(n[2]).toBeCloseTo(0, 6);
    expect(s.sampleSlope(3.3, -2.2)).toBeCloseTo(radToDeg(Math.atan(0.5)), 4);
    // Both triangles of a cell agree on a plane.
    expect(s.sampleSlope(3.9, -2.9)).toBeCloseTo(s.sampleSlope(3.1, -2.1), 6);
  });

  it('ground type of the nearest vertex', () => {
    const t = createFlatTerrain(20, 1);
    t.ground[(10 + 2) * t.nx + (10 + 3)] = 4; // vertex at x = 3, z = 2
    const s = new TerrainSampler(t);
    expect(s.sampleGroundType(3.2, 1.8)).toBe(4);
    expect(s.sampleGroundType(3.6, 1.8)).toBe(0);
    expect(s.sampleGround(3, 2).key).toBe('concrete');
  });

  it('raycast hits the surface', () => {
    const s = new TerrainSampler(grid((x, z) => 4 + Math.sin(x * 0.3) * 2 + z * 0.1));
    const out: Vec3 = [0, 0, 0];
    const dir: Vec3 = [0.3, -1, 0.2];
    const l = Math.hypot(...dir);
    expect(s.raycast([-2, 30, -1], [dir[0] / l, dir[1] / l, dir[2] / l], 200, out)).toBe(true);
    expect(out[1]).toBeCloseTo(s.sampleHeight(out[0], out[2]), 3);
  });
});

describe('terrain editing', () => {
  const dab = (t: TerrainData, op: 'raise' | 'lower' | 'flatten' | 'smooth' | 'paint', extra = {}) =>
    applyDab(t, { op, x: 0, z: 0, brush: { radius: 5, strength: 1 }, dt: 0.1, ...extra });

  it('raise / lower with a falloff (center most, rim untouched)', () => {
    const t = createFlatTerrain(20, 1);
    const s = new TerrainSampler(t);
    expect(dab(t, 'raise')).not.toBeNull();
    s.sync();
    const center = s.sampleHeight(0, 0);
    expect(center).toBeCloseTo(0.8, 2); // 8 m/s × 0.1 s × falloff 1
    expect(s.sampleHeight(3, 0)).toBeGreaterThan(0);
    expect(s.sampleHeight(3, 0)).toBeLessThan(center);
    expect(s.sampleHeight(6, 0)).toBe(0);
    dab(t, 'lower');
    s.sync();
    expect(s.sampleHeight(0, 0)).toBeCloseTo(0, 6);
    expect(t.revision).toBeGreaterThan(0);
  });

  it('flatten pulls toward the target height', () => {
    const t = grid((x) => x * 0.5);
    for (let i = 0; i < 30; i++) dab(t, 'flatten', { targetHeight: 1 });
    const s = new TerrainSampler(t);
    expect(s.sampleHeight(0, 0)).toBeCloseTo(1, 1);
    expect(s.sampleHeight(1, 0)).toBeCloseTo(1, 1);
  });

  it('smooth reduces roughness and is order independent', () => {
    const t = grid((x, z) => ((x + z) % 2 === 0 ? 1 : -1));
    const rough = (tt: TerrainData) => {
      let r = 0;
      for (let i = 1; i < tt.nx; i++) r += Math.abs(tt.heights[10 * tt.nx + i] - tt.heights[10 * tt.nx + i - 1]);
      return r;
    };
    const before = rough(t);
    dab(t, 'smooth');
    expect(rough(t)).toBeLessThan(before * 0.8);
    // Mirrored input → mirrored output (visit order does not leak into the result).
    const a = grid((x, z) => Math.sin(x) + z * 0.1);
    const b = grid((x, z) => Math.sin(-x) + z * 0.1);
    dab(a, 'smooth');
    dab(b, 'smooth');
    expect(new TerrainSampler(a).sampleHeight(2, 1)).toBeCloseTo(new TerrainSampler(b).sampleHeight(-2, 1), 5);
  });

  it('paint sets the ground type inside the brush', () => {
    const t = createFlatTerrain(20, 1);
    dab(t, 'paint', { groundType: 2 });
    const s = new TerrainSampler(t);
    expect(s.sampleGroundType(0, 0)).toBe(2);
    expect(s.sampleGroundType(2, 2)).toBe(2);
    expect(s.sampleGroundType(8, 8)).toBe(0);
    expect(s.flat).toBe(true); // heights untouched
  });

  it('edits stay inside the elevation limits and on the 1 cm quantum', () => {
    const t = createFlatTerrain(20, 1);
    for (let i = 0; i < 400; i++) dab(t, 'raise');
    expect(Math.max(...t.heights)).toBeLessThanOrEqual(80);
    // Every stored value is a 1 cm step (what the save format stores).
    for (const h of t.heights) expect(Math.fround(quantizeHeight(h))).toBe(h);
  });
});

describe('save / load', () => {
  it('terrain codec round-trips bit-exactly and compactly', () => {
    const t = generateTerrain('valley', 7);
    applyDab(t, { op: 'paint', x: 10, z: 5, brush: { radius: 12, strength: 1 }, dt: 0.1, groundType: 3 });
    const enc = encodeTerrain(t);
    const back = decodeTerrain(JSON.parse(JSON.stringify(enc)));
    expect(back.heights).toEqual(t.heights);
    expect(back.ground).toEqual(t.ground);
    expect(back.settings).toEqual(t.settings);
    // 40 401 vertices: raw float32 would be 161 KB (+ 40 KB ground).
    expect(JSON.stringify(enc).length).toBeLessThan(90_000);
    expect(encodeTerrain(createFlatTerrain())).toMatchObject({ elevation: null, ground: null });
  });

  it('document save → load keeps terrain and objects', () => {
    const doc = createEmptyDocument('t');
    doc.terrain = generateTerrain('gentleHills', 3);
    const o = createWorldObject({ type: 'tree', transform: { position: [1, 2, 3], rotation: [0, 1, 0], scale: [1, 1, 1] } }, 1);
    doc.objects[o.id] = o;
    const res = parseDocument(serializeDocument(doc));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(res.doc.terrain.heights).toEqual(doc.terrain.heights);
    expect(res.doc.terrain.settings).toEqual({ preset: 'gentleHills', seed: 3, waterLevel: null });
    expect(res.doc.objects[o.id].transform.position).toEqual([1, 2, 3]);
  });

  it('a Phase 0–11 (schema v1) project migrates to a flat terrain', () => {
    const v1 = {
      schemaVersion: 1,
      meta: { name: 'old', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      settings: { size: [200, 200], gravity: 9.81, airDensity: 1.225 },
      terrain: { kind: 'flat' },
      objects: {
        a: { id: 'a', type: 'car', name: '', serial: 1, seed: 5, transform: { position: [3, 0, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
          physics: { mass: 1000, friction: 0.7, restitution: 0.1, anchored: false, dragCoefficient: 0.9, windResistance: 45, durability: 70, breakThreshold: 1.8 }, params: {} },
      },
    };
    const res = parseDocument(JSON.stringify(v1));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.schemaVersion).toBe(SCHEMA_VERSION); // migrated to the current schema (v3 since Phase 13)
    expect(res.doc.terrain.kind).toBe('heightfield');
    expect(res.doc.terrain.nx).toBe(201);
    expect(new TerrainSampler(res.doc.terrain).flat).toBe(true);
    expect(res.doc.objects.a.transform.position).toEqual([3, 0, 4]);
    // …and saving it again stays small (flat terrain is not stored vertex by vertex).
    expect(serializeDocument(res.doc).length).toBeLessThan(4000);
  });
});

const sameBytes = (x: ArrayBufferView, y: ArrayBufferView) =>
  Buffer.from(x.buffer, x.byteOffset, x.byteLength).equals(Buffer.from(y.buffer, y.byteOffset, y.byteLength));

describe('presets', () => {
  afterEach(() => vi.restoreAllMocks());

  it('are deterministic per seed and never use Math.random', () => {
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random used');
    });
    for (const p of TERRAIN_PRESETS) {
      const a = generateTerrain(p, 42);
      const b = generateTerrain(p, 42);
      // Byte-level comparison: bit-exact and much faster than a deep equal of 40 401 values.
      expect(sameBytes(b.heights, a.heights)).toBe(true);
      expect(sameBytes(b.ground, a.ground)).toBe(true);
      if (p !== 'flat') expect(sameBytes(generateTerrain(p, 43).heights, a.heights)).toBe(false);
    }
    expect(spy).not.toHaveBeenCalled();
  }, 60_000);

  it('keep the town area buildable', () => {
    for (const p of TERRAIN_PRESETS) {
      const s = new TerrainSampler(generateTerrain(p, 1));
      let maxSlope = 0;
      for (let x = -50; x <= 50; x += 5) for (let z = -25; z <= 25; z += 5) maxSlope = Math.max(maxSlope, s.sampleSlope(x, z));
      expect(maxSlope).toBeLessThan(16);
    }
  });
});

describe('object placement on terrain', () => {
  const slope = new TerrainSampler(grid((x, z) => 0.3 * x + 0.1 * z + 2, 60));
  const obj = (type: 'building' | 'car' | 'human' | 'tree') =>
    createWorldObject({ type, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }, 1);
  const up = (rot: Vec3) => qRotate(quatFromEuler(rot), [0, 1, 0]);

  it('flat ground: exactly (x, 0, z) with yaw only', () => {
    const flat = new TerrainSampler(createFlatTerrain());
    expect(groundPose(obj('car'), 3, 4, 0.7, flat)).toEqual({ position: [3, 0, 4], rotation: [0, 0.7, 0] });
  });

  it('building stays level on its highest footprint point (plinth below, nothing buried); person level at its feet', () => {
    // Phase 13: previously the building sat on its LOWEST corner and the uphill side was buried.
    const b = obj('building');
    const p = groundPose(b, 1, 2, 0, slope);
    expect(p.rotation).toEqual([0, 0, 0]);
    expect(p.position[1]).toBeGreaterThan(slope.sampleHeight(1, 2));
    const w = Number(b.params.width);
    const d = Number(b.params.depth);
    const corners = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([sx, sz]) => slope.sampleHeight(1 + (sx * w) / 2, 2 + (sz * d) / 2));
    expect(p.position[1]).toBeCloseTo(Math.max(...corners), 4);
    const placed = { ...b, transform: { ...b.transform, position: p.position, rotation: p.rotation } };
    expect(foundationPlinth(placed, slope)).toBeCloseTo(Math.max(...corners) - Math.min(...corners), 3);
    const h = groundPose(obj('human'), 1, 2, 1.2, slope);
    expect(h.position[1]).toBeCloseTo(slope.sampleHeight(1, 2), 6);
    expect(up(h.rotation)[1]).toBeCloseTo(1, 9);
  });

  it('vehicle follows the ground plane; tree leans partly', () => {
    const n = slope.sampleNormal(0, 0, [0, 0, 0]);
    for (const yaw of [0, 0.8, 2.5]) {
      const c = groundPose(obj('car'), 0, 0, yaw, slope);
      const u = up(c.rotation);
      expect(u[0]).toBeCloseTo(n[0], 4);
      expect(u[1]).toBeCloseTo(n[1], 4);
      expect(u[2]).toBeCloseTo(n[2], 4);
      // Heading preserved: local +x projected on the ground still points along yaw.
      const fwd = qRotate(quatFromEuler(c.rotation), [1, 0, 0]);
      expect(Math.atan2(-fwd[2], fwd[0])).toBeCloseTo(yaw > Math.PI ? yaw - 2 * Math.PI : yaw, 4);
    }
    const tr = up(groundPose(obj('tree'), 0, 0, 0, slope).rotation);
    expect(tr[1]).toBeGreaterThan(n[1]);
    expect(tr[1]).toBeLessThan(1);
  });

  it('grounded detection', () => {
    const c = obj('human');
    c.transform.position = [0, slope.sampleHeight(0, 0), 0];
    expect(isGrounded(c, slope)).toBe(true);
    c.transform.position = [0, slope.sampleHeight(0, 0) + 2, 0];
    expect(isGrounded(c, slope)).toBe(false);
  });
});

describe('terrain undo / redo (world store)', () => {
  it('a stroke is one undo step; grounded objects follow and come back', () => {
    const store = useWorldStore.getState();
    store.newDocument();
    const id = store.addObject({ type: 'human', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } });
    const lifted = store.addObject({ type: 'human', transform: { position: [1, 5, 1], rotation: [0, 0, 0], scale: [1, 1, 1] } });
    const pastBefore = useWorldStore.getState().past.length;

    store.beginTerrainStroke();
    for (let i = 0; i < 10; i++) store.terrainDab({ op: 'raise', x: 0, z: 0, brush: { radius: 6, strength: 1 }, dt: 0.05 });
    store.endTerrainStroke();
    let s = useWorldStore.getState();
    expect(s.past.length).toBe(pastBefore + 1);
    const h = new TerrainSampler(s.doc.terrain).sampleHeight(0, 0);
    expect(h).toBeCloseTo(4, 1);
    expect(s.doc.objects[id].transform.position[1]).toBeCloseTo(h, 6);
    expect(s.doc.objects[lifted].transform.position[1]).toBe(5); // lifted on purpose: stays

    s.undo();
    s = useWorldStore.getState();
    expect(new TerrainSampler(s.doc.terrain).flat).toBe(true);
    expect(s.doc.objects[id].transform.position[1]).toBe(0);

    s.redo();
    s = useWorldStore.getState();
    expect(new TerrainSampler(s.doc.terrain).sampleHeight(0, 0)).toBeCloseTo(h, 6);
    expect(s.doc.objects[id].transform.position[1]).toBeCloseTo(h, 6);
  });

  it('grounded objects follow a preset applied over existing relief', () => {
    const store = useWorldStore.getState();
    store.newDocument();
    store.applyTerrainPreset('gentleHills', 1);
    const s1 = new TerrainSampler(useWorldStore.getState().doc.terrain);
    const id = store.addObject({ type: 'car', transform: { position: [20, s1.sampleHeight(20, 30), 30], rotation: [0, 0.5, 0], scale: [1, 1, 1] } });
    const pose = reseat(useWorldStore.getState().doc.objects[id], s1);
    store.updateTransform(id, { position: pose.position, rotation: pose.rotation });
    store.applyTerrainPreset('valley', 2);
    const st = useWorldStore.getState();
    expect(isGrounded(st.doc.objects[id], new TerrainSampler(st.doc.terrain))).toBe(true);
  });

  it('presets are undoable too', () => {
    const store = useWorldStore.getState();
    store.newDocument();
    store.applyTerrainPreset('coastal', 9);
    let s = useWorldStore.getState();
    expect(s.doc.terrain.settings).toEqual({ preset: 'coastal', seed: 9, waterLevel: 0 });
    expect(s.doc.terrain.heights).toEqual(generateTerrain('coastal', 9).heights);
    s.undo();
    s = useWorldStore.getState();
    expect(new TerrainSampler(s.doc.terrain).flat).toBe(true);
    expect(s.doc.terrain.settings.preset).toBe('flat');
  });
});
