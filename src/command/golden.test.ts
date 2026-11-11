/**
 * Phase 37 §15 / §20 — golden command scripts: the same script on the same start world gives the same world.
 *
 * One script each for the default world, `sampleTown()` and a built-in template (`golden/*.dscmd.txt`, plain text, the
 * file format of "Run script"). For each: the script runs as ONE undo step, the result's canonical hash (object ids
 * relabelled — they are random) and terrain bits equal the recorded ones in `golden/golden.json`, a second run on a
 * copy of the start document gives the same plan hash and the same world, a run on the world built again gives the
 * same world up to the random ids, and one undo gives the start world back bit for bit.
 *
 * `UPDATE_GOLDEN=1 npx vitest run src/command/golden.test.ts` rewrites golden.json — only after a deliberate change of
 * the scripts or of an edit rule; say which in the commit message.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { WorldDocument } from '@/core/model';
import { buildTemplate } from '@/templates/builtin';
import { createEmptyDocument } from '@/world/WorldDocument';
import { defaultTownObjects, defaultTownRoads } from '@/world/defaultTown';
import { canonicalFingerprint, terrainBitsHash, worldFingerprint } from '@/world/fingerprint';
import { forkDocument } from '@/world/fork';
import { sampleTown } from '@/world/sampleScene';
import { scratchWorld } from '@/world/worldStore';
import { emptyContext } from './context';
import type { Intent } from './intent';
import { interpret, MAX_SCRIPT_LINES, scriptLines } from './interpret';
import { runIntents } from './run';

const DIR = path.resolve(__dirname, 'golden');
const GOLDEN = path.join(DIR, 'golden.json');

/** What is recorded per script. No plan hash: plans name the start world's objects, whose ids are random per build. */
interface Golden {
  lines: number;
  start: string;
  end: string;
  terrain: string;
  objects: number;
  instances: number;
}

const WORLDS: Record<string, () => ReturnType<typeof scratchWorld>> = {
  'default-town': () => {
    const st = scratchWorld(createEmptyDocument());
    st.getState().applyEdit({ roads: defaultTownRoads(), add: defaultTownObjects() });
    return st;
  },
  'sample-town': () => {
    const st = scratchWorld(createEmptyDocument());
    st.getState().addObjects(sampleTown());
    return st;
  },
  'mountain-village': () => scratchWorld(buildTemplate('mountainVillage', 1, { now: '2026-01-01T00:00:00.000Z' })),
};

function intentsOf(name: string): Intent[] {
  const lines = scriptLines(fs.readFileSync(path.join(DIR, `${name}.dscmd.txt`), 'utf8'));
  expect(lines.length).toBeGreaterThan(8);
  expect(lines.length).toBeLessThanOrEqual(MAX_SCRIPT_LINES);
  return lines.flatMap((l) => {
    const r = interpret(l.text);
    if (r.kind !== 'ok') throw new Error(`${name} line ${l.n} is not understood: ${l.text} ${JSON.stringify(r)}`);
    return r.intents;
  });
}

const bits = (doc: WorldDocument) => `${worldFingerprint(doc)} ${terrainBitsHash(doc)}`;

function run(name: string, from?: WorldDocument) {
  const st = from ? scratchWorld(forkDocument(from)) : WORLDS[name]();
  const S = () => st.getState();
  // A copy taken BEFORE the run: the store edits the terrain arrays of its document in place.
  const start = forkDocument(S().doc);
  const startBits = bits(S().doc);
  const startCanon = canonicalFingerprint(S().doc);
  const steps = S().past.length;
  const list = intentsOf(name);
  const r = runIntents(st, list, emptyContext());
  if (!r.ok) throw new Error(`${name}: line ${r.failure.index + 1} failed ${JSON.stringify(r.failure)}`);
  return { st, S, start, startBits, startCanon, steps, r, lines: list.length };
}

const recorded: Record<string, Golden> = fs.existsSync(GOLDEN) ? (JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Record<string, Golden>) : {};
const update = process.env.UPDATE_GOLDEN === '1';
const fresh: Record<string, Golden> = {};

describe('golden command scripts', () => {
  for (const name of Object.keys(WORLDS)) {
    it(`${name}: one step, the recorded world, the same world twice, undo = the start bit for bit`, () => {
      const a = run(name);
      const doc = a.S().doc;
      const now: Golden = {
        lines: a.lines,
        start: a.startCanon,
        end: canonicalFingerprint(doc),
        terrain: terrainBitsHash(doc),
        objects: Object.keys(doc.objects).length,
        instances: doc.scenario.experiment?.instances.length ?? 0,
      };
      fresh[name] = now;
      // Every editing line of the script did something (a line that changes nothing would test nothing).
      const idle = a.r.lines.filter((l) => !['select', 'deselect', 'query', 'focus'].includes(l.plan.intent.kind) && !l.plan.ops.length).map((l) => l.plan.canonical);
      expect(idle).toEqual([]);
      // One script = one undo step, and it changed the world.
      expect(a.r.changed).toBe(true);
      expect(a.S().past.length).toBe(a.steps + 1);
      expect(now.end).not.toBe(now.start);
      // The same script on a copy of the same start document: the same plans (hash) and the same world.
      const b = run(name, a.start);
      expect(b.startBits).toBe(a.startBits);
      expect(b.r.hash).toBe(a.r.hash);
      expect(canonicalFingerprint(b.S().doc)).toBe(now.end);
      expect(terrainBitsHash(b.S().doc)).toBe(now.terrain);
      // …and on the same world built again (its objects get other random ids): the same world up to those ids.
      const c = run(name);
      expect(c.startCanon).toBe(now.start);
      expect(canonicalFingerprint(c.S().doc)).toBe(now.end);
      expect(terrainBitsHash(c.S().doc)).toBe(now.terrain);
      // Undo gives the start back bit for bit; redo gives the result back bit for bit.
      const after = bits(doc);
      a.S().undo();
      expect(bits(a.S().doc)).toBe(a.startBits);
      a.S().redo();
      expect(bits(a.S().doc)).toBe(after);
      if (!update) expect(now).toEqual(recorded[name]);
    });
  }

  it('golden.json lists exactly the scripts of the folder', () => {
    if (update) {
      fs.writeFileSync(GOLDEN, `${JSON.stringify(fresh, null, 2)}\n`);
      return;
    }
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.dscmd.txt')).map((f) => f.replace('.dscmd.txt', '')).sort();
    expect(Object.keys(recorded).sort()).toEqual(files);
    expect(files).toEqual(Object.keys(WORLDS).sort());
  });
});
