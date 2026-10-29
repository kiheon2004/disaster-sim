/**
 * Phase 33 (spec §54): people in combined hazard scenes — earthquake + building collapse, flood + floating debris, blast +
 * a fall from a ledge, volcanic ejecta, a landslide, reversed gravity among structures, celestial tides, a moving
 * celestial source, a celestial capture and a multi-hazard scene. Each scene runs with the extended human model and with
 * the legacy (Phase 0–32) people model and checks: no NaN / Infinity in poses and velocities, no divergence (every free
 * body's speed stays below a physical bound stated per scene), one IMPACT event per contact episode and one INJURED event
 * per segment and episode (no duplicates for the same person, time and partner / segment), no duplicate force paths.
 *
 * Speed bounds (generous, from energy): a body falling from height h reaches √(2 g h); one under a celestial source can at
 * most reach the escape speed from the softening radius √(2 μ / ε) (plus the source's own speed); a blast or an ejecta
 * impact cannot give a person more than the fragments' speed (well below 300 m/s for the energies used).
 */
import { describe, expect, it } from 'vitest';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { SimulationController } from '@/simulation/SimulationController';
import { buildWorld, building, car, person, slope, type DemoObject } from '@/human/demos';
import { G_N } from '@/celestial/constants';
import { defaultCelestialSpec, defaultSource, type CelestialSourceSpec } from '@/celestial/types';
import { defaultGravitySpec } from '@/gravity/types';

const G = 9.81;
const quake = (pga: number, startTime = 0): EventSpec => ({ event: 'earthquake', magnitude: 7.5, pga, duration: 20, seed: 3, startTime } as EventSpec);
const celestial = (sources: CelestialSourceSpec[]): EventSpec => ({
  ...defaultCelestialSpec(), scenario: 'custom', scale: 'educational', probes: [], tidal: true, lensing: false, limitPolicy: 'warn', end: 'restore',
  accretion: { visual: false, particles: 0, inner: 6, outer: 20, particleMass: 1 }, duration: 600, startTime: 0, sources,
} as EventSpec);
const bh = (p: Partial<CelestialSourceSpec>): CelestialSourceSpec => ({ ...defaultSource(), kind: 'blackHole', massPolicy: 'fixed', motion: 'fixed', ...p });
const escape = (mu: number, eps: number) => Math.sqrt((2 * mu) / eps);
const crowd = (x0: number, z0: number, n: number, seed: number, dx = 3): DemoObject[] => Array.from({ length: n }, (_, k) => person(x0 + (k % 4) * dx, z0 + Math.floor(k / 4) * dx, seed + k));

interface Scene {
  name: string;
  doc: () => WorldDocument;
  events: EventSpec[];
  seconds: number;
  /** Physical upper bound of any free body's speed in the scene (m/s), with its reason. */
  vmax: number;
  /** The scene takes somebody off their feet in the extended model (false: the hazard has no mechanical path to people). */
  falls?: boolean;
  /** Somebody is captured by a celestial source (both models). */
  capture?: boolean;
}

const SCENES: Scene[] = [
  {
    // Debris falls at most from the apartment's roof (≈ 18 m): √(2 g 18) ≈ 19 m/s; ground velocities ≈ 1 m/s.
    name: 'earthquake + building collapse + people',
    doc: () => buildWorld({ seed: 1, objects: [building(0, 0, 1, 'apartment'), building(28, 0, 2, 'house'), ...crowd(-16, -8, 8, 10), person(20, 8, 30), person(0, 40, 31)] }),
    events: [quake(1.2)], seconds: 15, vmax: Math.sqrt(2 * G * 18) + 10,
  },
  {
    // A 1.5 m flood front: flow ≈ 2 √(g h) ≈ 8 m/s at most; floating cars and people move with it.
    name: 'flood + floating debris + people',
    doc: () => buildWorld({ seed: 2, objects: [car(-6, 75, 1), car(6, 72, 2, 0.6), car(0, 60, 3), ...crowd(-6, 80, 4, 10, 4), person(0, 40, 20)] }),
    events: [{ event: 'risingWater', boundary: 'S', level: 1.5, riseRate: 60, duration: 120, startTime: 0 } as EventSpec], seconds: 25, vmax: 2 * Math.sqrt(G * 1.5) + 5,
  },
  {
    // People near the edge of a 6 m ledge, a 5 GJ blast 15 m behind them pushes them over: blast push (≲ 40 m/s measured
    // for 2 GJ at 8 m) plus √(2 g 6) ≈ 11 m/s of the fall.
    name: 'blast + fall from a ledge',
    doc: () => buildWorld({ seed: 3, height: (x) => (x < 0 ? 6 : 0), objects: [person(-1, -3, 1), person(-1.5, 0, 2), person(-1, 3, 3), person(-8, 0, 4), person(10, 0, 5)] }),
    events: [{ event: 'blast', position: [-16, 0], height: 1, energy: 5e9, model: 'weakShock', waveform: 'nWave', startTime: 0.5 } as EventSpec],
    seconds: 8, vmax: 60 + Math.sqrt(2 * G * 6),
  },
  {
    // Ballistic bombs leave the vent at most at a few tens of m/s; a person struck takes far less (≪ 300 m/s). A bomb that
    // lands on a person is recorded as an ejecta IMPACT (volcano/objects.ts strike) but gives no impulse to the body, and
    // lava is not a ForceLedger source of the balance model — so nobody is expected to fall here (model limit).
    name: 'volcanic ejecta + people',
    doc: () => buildWorld({ seed: 4, objects: [...crowd(10, -6, 8, 10, 4), building(-20, 20, 1, 'house')] }),
    events: [{ event: 'volcano', vents: [{ kind: 'central', position: [0, 0], radius: 2 }], material: 'basalt', temperature: 1150, rate: 6, duration: 600, profile: 'constant', bombFraction: 0.3, ashFraction: 0.1, plumeHeight: 60, startTime: 0 } as EventSpec],
    seconds: 15, vmax: 300, falls: false,
  },
  {
    // A 32° slope (up to 56 m) fails above people at its toe: debris and people slide at most from the slope top,
    // √(2 g 56) ≈ 33 m/s.
    name: 'landslide + people',
    doc: () => buildWorld({ seed: 5, height: slope(32, 0, 56), objects: [person(3, -4, 1), person(6, 0, 2), person(4, 5, 3), person(20, 0, 4), person(-25, 12, 5)] }),
    events: [{ event: 'landslide', area: { kind: 'circle', center: [-14, 0], radius: 12 }, thickness: 2.5, saturation: 1, trigger: 'user', targetSaturation: 1, duration: 10 } as EventSpec],
    seconds: 25, vmax: Math.sqrt(2 * G * 56) + 5,
  },
  {
    // Reversed for 5 s (2 s smooth ramp), then restored over the same ramp: bodies rise at most g·5 s ≈ 50 m/s and fall
    // back from ≤ ½ g 5² ≈ 125 m: √(2 g 125) ≈ 50 m/s.
    name: 'reversed gravity + structures + people',
    doc: () => buildWorld({ seed: 6, objects: [building(-15, -15, 1, 'house'), building(15, -15, 2, 'house'), car(0, 5, 3), ...crowd(-6, 10, 6, 10)] }),
    events: [{ ...defaultGravitySpec(), scenario: 'reverse', global: true, magnitude: G, direction: [0, 1, 0], transition: 'vector', profile: 'smooth', ramp: 2, duration: 5, end: 'restore', sources: [], startTime: 1 } as EventSpec],
    seconds: 12, vmax: 2 * G * 5 + 10,
  },
  {
    // The tidal-stretch source of Phase 32 (μ = 3·10⁴ m³/s², ε = 2 m) over a block with houses and people.
    name: 'celestial tides + people',
    doc: () => buildWorld({ seed: 7, objects: [building(-20, -20, 1, 'house'), building(10, -25, 2, 'house'), ...crowd(-10, 10, 8, 10, 5), person(40, 40, 30)] }),
    events: [celestial([bh({ center: [-10, 20, 6], mass: 3e4 / G_N, softening: 2, capture: 1, ramp: 6 })])], seconds: 20, vmax: escape(3e4, 2) + 10,
  },
  {
    // A source (μ = 8·10⁴ m³/s², ε = 2.5 m) crossing the block at 6 m/s, 22 m up.
    name: 'moving celestial source + people',
    doc: () => buildWorld({ seed: 8, objects: [building(-30, -20, 1, 'house'), building(30, -20, 2, 'house'), car(-10, 10, 3), ...crowd(-15, 0, 8, 10, 8)] }),
    events: [celestial([bh({ center: [-60, 22, 0], mass: 8e4 / G_N, softening: 2.5, capture: 2, ramp: 3, motion: 'path', path: [[0, -60, 22, 0], [20, 60, 22, 0]] })])],
    seconds: 20, vmax: escape(8e4, 2.5) + 6 + 10,
  },
  {
    // The Phase 32 capture preset's source (μ = 5·10⁴ m³/s², ε = 2 m, capture 2.5 m) 12 m above a group of people.
    name: 'celestial capture + people',
    doc: () => buildWorld({ seed: 9, objects: [building(15, -20, 1, 'house'), ...crowd(-14, 4, 8, 10), person(40, 0, 30)] }),
    events: [celestial([bh({ center: [-10, 12, 8], mass: 5e4 / G_N, softening: 2, capture: 2.5, ramp: 3 })])], seconds: 15, vmax: escape(5e4, 2) + 10, capture: true,
  },
  {
    // Earthquake + gusty wind + a blast among houses, cars and people (no rain: the 2-D water solver over the whole map
    // would dominate the run time without adding a path to people that the flood scene does not already cover).
    name: 'multi-hazard (earthquake + wind + blast)',
    doc: () => buildWorld({ seed: 10, objects: [building(-25, -20, 1, 'house'), building(0, -22, 2, 'apartment'), building(25, -20, 3, 'house'), car(-10, 8, 4), car(10, 8, 5), ...crowd(-12, 15, 12, 10, 4)] }),
    events: [
      quake(0.5, 2),
      { event: 'wind', speed: 25, direction: 'E', duration: 30, gustStrength: 0.3, rampDuration: 4, startTime: 0 } as EventSpec,
      { event: 'blast', position: [30, 30], height: 1, energy: 2e9, model: 'weakShock', waveform: 'nWave', startTime: 8 } as EventSpec,
    ],
    seconds: 15, vmax: 100,
  },
];

interface Outcome { maxSpeed: number; people: number; extendedFalls: number; captured: number }

async function runScene(s: Scene, extended: boolean): Promise<Outcome> {
  const doc = s.doc();
  if (!extended) delete doc.settings.simulation.humans;
  const c = new SimulationController({ headless: true });
  await c.load(doc);
  for (const e of s.events) c.addEvent(e);
  const rt = c.getRuntime()!, ph = c.getPhysics()!;
  const all = [...rt.entities.values()];
  const people = all.filter((e) => e.source.type === 'human');
  let maxSpeed = 0;
  const dt = 0.25;
  for (let t = 0; t < s.seconds - 1e-9; t += dt) {
    c.advance(dt);
    for (const e of all) {
      const at = `${s.name} [${extended ? 'extended' : 'legacy'}] ${e.source.type} ${e.id} t=${(t + dt).toFixed(2)}`;
      expect(e.pose.position.every(Number.isFinite) && e.pose.quaternion.every(Number.isFinite), `pose ${at}`).toBe(true);
      if (e.body === null || !e.dynamic) continue;
      const v = ph.getLinearVelocity(e.body), w = ph.getAngularVelocity(e.body);
      expect([...v, ...w].every(Number.isFinite), `velocity ${at}`).toBe(true);
      const sp = Math.hypot(v[0], v[1], v[2]);
      if (sp > maxSpeed) maxSpeed = sp;
      expect(sp, `speed ${at}`).toBeLessThan(s.vmax);
    }
    for (const e of people) if (e.human) expect([...e.human.v, ...e.human.w, e.health].every(Number.isFinite), `human state ${s.name}`).toBe(true);
  }
  const ev = c.getDamageEvents();
  const impact = ev.filter((d) => d.eventType === 'IMPACT' && d.human).map((d) => `${d.objectId}|${d.time}|${d.human!.partner}`);
  expect(new Set(impact).size, `${s.name}: duplicate IMPACT events`).toBe(impact.length);
  const injured = ev.filter((d) => d.eventType === 'INJURED' && d.human).map((d) => `${d.objectId}|${d.time}|${d.human!.segment}|${d.human!.partner}`);
  expect(new Set(injured).size, `${s.name}: duplicate INJURED events`).toBe(injured.length);
  expect(c.duplicateForces(), `${s.name}: duplicate forces`).toBe(0);
  if (extended) {
    for (const e of people) {
      expect(e.human, `${s.name}: extended state`).toBeDefined();
      for (const r of Object.values(e.human!.risk)) expect(Number.isFinite(r.cum) && r.cum >= 0).toBe(true);
    }
  } else for (const e of people) expect(e.human).toBeUndefined();
  return { maxSpeed, people: people.length, extendedFalls: people.reduce((n, e) => n + (e.human?.falls ?? 0), 0), captured: people.filter((e) => e.flags.captured).length };
}

describe('people in combined hazard scenes (extended and legacy model)', () => {
  for (const s of SCENES) {
    it(s.name, async () => {
      const ext = await runScene(s, true);
      const leg = await runScene(s, false);
      expect(ext.people).toBe(leg.people);
      // Every scene with a mechanical path to people is strong enough to take somebody off their feet.
      if (s.falls !== false) expect(ext.extendedFalls).toBeGreaterThan(0);
      if (s.capture) { expect(ext.captured).toBeGreaterThan(0); expect(leg.captured).toBeGreaterThan(0); }
    }, 300000);
  }
});
