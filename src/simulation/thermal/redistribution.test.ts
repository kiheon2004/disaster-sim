/**
 * Phase 25 residual 2.1 (studied in Phase 26): one load-redistribution round per building per step
 * under GRADUAL strength loss. A heated RC apartment is run twice — with the engine's policy (1 round
 * per step) and with rounds until nothing is pending in the same step — and the collapse sequences are
 * compared. Measured (docs/THERMAL_PHYSICS.md §2.1): the heat-triggered failure and the redistribution
 * chain that follows are the same members for the same reasons at the same times (to a step); a falling
 * block formed one step later hits a floor at a slightly different speed, and one impact near the floor's
 * capacity differs (6 of 39 members). The policy stays one round per step (unchanged, deterministic).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Vec3 } from '@/core/types';
import type { EventSpec } from '@/events/specs';
import { createEmptyDocument, createWorldObject, nextSerial } from '@/world/WorldDocument';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import { CollapseModel } from '@/structure/collapse';
import { SimulationController } from '../SimulationController';

afterEach(() => { CollapseModel.roundsPerStep = 1; });

async function run(rounds: number) {
  CollapseModel.roundsPerStep = rounds;
  const d = createEmptyDocument('t');
  const des = createDesign(presetSpec('apartment')!, 'apartment');
  const o = createWorldObject({ type: 'building', building: des, seed: 3, transform: { position: [0, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 } }, nextSerial(d.objects, 'building'));
  d.objects[o.id] = o;
  const m0 = des.members.find((x) => x.type === 'column' && x.level === 0)!;
  const pos: [number, number] = [m0.position[0] + Math.sign(-m0.position[0] || 1) * 1.8, m0.position[2] + Math.sign(-m0.position[2] || 1) * 1.8];
  const c = new SimulationController({ headless: true });
  await c.load(d);
  c.addEvent({ event: 'heatSource', kind: 'temperature', position: pos, height: 4, radius: 3.2, input: 'power', temperature: 1373.15, profile: 'constant', duration: 3000 } as EventSpec);
  c.advance(900);
  const m = [...c.getRuntime()!.entities.values()][0].modular!.structure!.model;
  const recs = m.records.map((r) => ({ i: r.i, t: r.time, cause: r.cause, hazard: r.hazard, round: r.round }));
  c.unload();
  return recs;
}

describe('redistribution rounds per step under gradual heating (Phase 25 residual 2.1)', () => {
  it('one round per step: same trigger and redistribution chain as rounds-until-stable; only a downstream impact near capacity differs', async () => {
    const one = await run(1);
    const many = await run(50);
    expect(one.length).toBeGreaterThan(5);
    const key = (r: { i: number; cause: string }) => `${r.i}|${r.cause}`;
    if (process.env.THERMAL_LOG_SEQ) console.log('ONE', JSON.stringify(one.map((r) => [r.i, +r.t.toFixed(3), r.cause, r.round])), '\nMANY', JSON.stringify(many.map((r) => [r.i, +r.t.toFixed(3), r.cause, r.round])));
    const a = new Set(one.map(key)), b = new Set(many.map(key));
    const common = [...a].filter((k) => b.has(k)).length;
    // Same trigger, same redistribution chain; at most a fifth of the members differ (downstream impacts).
    expect(key(one[0])).toBe(key(many[0]));
    expect(common / Math.max(a.size, b.size)).toBeGreaterThan(0.8);
    const beforeImpacts = (rs: typeof one) => rs.filter((r) => r.t < 843.2).map(key);
    expect(new Set(beforeImpacts(one))).toEqual(new Set(beforeImpacts(many)));
    expect(one.every((r) => r.hazard === 'thermal')).toBe(true);
    // The first (heat-triggered) failure happens at the same time; the rest of the chain is later by at most a few steps per round.
    expect(one[0].t).toBe(many[0].t);
    const lastOne = Math.max(...one.map((r) => r.t)), lastMany = Math.max(...many.map((r) => r.t));
    const rounds = Math.max(...one.map((r) => r.round)) - Math.min(...one.map((r) => r.round));
    if (process.env.THERMAL_LOG) console.log('chain', one.length, 'records; completes', lastOne, 'vs', lastMany, 's; rounds', rounds);
    expect(Math.abs(lastOne - lastMany)).toBeLessThan(0.5);
  }, 600000);
});
