/**
 * A/B identity (Phase 26): the same no-heat scenes run on this build and on the Phase 25 build must give
 * bit-identical results. Writes one SHA-256 per scene (damage events, collapse records, rubble, poses,
 * water) to IDENTITY_OUT.
 * Phase 27: IDENTITY_HEAT=1 adds heat-source scenes (no fire) whose thermal state is hashed too — with
 * the fire system off they must be bit-identical to the Phase 26 build.
 * Phase 28: IDENTITY_FIRE=1 adds fire scenes (room fire, burning stand, heat ignition) whose fire and thermal
 * state is hashed too — with the volcano system off they must be bit-identical to the Phase 27 build.
 * Phase 29: IDENTITY_ATMOS=1 adds (on top of the heat and fire scenes) an empty world, a meteor entering the
 * atmosphere, lava, ash with wind, volcano + fire and a multi-hazard town, with the volcano state hashed —
 * without an atmosphere experiment they must be bit-identical to the Phase 28 build. (Uses only Phase 28
 * APIs, so the same file runs on that build.)
 * Phase 30: IDENTITY_CLIMATE=1 adds (on top of all the above) atmospheric removal / restoration, long lava cooling and a
 * smoke scene, with the atmosphere state hashed — without a climate experiment they must be bit-identical to the
 * Phase 29 build. The flood budget is hashed through its Phase 14 keys (Phase 30 adds phase-change terms that stay
 * zero without a climate — listing the keys keeps the same hash input on both builds).
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, it } from 'vitest';
import type { Vec3 } from '@/core/types';
import { useWorldStore } from '@/world/worldStore';
import { createEmptyDocument } from '@/world/WorldDocument';
import { SimulationController } from '@/simulation/SimulationController';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';

const S = () => useWorldStore.getState();
const tf = (x: number, z: number) => ({ position: [x, 0, z] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
const D = (id: string) => createDesign(presetSpec(id)!, id);
function world(add: { type: string; building?: ReturnType<typeof D>; seed: number; transform: ReturnType<typeof tf> }[]): WorldDocument {
  S().setLocked(false);
  S().replaceDocument(createEmptyDocument('identity'));
  if (add.length) S().applyEdit({ add: add as never });
  return structuredClone(S().doc);
}
const houses = (n: number) => Array.from({ length: n }, (_, k) => ({ type: 'building', building: D('house'), seed: k + 1, transform: tf(-30 + (k % 6) * 12, k < 6 ? 12 : -12) }));
const SCENES: { name: string; doc: () => WorldDocument; events: EventSpec[]; seconds: number }[] = [
  { name: 'street earthquake 1.1 g', doc: () => world([{ type: 'building', building: D('apartment'), seed: 1, transform: tf(0, 0) }, { type: 'building', building: D('house'), seed: 2, transform: tf(18, 0) }, ...[0, 1, 2, 3].map((k) => ({ type: 'car', seed: 20 + k, transform: tf(-12 + k * 6, 10) }))]), events: [{ event: 'earthquake', magnitude: 7.5, pga: 1.1, duration: 20, seed: 3 } as EventSpec], seconds: 20 },
  { name: 'blast 12 houses', doc: () => world(houses(12)), events: [{ event: 'blast', position: [0, 0], height: 1, energy: 2e9, model: 'weakShock', waveform: 'nWave', startTime: 0.5 } as EventSpec], seconds: 8 },
  { name: 'flood + rain', doc: () => world([0, 1, 2].map((k) => ({ type: 'building', building: D('house'), seed: k + 1, transform: tf(-20 + k * 14, 0) }))), events: [{ event: 'rain', intensity: 200, duration: 60 } as EventSpec, { event: 'waterSource', position: [0, 20], rate: 6, duration: 60, radius: 3 } as EventSpec], seconds: 30 },
  { name: 'wind cladding', doc: () => world([{ type: 'building', building: D('office'), seed: 1, transform: tf(0, 0) }, { type: 'tree', seed: 4, transform: tf(20, 5) }]), events: [{ event: 'wind', speed: 48, direction: 'E', duration: 40 } as EventSpec], seconds: 20 },
  { name: 'impact', doc: () => world([{ type: 'building', building: D('house'), seed: 1, transform: tf(30, 0) }]), events: [{ event: 'impact', target: [6, 6], material: 'stony', diameter: 1, speed: 15000, angle: 70, azimuth: 45, entry: 'direct', airBlast: true } as EventSpec], seconds: 12 },
];

const heat = (p: Record<string, unknown>): EventSpec => ({ event: 'heatSource', kind: 'point', position: [0, 0], height: 1.5, radius: 2, input: 'power', power: 2e6, profile: 'constant', duration: 120, ...p } as EventSpec);
const HEAT_SCENES: typeof SCENES = [
  { name: 'heat: warehouse room fire-like source', doc: () => world([{ type: 'building', building: D('warehouse'), seed: 1, transform: tf(0, 0) }]), events: [heat({ power: 8e6, duration: 300 })], seconds: 300 },
  { name: 'heat: house + trees, ramp', doc: () => world([{ type: 'building', building: D('house'), seed: 1, transform: tf(0, 0) }, { type: 'tree', seed: 2, transform: tf(9, 0) }, { type: 'tree', seed: 3, transform: tf(-9, 3) }]), events: [heat({ position: [5, 0], power: 3e6, profile: 'ramp', rampTime: 30, duration: 90 })], seconds: 90 },
  { name: 'heat: apartment temperature sphere + earthquake', doc: () => world([{ type: 'building', building: D('apartment'), seed: 1, transform: tf(0, 0) }]), events: [heat({ kind: 'temperature', temperature: 1073.15, radius: 3, height: 2, duration: 120 }), { event: 'earthquake', magnitude: 6.5, pga: 0.4, duration: 15, seed: 3, startTime: 60 } as EventSpec], seconds: 90 },
  { name: 'heat: surface + rain', doc: () => world([{ type: 'tree', seed: 2, transform: tf(3, 0) }]), events: [heat({ kind: 'surface', radius: 6, power: 1e6, duration: 60 }), { event: 'rain', intensity: 100, duration: 60 } as EventSpec], seconds: 60 },
];

const fireSettings = (p: Record<string, unknown> = {}) => ({ foliageMoisture: 1.5, openings: 'windowsOpen', heatIgnition: false, ...p });
const conifer = (x: number, z: number, seed: number) => ({ type: 'tree', params: { species: 'conifer', height: 11, canopyRadius: 2.2, trunkRadius: 0.32 }, seed, transform: tf(x, z) });
const withFire = (d: WorldDocument, p: Record<string, unknown> = {}) => { (d.settings.simulation as unknown as Record<string, unknown>).fire = fireSettings(p); return d; };
const FIRE_SCENES: typeof SCENES = [
  { name: 'fire: house room fire, windows open', doc: () => withFire(world([{ type: 'building', building: D('house'), seed: 7, transform: tf(0, 0) }, conifer(9, 0, 1) as never])), events: [{ event: 'fire', position: [0, 0], height: 1, radius: 1, duration: 900 } as EventSpec], seconds: 600 },
  { name: 'fire: dry stand + wind', doc: () => withFire(world(Array.from({ length: 12 }, (_, k) => conifer(-10 + (k % 4) * 6, -6 + Math.floor(k / 4) * 6, 30 + k) as never)), { foliageMoisture: 0.2 }), events: [{ event: 'wind', speed: 8, direction: 'W', duration: 300 } as EventSpec, { event: 'fire', position: [-10, -6], height: 6, radius: 2, duration: 300 } as EventSpec], seconds: 180 },
  { name: 'fire: heat ignition of a dry crown', doc: () => withFire(world([conifer(0, 0, 3) as never]), { foliageMoisture: 0.2, heatIgnition: true }), events: [heat({ position: [3, 0], height: 4, power: 2e6, duration: 120 })], seconds: 120 },
];

const erupt = (p: Record<string, unknown> = {}): EventSpec => ({ event: 'volcano', vents: [{ kind: 'central', position: [-40, 0], radius: 2 }], material: 'basalt', temperature: 1150, rate: 2, duration: 120, profile: 'constant', ...p } as EventSpec);
const ATMOS_SCENES: typeof SCENES = [
  { name: 'atmos: empty world', doc: () => world([]), events: [], seconds: 10 },
  { name: 'atmos: meteor atmospheric entry', doc: () => world([{ type: 'building', building: D('house'), seed: 1, transform: tf(30, 0) }]), events: [{ event: 'impact', target: [0, 0], material: 'stony', diameter: 2, speed: 18000, angle: 45, azimuth: 90, entry: 'atmosphere', airBlast: true } as EventSpec], seconds: 20 },
  { name: 'atmos: lava', doc: () => world([{ type: 'building', building: D('house'), seed: 1, transform: tf(-25, 0) }, conifer(-30, 8, 2) as never]), events: [erupt()], seconds: 120 },
  { name: 'atmos: ash + wind', doc: () => world(houses(4)), events: [{ event: 'wind', speed: 8, direction: 'W', duration: 300 } as EventSpec, erupt({ ashFraction: 0.2, bombFraction: 0.05, plumeHeight: 80 })], seconds: 120 },
  { name: 'atmos: volcano + fire + rain', doc: () => withFire(world([conifer(-32, 0, 3) as never, conifer(-26, 4, 4) as never]), { foliageMoisture: 0.2 }), events: [erupt({ rate: 3 }), { event: 'rain', intensity: 20, duration: 120 } as EventSpec], seconds: 120 },
  { name: 'atmos: multi-hazard town', doc: () => withFire(world([...houses(8), conifer(30, 25, 9) as never])), events: [{ event: 'wind', speed: 20, direction: 'E', duration: 120 } as EventSpec, { event: 'earthquake', magnitude: 6.5, pga: 0.35, duration: 15, seed: 3, startTime: 10 } as EventSpec, { event: 'fire', position: [-30, 12], height: 1, radius: 1, duration: 300 } as EventSpec, heat({ position: [20, -30], power: 2e6, duration: 60 })], seconds: 90 },
];

const atm = (p: Record<string, unknown>): EventSpec => ({ event: 'atmosphere', altitude: 0, boundary: 'open', thermo: 'adiabatic', removal: 'none', startTime: 0, ...p } as EventSpec);
const CLIMATE_SCENES: typeof SCENES = [
  { name: 'climate-off: atmospheric removal + wind', doc: () => world(houses(4)), events: [atm({ removal: 'linear', extent: 'uniform', target: 0.3, duration: 60 }), { event: 'wind', speed: 15, direction: 'W', duration: 300 } as EventSpec], seconds: 90 },
  { name: 'climate-off: atmospheric restoration', doc: () => world([]), events: [atm({ boundary: 'closed', removal: 'linear', target: 0.4, duration: 30, restore: 'reservoir', restoreAt: 40, restoreDuration: 30, restoreTarget: 1 })], seconds: 80 },
  { name: 'climate-off: lava cooling (long)', doc: () => world([]), events: [erupt({ duration: 60 })], seconds: 300 },
  { name: 'climate-off: smoke (stand fire + wind)', doc: () => withFire(world(Array.from({ length: 8 }, (_, k) => conifer(-10 + (k % 4) * 6, -3 + Math.floor(k / 4) * 6, 60 + k) as never)), { foliageMoisture: 0.2 }), events: [{ event: 'wind', speed: 5, direction: 'W', duration: 300 } as EventSpec, { event: 'fire', position: [-10, -3], height: 6, radius: 2, duration: 300 } as EventSpec], seconds: 120 },
];

function atmosLines(c: SimulationController): string[] {
  const ar = (c.getEnvironment() as unknown as { atmosphere?: { rt: { field: { sigma: Float64Array; Ux: Float64Array; gas: Float64Array; mass: object; energy: object } } | null } }).atmosphere?.rt;
  if (!ar) return ['no-atmosphere'];
  const f = ar.field;
  return [Array.from(f.sigma).join(','), Array.from(f.Ux).join(','), Array.from(f.gas).join(','), JSON.stringify(f.mass), JSON.stringify(f.energy)];
}

function volcanoLines(c: SimulationController): string[] {
  const vr = c.getEnvironment().volcano.rt;
  if (!vr) return ['no-volcano'];
  const f = vr.world.field;
  return [Array.from(f.M).join(','), Array.from(f.dep).join(','), Array.from(f.depE).join(','), vr.world.puffs.map((p) => [p.x, p.y, p.z, p.mass].join(':')).join(','), JSON.stringify(vr.world.ledger())];
}

function fireLines(c: SimulationController): string[] {
  const fr = c.getEnvironment().fire.rt;
  if (!fr) return ['no-fire'];
  const fw = fr.fw, lines: string[] = [];
  for (let i = 0; i < fw.n; i++) lines.push([fw.kind[i], fw.state[i], fw.m[i], fw.E[i], fw.char[i], fw.tIgn[i], fr.cause[i]].join('|'));
  for (const R of fw.rooms) lines.push([R.o2, R.soot, R.Ao, R.flashover].join('|'));
  lines.push(Array.from(fw.soot).join(','), JSON.stringify(fw.ledger.snapshot()));
  return lines;
}

function thermalLines(c: SimulationController): string[] {
  const rt = c.getEnvironment().thermal.rt;
  if (!rt) return ['no-thermal'];
  const w = rt.world, B = w.bodies, L = w.ledger;
  const lines: string[] = [];
  for (let i = 0; i < B.n; i++) lines.push([B.kind[i], B.alive[i], B.ES[i], B.EC[i], B.mS[i], B.TmaxS[i]].join('|'));
  w.terrain.forActive((cc) => { for (let l = 0; l < w.terrain.nl; l++) lines.push(String(w.terrain.E[cc * w.terrain.nl + l])); });
  lines.push(Array.from(w.air.E).join(','), w.comps.map((x) => x.E).join(','));
  lines.push([L.added, L.boundarySupply, L.impactDeposit, L.lost.radiationSky, L.lost.unresolvedRadiation, L.lost.atmosphere, L.lost.airAdvection, L.lost.aboveLayer, L.lost.deepGround, L.lost.water, L.lost.debris, L.final].join('|'));
  return lines;
}

describe.skipIf(!process.env.IDENTITY_OUT)('identity', () => {
  it('scenes', { timeout: 3_600_000 }, async () => {
    const out: Record<string, string> = {};
    const CLI = !!process.env.IDENTITY_CLIMATE, ATM = !!process.env.IDENTITY_ATMOS || CLI, FIRE = !!process.env.IDENTITY_FIRE || ATM, HEAT = !!process.env.IDENTITY_HEAT || FIRE;
    for (const sc of [...SCENES, ...(HEAT ? HEAT_SCENES : []), ...(FIRE ? FIRE_SCENES : []), ...(ATM ? ATMOS_SCENES : []), ...(CLI ? CLIMATE_SCENES : [])]) {
      const c = new SimulationController({ headless: true });
      await c.load(sc.doc());
      for (const e of sc.events) c.addEvent(e);
      c.advance(sc.seconds);
      const rt = c.getRuntime()!;
      const lines: string[] = [];
      lines.push(...c.getDamageEvents().map((e) => [e.time, e.objectType, e.eventType, e.componentId ?? '', e.hazard, e.cause, ...e.worldPosition].join('|')));
      for (const e of rt.entities.values()) {
        lines.push([e.source.type, e.state, ...e.pose.position, ...e.pose.quaternion].join('|'));
        const m = e.modular?.structure?.model;
        if (m) lines.push(...m.records.map((r) => [r.i, r.time, r.cause, r.trigger, r.root, r.u, r.hazard].join('|')), Array.from(m.dy).join(','));
      }
      if (rt.structures) lines.push(...rt.structures.rubble.heaps.map((h) => [h.mass, h.height, h.cx, h.cz].join('|')));
      const f = c.getEnvironment().flood.field;
      if (f) { const b = f.budget as unknown as Record<string, number>; lines.push(Array.from(f.h).reduce((a, x) => a + x, 0).toString(), JSON.stringify(['initial', 'rain', 'sources', 'boundaryIn', 'boundaryOut', 'infiltration', 'drainage', 'current', 'error'].map((k) => b[k]))); }
      if (HEAT) for (const l of thermalLines(c)) lines.push(l);
      if (FIRE) for (const l of fireLines(c)) lines.push(l);
      if (ATM) for (const l of volcanoLines(c)) lines.push(l);
      if (CLI) for (const l of atmosLines(c)) lines.push(l);
      out[sc.name] = createHash('sha256').update(lines.join('\n')).digest('hex');
      c.unload();
    }
    fs.writeFileSync(process.env.IDENTITY_OUT!, JSON.stringify(out, null, 1));
  });
});
