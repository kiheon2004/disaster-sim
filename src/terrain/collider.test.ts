/**
 * Terrain ↔ physics ↔ simulation integration: collider consistency, objects resting and sliding
 * on slopes, terrain-relative wind and deterministic simulation on terrain.
 */
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@/core/types';
import type { WorldDocument } from '@/core/model';
import { Rng } from '@/core/random';
import { RapierEngine } from '@/physics/RapierEngine';
import { SimulationController } from '@/simulation/SimulationController';
import { WindField } from '@/simulation/environment/WindField';
import { SpatialWindField } from '@/simulation/wind/SpatialWindField';
import { DEFAULT_WIND_MODEL } from '@/core/model';
import { createEmptyDocument, createWorldObject, nextSerial } from '@/world/WorldDocument';
import { sampleTown } from '@/world/sampleScene';
import { createFlatTerrain, quantizeHeight } from './TerrainData';
import { generateTerrain } from './TerrainPresets';
import { TerrainSampler } from './TerrainSampler';
import { terrainColliderDesc } from './TerrainPhysicsAdapter';
import { groundPose, reseat } from './groundPlacement';

const DOWN: Vec3 = [0, -1, 0];

describe('terrain collider consistency', () => {
  it('Rapier heightfield surface == TerrainSampler height (same triangles)', async () => {
    const t = generateTerrain('gentleHills', 5);
    const s = new TerrainSampler(t);
    const eng = new RapierEngine();
    await eng.init(9.81, terrainColliderDesc(t));
    const rng = new Rng(3);
    let worst = 0;
    for (let k = 0; k < 600; k++) {
      const x = rng.range(-99.9, 99.9);
      const z = rng.range(-99.9, 99.9);
      const toi = eng.castGroundRay([x, 200, z], DOWN, 500);
      expect(toi).not.toBeNull();
      worst = Math.max(worst, Math.abs(200 - toi! - s.sampleHeight(x, z)));
    }
    // Surroundings outside the grid are the y = 0 plane in both.
    expect(200 - eng.castGroundRay([150, 200, -130], DOWN, 500)!).toBeCloseTo(0, 5);
    eng.dispose();
    expect(worst).toBeLessThan(1e-3);
  });

  it('setTerrain() replaces the collider after an edit (flat ↔ relief)', async () => {
    const eng = new RapierEngine();
    await eng.init(9.81, null);
    // (Rays exactly through a grid vertex can miss in Rapier's ray query; probe between vertices.)
    expect(200 - eng.castGroundRay([10.3, 200, 10.6], DOWN, 500)!).toBeCloseTo(0, 6);
    const t = generateTerrain('valley', 2);
    eng.setTerrain(terrainColliderDesc(t));
    const s = new TerrainSampler(t);
    expect(200 - eng.castGroundRay([10.3, 200, 60.6], DOWN, 500)!).toBeCloseTo(s.sampleHeight(10.3, 60.6), 3);
    eng.setTerrain(null);
    expect(200 - eng.castGroundRay([10.3, 200, 60.6], DOWN, 500)!).toBeCloseTo(0, 6);
    eng.dispose();
  });

  it('flat terrain keeps the original flat ground (no heightfield)', () => {
    expect(terrainColliderDesc(createFlatTerrain())).toBeNull();
  });
});

/** Document with a constant slope (dh/dx = k) and the given objects. */
function slopeDoc(k: number, place: (s: TerrainSampler) => Parameters<typeof createWorldObject>[0][]): WorldDocument {
  const doc = createEmptyDocument('slope');
  const t = doc.terrain;
  for (let iz = 0; iz < t.nz; iz++) for (let ix = 0; ix < t.nx; ix++) t.heights[iz * t.nx + ix] = quantizeHeight(10 + k * (t.originX + ix));
  t.revision++;
  const s = new TerrainSampler(t);
  for (const input of place(s)) {
    const o = createWorldObject(input, nextSerial(doc.objects, input.type));
    doc.objects[o.id] = o;
  }
  return doc;
}

describe('objects on sloped terrain (physics)', () => {
  it('a car placed on a gentle slope rests on it; a crate on a steep slope slides downhill', async () => {
    const car = createWorldObject({ type: 'car', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }, 1);
    const doc = slopeDoc(0.12, (s) => [
      { type: 'car', seed: 1, transform: { ...groundPose(car, 0, 0, 0.4, s), scale: [1, 1, 1] } },
    ]);
    const c = new SimulationController();
    await c.load(doc);
    c.advance(3);
    const e = [...c.getRuntime()!.entities.values()][0];
    const s = new TerrainSampler(doc.terrain);
    expect(e.pose.position[1]).toBeGreaterThan(s.sampleHeight(e.pose.position[0], e.pose.position[2]) - 0.05);
    expect(e.displacement).toBeLessThan(0.3); // friction holds it (tan θ = 0.12)
    c.unload();

    // 35° slope, low friction person-sized box (a fallen person/crate): slides toward -x (downhill).
    const steep = slopeDoc(0.7, (s) => [
      { type: 'car', seed: 2, physics: { friction: 0.2 }, transform: { ...groundPose(car, 20, 0, 0, s), scale: [1, 1, 1] } },
    ]);
    const c2 = new SimulationController();
    await c2.load(steep);
    const start = [...c2.getRuntime()!.entities.values()][0].pose.position[0];
    c2.advance(2);
    const e2 = [...c2.getRuntime()!.entities.values()][0];
    expect(e2.pose.position[0]).toBeLessThan(start - 1);
    const s2 = new TerrainSampler(steep.terrain);
    expect(e2.pose.position[1]).toBeGreaterThan(s2.sampleHeight(e2.pose.position[0], e2.pose.position[2]) - 0.1);
    c2.unload();
  });

  it('ground type under a free-standing object scales its friction (×1 on grass)', async () => {
    const doc = slopeDoc(0, () => [
      { type: 'car', seed: 3, transform: { position: [0, 10, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      { type: 'car', seed: 4, transform: { position: [30, 10, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    ]);
    const t = doc.terrain;
    t.ground[(100 + 0) * t.nx + (100 + 30)] = 3; // asphalt under the second car
    const c = new SimulationController();
    await c.load(doc);
    const [a, b] = [...c.getRuntime()!.entities.values()];
    expect(a.groundFriction).toBe(1);
    expect(b.groundFriction).toBeCloseTo(0.7 / 0.55, 9);
    c.unload();
  });
});

describe('resting bodies on uneven terrain', () => {
  it('calm vehicles on hills go to sleep; wind still pushes them', async () => {
    const doc = createEmptyDocument('rest');
    doc.terrain = generateTerrain('gentleHills', 1);
    const s = new TerrainSampler(doc.terrain);
    for (let i = 0; i < 12; i++) {
      const o = createWorldObject({ type: 'car', seed: i, transform: { position: [-60 + i * 11, 0, 60], rotation: [0, i * 0.5, 0], scale: [1, 1, 1] } }, i + 1);
      o.transform = { ...o.transform, ...reseat(o, s) };
      doc.objects[o.id] = o;
    }
    const c = new SimulationController();
    await c.load(doc);
    c.advance(4);
    const cars = [...c.getRuntime()!.entities.values()];
    const physics = (c as unknown as { physics: { isSleeping(h: number): boolean } }).physics;
    expect(cars.filter((e) => physics.isSleeping(e.body!)).length).toBe(cars.length);
    const before = cars.map((e) => [...e.pose.position]);
    c.addEvent({ event: 'wind', speed: 65, direction: 'W', duration: 30, rampDuration: 1 });
    c.advance(5);
    const moved = cars.filter((e, i) => Math.hypot(e.pose.position[0] - before[i][0], e.pose.position[2] - before[i][2]) > 0.5).length;
    expect(moved).toBeGreaterThan(0);
    c.unload();
  }, 60_000);
});

describe('wind on terrain', () => {
  it('the height profile is measured from the local ground', () => {
    const t = generateTerrain('gentleHills', 11);
    const s = new TerrainSampler(t);
    const onHills = new WindField();
    onHills.terrain = s;
    const flat = new WindField();
    for (const f of [onHills, flat]) {
      f.baseSpeed = 30;
      f.fromBearing = 90;
    }
    for (const [x, z] of [[40, 70], [-60, -80], [0, 0]]) {
      const g = s.sampleHeight(x, z);
      expect(onHills.speedAt([x, g + 10, z], 0)).toBeCloseTo(flat.speedAt([x, 10, z], 0), 9);
      expect(onHills.speedAt([x, g + 2, z], 0)).toBeLessThan(onHills.speedAt([x, g + 25, z], 0));
    }
  });

  it('obstacle wakes are measured from the obstacle base', () => {
    const wind = new WindField();
    wind.baseSpeed = 30;
    wind.fromBearing = 90; // from the east → flows toward -x
    const field = new SpatialWindField(wind, DEFAULT_WIND_MODEL, 1);
    const base = 12;
    field.setObstacles([{ id: 'b', cx: 0, cz: 0, hx: 5, hz: 5, ax: [1, 0], az: [0, 1], height: 20, baseY: base, active: true }]);
    const inWake = field.sample([-15, base + 5, 0], 0, undefined, undefined).shelter;
    const above = field.sample([-15, base + 40, 0], 0, undefined, undefined).shelter;
    expect(inWake).toBeLessThan(0.8);
    expect(above).toBeCloseTo(1, 6);
  });
});

describe('determinism on terrain', () => {
  function hillyTown(seed: number, terrainSeed = 4): WorldDocument {
    const doc = createEmptyDocument('det');
    doc.terrain = generateTerrain('gentleHills', terrainSeed);
    const s = new TerrainSampler(doc.terrain);
    for (const input of sampleTown()) {
      const o = createWorldObject(input, nextSerial(doc.objects, input.type));
      const p = reseat(o, s);
      o.transform = { ...o.transform, position: p.position, rotation: p.rotation };
      doc.objects[o.id] = o;
    }
    doc.settings.simulation.seed = seed;
    return doc;
  }

  async function run(doc: WorldDocument) {
    const c = new SimulationController();
    await c.load(doc);
    c.addEvent({ event: 'wind', speed: 46, direction: 'S', duration: 40, gustStrength: 0.3, rampDuration: 4 });
    c.advance(8);
    const seq = c.getDamageEvents().map((e) => `${e.time}|${e.objectId}|${e.componentId ?? ''}|${e.eventType}|${e.localWindSpeed}`);
    const poses = [...c.getRuntime()!.entities.values()].map((e) => [...e.pose.position, ...e.pose.quaternion].join(','));
    c.unload();
    return { seq, poses };
  }

  it('same terrain + world + event + seed → identical result; another terrain differs', async () => {
    const doc = hillyTown(42);
    const a = await run(doc);
    const b = await run(structuredClone(doc));
    expect(a.seq.length).toBeGreaterThan(10);
    expect(b.seq).toEqual(a.seq);
    expect(b.poses).toEqual(a.poses);
    const other = await run(hillyTown(42, 5));
    expect(other.seq).not.toEqual(a.seq);
  }, 180_000);

  it('objects start exactly on the terrain (no drop at t = 0)', async () => {
    const doc = hillyTown(1);
    const s = new TerrainSampler(doc.terrain);
    const c = new SimulationController();
    await c.load(doc);
    c.advance(1);
    for (const e of c.getRuntime()!.entities.values()) {
      if (e.source.type !== 'human' && e.source.type !== 'car') continue;
      const [x, y, z] = e.pose.position;
      // Settled within a few centimeters of where it was placed, still above the ground.
      expect(Math.abs(y - e.initialPose.position[1])).toBeLessThan(0.15);
      expect(y).toBeGreaterThan(s.sampleHeight(x, z) - 0.15);
    }
    c.unload();
  }, 60_000);
});
