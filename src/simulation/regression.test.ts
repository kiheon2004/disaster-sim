/**
 * Phase 14 regression: earthquake and terrain runs must not change with the flood systems in
 * the pipeline (they are dormant without a water event).
 *
 * The fixtures in __golden__/regression-*.json were generated on the Phase 13 commit (before any
 * Phase 14 code) with this same file: UPDATE_GOLDEN=1 npx vitest run src/simulation/regression.test.ts
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SimulationController } from './SimulationController';
import { createEmptyDocument, createWorldObject, nextSerial } from '@/world/WorldDocument';
import { sampleTown } from '@/world/sampleScene';
import type { TerrainPresetId, WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { generateTerrain } from '@/terrain/TerrainPresets';
import { TerrainSampler } from '@/terrain/TerrainSampler';
import { reseat } from '@/terrain/groundPlacement';

const DIR = path.join(__dirname, '__golden__');

function town(seed: number, preset?: TerrainPresetId): WorldDocument {
  const d = createEmptyDocument('regression');
  if (preset) d.terrain = generateTerrain(preset, 3);
  const terrain = new TerrainSampler(d.terrain);
  for (const input of sampleTown()) {
    const o = createWorldObject(input, nextSerial(d.objects, input.type));
    if (preset) o.transform = { ...o.transform, ...reseat(o, terrain) };
    d.objects[o.id] = o;
  }
  d.settings.simulation.seed = seed;
  return d;
}

async function run(d: WorldDocument, specs: EventSpec[], seconds: number) {
  const index = new Map(Object.keys(d.objects).map((id, i) => [id, `#${i}`]));
  const sid = (id: string | null | undefined) => (id ? index.get(id) ?? id : '');
  const c = new SimulationController();
  await c.load(d);
  for (const s of specs) c.addEvent(s);
  c.advance(seconds);
  const events = c.getDamageEvents().map((e) =>
    [e.time, sid(e.objectId), e.componentId ?? '', e.eventType, e.cause, e.hazard, e.localWindSpeed, e.force, e.damageBefore, e.damageAfter, e.groundAcceleration, e.response, ...e.worldPosition].join('|'),
  );
  const entities = [...c.getRuntime()!.entities.values()].map((e) => [sid(e.id), e.state, e.health, e.peakLoadRatio, ...e.pose.position, ...e.pose.quaternion].join('|'));
  c.unload();
  const hash = (lines: string[]) => createHash('sha256').update(lines.join('\n')).digest('hex');
  return { events: events.length, eventsHash: hash(events), entitiesHash: hash(entities), first: events.slice(0, 3) };
}

const CASES: { name: string; build: () => WorldDocument; specs: EventSpec[]; seconds: number }[] = [
  {
    name: 'regression-earthquake-town',
    build: () => town(42),
    specs: [{ event: 'earthquake', magnitude: 6.8, pga: 0.5, duration: 12, seed: 3 }],
    seconds: 10,
  },
  {
    name: 'regression-wind-hills',
    build: () => town(7, 'gentleHills'),
    specs: [{ event: 'wind', speed: 44, direction: 'SW', duration: 30, gustStrength: 0.3, rampDuration: 3 }],
    seconds: 8,
  },
  {
    // Coastal: sand painted along the shore, static reference water level (sea) present.
    name: 'regression-wind-quake-coastal',
    build: () => town(11, 'coastal'),
    specs: [
      { event: 'wind', speed: 38, direction: 'S', duration: 30, gustStrength: 0.3, rampDuration: 3 },
      { event: 'earthquake', magnitude: 6.5, pga: 0.35, duration: 10, seed: 5 },
    ],
    seconds: 8,
  },
];

describe('Phase 14 regression (wind / earthquake / terrain unchanged)', () => {
  it.each(CASES)('$name', async ({ name, build, specs, seconds }) => {
    const result = await run(build(), specs, seconds);
    const file = path.join(DIR, `${name}.json`);
    if (process.env.UPDATE_GOLDEN || !fs.existsSync(file)) {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(result, null, 1) + '\n');
    }
    const golden = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(result.events).toBe(golden.events);
    expect(result.first).toEqual(golden.first);
    expect(result.eventsHash).toBe(golden.eventsHash);
    expect(result.entitiesHash).toBe(golden.entitiesHash);
  }, 300_000);
});
