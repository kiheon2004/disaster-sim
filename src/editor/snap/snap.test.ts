/** Phase 36 §13 snap engine: priority, tolerances, hysteresis, road lane / frontage headings, footprint edges, structural grid. */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, createWorldObject } from '@/world/WorldDocument';
import { drawRoad, segmentLine } from '@/roads/network';
import { defaultProfile, emptyNetwork } from '@/roads/types';
import { presetDesign } from '@/roads/city';
import type { Vec3 } from '@/core/types';
import { SNAP_HYSTERESIS, SNAP_TOLERANCE, footprintHalves, snapPoint, type SnapEnv } from './snapEngine';

const road = () => drawRoad(emptyNetwork(), [[-50, 0], [50, 0]], { curved: false, profile: defaultProfile() }).network;
const tf = (x: number, z: number, yawDeg = 0) => ({ position: [x, 0, z] as Vec3, rotation: [0, (yawDeg * Math.PI) / 180, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
const env = (over: Partial<SnapEnv> = {}): SnapEnv => ({ objects: [], roads: emptyNetwork(), grid: 1, ...over });

describe('snap engine', () => {
  it('grid when nothing else is near; free with the grid off', () => {
    expect(snapPoint({ x: 3.4, z: -7.6, yaw: 0, half: [1, 1], type: 'wall' }, env())).toMatchObject({ kind: 'grid', x: 3, z: -8 });
    expect(snapPoint({ x: 3.4, z: -7.6, yaw: 0, half: [1, 1], type: 'wall' }, env({ grid: 0 }))).toMatchObject({ kind: 'free', x: 3.4, z: -7.6 });
  });

  it('road node beats everything within 3 m', () => {
    const net = road();
    const t = snapPoint({ x: 48.2, z: 1.5, yaw: 0, half: [1, 1], type: 'streetLight' }, env({ roads: net }));
    expect(t.kind).toBe('roadNode');
    expect([t.x, t.z]).toEqual([50, 0]);
  });

  it('a car snaps to a lane centre with the lane heading; the opposite lane faces the other way', () => {
    const net = road();
    const half = footprintHalves('car', createWorldObject({ type: 'car', transform: tf(0, 0) }, 1).params);
    const right = snapPoint({ x: 10, z: 2.6, yaw: 0, half, type: 'car' }, env({ roads: net }));
    const left = snapPoint({ x: 10, z: -2.6, yaw: 0, half, type: 'car' }, env({ roads: net }));
    expect(right.kind).toBe('roadLane');
    expect(left.kind).toBe('roadLane');
    expect(Math.abs(right.z)).toBeCloseTo(1.75, 6); // 7 m street, two lanes: centres at ±1.75
    expect(Math.abs(Math.cos(right.yaw! - left.yaw!) + 1)).toBeLessThan(1e-9); // opposite directions
  });

  it('a building faces the road, 1 m behind the sidewalk', () => {
    const net = road();
    const seg = Object.values(net.segments)[0];
    void segmentLine(net, seg);
    const half: [number, number] = [5, 4];
    const t = snapPoint({ x: 0, z: 13.5, yaw: 0, half, type: 'building' }, env({ roads: net }));
    expect(t.kind).toBe('roadFront');
    const p = defaultProfile();
    expect(Math.abs(t.z)).toBeCloseTo(p.width / 2 + p.sidewalkWidth + 1 + half[1], 6);
  });

  it('footprint edges flush / touching a parallel neighbour (also turned by 90°)', () => {
    const n = createWorldObject({ type: 'wall', params: { length: 6, height: 2, thickness: 0.3 }, transform: tf(0, 0) }, 1);
    const half: [number, number] = [2, 0.15];
    // Touching on the right: neighbour half 3 + moving half 2 = 5.
    const t = snapPoint({ x: 5.5, z: 0.1, yaw: 0, half, type: 'wall' }, env({ objects: [n], grid: 0 }));
    expect(t.kind).toBe('objectEdge');
    expect(t.x).toBeCloseTo(5, 6);
    // Not parallel (30°): no edge snap.
    const t2 = snapPoint({ x: 5.5, z: 0.1, yaw: Math.PI / 6, half, type: 'wall' }, env({ objects: [n], grid: 0 }));
    expect(t2.kind).not.toBe('objectEdge');
  });

  it('a footprint edge on a column line of a modular neighbour', () => {
    const design = presetDesign('apartment', 3)!;
    const b = createWorldObject({ type: 'building', building: design, transform: tf(0, 0) }, 1);
    const spec = b.building!.spec;
    const nx = Math.round(spec.width / spec.bay);
    const line = -spec.width / 2 + spec.width / nx; // first interior column line
    const half: [number, number] = [2, 2];
    // Moving box just outside the neighbour's far side (v), its left edge near the column line.
    const z = spec.depth / 2 + 2 + 0.5; // next to the building's far side (0.5 m gap)
    const t = snapPoint({ x: line + 2 + 0.5, z, yaw: 0, half, type: 'wall' }, env({ objects: [b], grid: 0, disabled: new Set(['objectEdge', 'objectCenter']) }));
    expect(t.kind).toBe('structGrid');
    expect(t.x).toBeCloseTo(line + 2, 6);
  });

  it('hysteresis: the previous target keeps winning up to 1.6 × its tolerance', () => {
    const net = road();
    const q = (x: number) => ({ x, z: 0.5, yaw: 0, half: [1, 1] as [number, number], type: 'streetLight' as const });
    const first = snapPoint(q(47.5), env({ roads: net }));
    expect(first.kind).toBe('roadNode');
    const far = 50 - SNAP_TOLERANCE.roadNode * (SNAP_HYSTERESIS - 0.1);
    expect(snapPoint(q(far), env({ roads: net })).kind).not.toBe('roadNode'); // fresh: outside 3 m
    expect(snapPoint(q(far), env({ roads: net, prev: first })).kind).toBe('roadNode'); // held by hysteresis
  });

  it('a kind can be turned off', () => {
    const net = road();
    const t = snapPoint({ x: 48.2, z: 1.5, yaw: 0, half: [1, 1], type: 'streetLight' }, env({ roads: net, disabled: new Set(['roadNode']) }));
    expect(t.kind).toBe('grid');
  });

  it('an empty document has nothing to snap to but the grid', () => {
    const d = createEmptyDocument();
    expect(snapPoint({ x: 0.2, z: 0.2, yaw: 0, half: [1, 1], type: 'wall' }, env({ objects: Object.values(d.objects), roads: d.roads })).kind).toBe('grid');
  });
});

describe('frontage + neighbour', () => {
  it('a building on the road frontage also sits flush with its neighbour along the road', () => {
    const net = road();
    const half: [number, number] = [4, 3.5];
    const front = -(3.5 + 2 + 1 + 3.5);
    const n = createWorldObject({ type: 'wall', params: { length: 8, height: 3, thickness: 7 }, transform: tf(-30, front) }, 1);
    const t = snapPoint({ x: -21.5, z: front - 0.4, yaw: 0, half, type: 'building' }, env({ roads: net, objects: [n], grid: 0 }));
    expect(t.kind).toBe('roadFront');
    expect(t.z).toBeCloseTo(front, 6);
    expect(t.x).toBeCloseTo(-22, 6);
  });
});
