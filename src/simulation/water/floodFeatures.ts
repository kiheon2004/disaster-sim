/**
 * What the water grid needs from the world (Phase 14): solid footprints that block the flow and
 * road surfaces (paved: low infiltration, storm drains, smooth).
 *
 *  - buildings: their footprint (collapsed buildings are removed from the grid later)
 *  - walls ≥ 0.2 m thick (masonry): a 1 m wide line of blocked cells (thin walls would leak
 *    between cell centers); thinner walls are fences and let water through
 *  - roads: their full width
 */
import { qRotate } from '@/core/math';
import type { RuntimeEntity, SimulationRuntime } from '../SimulationRuntime';
import type { Footprint } from './WaterField';

export const MIN_BLOCKING_WALL = 0.2;

function yawOf(e: RuntimeEntity): number {
  const v = qRotate(e.initialPose.quaternion, [1, 0, 0]);
  return Math.atan2(-v[2], v[0]);
}

function footprint(e: RuntimeEntity, hx: number, hz: number): Footprint {
  const p = e.initialPose.position;
  return { id: e.id, center: [p[0], p[2]], half: [hx, hz], yaw: yawOf(e) };
}

export function floodFeatures(rt: SimulationRuntime): { obstacles: Footprint[]; roads: Footprint[] } {
  const obstacles: Footprint[] = [];
  const roads: Footprint[] = [];
  for (const e of rt.entities.values()) {
    switch (e.source.type) {
      case 'building':
        obstacles.push(footprint(e, e.dims[0] / 2, e.dims[2] / 2));
        break;
      case 'wall':
        if (e.dims[2] >= MIN_BLOCKING_WALL) obstacles.push(footprint(e, e.dims[0] / 2, Math.max(0.5, e.dims[2] / 2)));
        break;
      case 'road':
        roads.push(footprint(e, e.dims[0] / 2, e.dims[2] / 2));
        break;
    }
  }
  return { obstacles, roads };
}
