/**
 * Phase 15 regression: flood-only and combined-hazard runs.
 *
 * The fixtures in __golden__/multi-*.json were generated on the Phase 14 commit (3656f79, before
 * any Phase 15 code) with this same file. With multi-hazard interactions OFF every case must
 * reproduce bit for bit; single-hazard cases must also reproduce with interactions ON (the
 * interaction terms vanish without a second hazard).
 *   UPDATE_GOLDEN=1 npx vitest run src/simulation/regressionMulti.test.ts   (only on the base commit)
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SimulationController } from './SimulationController';
import { createEmptyDocument, createWorldObject, nextSerial } from '@/world/WorldDocument';
import { sampleTown } from '@/world/sampleScene';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { TerrainSampler } from '@/terrain/TerrainSampler';
import { WaterField } from './water/WaterField';
import { captureWaterState } from './water/waterStateCodec';

const DIR = path.join(__dirname, '__golden__');

function town(seed: number, interactions: boolean): WorldDocument {
  const d = createEmptyDocument('multi');
  for (const input of sampleTown()) {
    const o = createWorldObject(input, nextSerial(d.objects, input.type));
    d.objects[o.id] = o;
  }
  d.settings.simulation.seed = seed;
  (d.settings.simulation as unknown as Record<string, unknown>).interactions = { enabled: interactions };
  return d;
}

const WIND: EventSpec = { event: 'wind', speed: 38, direction: 'S', duration: 40, gustStrength: 0.3, rampDuration: 3 };
const QUAKE: EventSpec = { event: 'earthquake', magnitude: 6.8, pga: 0.45, duration: 12, seed: 3 };
const RAIN: EventSpec = { event: 'rain', intensity: 150, duration: 60 };
const RISE: EventSpec = { event: 'risingWater', boundary: 'S', level: 1.2, riseRate: 6, duration: 60 };

async function run(d: WorldDocument, specs: EventSpec[], seconds: number, water: boolean) {
  const index = new Map(Object.keys(d.objects).map((id, i) => [id, `#${i}`]));
  const sid = (id: string | null | undefined) => (id ? index.get(id) ?? id : '');
  const c = new SimulationController();
  if (water) {
    const f = new WaterField(new TerrainSampler(d.terrain), d.settings.simulation.water);
    f.h.fill(0.5);
    c.setInitialWaterState(captureWaterState(f, 0));
  }
  await c.load(d);
  for (const s of specs) c.addEvent(s);
  c.advance(seconds);
  const r = (e: Record<string, unknown>, k: string) => (e[k] === undefined ? '' : e[k]);
  const events = c.getDamageEvents().map((e) =>
    [e.time, sid(e.objectId), e.componentId ?? '', e.eventType, e.cause, e.hazard, e.localWindSpeed, e.force, e.damageBefore, e.damageAfter, e.groundAcceleration, e.response,
      r(e as unknown as Record<string, unknown>, 'waterDepth'), r(e as unknown as Record<string, unknown>, 'flowSpeed'), ...e.worldPosition].join('|'),
  );
  const entities = [...c.getRuntime()!.entities.values()].map((e) => [sid(e.id), e.state, e.health, e.peakLoadRatio, ...e.pose.position, ...e.pose.quaternion].join('|'));
  const field = c.getEnvironment().flood?.field;
  const hash = (lines: string[]) => createHash('sha256').update(lines.join('\n')).digest('hex');
  const waterHash = field ? createHash('sha256').update(Buffer.from(field.h.buffer)).digest('hex') : '';
  c.unload();
  return { events: events.length, eventsHash: hash(events), entitiesHash: hash(entities), waterHash, first: events.slice(0, 3) };
}

const CASES: { name: string; specs: EventSpec[]; water: boolean; single: boolean }[] = [
  { name: 'multi-flood-only', specs: [RAIN, RISE], water: true, single: true },
  { name: 'multi-wind-quake', specs: [WIND, QUAKE], water: false, single: false },
  { name: 'multi-wind-flood', specs: [WIND, RAIN, RISE], water: true, single: false },
  { name: 'multi-quake-flood', specs: [QUAKE, RAIN, RISE], water: true, single: false },
  { name: 'multi-wind-quake-flood', specs: [WIND, QUAKE, RAIN, RISE], water: true, single: false },
];

describe('Phase 15 regression (flood-only and combined hazards, interactions off = Phase 14)', () => {
  it.each(CASES)('$name', async ({ name, specs, water, single }) => {
    const file = path.join(DIR, `${name}.json`);
    const result = await run(town(21, false), specs, 10, water);
    if (process.env.UPDATE_GOLDEN || !fs.existsSync(file)) {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(result, null, 1) + '\n');
    }
    const golden = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(result).toEqual(golden);
    if (single) expect(await run(town(21, true), specs, 10, water)).toEqual(golden);
  }, 300_000);
});
