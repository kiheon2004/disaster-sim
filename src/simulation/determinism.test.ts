import { describe, expect, it } from 'vitest';
import { SimulationController } from './SimulationController';
import { createEmptyDocument, createWorldObject, nextSerial } from '@/world/WorldDocument';
import { sampleTown } from '@/world/sampleScene';
import type { WorldDocument } from '@/core/model';

function town(seed: number): WorldDocument {
  const doc = createEmptyDocument('det');
  for (const input of sampleTown()) {
    const o = createWorldObject(input, nextSerial(doc.objects, input.type));
    doc.objects[o.id] = o;
  }
  doc.settings.simulation.seed = seed;
  return doc;
}

async function run(doc: WorldDocument) {
  const c = new SimulationController();
  await c.load(doc);
  c.addEvent({ event: 'wind', speed: 46, direction: 'S', duration: 40, gustStrength: 0.3, rampDuration: 4 });
  c.advance(12);
  const seq = c.getDamageEvents().map((e) => `${e.time.toFixed(4)}|${e.objectId}|${e.componentId ?? ''}|${e.eventType}|${e.localWindSpeed.toFixed(4)}`);
  const m = c.getMetrics()!;
  c.unload();
  return { seq, m };
}

describe('simulation reproducibility', () => {
  it('same world + events + seed → identical damage sequence', async () => {
    const doc = town(42);
    const a = await run(doc);
    const b = await run(doc);
    expect(a.seq.length).toBeGreaterThan(20);
    expect(b.seq).toEqual(a.seq);
    expect(b.m.totalDamageEvents).toBe(a.m.totalDamageEvents);
    expect(b.m.firstDamageTime).toBe(a.m.firstDamageTime);
  }, 180_000);

  it('a different seed changes the result', async () => {
    const doc = town(42);
    const a = await run(doc);
    const other = structuredClone(doc);
    other.settings.simulation.seed = 4242;
    const b = await run(other);
    expect(b.seq).not.toEqual(a.seq);
  }, 180_000);

  it('metrics are consistent with the event history', async () => {
    const { m } = await run(town(7));
    expect(m.maxWindSpeed).toBeCloseTo(46, 0);
    expect(m.firstDamageTime).not.toBeNull();
    expect(m.histogram.reduce((x, y) => x + y, 0)).toBe(m.totalDamageEvents);
    expect(m.humansFallen).toBeGreaterThan(0);
  }, 180_000);
});
