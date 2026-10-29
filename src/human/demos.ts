/**
 * Demo worlds of the human-response presets (Phase 33): small, flat (or simply sloped) educational scenes — a few people
 * and only what the experiment needs (a debris block, a house, a slope) — built as complete world documents with the
 * extended human model switched on (settings.simulation.humans = { model: 'extended' }). Not real places; every
 * scene uses the project's default air, water and ground models.
 *
 * The documents are built without the editor store (pure): objects via createWorldObject, terrain heights / ground types
 * written to the terrain and taken as the landscape base (createLandscape), objects set on the terrain surface.
 */
import type { Vec3 } from '@/core/types';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { createEmptyDocument, createWorldObject, type CreateObjectInput } from '@/world/WorldDocument';
import { createLandscape } from '@/landscape/compose';
import { quantizeHeight } from '@/terrain/TerrainData';
import { createDesign } from '@/buildings/design';
import { presetSpec as buildingSpec } from '@/buildings/spec';
import { defaultGravitySpec, EARTH_G, type GravitySpec } from '@/gravity/types';
import { G_N } from '@/celestial/constants';
import { defaultCelestialSpec, defaultSource, type CelestialSourceSpec, type CelestialSpec } from '@/celestial/types';

export const HUMAN_PRESET_IDS = [
  'standStill', 'weakWind', 'strongGust', 'slopeSlide', 'lowFriction', 'drop1m', 'drop3m', 'drop10m', 'rotatingFall', 'debrisHit',
  'quakeBalance', 'floodPush', 'blastWave', 'buildingCollapse', 'lowGravityFall', 'highGravityFall', 'reversedGravity',
  'horizontalGravity', 'celestialTides', 'celestialCapture',
] as const;
export type HumanPresetId = (typeof HUMAN_PRESET_IDS)[number];

export interface HumanDemo {
  doc: WorldDocument;
  events: EventSpec[];
}

/** An object to place: `lift` is its height above the terrain surface (m). */
export type DemoObject = CreateObjectInput & { lift?: number };

export interface DemoWorld {
  objects: DemoObject[];
  /** Terrain height (m) at a world point (flat when absent). */
  height?: (x: number, z: number) => number;
  /** Ground type id at a world point (grass when absent; see terrain/GroundMaterials). */
  ground?: (x: number, z: number) => number;
  seed: number;
  name?: string;
}

const DEG = Math.PI / 180;
const tf = (x: number, z: number, rot: Vec3 = [0, 0, 0]): CreateObjectInput['transform'] => ({ position: [x, 0, z] as Vec3, rotation: rot, scale: [1, 1, 1] as Vec3 });

/** A person (1.75 m) at (x, z), `lift` m above the ground, with an optional initial orientation (Euler, rad). */
export const person = (x: number, z: number, seed: number, lift = 0, rot: Vec3 = [0, 0, 0]): DemoObject => ({
  type: 'human', seed, lift, params: { height: 1.75, shirtColor: seed % 2 ? '#3b82c4' : '#d9822b', pantsColor: '#2f3640' }, transform: tf(x, z, rot),
});
/** A loose block of debris: the car body (the only free rigid object type) sized 1.2 × 0.8 × 1.0 m (≈ 115 kg). */
export const debris = (x: number, z: number, seed: number, lift: number): DemoObject => ({
  type: 'car', seed, lift, params: { variant: 'sedan', length: 1.2, width: 1, height: 0.8, color: '#8d8a84' }, transform: tf(x, z),
});
export const car = (x: number, z: number, seed: number, yaw = 0): DemoObject => ({ type: 'car', seed, transform: tf(x, z, [0, yaw, 0]) });
export const building = (x: number, z: number, seed: number, preset: string): DemoObject => ({ type: 'building', building: createDesign(buildingSpec(preset)!, preset), seed, transform: tf(x, z) });

/** A plane rising towards −x at `deg` from x = x1 (flat for x ≥ x1), capped at `top` m. */
export const slope = (deg: number, x1: number, top: number) => (x: number) => Math.min(top, Math.max(0, (x1 - x) * Math.tan(deg * DEG)));

/** Build the world document of a demo (extended human model on). */
export function buildWorld(w: DemoWorld): WorldDocument {
  const doc = createEmptyDocument(w.name ?? 'human demo');
  doc.settings.simulation.seed = w.seed;
  doc.settings.simulation.humans = { model: 'extended' };
  const t = doc.terrain;
  const h = w.height ?? (() => 0);
  if (w.height || w.ground) {
    for (let iz = 0; iz < t.nz; iz++) for (let ix = 0; ix < t.nx; ix++) {
      const x = t.originX + ix * t.cellSize, z = t.originZ + iz * t.cellSize, i = iz * t.nx + ix;
      if (w.height) t.heights[i] = quantizeHeight(w.height(x, z));
      if (w.ground) t.ground[i] = w.ground(x, z);
    }
    doc.landscape = createLandscape(t);
  }
  const serial = new Map<string, number>();
  for (const { lift, ...o } of w.objects) {
    const n = (serial.get(o.type) ?? 0) + 1;
    serial.set(o.type, n);
    const [x, , z] = o.transform.position;
    const obj = createWorldObject({ ...o, transform: { ...o.transform, position: [x, h(x, z) + (lift ?? 0), z] } }, n);
    doc.objects[obj.id] = obj;
  }
  return doc;
}

// ── event specs ──
const gravity = (p: Partial<GravitySpec>): EventSpec => ({ ...defaultGravitySpec(), scenario: 'custom', global: true, magnitude: EARTH_G, direction: [0, -1, 0], transition: 'vector', profile: 'constant', duration: 600, end: 'hold', sources: [], startTime: 0, ...p } as EventSpec);
const celestial = (sources: CelestialSourceSpec[], p: Partial<CelestialSpec> = {}): EventSpec => ({
  ...defaultCelestialSpec(), scenario: 'custom', scale: 'educational', probes: [], tidal: true, lensing: false, limitPolicy: 'warn', end: 'restore',
  accretion: { visual: false, particles: 0, inner: 6, outer: 20, particleMass: 1 }, duration: 600, startTime: 0, sources, ...p,
} as EventSpec);
const source = (p: Partial<CelestialSourceSpec>): CelestialSourceSpec => ({ ...defaultSource(), ...p });
const M = (mu: number) => mu / G_N;
const wind = (speed: number, gust: number): EventSpec => ({ event: 'wind', speed, direction: 'S', duration: 60, gustStrength: gust, rampDuration: 4, startTime: 0 } as EventSpec);

/** A row of three people across x (spacing 4 m) at z. */
const row = (z: number, seed: number, lift = 0) => [person(-4, z, seed, lift), person(0, z, seed + 1, lift), person(4, z, seed + 2, lift)];

/** The world and the events of a preset. */
export function humanDemo(id: HumanPresetId, seed: number): HumanDemo {
  const W = (objects: DemoObject[], extra: Partial<DemoWorld> = {}) => buildWorld({ objects, seed, name: id, ...extra });
  switch (id) {
    case 'standStill': return { doc: W(row(0, 1)), events: [] };
    case 'weakWind': return { doc: W(row(0, 1)), events: [wind(12, 0)] };
    case 'strongGust': return { doc: W(row(0, 1)), events: [wind(35, 0.3)] };
    case 'slopeSlide': {
      // A 45° grass slope (x < 0, up to 12 m) above a flat yard: one person on the slope, one in the yard.
      const height = slope(45, 0, 12);
      return { doc: W([person(-5, 0, 1), person(8, 0, 2)], { height }), events: [] };
    }
    case 'lowFriction': {
      // The same 34° slope, grass on the south half (z < 0), mud on the north half (z ≥ 0): one person on each.
      const height = slope(34, 0, 12);
      const ground = (_x: number, z: number) => (z >= 0 ? 7 : 0);
      return { doc: W([person(-6, -8, 1), person(-6, 8, 2)], { height, ground }), events: [] };
    }
    case 'drop1m': return { doc: W([person(0, 0, 1, 1), person(4, 0, 2)]), events: [] };
    case 'drop3m': return { doc: W([person(0, 0, 1, 3), person(4, 0, 2)]), events: [] };
    case 'drop10m': return { doc: W([person(0, 0, 1, 10), person(4, 0, 2)]), events: [] };
    case 'rotatingFall': return { doc: W([person(0, 0, 1, 3, [1.2, 0, 0.3]), person(4, 0, 2, 3)]), events: [] };
    case 'debrisHit': return { doc: W([person(0, 0, 1), debris(0, 0, 3, 4), person(4, 0, 2)]), events: [] };
    case 'quakeBalance': return { doc: W(row(0, 1)), events: [{ event: 'earthquake', magnitude: 7, pga: 0.8, duration: 15, seed: 3, startTime: 0 } as EventSpec] };
    // The south map edge (z = +100) becomes open water rising quickly to 1.2 m: a shallow flood front runs inland over the
    // flat ground past the people at 10, 20 and 30 m from the edge.
    case 'floodPush': return { doc: W([person(-4, 90, 1), person(0, 80, 2), person(4, 70, 3)]), events: [{ event: 'risingWater', boundary: 'S', level: 1.2, riseRate: 30, duration: 120, startTime: 0 } as EventSpec] };
    case 'blastWave': return {
      doc: W([person(8, 0, 1), person(16, 0, 2), person(32, 0, 3), person(64, 0, 4)]),
      events: [{ event: 'blast', position: [0, 0], height: 1, energy: 2e9, model: 'weakShock', waveform: 'nWave', startTime: 0.5 } as EventSpec],
    };
    case 'buildingCollapse': return {
      doc: W([building(0, 0, 1, 'apartment'), person(-12, 0, 2), person(12, 0, 3), person(0, 10, 4), person(0, -40, 5)]),
      events: [{ event: 'earthquake', magnitude: 7.5, pga: 1.2, duration: 20, seed: 3, startTime: 0 } as EventSpec],
    };
    case 'lowGravityFall': return { doc: W([person(0, 0, 1, 3), person(4, 0, 2)]), events: [gravity({ magnitude: 1.62 })] };
    case 'highGravityFall': return { doc: W([person(0, 0, 1, 3), person(4, 0, 2)]), events: [gravity({ magnitude: 2 * EARTH_G })] };
    case 'reversedGravity': return { doc: W([...row(0, 1), car(0, 8, 9, Math.PI / 2)]), events: [gravity({ direction: [0, 1, 0], profile: 'smooth', ramp: 2, startTime: 1 })] };
    case 'horizontalGravity': return { doc: W(row(0, 1)), events: [gravity({ direction: [1, 0, 0], transition: 'rotate', profile: 'smooth', ramp: 6, startTime: 1 })] };
    case 'celestialTides': return {
      // A compact mass 12 m below the ground (μ = 2000 m³/s², no capture): people at 0, 4 and 40 m horizontal distance feel
      // its pull added to the Earth's (≈ +1.4 g straight down at the first) and a stretching (tidal) load that falls off ∝ 1 / r³.
      doc: W([person(0, 0, 1), person(4, 0, 2), person(40, 0, 3)]),
      events: [celestial([source({ kind: 'compact', center: [0, -12, 0], mass: M(2000), softening: 2, capture: 0, ramp: 4 })])],
    };
    case 'celestialCapture': return {
      // An educational black hole 8 m above the ground (μ = 5·10⁴ m³/s², capture radius 1.5 m): the pull at the person
      // below is ≈ 5·10⁴ / 8² ≈ 780 m/s² ≫ g — lifted and captured; the people 30 m away are pulled sideways.
      doc: W([person(0, 0, 1), person(30, 0, 2), person(-30, 10, 3)]),
      events: [celestial([source({ kind: 'blackHole', center: [0, 8, 0], mass: M(5e4), softening: 1.5, capture: 1.5, ramp: 1 })])],
    };
  }
}
