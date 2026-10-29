/**
 * Phase 27: fire in the simulation — room fires (t² growth, ventilation, flashover, window glass,
 * spread between stories), fire-weakened timber structures through the collapse engine (charred
 * section never restoring strength), vegetation (spacing, moisture, wind, rain), heat-source ignition
 * only when enabled, ledgers (fuel, chemical energy = thermal combustion account, oxygen, smoke),
 * determinism, object-id independence, original-world restoration, save / load.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@/core/types';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { createEmptyDocument, createWorldObject, nextSerial, type CreateObjectInput } from '@/world/WorldDocument';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import type { BuildingDesign } from '@/buildings/types';
import { createInstance } from '@/phenomena/schedule';
import { E_O2, Y_O2_LIMIT } from '@/fire/materials';
import { FS, IK, isBurning } from '@/fire/FireWorld';
import type { FireSettings } from '@/fire/types';
import { SimulationController } from '../SimulationController';
import type { FireRuntime } from './runtime';

const T = (x = 0, z = 0): CreateObjectInput['transform'] => ({ position: [x, 0, z] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
const design = (id: string) => createDesign(presetSpec(id)!, id);
const B = (d: BuildingDesign, x = 0, z = 0, seed = 7): CreateObjectInput => ({ type: 'building', building: d, seed, transform: T(x, z) });
const tree = (x: number, z: number, seed = 3): CreateObjectInput => ({ type: 'tree', params: { species: 'conifer', height: 11, canopyRadius: 2.2, trunkRadius: 0.32 }, seed, transform: T(x, z) });

function doc(inputs: CreateObjectInput[], fire?: Partial<FireSettings>): WorldDocument {
  const d = createEmptyDocument('p27');
  for (const input of inputs) {
    const o = createWorldObject(input, nextSerial(d.objects, input.type));
    d.objects[o.id] = o;
  }
  d.settings.simulation.seed = 42;
  if (fire) d.settings.simulation.fire = { foliageMoisture: 1.5, openings: 'asBuilt', heatIgnition: false, ...fire };
  return d;
}

const ignite = (p: Partial<Extract<EventSpec, { event: 'fire' }>> = {}): EventSpec => ({ event: 'fire', position: [0, 0], height: 1, radius: 1, duration: 600, ...p } as EventSpec);

async function load(d: WorldDocument, specs: EventSpec[]) {
  const c = new SimulationController({ headless: true });
  await c.load(d);
  for (const s of specs) c.addEvent(s);
  return c;
}

const frOf = (c: SimulationController): FireRuntime => c.getEnvironment().fire.rt!;

/** Hash of the fire and thermal state (items in registration order, rooms, structure records). */
function fireHash(c: SimulationController): string {
  const fr = frOf(c), fw = fr.fw, w = fr.trt.world, Bd = w.bodies;
  const parts: string[] = [];
  for (let i = 0; i < fw.n; i++) parts.push(`${fw.kind[i]}|${fw.state[i]}|${fw.m[i]}|${fw.water[i]}|${fw.E[i]}|${fw.char[i]}|${fw.tIgn[i]}`);
  for (const R of fw.rooms) parts.push(`${R.o2}|${R.soot}|${R.Ao}|${R.flashover}`);
  for (let i = 0; i < Bd.n; i++) parts.push(`${Bd.alive[i]}|${Bd.ES[i]}|${Bd.EC[i]}|${Bd.mS[i]}`);
  parts.push(...Array.from(fw.soot, String), JSON.stringify(fw.ledger.snapshot()), JSON.stringify(w.ledger.snapshot()));
  for (const e of c.getRuntime()!.entities.values()) {
    const m = e.modular?.structure?.model;
    if (m) parts.push(...m.records.map((r) => [r.i, r.time, r.cause, r.hazard].join('|')));
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

function expectLedgersClosed(fr: FireRuntime) {
  const L = fr.fw.ledger, TL = fr.trt.world.ledger;
  expect(Math.abs(L.chemResidual()) / Math.max(1, L.chemRegistered)).toBeLessThan(1e-9);
  expect(Math.abs(L.fuelResidual()) / Math.max(1, L.fuelRegistered)).toBeLessThan(1e-9);
  expect(Math.abs(L.smokeResidual())).toBeLessThan(1e-6 * Math.max(1, L.smokeProduced));
  // The heat of combustion entered the thermal world exactly once (its own ledger account).
  expect(Math.abs(TL.combustion - L.released)).toBeLessThan(1e-6 * Math.max(1, L.released));
  expect(L.oxygenConsumed).toBeCloseTo(L.released / E_O2, 3);
  expect(TL.relativeResidual()).toBeLessThan(1e-9);
}

describe('fire channel', () => {
  it('stays dormant without a fire; a heat source does not start the combustion model unless heat ignition is on', { timeout: 180_000 }, async () => {
    const c = await load(doc([B(design('house'))]), [{ event: 'heatSource', kind: 'point', position: [0, 9], height: 1.5, radius: 2, input: 'power', power: 3e5, profile: 'constant', duration: 30 } as EventSpec]);
    c.advance(5);
    expect(c.getEnvironment().thermal.rt).not.toBeNull();
    expect(c.getEnvironment().fire.rt).toBeNull();
    expect(c.getEnvironment().thermal.rt!.world.hasGasRadiation).toBe(false);
    c.unload();
    const c2 = await load(doc([B(design('house'))], { heatIgnition: true }), [{ event: 'heatSource', kind: 'point', position: [0, 9], height: 1.5, radius: 2, input: 'power', power: 3e5, profile: 'constant', duration: 30 } as EventSpec]);
    c2.advance(5);
    expect(c2.getEnvironment().fire.rt).not.toBeNull();
    c2.unload();
  });

  it('rejects an ignition where nothing can burn, with a reason', { timeout: 180_000 }, async () => {
    const c = await load(doc([B(design('apartment'), 30, 0)]), [ignite({ position: [-30, -30] })]);
    c.advance(2);
    const ig = c.getEnvironment().fire.ignitions[0];
    expect(ig.done).toBe(true);
    expect(ig.lit).toBe(0);
    expect(ig.reason).toBe('fire.reject.noFuel');
    expect(c.getMilestones().some((m) => m.kind === 'ignitionRejected')).toBe(true);
    c.unload();
  });
});

describe('room fire in a timber house', () => {
  it('closed: t² growth, then oxygen-limited — the room never goes below the limiting O₂ fraction; ledgers close', { timeout: 180_000 }, async () => {
    const c = await load(doc([B(design('house'))]), [ignite()]);
    c.advance(240);
    const fr = frOf(c), fw = fr.fw;
    const ci = fw.rooms[0].contents;
    expect(fw.kind[ci]).toBe(IK.contents);
    // EN 1991-1-2 medium growth (t_α = 300 s): 1 MW·(t/300)².
    expect(fw.hrr[ci]).toBeGreaterThan(0.85 * 1e6 * (240 / 300) ** 2);
    expect(fw.hrr[ci]).toBeLessThan(1.05 * 1e6 * (240 / 300) ** 2);
    c.advance(660);
    expect(c.getMilestones().some((m) => m.kind === 'oxygenLimited')).toBe(true);
    for (const R of fw.rooms) expect(R.o2).toBeGreaterThanOrEqual(Y_O2_LIMIT * R.gas * 0.999);
    expect(fw.hrrNow).toBeLessThan(0.3e6);
    expectLedgersClosed(fr);
    c.unload();
  });

  it('windows open: glass breaks, flashover, external flames, the upper story catches fire; the structure fails with hazard fire', { timeout: 300_000 }, async () => {
    const d = design('house');
    const before = JSON.stringify(d);
    const c = await load(doc([B(d)], { openings: 'windowsOpen' }), [ignite({ duration: 3600 })]);
    const fr = () => frOf(c);
    // Strength of charring members is never restored.
    const lastF = new Map<number, number>();
    let restored = 0;
    for (let t = 0; t < 3600; t += 60) {
      c.advance(60);
      const bt = fr().trt.buildings[0];
      for (let i = 0; i < fr().fw.n; i++) {
        if (fr().fw.kind[i] !== IK.member || fr().fw.char[i] <= 0) continue;
        const m = fr().fw.sub[i];
        const f = bt.fApplied[m];
        if (f > (lastF.get(m) ?? 1) + 1e-9) restored++;
        lastF.set(m, f);
      }
    }
    expect(restored).toBe(0);
    const ms = c.getMilestones();
    const at = (k: string) => ms.find((m) => m.kind === k)?.time ?? NaN;
    expect(at('flashover')).toBeGreaterThan(400);
    expect(at('flashover')).toBeLessThan(1200);
    expect(at('windowBreak')).toBeLessThan(at('flashover') + 60);
    expect(fr().fw.rooms.every((R) => !Number.isNaN(R.flashover))).toBe(true); // the upper story too
    expect(fr().fw.ledger.releasedExternal).toBeGreaterThan(0);
    expect(fr().stats.fireFailures).toBeGreaterThan(0);
    expect(at('fireFailure')).toBeGreaterThan(at('flashover'));
    expectLedgersClosed(fr());
    // The shared design (blueprint) is never written.
    expect(JSON.stringify(d)).toBe(before);
    c.unload();
  });
});

describe('vegetation', () => {
  const stand = (sp: number) => [tree(0, 0, 1), tree(sp, 0, 2), tree(2 * sp, 0, 3)];
  const crowns = (c: SimulationController) => {
    const fw = frOf(c).fw;
    const out: number[] = [];
    for (let i = 0; i < fw.n; i++) if (fw.kind[i] === IK.foliage) out.push(1 - fw.m[i] / fw.m0[i]);
    return out;
  };

  it('dry crowns 5 m apart burn one after another; 7 m apart the fire stops in calm air and crosses in a wind', { timeout: 180_000 }, async () => {
    let c = await load(doc(stand(5), { foliageMoisture: 0.2 }), [ignite({ height: 6, radius: 2 })]);
    c.advance(120);
    expect(crowns(c).every((b) => b > 0.9)).toBe(true);
    expect(c.getMilestones().some((m) => m.kind === 'fireSpread')).toBe(true);
    // A burned crown: canopy gone in the view and the wind load, destroyed by fire.
    const t0 = [...c.getRuntime()!.entities.values()].find((e) => e.source.type === 'tree')!;
    expect(t0.visual.burned).toBeGreaterThan(0.9);
    expect(c.getDamageEvents().some((ev) => ev.objectId === t0.id && ev.eventType === 'DESTROYED' && ev.cause === 'fire')).toBe(true);
    expectLedgersClosed(frOf(c));
    c.unload();
    c = await load(doc(stand(7), { foliageMoisture: 0.2 }), [ignite({ height: 6, radius: 2 })]);
    c.advance(120);
    let b = crowns(c);
    expect(b[0]).toBeGreaterThan(0.9);
    expect(b[1]).toBeLessThan(0.05);
    c.unload();
    c = await load(doc(stand(7), { foliageMoisture: 0.2 }), [{ event: 'wind', speed: 10, direction: 'W', duration: 300 } as EventSpec, ignite({ height: 6, radius: 2 })]);
    c.advance(120);
    b = crowns(c);
    expect(b[1]).toBeGreaterThan(0.5);
    c.unload();
  });

  it('live (150 %) foliage refuses the ignition; heavy rain puts burning crowns out and stops the spread', { timeout: 180_000 }, async () => {
    let c = await load(doc(stand(5)), [ignite({ height: 6, radius: 2 })]);
    c.advance(60);
    // The crowns are too wet to light; a bark spot of the trunk takes the pilot flame but cannot keep burning alone.
    const fw = frOf(c).fw;
    for (let i = 0; i < fw.n; i++) {
      if (fw.kind[i] === IK.foliage) { expect(fw.tooMoist(i)).toBe(true); expect(fw.m[i]).toBe(fw.m0[i]); }
      if (fw.kind[i] === IK.trunk) expect(isBurning(fw.state[i])).toBe(false);
    }
    c.unload();
    c = await load(doc(stand(5), { foliageMoisture: 0.2 }), [{ event: 'rain', intensity: 200, duration: 300 } as EventSpec, ignite({ height: 6, radius: 2, startTime: 0 })]);
    c.advance(120);
    const b = crowns(c);
    expect(b[0]).toBeLessThan(0.6);
    expect(b[2]).toBeLessThan(0.05);
    expect(frOf(c).fw.ledger.waterEvaporated).toBeGreaterThan(0);
    c.unload();
  });

  it('a heat source ignites a dry crown only through its computed flux, when heat ignition is enabled', { timeout: 180_000 }, async () => {
    const src: EventSpec = { event: 'heatSource', kind: 'point', position: [4, 0], height: 8.8, radius: 2, input: 'power', power: 4e6, profile: 'constant', duration: 300 } as EventSpec;
    const c = await load(doc([tree(0, 0)], { foliageMoisture: 0.2, heatIgnition: true }), [src]);
    c.advance(200);
    const fw = frOf(c).fw;
    const f = [...Array(fw.n).keys()].find((i) => fw.kind[i] === IK.foliage)!;
    expect(fw.state[f] === FS.burnedOut || isBurning(fw.state[f]) || fw.m[f] < fw.m0[f]).toBe(true);
    expect(frOf(c).cause[f]).toBe('flux');
    c.unload();
  });
});

describe('determinism, ids, restoration, save / load', () => {
  const scene = () => [B(design('house'), 0, 0, 7), tree(9, 0, 1), tree(12, 4, 2)];

  it('same result twice, with new object ids, and after a reset of the run', { timeout: 120_000 }, async () => {
    const run = async (d: WorldDocument) => {
      const c = await load(d, [ignite({ duration: 900 })]);
      c.advance(300);
      const h = fireHash(c);
      return { c, h };
    };
    const a = await run(doc(scene(), { openings: 'windowsOpen', foliageMoisture: 0.3 }));
    const b = await run(doc(scene(), { openings: 'windowsOpen', foliageMoisture: 0.3 }));
    expect(b.h).toBe(a.h);
    // Reset → same original world → same ignition / spread / collapse order.
    await a.c.reset();
    a.c.addEvent(ignite({ duration: 900 }));
    a.c.advance(300);
    expect(fireHash(a.c)).toBe(a.h);
    a.c.unload();
    b.c.unload();
  });

  it('saves the fire scenario and settings (schema v7) and loads older projects without them', () => {
    const d = doc([B(design('house'))], { openings: 'windowsOpen', foliageMoisture: 0.4, heatIgnition: true });
    const inst = createInstance('fire', [], ignite({ position: [2, 3], radius: 2.5 }));
    d.scenario.experiment = { ...d.scenario.experiment, instances: [inst] };
    const res = parseDocument(serializeDocument(d));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.settings.simulation.fire).toEqual({ openings: 'windowsOpen', foliageMoisture: 0.4, heatIgnition: true });
    expect(res.doc.scenario.experiment?.instances[0].spec).toMatchObject({ event: 'fire', position: [2, 3], radius: 2.5 });
    const old = doc([B(design('house'))]);
    const r2 = parseDocument(serializeDocument(old));
    expect(r2.ok && r2.doc.settings.simulation.fire).toBeFalsy();
  });
});

describe('Phase 28 extension points', () => {
  it('an external incident-flux provider ignites fuel through the normal ignition rules; contact ignition uses the state machine', { timeout: 180_000 }, async () => {
    const c = await load(doc([tree(0, 0)], { foliageMoisture: 0.2 }), [ignite({ position: [60, 60], radius: 0.5 })]);
    c.advance(1);
    const fr = frOf(c);
    // The tree joins the thermal network when something heats near it; it is brought in directly here.
    const te = fr.trt.ents.find((x) => x.kind === 'tree')!;
    fr.trt.activate({ env: c.getEnvironment(), runtime: c.getRuntime()!, time: c.getTime() } as never, te);
    let calls = 0;
    fr.incidentProviders.push((rt, q, pilot) => { calls++; for (let i = 0; i < rt.fw.n; i++) if (rt.fw.kind[i] === IK.foliage) { q[i] += 60e3; pilot[i] = 1; } });
    c.advance(20);
    const fw = fr.fw;
    const f = [...Array(fw.n).keys()].find((i) => fw.kind[i] === IK.foliage)!;
    expect(calls).toBeGreaterThan(0);
    expect(fw.m[f]).toBeLessThan(fw.m0[f]);
    expect(fr.contact([100, 0, 100], 1, 'lava')).toBe(0);
    c.unload();
  });
});
