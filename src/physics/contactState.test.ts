/**
 * Phase 32.1: the contact state kept from Rapier's collision events (`touching`) equals the narrow phase asked pair by
 * pair (`touchingQuery`: a collider pair with at least one solver contact) for every body after every step — a pile on
 * a heightfield terrain and on flat ground, bodies removed, a body made fixed and dynamic again, the terrain replaced.
 */
import { describe, expect, it } from 'vitest';
import { RapierEngine } from './RapierEngine';
import type { BodyHandle, TerrainColliderDesc } from './PhysicsEngine';

function terrain(bump: number): TerrainColliderDesc {
  const nx = 17, nz = 17, heights = new Float32Array(nx * nz);
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) heights[iz * nx + ix] = bump * Math.sin(ix * 0.7) * Math.cos(iz * 0.5);
  return { nx, nz, cellSize: 1, originX: -8, originZ: -8, heights, friction: 0.8 };
}

async function run(withTerrain: boolean) {
  const e = new RapierEngine();
  await e.init(9.81, withTerrain ? terrain(0.3) : null);
  const bodies: BodyHandle[] = [];
  for (let k = 0; k < 60; k++) {
    const x = (k % 5) * 1.1 - 2.2, z = (Math.floor(k / 5) % 4) * 1.1 - 1.6, y = 1 + Math.floor(k / 20) * 1.2;
    bodies.push(e.createBody({
      kind: 'dynamic', position: [x, y, z], quaternion: [0, 0, 0, 1], mass: 10, friction: 0.6, restitution: 0.1,
      shapes: [k % 3 ? { type: 'box', halfExtents: [0.4, 0.4, 0.4] } : { type: 'ball', radius: 0.45 }],
      contactForceThreshold: k % 2 ? 100 : undefined,
      userData: { entityId: `b${k}` },
    }));
  }
  let checks = 0, touching = 0, mismatches = 0;
  const live = new Set(bodies);
  for (let s = 0; s < 240; s++) {
    if (s === 60) for (const h of bodies.slice(0, 8)) { e.removeBody(h); live.delete(h); }
    if (s === 90) e.setBodyKind(bodies[20], 'fixed');
    if (s === 150) e.setBodyKind(bodies[20], 'dynamic');
    if (s === 120 && withTerrain) e.setTerrain(terrain(0.5));
    e.step(1 / 60);
    for (const h of live) {
      const a = e.touching(h), b = e.touchingQuery(h);
      checks++;
      if (b) touching++;
      if (a !== b) mismatches++;
    }
  }
  e.dispose();
  return { checks, touching, mismatches };
}

describe('contact state from collision events', () => {
  it('equals the pair-by-pair narrow-phase query — heightfield terrain, removals, type changes, terrain replaced', async () => {
    const r = await run(true);
    expect(r.touching).toBeGreaterThan(r.checks / 4);
    expect(r.mismatches).toBe(0);
  });
  it('equals the query on flat ground', async () => {
    const r = await run(false);
    expect(r.touching).toBeGreaterThan(r.checks / 4);
    expect(r.mismatches).toBe(0);
  });
});
