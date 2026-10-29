/**
 * Phase 31 audit (H2 / M2): roof-snow packets keep their mass and enthalpy through every hand-over — roof store →
 * falling member → resting member → ground cells, or a boundary outflow when they come down outside the climate grid —
 * and the snow a resting member carries loads the member it rests on exactly as its own weight does (added on rest,
 * taken off on release: never a negative or missing surcharge).
 */
import { describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { SimulationController } from '@/simulation/SimulationController';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import type { EventSpec } from '@/events/specs';
import { defaultClimateSpec, type ClimateSpec } from '@/climate/types';
import { T_MELT } from '@/climate/constants';
import { MS } from '@/structure/types';
import { GRAVITY } from '@/core/units';
import type { CollapseModel } from '@/structure/collapse';
import { worldFingerprint } from '@/world/fingerprint';
import { gravity } from './testSpecs';

const S = () => useWorldStore.getState();
const climate = (p: Partial<ClimateSpec> = {}): EventSpec => ({ ...defaultClimateSpec(), solar: 'off', precipitation: 0, scenario: 'custom', profile: 'constant', duration: 3600, humidityTarget: undefined, temperature: T_MELT - 5, target: T_MELT - 5, humidity: 0.8, blowingSnow: false, ...p } as EventSpec);

async function start(preset: string, events: EventSpec[], pos: [number, number, number] = [0, 0, 0]) {
  S().setLocked(false);
  S().newDocument();
  S().doc.settings.simulation.seed = 11;
  S().applyEdit({ add: [{ type: 'building', building: createDesign(presetSpec(preset)!, preset), seed: 3, transform: { position: pos, rotation: [0, 0, 0], scale: [1, 1, 1] } }] as never });
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(S().doc));
  for (const e of events) c.addEvent(e);
  return c;
}
const building = (c: SimulationController) => [...c.getRuntime()!.entities.values()].find((e) => e.source.type === 'building')!;
const crt = (c: SimulationController) => c.getEnvironment().climate.rt!;
const model = (c: SimulationController) => building(c).modular!.structure!.model as CollapseModel;

/** Packet mass in transit + what reached the ground / left the grid = what left the roof store. */
function closed(c: SimulationController) {
  const s = crt(c).stats;
  expect(s.waterResidual).toBeLessThan(1e-8);
  expect(s.energyResidual).toBeLessThan(1e-8);
}

/** Every alive member's surcharge covers the members resting on it with their carried snow; none is negative. */
function restingLoads(m: CollapseModel) {
  const rest = new Float64Array(m.n);
  for (let i = 0; i < m.n; i++) if (m.state[i] === MS.RESTING && m.restOn[i] >= 0) rest[m.restOn[i]] += m.g.weight[i] + m.carried[i] * GRAVITY;
  for (let r = 0; r < m.n; r++) {
    if (m.state[r] >= MS.FAILED) continue;
    expect(m.s.extra[r]).toBeGreaterThan(-1e-6);
    if (rest[r] > 0) expect(m.s.extra[r] + 1e-6 * rest[r]).toBeGreaterThanOrEqual(rest[r]);
  }
}

describe('roof-snow packets (H2 / M2)', { timeout: 900_000 }, () => {
  it('a packet with no ground cell under it (memberCells empty, outside the grid) leaves as a boundary outflow; ledgers closed', async () => {
    const c = await start('warehouse', [climate({ initialSnow: 1.2, initialSnowDensity: 300 })]);
    // Until the first panels fail and fall with their packets.
    for (let k = 0; k < 160 && !(c.getEnvironment().climate.rt?.packets.length); k++) c.advance(0.05);
    const r = crt(c), cw = r.cw;
    expect(r.packets.length).toBeGreaterThan(0);
    const ref = r.packets[0];
    const m = cw.packets[ref.p].m;
    expect(m).toBeGreaterThan(0);
    cw.depositPacket(ref.p, []);
    expect(cw.packets[ref.p].done).toBe(true);
    expect(cw.packets[ref.p].to).toBe('outflow');
    expect(cw.water.boundaryOut).toBeCloseTo(m, 9);
    expect(cw.energy.boundaryOut).not.toBe(0);
    c.advance(1);
    closed(c);
    // A second deposit of the same packet books nothing again.
    cw.depositPacket(ref.p, [0]);
    expect(cw.water.boundaryOut).toBeCloseTo(m, 9);
    c.advance(1);
    closed(c);
    c.unload();
  });

  it('a building at the world edge: snow of panels landing beyond the grid is booked out, never lost', async () => {
    // The east edge of the terrain (heights on vertices: x₁ = originX + (nx − 1)·cell); the warehouse (≈ 30 m wide)
    // straddles it, so the panels beyond it come down outside the grid.
    S().setLocked(false);
    S().newDocument();
    const t = S().doc.terrain;
    const east = t.originX + (t.nx - 1) * t.cellSize;
    const c = await start('warehouse', [climate({ initialSnow: 1.2, initialSnowDensity: 300 })], [east - 4, 0, 0]);
    c.advance(12);
    const r = crt(c), cw = r.cw;
    expect(r.packets.length).toBe(0);
    expect(r.cw.packetMass()).toBe(0);
    expect(cw.packets.length).toBeGreaterThan(0);
    closed(c);
    c.unload();
  });

  it('roof failure → rest on a floor → the floor fails → re-fall → ground under 2 g: packet mass unchanged, resting loads carry the snow', async () => {
    const c = await start('house', [climate({ initialSnow: 1.2, initialSnowDensity: 300 }), gravity({ magnitude: 2 * 9.81, startTime: 3 })]);
    c.advance(4);
    const r = crt(c), cw = r.cw, m = model(c);
    const ids = r.packets.map((q) => q.p);
    expect(ids.length).toBeGreaterThan(0);
    const mass0 = ids.reduce((s, p) => s + cw.packets[p].m, 0);
    // Some packets rest on members of the house (the receivers).
    const recv = new Set<number>();
    for (const q of r.packets) if (m.state[q.i] === MS.RESTING && m.restOn[q.i] >= 0) recv.add(m.restOn[q.i]);
    expect(recv.size).toBeGreaterThan(0);
    restingLoads(m);
    closed(c);
    // Gravity does not change a packet's mass (only the weight the structure feels, through kM).
    for (const q of r.packets) expect(m.carried[q.i]).toBeCloseTo(cw.packets[q.p].m, 6);
    m.fail([...recv], 'removed', 'gravity', c.getTime());
    for (let k = 0; k < 60; k++) {
      c.advance(0.1);
      restingLoads(m);
      let inTransit = 0;
      for (const p of ids) if (!cw.packets[p].done) inTransit += cw.packets[p].m;
      expect(inTransit).toBeLessThanOrEqual(mass0 * (1 + 1e-12));
    }
    closed(c);
    c.unload();
  });

  it('several panels failing in one step, and packets still in transit at the end of the run: counted in storage, ledgers closed', async () => {
    const c = await start('warehouse', [climate({ initialSnow: 1.5, initialSnowDensity: 320 })]);
    // A few steps after the failure the panels are still falling with their packets.
    for (let k = 0; k < 40; k++) {
      c.advance(0.05);
      closed(c);
    }
    const r = crt(c);
    const stored = r.cw.packetMass();
    const carriedPk = r.packets.reduce((s, q) => s + r.cw.packets[q.p].m, 0);
    expect(stored).toBeCloseTo(carriedPk, 6);
    c.unload();
  });

  it('restoration (§16): roof snow packets falling under 2 g then reversed gravity — reset gives the original world, the rerun is identical', async () => {
    const events = [climate({ initialSnow: 1.2, initialSnowDensity: 300 }), gravity({ magnitude: 2 * 9.81, startTime: 1, duration: 5 }), gravity({ name: 'rev', magnitude: 9.81, direction: [0, 1, 0], startTime: 6, duration: 2 })];
    const c = await start('house', events);
    const doc = structuredClone(S().doc);
    const fp = worldFingerprint(doc);
    c.advance(9);
    const sig = (cc: SimulationController) => {
      const r = crt(cc), m = model(cc);
      return JSON.stringify([r.cw.packets.map((p) => [p.m, p.done, p.to ?? '']), Array.from(m.state), m.records.length, r.stats.waterResidual < 1e-8, cc.getEnvironment().gravity.rt!.balance().workGravity]);
    };
    const s1 = sig(c);
    expect(crt(c).cw.packets.length).toBeGreaterThan(0);
    await c.reset();
    expect(c.getEnvironment().gravity.field).toBeNull();
    for (const e of events) c.addEvent(e);
    c.advance(9);
    expect(sig(c)).toBe(s1);
    expect(worldFingerprint(S().doc)).toBe(fp);
    c.unload();
  });
});
