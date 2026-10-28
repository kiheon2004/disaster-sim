/**
 * Golden simulation regression: performance work must not change simulation results.
 *
 * The fixtures were generated BEFORE the Phase 11 engine optimizations. Every damage event is
 * serialized at full floating-point precision together with the final health, state and pose of
 * every entity, so any change in evaluation order, sampling or caching that alters a single bit
 * of the outcome fails this test.
 *
 * Regenerate (only for intentional model changes): UPDATE_GOLDEN=1 npx vitest run src/simulation/golden.test.ts
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SimulationController } from './SimulationController';
import { createEmptyDocument, createWorldObject, nextSerial, type CreateObjectInput } from '@/world/WorldDocument';
import { sampleTown } from '@/world/sampleScene';
import { stressScene } from '@/world/stressScene';
import type { WorldDocument } from '@/core/model';
import type { WindEventSpec } from '@/events/specs';

const DIR = path.join(__dirname, '__golden__');

function doc(inputs: CreateObjectInput[], seed: number): WorldDocument {
  const d = createEmptyDocument('golden');
  for (const input of inputs) {
    const o = createWorldObject(input, nextSerial(d.objects, input.type));
    d.objects[o.id] = o;
  }
  d.settings.simulation.seed = seed;
  return d;
}

async function run(d: WorldDocument, wind: WindEventSpec, seconds: number) {
  // Object ids are random per document; use the stable insertion index instead.
  const index = new Map(Object.keys(d.objects).map((id, i) => [id, `#${i}`]));
  const sid = (id: string | null | undefined) => (id ? index.get(id) ?? id : '');
  const c = new SimulationController();
  await c.load(d);
  c.addEvent(wind);
  c.advance(seconds);
  const events = c.getDamageEvents().map((e) =>
    [e.time, sid(e.objectId), e.componentId ?? '', e.eventType, e.cause, e.localWindSpeed, e.force, e.damageBefore, e.damageAfter, sid(e.shadowSource), ...e.worldPosition].join('|'),
  );
  const entities = [...c.getRuntime()!.entities.values()].map((e) =>
    [sid(e.id), e.state, e.health, e.peakLoadRatio, ...e.pose.position, ...e.pose.quaternion].join('|'),
  );
  const rt = c.getRuntime()!;
  const summary = { events: events.length, debris: rt.debris.length };
  c.unload();
  const hash = (lines: string[]) => createHash('sha256').update(lines.join('\n')).digest('hex');
  return { summary, eventsHash: hash(events), entitiesHash: hash(entities), firstEvents: events.slice(0, 5), lastEvents: events.slice(-5) };
}

const CASES: { name: string; build: () => WorldDocument; wind: WindEventSpec; seconds: number }[] = [
  {
    name: 'sample-town-s46',
    build: () => doc(sampleTown(), 42),
    wind: { event: 'wind', speed: 46, direction: 'S', duration: 40, gustStrength: 0.3, rampDuration: 4 },
    seconds: 12,
  },
  {
    name: 'stress-300-e42',
    build: () => doc(stressScene(300), 1234),
    wind: { event: 'wind', speed: 42, direction: 'E', duration: 60, gustStrength: 0.25, rampDuration: 4 },
    seconds: 10,
  },
  {
    // Diagonal wind exercises rotated wake rectangles in the spatial index.
    name: 'stress-200-ne50',
    build: () => doc(stressScene(200, 7), 99),
    wind: { event: 'wind', speed: 50, direction: 'NE', duration: 60, gustStrength: 0.35, rampDuration: 3 },
    seconds: 9,
  },
];

describe('golden simulation (bit-exact results)', () => {
  it.each(CASES)('$name', async ({ name, build, wind, seconds }) => {
    const result = await run(build(), wind, seconds);
    const file = path.join(DIR, `${name}.json`);
    if (process.env.UPDATE_GOLDEN || !fs.existsSync(file)) {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(result, null, 1) + '\n');
    }
    const golden = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(result.summary).toEqual(golden.summary);
    expect(result.firstEvents).toEqual(golden.firstEvents);
    expect(result.lastEvents).toEqual(golden.lastEvents);
    expect(result.eventsHash).toBe(golden.eventsHash);
    expect(result.entitiesHash).toBe(golden.entitiesHash);
  }, 300_000);
});
