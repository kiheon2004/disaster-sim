/**
 * Demo worlds of the vehicle presets (Phase 35): small educational scenes — one to three wheeled cars (vehicle dynamics on,
 * settings.simulation.vehicles) with their inputs (constant controls, a timed program or an autopilot path) and only what the
 * experiment needs: a painted ground type (asphalt, mud), a slope from a terrain height function, a wall, a person, a hazard
 * event of the project (wind, earthquake, rising flood water, landslide, blast, variable gravity, a climate snow / ice cover).
 *
 * The surfaces come from the models of the project: the ground type of the terrain cell (src/vehicle/surface.ts → params
 * TIRE.muGround), a flood water film (≥ 5 mm → wet friction), the Phase 30 climate cover (snow pack from an initial snow depth,
 * ice from freezing rain on frozen ground). No preset prescribes a friction value directly. Not real places, roads or vehicles:
 * the cars are the generic educational sedan / SUV of src/vehicle/params.ts.
 *
 * Built without the editor store (pure) through the Phase 33 demo world builder (buildWorld: objects, terrain heights, ground
 * types); the k-th entry of `cars` configures the k-th car object of the scene (insertion order).
 */
import type { Vec3 } from '@/core/types';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { buildWorld, person, slope, type DemoObject } from '@/human/demos';
import { defaultGravitySpec, EARTH_G, type GravitySpec } from '@/gravity/types';
import { defaultClimateSpec, type ClimateSpec } from '@/climate/types';
import type { Seat, VehicleCar, VehicleSettings } from './settings';
import { vehicleGeometry } from './geometry';
import { CAR_DENSITY } from './params';
import { defaultThermalSettings } from '@/thermal/ThermalWorld';

export const VEHICLE_PRESET_IDS = [
  'stationary', 'suspensionDrop', 'constantThrottle', 'constantSpeed', 'hardBraking', 'lowSpeedSteer', 'highSpeedSteer', 'circle',
  'slalom', 'fwd', 'rwd', 'awd', 'dryAsphalt', 'wetRoad', 'icyRoad', 'snowyRoad', 'slopeHold', 'slopeStart', 'slopeBrake', 'rollover',
  'frontalCrash', 'sideCrash', 'carToCar', 'carToWall', 'carToPerson', 'crosswind', 'earthquake', 'flood', 'debrisFlow', 'blast',
  'lowGravity', 'combined',
] as const;
export type VehiclePresetId = (typeof VEHICLE_PRESET_IDS)[number];

export interface VehicleDemo {
  doc: WorldDocument;
  events: EventSpec[];
}

const DEG = Math.PI / 180;
/** Ground type ids (src/terrain/GroundMaterials.ts). */
export const GROUND = { grass: 0, asphalt: 3, mud: 7 } as const;
const K = (c: number) => c + 273.15;

/** A car (default sedan 4.5 × 1.8 × 1.45 m) at (x, z): yaw about +Y (0 = forward +X), pitch about its own Z (nose up > 0). */
export const vcar = (x: number, z: number, seed: number, yaw = 0, pitch = 0, lift = 0, variant: 'sedan' | 'suv' = 'sedan'): DemoObject => ({
  type: 'car', seed, lift,
  params: variant === 'suv' ? { variant, length: 4.8, width: 1.9, height: 1.75, color: '#7a8a96' } : { variant, length: 4.5, width: 1.8, height: 1.45, color: seed % 2 ? '#3d6fd6' : '#c8463b' },
  transform: { position: [x, 0, z] as Vec3, rotation: [0, yaw, pitch] as Vec3, scale: [1, 1, 1] as Vec3 },
});
/** A wall (anchored structure) of length `len` along Z at x (rotated a quarter turn), or at an angle `yaw`. */
export const wall = (x: number, z: number, seed: number, len = 12, yaw = Math.PI / 2): DemoObject => ({
  type: 'wall', seed, params: { length: len, height: 2, thickness: 0.5, color: '#b9a689' },
  transform: { position: [x, 0, z] as Vec3, rotation: [0, yaw, 0] as Vec3, scale: [1, 1, 1] as Vec3 },
});

/** A car's configuration with occupants referring to the people of the scene by their index (k-th human object). */
export type CarCfg = Omit<VehicleCar, 'occupants'> & { occupants?: { human: number; seat: Seat; restrained: boolean }[] };

export interface VehicleWorld {
  objects: DemoObject[];
  cars: CarCfg[];
  vehicles?: Omit<VehicleSettings, 'model' | 'cars'>;
  height?: (x: number, z: number) => number;
  ground?: (x: number, z: number) => number;
  seed: number;
  name: string;
}

/** The world document of a vehicle demo (vehicle dynamics on; the extended human model for the people). */
export function buildVehicleWorld(w: VehicleWorld): WorldDocument {
  const doc = buildWorld({ objects: w.objects, seed: w.seed, name: w.name, height: w.height, ground: w.ground });
  const objs = Object.values(doc.objects);
  const carIds = objs.filter((o) => o.type === 'car').map((o) => o.id);
  const humanIds = objs.filter((o) => o.type === 'human').map((o) => o.id);
  const cars: Record<string, VehicleCar> = {};
  w.cars.forEach((c, k) => {
    const { occupants, ...rest } = structuredClone(c);
    cars[carIds[k]] = { ...rest, ...(occupants ? { occupants: occupants.map((o) => ({ human: humanIds[o.human], seat: o.seat, restrained: o.restrained })) } : {}) };
  });
  doc.settings.simulation.vehicles = { model: 'dynamics', ...(w.vehicles ?? {}), cars };
  return doc;
}

// ── inputs ──
/** Parked: gear P, parking brake, full service brake. */
export const PARKED: CarCfg = { controls: { gear: 'P', handbrake: true, brake: 1 } };
/** Full throttle from rest until `tBrake`, then neutral and full brake (the braking-distance experiments). */
export const accelBrake = (tBrake: number, abs: boolean, t0 = 0, throttle = 1): CarCfg => ({
  abs,
  program: [{ t: 0, gear: 'D', handbrake: false, brake: t0 > 0 ? 1 : 0, throttle: t0 > 0 ? 0 : throttle }, ...(t0 > 0 ? [{ t: t0, brake: 0, throttle }] : []), { t: tBrake, gear: 'N', throttle: 0, brake: 1 }],
});
/** A straight autopilot path along +X at z from x0 to x1. */
const straight = (x0: number, x1: number, z: number, speed: number, avoid = false): CarCfg => ({ autopilot: { path: [[x0, z], [x1, z]], speed, avoid } });
/** Times of the experiments (s): when the brake / the steering step comes. */
export const T_BRAKE = { dry: 4, hard: 4, wet: 4, snow: 6, ice: 8 } as const;
/** Icing period of the icy road (s): freezing rain on frozen ground before the car moves. */
export const ICE_RAIN = 60;
export const SNOW_DEPTH = 0.05;
/** Depth of the standing water film of the wet road (m). */
export const WET_FILM = 0.01;
export const SLOPE = { hold: 20, start: 12, brake: 10 } as const;
export const CIRCLE_R = 20;
export const CIRCLE_V = 8;
export const SLALOM = { x0: -80, pitch: 18, n: 8, offset: 2.5, speed: 8 } as const;
export const WIND_SPEED = 25;
/** Peak ground acceleration of the earthquake presets — the event's `pga` is in g (not m/s²). */
export const QUAKE_PGA = 0.35;
export const BLAST = { energy: 2e8, near: 12, far: 30 } as const;
export const MOON_G = 1.62;
/** Final flood level (m) of the flood preset. */
export const FLOOD_LEVEL = 1.2;

// ── event specs ──
export const gravityEvent = (p: Partial<GravitySpec>): EventSpec => ({ ...defaultGravitySpec(), scenario: 'custom', global: true, magnitude: EARTH_G, direction: [0, -1, 0], transition: 'vector', profile: 'constant', duration: 600, end: 'hold', sources: [], startTime: 0, ...p } as EventSpec);
export const windEvent = (speed: number, direction: string, duration = 60, startTime = 0): EventSpec => ({ event: 'wind', speed, direction, duration, gustStrength: 0, rampDuration: 2, startTime } as EventSpec);
export const quakeEvent = (pga: number, duration: number, startTime = 0): EventSpec => ({ event: 'earthquake', magnitude: 7, pga, duration, seed: 3, startTime } as EventSpec);
export const risingWater = (level: number, riseRate: number, duration = 600): EventSpec => ({ event: 'risingWater', boundary: 'S', level, riseRate, duration, startTime: 0 } as EventSpec);
export const blastEvent = (x: number, z: number, energy: number, startTime: number): EventSpec => ({ event: 'blast', position: [x, z], height: 1, energy, model: 'weakShock', waveform: 'nWave', startTime } as EventSpec);
export const climateEvent = (p: Partial<ClimateSpec>): EventSpec => ({
  ...defaultClimateSpec(), scenario: 'custom', forcing: 'prescribed', profile: 'constant', humidity: 0.9, humidityTarget: undefined, precipitation: 0, solar: 'off',
  blowingSnow: false, soilMoisture: 0.2, startTime: 0, ...p,
} as EventSpec);

/** A shore: flat for z ≥ 85 (the south edge where the water rises), rising 1 m per 10 m inland (capped at 4 m). */
export const shore = (_x: number, z: number) => Math.min(4, Math.max(0, (85 - z) * 0.1));
const asphalt = () => GROUND.asphalt;
/** Slalom gates: (x, z) of gate k — alternating ±offset across the lane, every `pitch` m. */
export const slalomGates = () => Array.from({ length: SLALOM.n }, (_, k) => [SLALOM.x0 + 20 + k * SLALOM.pitch, k % 2 ? -SLALOM.offset : SLALOM.offset] as [number, number]);
/** The slalom line: a sine through the gates (points every 2.5 m), straight 20 m run-in and run-out. */
export function slalomPath(): [number, number][] {
  const x1 = SLALOM.x0 + 20, x2 = x1 + (SLALOM.n - 1) * SLALOM.pitch;
  const out: [number, number][] = [[SLALOM.x0, 0]];
  for (let x = x1 - SLALOM.pitch / 2; x <= x2 + SLALOM.pitch / 2 + 1e-9; x += 2.5) out.push([x, SLALOM.offset * Math.cos((Math.PI * (x - x1)) / SLALOM.pitch)]);
  out.push([x2 + SLALOM.pitch / 2 + 20, 0]);
  return out;
}
/** The circle path (counter-clockwise seen from above with +Z towards the viewer — a left turn for the driver), closed. */
export const circlePath = (): [number, number][] => Array.from({ length: 33 }, (_, k) => [CIRCLE_R * Math.cos((-k / 32) * 2 * Math.PI), CIRCLE_R * Math.sin((-k / 32) * 2 * Math.PI)] as [number, number]);

/** The world and the events of a vehicle preset. */
export function vehicleDemo(id: VehiclePresetId, seed: number): VehicleDemo {
  const W = (objects: DemoObject[], cars: CarCfg[], extra: Partial<VehicleWorld> = {}) => buildVehicleWorld({ objects, cars, seed, name: id, ground: asphalt, ...extra });
  switch (id) {
    case 'stationary': return { doc: W([vcar(0, 0, 1)], [PARKED]), events: [] };
    // Dropped from 0.15 m: the body falls, lands on the springs and rings down at the damped ride frequency.
    case 'suspensionDrop': return { doc: W([vcar(0, 0, 1, 0, 0, 0.15)], [PARKED]), events: [] };
    case 'constantThrottle': return { doc: W([vcar(-80, 0, 1)], [{ controls: { gear: 'D', throttle: 0.2 } }]), events: [] };
    case 'constantSpeed': return { doc: W([vcar(-85, 0, 1)], [straight(-85, 95, 0, 12)]), events: [] };
    // Two cars side by side, the same full-throttle start and full brake at 4 s: ABS on (z = −4) and ABS off (z = +4).
    case 'hardBraking': return { doc: W([vcar(-80, -4, 1), vcar(-80, 4, 2)], [accelBrake(T_BRAKE.hard, true), accelBrake(T_BRAKE.hard, false)]), events: [] };
    case 'lowSpeedSteer': return { doc: W([vcar(0, 0, 1)], [{ controls: { gear: 'D', throttle: 0.06, steer: 0.5 } }]), events: [] };
    // Full throttle along +X for 4 s, then part throttle with a steering step (left).
    case 'highSpeedSteer': return { doc: W([vcar(-80, 0, 1)], [{ program: [{ t: 0, gear: 'D', throttle: 1 }, { t: 4, throttle: 0.3, steer: 0.5 }] }]), events: [] };
    case 'circle': return { doc: W([vcar(CIRCLE_R, 0, 1, Math.PI / 2)], [{ autopilot: { path: circlePath(), speed: CIRCLE_V, loop: true, avoid: false } }]), events: [] };
    case 'slalom': return { doc: W([vcar(SLALOM.x0, 0, 1)], [{ autopilot: { path: slalomPath(), speed: SLALOM.speed, avoid: false } }]), events: [] };
    // The same full throttle on mud (low friction): front, rear or all-wheel drive of the same sedan.
    case 'fwd': case 'rwd': case 'awd':
      return { doc: W([vcar(-80, 0, 1)], [{ drive: id, controls: { gear: 'D', throttle: 1 } }], { ground: () => GROUND.mud }), events: [] };
    // Locked-wheel stops (ABS off) on four surfaces: dry asphalt, a flood water film, an ice glaze from freezing rain, a snow pack.
    case 'dryAsphalt': return { doc: W([vcar(-80, 0, 1)], [accelBrake(T_BRAKE.dry, false)]), events: [] };
    // A standing water film: the road lies 1 cm below the reference water level (0 m) held at the map edges, so the flood
    // model starts with the connected ground filled to 0 m (Phase 14 initial fill) — a 1 cm film on the whole road.
    case 'wetRoad': {
      const doc = W([vcar(-80, 0, 1)], [accelBrake(T_BRAKE.wet, false)], { height: () => -WET_FILM });
      doc.terrain.settings.waterLevel = 0;
      doc.settings.simulation.water = { ...doc.settings.simulation.water, drainageCapacity: 0, infiltration: false };
      return { doc, events: [risingWater(0, 0.01)] };
    }
    // Freezing rain (60 mm/h for 50 s — heavy and time-compressed) on ground that starts at the −8 °C of the scene: it freezes
    // on contact into an ice glaze (Phase 30 cover ≥ 0.3 kg/m² = ice); the car waits parked, then starts and brakes on it.
    case 'icyRoad': {
      const doc = W([vcar(-80, 0, 1)], [accelBrake(ICE_RAIN + T_BRAKE.ice, false, ICE_RAIN)]);
      doc.settings.simulation.thermal = { ...defaultThermalSettings(), ambient: K(-8) };
      return { doc, events: [climateEvent({ temperature: K(-8), target: K(-8), duration: 600, humidity: 0.95, precipitation: 60, precipPhase: 'rain', precipStart: 0, precipDuration: ICE_RAIN - 10, initialFrost: 0.3 })] };
    }
    case 'snowyRoad': return {
      doc: W([vcar(-80, 0, 1)], [accelBrake(T_BRAKE.snow, false)]),
      events: [climateEvent({ temperature: K(-5), target: K(-5), duration: 600, initialSnow: SNOW_DEPTH, initialSnowDensity: 200, roofSnow: false, initialFrost: 0.2 })],
    };
    // 20° slope (rising towards −X): one parked car on asphalt (z < 0), one on mud (z ≥ 0), both nose downhill.
    case 'slopeHold': return {
      doc: W([vcar(-30, -6, 1, 0, -SLOPE.hold * DEG, 0.05), vcar(-30, 6, 2, 0, -SLOPE.hold * DEG, 0.05)], [PARKED, PARKED], { height: slope(SLOPE.hold, 40, 40), ground: (_x, z) => (z < 0 ? GROUND.asphalt : GROUND.mud) }),
      events: [],
    };
    // 12° slope: two cars facing uphill hold on the brakes for 2 s, then the same throttle: asphalt (z < 0) and mud (z ≥ 0).
    case 'slopeStart': {
      const prog: CarCfg = { program: [{ t: 0, gear: 'D', brake: 1, handbrake: false }, { t: 2, brake: 0, throttle: 0.6 }] };
      return { doc: W([vcar(10, -6, 1, Math.PI, SLOPE.start * DEG, 0.05), vcar(10, 6, 2, Math.PI, SLOPE.start * DEG, 0.05)], [prog, prog], { height: slope(SLOPE.start, 40, 40), ground: (_x, z) => (z < 0 ? GROUND.asphalt : GROUND.mud) }), events: [] };
    }
    // 10° asphalt slope: the car rolls downhill in neutral, then a locked-wheel stop (ABS off) still on the slope.
    case 'slopeBrake': return {
      doc: W([vcar(-75, 0, 1, 0, -SLOPE.brake * DEG, 0.05)], [{ abs: false, program: [{ t: 0, gear: 'N', handbrake: false, brake: 0 }, { t: 7, brake: 1 }] }], { height: slope(SLOPE.brake, 40, 40) }),
      events: [],
    };
    // Lateral gravity step at 0.8 of the static tip angle atan(t / 2h) (tilt-table test, sudden): the car tips over.
    case 'rollover': return { doc: W([vcar(0, 0, 1)], [PARKED], { vehicles: { tire: 'linear' } }), events: [rolloverGravity()] };
    // Full throttle into a wall 20 m ahead; a restrained driver and an unrestrained front passenger.
    case 'frontalCrash': return {
      doc: W([vcar(-22, 0, 1), wall(0.5, 0, 2), person(-40, 20, 3), person(-40, 24, 4)],
        [{ controls: { gear: 'D', throttle: 1 }, occupants: [{ human: 0, seat: 'driver', restrained: true }, { human: 1, seat: 'front', restrained: false }] }]),
      events: [],
    };
    // A parked car broadside (along Z) struck in the side by a car driving along +X.
    case 'sideCrash': return { doc: W([vcar(-25, 0, 1), vcar(0, 0, 2, Math.PI / 2)], [{ program: [{ t: 0, gear: 'D', throttle: 0.6 }, { t: 3.5, gear: 'N', throttle: 0 }] }, PARKED]), events: [] };
    // Head-on: an SUV and a sedan drive at each other, coasting in neutral from 3 s.
    case 'carToCar': {
      const run: CarCfg = { program: [{ t: 0, gear: 'D', throttle: 0.5 }, { t: 3, gear: 'N', throttle: 0 }] };
      return { doc: W([vcar(-24, 0, 1, 0, 0, 0, 'suv'), vcar(24, 0, 2, Math.PI)], [run, run]), events: [] };
    }
    // Oblique (30°) strike into a long wall: the car glances off.
    case 'carToWall': return { doc: W([vcar(-20, -10, 1, -30 * DEG), wall(2, 0, 2, 30)], [{ controls: { gear: 'D', throttle: 0.6 } }]), events: [] };
    case 'carToPerson': return { doc: W([vcar(-14, 0, 1), person(0, 0, 2), person(0, 12, 3)], [{ controls: { gear: 'D', throttle: 0.5 } }]), events: [] };
    // A 25 m/s side wind (across the lane) on a car driving along +X at part throttle and on a parked car.
    case 'crosswind': return {
      doc: W([vcar(-80, 10, 1), vcar(0, -20, 2)], [{ program: [{ t: 0, gear: 'D', throttle: 0.4 }, { t: 3, throttle: 0.12 }] }, PARKED]),
      events: [windEvent(WIND_SPEED, 'N', 60)],
    };
    case 'earthquake': return { doc: W([vcar(0, -10, 1), vcar(-80, 10, 2)], [PARKED, straight(-80, 95, 10, 8)]), events: [quakeEvent(QUAKE_PGA, 15, 1)] };
    // Water rising quickly at the south edge to 1.6 m: a parked car on the flat shore (z = 95, deep) and one inland on the rising bank
    // (z = 75: ground 1.0 m higher, shallow).
    case 'flood': return { doc: W([vcar(0, 95, 1), vcar(20, 80, 2)], [PARKED, PARKED], { height: shore, ground: () => GROUND.grass }), events: [risingWater(FLOOD_LEVEL, 0.5)] };
    // A saturated 32° slope fails above a parked car at its toe (forced failure, Voellmy runout).
    case 'debrisFlow': return {
      doc: W([vcar(8, 0, 1, Math.PI / 2), vcar(8, 40, 2, Math.PI / 2)], [PARKED, PARKED], { height: slope(32, 0, 56), ground: () => GROUND.grass }),
      events: [{ event: 'landslide', area: { kind: 'circle', center: [-14, 0], radius: 12 }, thickness: 2.5, saturation: 1, trigger: 'user', targetSaturation: 1, duration: 10 } as EventSpec],
    };
    case 'blast': return { doc: W([vcar(BLAST.near, 0, 1, Math.PI / 2), vcar(BLAST.far, 0, 2, Math.PI / 2)], [PARKED, PARKED]), events: [blastEvent(0, 0, BLAST.energy, 1)] };
    case 'lowGravity': return { doc: W([vcar(0, 0, 1)], [PARKED]), events: [gravityEvent({ magnitude: MOON_G })] };
    // Earthquake + side wind + a blast while a car drives an autopilot lane and another is parked.
    case 'combined': return {
      doc: W([vcar(-80, 10, 1), vcar(0, -15, 2, Math.PI / 2), person(20, -25, 3)], [straight(-80, 95, 10, 8), PARKED]),
      events: [quakeEvent(0.25, 12, 1), windEvent(20, 'N', 60), blastEvent(-10, -35, BLAST.energy, 6)],
    };
  }
}

/** Rollover preset: the lateral gravity (its direction tilted towards +Z by `share` × the static tip angle of the default sedan). */
export const ROLL_SHARE = 0.8;
/** How long the tilted gravity holds (s) before the field is restored (the car is left where it came to rest). */
export const ROLL_TILT = 3;
function rolloverGravity(): EventSpec {
  const th = ROLL_SHARE * tipAngleSedan();
  return gravityEvent({ direction: [0, -Math.cos(th), Math.sin(th)], startTime: 1, duration: ROLL_TILT, end: 'restore' });
}
/** Static tip angle atan(t / 2h) of the default sedan (rigid body, wheel loads only). */
export function tipAngleSedan(): number {
  const g = vehicleGeometry({ variant: 'sedan', length: 4.5, width: 1.8, height: 1.45 }, 4.5 * 1.8 * 1.45 * CAR_DENSITY);
  return Math.atan(g.track / (2 * g.hcg));
}
