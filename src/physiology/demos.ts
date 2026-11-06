/**
 * Demo worlds of the physiology presets (Phase 34): small, flat educational scenes — a few people with the extended human
 * model and the reduced physiology switched on, and only what the experiment needs. Wherever an environment system of the
 * project provides the quantity, the scene uses it (scene ambient air, a climate experiment for cold / heat / humidity, a
 * wind event, rising flood water, a fire ignition for flame radiation / hot air / smoke / O₂, an atmosphere experiment for
 * low pressure, an earthquake with a building, a landslide). Where no environment system can provide a value — a CO
 * concentration beyond the soot-derived estimate, a fixed hypoxic O₂ fraction, water rising and falling over the airway,
 * the air of a burial pocket — the scene uses a physiology ZONE: an explicit experimental boundary condition (no force, no
 * heat or mass in the world), never a simulation result. Not real places or real people.
 */
import type { Vec3 } from '@/core/types';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { buildWorld, building, person as human, type DemoObject } from '@/human/demos';
import { defaultClimateSpec, type ClimateSpec } from '@/climate/types';
import { defaultAtmosphereSpec } from '@/atmosphere/types';
import { defaultThermalSettings } from '@/thermal/ThermalWorld';
import type { CreateObjectInput } from '@/world/WorldDocument';
import type { PhysiologyPerson, PhysiologySettings, PhysiologyZone } from './settings';

export const PHYSIO_PRESET_IDS = [
  'stableBaseline', 'coldIndoor', 'coldOutdoor', 'coldWind', 'coldWaterPartial', 'coldWaterFull', 'hotIndoor', 'heatwave',
  'hotHumid', 'hotDry', 'highActivity', 'longActivity', 'recovery', 'dehydration', 'fireRadiant', 'fireHotAir', 'smoke',
  'carbonMonoxide', 'hypoxia', 'lowPressure', 'airwayIntermittent', 'airwayContinuous', 'buriedExposure', 'quakeFireIncapacitated',
] as const;
export type PhysioPresetId = (typeof PHYSIO_PRESET_IDS)[number];

export interface PhysioDemo {
  doc: WorldDocument;
  events: EventSpec[];
}

const K = (c: number) => c + 273.15;
const tf = (x: number, z: number): CreateObjectInput['transform'] => ({ position: [x, 0, z] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
/** A conifer with a dry crown (fuel of the vegetation fire). */
export const conifer = (x: number, z: number, seed: number): DemoObject => ({ type: 'tree', params: { species: 'conifer', height: 11, canopyRadius: 2.2, trunkRadius: 0.32 }, seed, transform: tf(x, z) });

/** A scene object; a person may carry its own physiology (activity / clothing / intake) — set by object id on build. */
export type PhysioObject = DemoObject & { physio?: PhysiologyPerson };

export interface PhysioWorld {
  objects: PhysioObject[];
  physiology: PhysiologySettings;
  seed: number;
  name: string;
  /** Scene ambient (reference) air temperature (K): settings.simulation.thermal.ambient. */
  ambient?: number;
  fire?: { foliageMoisture: number; openings: 'asBuilt' | 'windowsOpen' | 'closed' };
  height?: (x: number, z: number) => number;
}

/** The world document of a physiology demo (extended human model + physiology on, fixed seed). */
export function buildPhysioWorld(w: PhysioWorld): WorldDocument {
  const doc = buildWorld({ objects: w.objects.map(({ physio: _, ...o }) => o), seed: w.seed, name: w.name, height: w.height });
  const physiology = structuredClone(w.physiology);
  // Per-person settings: the k-th person of the list is the k-th human object of the document (insertion order).
  const humans = Object.values(doc.objects).filter((o) => o.type === 'human');
  w.objects.filter((o) => o.type === 'human').forEach((o, k) => {
    if (o.physio) physiology.people = { ...physiology.people, [humans[k].id]: { ...o.physio } };
  });
  doc.settings.simulation.physiology = physiology;
  if (w.ambient !== undefined) doc.settings.simulation.thermal = { ...defaultThermalSettings(), ambient: w.ambient };
  if (w.fire) doc.settings.simulation.fire = { ...w.fire, heatIgnition: false };
  return doc;
}

// ── event specs ──
/** A climate experiment holding a constant air temperature / humidity (prescribed forcing, no sun unless asked). */
export const climateHold = (T: number, rh: number, duration: number, p: Partial<ClimateSpec> = {}): EventSpec => ({
  ...defaultClimateSpec(), scenario: 'custom', forcing: 'prescribed', temperature: T, target: T, profile: 'constant', duration, humidity: rh,
  humidityTarget: undefined, precipitation: 0, solar: 'off', blowingSnow: false, soilMoisture: 0.2, startTime: 0, ...p,
} as EventSpec);
export const windEvent = (speed: number, duration: number, direction = 'S'): EventSpec => ({ event: 'wind', speed, direction, duration, gustStrength: 0, rampDuration: 5, startTime: 0 } as EventSpec);
export const risingWater = (level: number, riseRate: number, duration: number): EventSpec => ({ event: 'risingWater', boundary: 'S', level, riseRate, duration, startTime: 0 } as EventSpec);
export const ignition = (x: number, z: number, height: number, radius: number, duration: number, startTime = 0): EventSpec => ({ event: 'fire', position: [x, z], height, radius, duration, startTime } as EventSpec);
export const quake = (pga: number, duration: number, startTime = 0): EventSpec => ({ event: 'earthquake', magnitude: 7.5, pga, duration, seed: 3, startTime } as EventSpec);
/** Mean water level (m) of the wash over a lying person's airway. */
export const WASH = 0.14;
/** Centre of the burial pocket zone of the buriedExposure preset (where the west person ends up under the rubble). */
export const POCKET: Vec3 = [-9.5, 0.5, 0.5];
export const altitude = (alt: number, T: number): EventSpec => ({ ...defaultAtmosphereSpec(), altitude: alt, temperature: T, removal: 'none', startTime: 0 } as EventSpec);

/** A zone (box) around a point: the experimental boundary condition of a preset. */
export const zoneBox = (id: string, center: Vec3, size: Vec3, p: Partial<PhysiologyZone>): PhysiologyZone => ({ id, shape: 'box', center, size, ...p });

/** A 4 × 3 stand of dry conifers (5 m spacing) with its west edge at x0, centred on z = 0. */
const stand = (x0: number, seed: number): DemoObject[] => {
  const out: DemoObject[] = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) out.push(conifer(x0 + i * 5, -5 + j * 5, seed + i * 3 + j));
  return out;
};
const DRY = { foliageMoisture: 0.2, openings: 'asBuilt' as const };
/** A shore: flat for z ≥ 85 (the south edge where the water rises), rising 1 m per 10 m inland (capped at 4 m). */
const shore = (_x: number, z: number) => Math.min(4, Math.max(0, (85 - z) * 0.1));
/** A 2 × 2 stand of dry conifers (5 m spacing) with its west edge at x0, centred on z = 0. */
const stand2 = (x0: number, seed: number): DemoObject[] => [conifer(x0, -2.5, seed), conifer(x0, 2.5, seed + 1), conifer(x0 + 5, -2.5, seed + 2), conifer(x0 + 5, 2.5, seed + 3)];

/** The world and the events of a physiology preset. */
export function physioDemo(id: PhysioPresetId, seed: number): PhysioDemo {
  const W = (objects: PhysioObject[], physiology: Omit<PhysiologySettings, 'model'>, extra: Partial<PhysioWorld> = {}) =>
    buildPhysioWorld({ objects, physiology: { model: 'reduced', ...physiology }, seed, name: id, ...extra });
  const P = (x: number, z: number, s: number, physio?: PhysiologyPerson, lift = 0, rot?: Vec3): PhysioObject => ({ ...human(x, z, s, lift, rot), ...(physio ? { physio } : {}) });
  switch (id) {
    // Thermoneutral air (24 °C, still, reference humidity), resting, normal clothing: nothing should change.
    case 'stableBaseline': return { doc: W([P(-4, 0, 1), P(0, 0, 2), P(4, 0, 3)], { activity: 'resting', clothing: 'normal' }, { ambient: K(24) }), events: [] };
    // An unheated room represented by the scene ambient air: 10 °C, still air, walls at air temperature.
    case 'coldIndoor': return { doc: W([P(-2, 0, 1, { clothing: 'light' }), P(2, 0, 2, { clothing: 'insulated' })], { activity: 'resting' }, { ambient: K(10) }), events: [] };
    case 'coldOutdoor': return { doc: W([P(-2, 0, 1), P(2, 0, 2)], { activity: 'light', clothing: 'normal' }), events: [climateHold(K(-5), 0.7, 3600)] };
    case 'coldWind': return { doc: W([P(-2, 0, 1), P(2, 0, 2)], { activity: 'light', clothing: 'normal' }), events: [climateHold(K(-5), 0.7, 3600), windEvent(10, 3600)] };
    // Rising water from the south edge to 1.0 m (≈ waist); water temperature 10 °C is the reference value (assumed — the
    // flood carries no temperature without the thermal water model).
    case 'coldWaterPartial': return {
      doc: W([P(0, 92, 1), P(0, 50, 2)], { activity: 'resting', clothing: 'normal', reference: { waterTemperature: K(10) } }, { height: shore }),
      events: [risingWater(1.0, 0.5, 3600)],
    };
    // Immersed to the neck: physiology-only water (zone) — a free body in 1.45 m of flood water would float or lose its
    // footing in the rigid-body model, so the immersion depth is held as a boundary condition (as if supported).
    case 'coldWaterFull': return {
      doc: W([P(0, 0, 1), P(20, 0, 2)], { activity: 'resting', clothing: 'normal', zones: [zoneBox('water', [0, 1, 0], [6, 6, 6], { water: { level: 1.45, temperature: K(10) } })] }),
      events: [],
    };
    case 'hotIndoor': return { doc: W([P(-2, 0, 1), P(2, 0, 2)], { activity: 'light', clothing: 'light', reference: { humidity: 0.6 } }, { ambient: K(34) }), events: [] };
    case 'heatwave': return {
      doc: W([P(-2, 0, 1), P(2, 0, 2)], { activity: 'light', clothing: 'light' }),
      events: [climateHold(K(38), 0.3, 3600, { solar: 'clearSky', latitude: 37.5, dayOfYear: 200, hour: 12, cloud: 0 })],
    };
    case 'hotHumid': return { doc: W([P(-2, 0, 1), P(2, 0, 2)], { activity: 'moderate', clothing: 'light' }), events: [climateHold(K(38), 0.85, 3600)] };
    case 'hotDry': return { doc: W([P(-2, 0, 1), P(2, 0, 2)], { activity: 'moderate', clothing: 'light' }), events: [climateHold(K(38), 0.15, 3600)] };
    case 'highActivity': return { doc: W([P(-2, 0, 1, { activity: 'strenuous' }), P(2, 0, 2, { activity: 'resting' })], { clothing: 'light' }, { ambient: K(20) }), events: [] };
    case 'longActivity': return { doc: W([P(-2, 0, 1), P(2, 0, 2)], { activity: 'moderate', clothing: 'light' }, { ambient: K(25) }), events: [] };
    case 'recovery': return { doc: W([P(0, 0, 1)], { activity: 'strenuous', clothing: 'light' }, { ambient: K(18) }), events: [] };
    case 'dehydration': return {
      doc: W([P(-2, 0, 1, { waterIntake: 0 }), P(2, 0, 2, { waterIntake: 0.4 })], { activity: 'moderate', clothing: 'light', reference: { humidity: 0.3 } }, { ambient: K(38) }),
      events: [],
    };
    // A burning stand of dry conifers (x 10…25); people upwind on the west side at 8 m and 16 m from the first trees.
    // A burning 2 × 2 stand of dry conifers (x 10…15); people upwind (west) at 6, 12 and 24 m from the first trees.
    // No wind: a person who sinks down would otherwise be rolled along by the drag (see the limits).
    case 'fireRadiant': return { doc: W([...stand2(10, 20), P(4, 0, 1), P(-2, 0, 2), P(-14, 0, 3)], { activity: 'resting' }, { fire: DRY }), events: [ignition(10, -2.5, 6, 2, 600)] };
    // Hot fire gases (100 °C, dry) at the airway as a boundary condition: the outdoor air layer of the environment model is
    // one well-mixed 5 m × 10 m column and barely warms beside a fire, and people inside burning rooms are not supported by
    // the rigid-body model — the zone isolates the convective heat. A second person outside the zone is the reference.
    case 'fireHotAir': return {
      doc: W([P(0, 0, 1), P(20, 0, 2)], { activity: 'resting', zones: [zoneBox('hotGas', [0, 1, 0], [6, 6, 6], { airTemperature: K(100), humidity: 0.05, ramp: 30 })] }),
      events: [],
    };
    // The smoke of a burning stand carried east by a 4 m/s wind: one person 30 m downwind, one 30 m upwind.
    case 'smoke': return { doc: W([...stand(-25, 20), P(20, 0, 1), P(-55, 0, 2)], { activity: 'light' }, { fire: DRY }), events: [windEvent(4, 600, 'W'), ignition(-25, -5, 6, 2, 600)] };
    case 'carbonMonoxide': return {
      doc: W([P(0, 0, 1), P(30, 0, 2)], { activity: 'resting', zones: [zoneBox('co', [0, 1, 0], [10, 6, 10], { co: 0.001, ramp: 60 })] }),
      events: [],
    };
    case 'hypoxia': return {
      doc: W([P(0, 0, 1), P(30, 0, 2)], { activity: 'light', zones: [zoneBox('o2', [0, 1, 0], [10, 6, 10], { o2: 0.12, ramp: 30 })] }),
      events: [],
    };
    case 'lowPressure': return { doc: W([P(-2, 0, 1), P(2, 0, 2)], { activity: 'light', clothing: 'normal' }), events: [altitude(3500, K(20))] };
    // A person lying on the ground (laid prone at the start); physiology-only water washing over the face with a 3 s period.
    case 'airwayIntermittent': return {
      doc: W([P(0, 0, 1, undefined, 0.3, [Math.PI / 2, 0, 0])], { activity: 'resting', zones: [zoneBox('waves', [0, 1, 0], [6, 6, 6], { start: 5, end: 65, water: { level: WASH, amplitude: 0.12, period: 3, temperature: K(20) } })] }),
      events: [],
    };
    // Flood water rising at the shore to 2.5 m: the person at the water's edge loses footing, the airway goes under.
    case 'airwayContinuous': return { doc: W([P(0, 92, 1), P(0, 50, 2)], { activity: 'resting', reference: { waterTemperature: K(20) } }, { height: shore }), events: [risingWater(2.5, 2, 600)] };
    // An earthquake brings down a six-storey apartment block; people stand around it. Where rubble buries the person on the
    // west side (rubble burial fixes the body in place), a confined void (0.4 m³, 0.1 air changes per hour) is the
    // boundary condition of the pocket air; elsewhere the gases at a buried airway are unknown.
    case 'buriedExposure': return {
      doc: W([building(0, 0, 9, 'apartment'), P(-9.8, 0, 1), P(9.8, 0, 2), P(0, 6.8, 3), P(0, -6.8, 4), P(-5, 6.8, 5), P(5, -6.8, 6), P(-9.8, 4, 7), P(9.8, -4, 8), P(40, 0, 9)],
        { activity: 'resting', zones: [zoneBox('pocket', POCKET, [3, 3, 3], { start: 20, confined: { volume: 0.4, exchange: 0.1 } })] }),
      events: [quake(1.2, 20)],
    };
    case 'quakeFireIncapacitated': return {
      doc: W([building(0, 0, 9, 'house'), ...stand2(8, 30).map((o) => ({ ...o, transform: { ...o.transform, position: [o.transform.position[0], 0, o.transform.position[2] + 10.5] as Vec3 } })), P(-7, 0, 1), P(7, 0, 2), P(0, 8, 3), P(0, -30, 4)], { activity: 'light' }, { fire: DRY }),
      events: [quake(1.2, 20), ignition(8, 8, 6, 2, 600, 25)],
    };
  }
}
