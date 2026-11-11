/**
 * Phase 37 (§9, §10, §15, §18, §20): running commands — one command (or one script) = one undo step, bit-identical
 * undo / redo, nothing changed on failure; the preview runs on a fork and leaves the document alone; the preview's plan
 * hash is the hash of the run on the document; the same script on the same world gives the same world.
 */
import { describe, expect, it } from 'vitest';
import type { WorldDocument } from '@/core/model';
import { drawRoad } from '@/roads/network';
import { defaultProfile } from '@/roads/types';
import { createEmptyDocument } from '@/world/WorldDocument';
import { defaultTownObjects, defaultTownRoads } from '@/world/defaultTown';
import { canonicalFingerprint, terrainBitsHash, worldFingerprint } from '@/world/fingerprint';
import { scratchWorld } from '@/world/worldStore';
import { parseCanonical } from './canonical';
import { emptyContext, type CommandContext } from './context';
import type { Intent } from './intent';
import { previewIntents, runIntents, type RunResult } from './run';

const intents = (...lines: string[]): Intent[] =>
  lines.map((l) => {
    const r = parseCanonical(l);
    if (!r.ok) throw new Error(`not canonical: ${l} ${JSON.stringify(r.error)}`);
    return r.intent;
  });

function street() {
  const st = scratchWorld(createEmptyDocument());
  st.getState().applyEdit({ roads: drawRoad(st.getState().doc.roads, [[-60, 0], [60, 0]], { curved: false, profile: defaultProfile() }).network });
  return st;
}
function town() {
  const st = scratchWorld(createEmptyDocument());
  st.getState().applyEdit({ roads: defaultTownRoads(), add: defaultTownObjects() });
  return st;
}
/** Everything undo must restore: the serialized document and every per-vertex array (derived layers too). */
const bits = (doc: WorldDocument) => `${worldFingerprint(doc)} ${terrainBitsHash(doc)}`;
const okRun = (r: RunResult) => {
  if (!r.ok) throw new Error(JSON.stringify(r.failure));
  return r;
};

/** A script that makes objects, a group with a name, a road, changed ground, a forest and a disaster. */
const SCRIPT = [
  'place building:house count=3 along=road:main side=north gap=2 floors=2',
  'group last name="북쪽 블록"',
  'place car count=4 along=road:main',
  'road 20,0 -> 20,70 preset=street',
  'terrain raise circle -40,45 r=12 by=3',
  'terrain flatten circle 50,50 r=8 to=1.5',
  'place building:apartment at=50,50 floors=4',
  'forest circle -40,45 r=14 density=low',
  'move group:"북쪽 블록" by=0,0,-4',
  'disaster blast at=junction energy=1.8e9 start=5',
  'disaster fire at=next(last)',
  'select type:tree',
  'hide selection',
];

describe('one command = one undo step', () => {
  it('"three houses north of the road, 2 m apart": Enter → three houses; one undo → gone, bit for bit; redo → back', () => {
    const st = street();
    const S = () => st.getState();
    const before = bits(S().doc);
    const steps = S().past.length;
    const r = okRun(runIntents(st, intents('place building:house count=3 along=road:main side=north gap=2 floors=2'), emptyContext()));
    expect(r.changed).toBe(true);
    expect(r.lines[0].added.length).toBe(3);
    expect(Object.keys(S().doc.objects).length).toBe(3);
    expect(S().past.length).toBe(steps + 1);
    // "The ones just made" is now these three.
    expect(r.ctx.results).toEqual([r.lines[0].added]);
    const after = bits(S().doc);
    S().undo();
    expect(bits(S().doc)).toBe(before);
    expect(Object.keys(S().doc.objects).length).toBe(0);
    S().redo();
    expect(bits(S().doc)).toBe(after);
  });

  it('group + name ("묶어서 이름 …") is one step; so is a whole script of 13 lines', () => {
    const st = street();
    const S = () => st.getState();
    const first = okRun(runIntents(st, intents('place building:house count=3 along=road:main side=north'), emptyContext()));
    const steps = S().past.length;
    const mid = bits(S().doc);
    okRun(runIntents(st, intents('group last name="북쪽 블록"'), first.ctx));
    expect(S().past.length).toBe(steps + 1);
    expect(Object.values(S().doc.groups ?? {})).toEqual([{ name: '북쪽 블록' }]);
    expect(new Set(Object.values(S().doc.objects).map((o) => o.group)).size).toBe(1);
    S().undo();
    expect(bits(S().doc)).toBe(mid);
    expect(S().doc.groups).toBeUndefined();

    const st2 = street();
    const T = () => st2.getState();
    const before = bits(T().doc);
    const n = T().past.length;
    const r = okRun(runIntents(st2, intents(...SCRIPT), emptyContext()));
    expect(r.lines.length).toBe(SCRIPT.length);
    expect(T().past.length).toBe(n + 1);
    const after = bits(T().doc);
    expect(after).not.toBe(before);
    // It did what it says: objects, a named group, a junction, raised and flattened ground, trees, two disasters, hidden trees.
    const objs = Object.values(T().doc.objects);
    expect(objs.filter((o) => o.type === 'building').length).toBe(4);
    expect(objs.filter((o) => o.type === 'car').length).toBe(4);
    expect(objs.filter((o) => o.type === 'tree').length).toBeGreaterThan(2);
    expect(objs.filter((o) => o.type === 'tree').every((o) => o.hidden)).toBe(true);
    expect(Object.keys(T().doc.roads.segments).length).toBe(3);
    expect(T().doc.scenario.experiment?.instances.map((i) => i.type)).toEqual(['blast', 'fire']);
    const sample = (x: number, z: number) => T().doc.terrain.heights[(z + 100) * T().doc.terrain.nx + (x + 100)];
    expect(sample(-40, 45)).toBe(3);
    expect(sample(50, 50)).toBe(1.5);
    // The apartment stands on the flattened ground, the grouped houses moved 4 m north of the frontage line.
    expect(objs.find((o) => o.building?.preset === 'apartment')!.transform.position[1]).toBeCloseTo(1.5, 2);
    // The selection the script made is what the caller is told to select.
    expect(r.ctx.selection.length).toBe(0); // (hidden objects leave the selection)
    T().undo();
    expect(bits(T().doc)).toBe(before);
    T().redo();
    expect(bits(T().doc)).toBe(after);
    T().undo();
    expect(bits(T().doc)).toBe(before);
  });

  it('a failing line: nothing changes, no step, the redo side stays; a question does the same', () => {
    const st = street();
    const S = () => st.getState();
    okRun(runIntents(st, intents('place tree at=0,30'), emptyContext()));
    S().undo(); // something to redo
    const before = bits(S().doc);
    const past = S().past, future = S().future;
    expect(future.length).toBe(1);
    const r = runIntents(st, intents('place building:house count=2 along=road:main side=north', 'terrain raise circle 30,30 r=8 by=2', 'move type:crate by=1,0,0', 'place tree at=1,1'), emptyContext());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // The third line names crates — there are none: the two lines before it are taken back.
    expect(r.failure).toMatchObject({ index: 2, error: { key: 'cmd37.err.noMatch' } });
    expect(r.lines.length).toBe(2);
    expect(bits(S().doc)).toBe(before);
    expect(S().past).toBe(past);
    expect(S().future).toBe(future);
    expect(S().busy()).toBe(false);
    // A question (which side of the road?) is not answered by guessing.
    const q = runIntents(st, intents('place tree at=5,5', 'place building:house along=road:main'), emptyContext());
    expect(!q.ok && 'clarify' in q.failure && q.failure.index).toBe(1);
    expect(bits(S().doc)).toBe(before);
    expect(S().past).toBe(past);
    // Refused while a stroke is open.
    S().beginTerrainStroke();
    expect(runIntents(st, intents('place tree at=5,5'), emptyContext())).toMatchObject({ ok: false, failure: { error: { key: 'cmd37.err.busy' } } });
    S().cancelTerrainStroke();
  });

  it('commands that change nothing record no step: queries, the camera, selection, an edit that is already so', () => {
    const st = town();
    const S = () => st.getState();
    const doc = S().doc, past = S().past;
    const r = okRun(runIntents(st, intents('count type:building', 'list type:building where floors>=5', 'info type:building tallest', 'measure 0,0 30,40', 'list roads', 'focus type:building tallest', 'select type:tree', 'lock selection', 'unlock selection', 'count all'), emptyContext()));
    expect(r.changed).toBe(false);
    expect(S().past).toBe(past);
    // (lock then unlock: the objects are new values that say the same — the document keeps its old ones)
    expect(S().doc.objects).toBe(doc.objects);
    expect(S().doc).toBe(doc);
    expect(r.effects.map((e) => e.fx)).toEqual(['focus', 'select']);
    expect(r.lines[0].plan.table?.title).toEqual({ key: 'cmd37.sum.count', params: { count: 9 } });
  });

  it('later lines see what earlier lines made: "last", "it", and a selection made by the script', () => {
    const st = street();
    const S = () => st.getState();
    const r = okRun(runIntents(st, intents('place tree count=3 at=0,30', 'move it by=0,0,10', 'select last', 'duplicate selection offset=20,0', 'delete last'), emptyContext()));
    // Three trees placed, moved, copied — and the copies (the last result) deleted again.
    const trees = Object.values(S().doc.objects);
    expect(trees.length).toBe(3);
    expect(trees.every((t) => t.transform.position[2] === 40)).toBe(true);
    expect(r.lines[3].added.length).toBe(3);
    // The result sets: the three trees (placed, then moved = changed); the deleted copies are gone from them.
    expect(r.ctx.results.every((set) => set.every((id) => S().doc.objects[id]))).toBe(true);
    expect([...r.ctx.selection].sort()).toEqual(Object.keys(S().doc.objects).sort());
    expect(S().past.length).toBe(2);
  });
});

describe('copies of cars', () => {
  it('"duplicate" takes the cars\' simulation settings along in the same step (the driver only when copied too)', () => {
    const st = town();
    const S = () => st.getState();
    const objs = Object.values(S().doc.objects);
    const [carA, carB] = objs.filter((o) => o.type === 'car');
    const [driver, passenger] = objs.filter((o) => o.type === 'human');
    S().updateSimulationSettings({ vehicles: { model: 'dynamics', cars: {
      [carA.id]: { drive: 'awd', autopilot: { path: [[0, 0], [20, 0]], speed: 5 } },
      [carB.id]: { drive: 'fwd', occupants: [{ human: driver.id, seat: 'driver', restrained: true }, { human: passenger.id, seat: 'passenger', restrained: false }] },
    } } as never });
    const before = bits(S().doc);
    const steps = S().past.length;
    const ctx: CommandContext = { ...emptyContext(), selection: [carA.id, carB.id, driver.id] };
    const r = okRun(runIntents(st, intents('duplicate selection offset=0,20'), ctx));
    expect(S().past.length).toBe(steps + 1);
    const cars = S().doc.settings.simulation.vehicles!.cars!;
    const added = r.lines[0].added.map((id) => S().doc.objects[id]);
    const copyA = added.find((o) => o.type === 'car' && cars[o.id]?.drive === 'awd')!;
    const copyB = added.find((o) => o.type === 'car' && cars[o.id]?.drive === 'fwd')!;
    const copyDriver = added.find((o) => o.type === 'human')!;
    expect(cars[copyA.id]).toMatchObject({ drive: 'awd', autopilot: { speed: 5, path: [[0, 0], [20, 0]] } });
    // The driver was copied too: the copy drives the copied car. The passenger was not: dropped.
    expect(cars[copyB.id].occupants).toEqual([{ human: copyDriver.id, seat: 'driver', restrained: true }]);
    // The sources are untouched.
    expect(cars[carB.id].occupants?.length).toBe(2);
    expect(r.lines[0].plan.notes).toContainEqual({ key: 'cmd37.note.carSettings', params: { count: 2 } });
    S().undo();
    expect(bits(S().doc)).toBe(before);
    expect(Object.keys(S().doc.settings.simulation.vehicles!.cars!).sort()).toEqual([carA.id, carB.id].sort());
  });
});

describe('preview', () => {
  it('runs on a fork: the document, its history and its arrays are untouched; the difference is what confirming does', () => {
    const st = street();
    const S = () => st.getState();
    const doc = S().doc, before = bits(doc), past = S().past;
    const p = previewIntents(doc, intents(...SCRIPT), emptyContext());
    expect(p.result.ok).toBe(true);
    expect(S().doc).toBe(doc);
    expect(bits(S().doc)).toBe(before);
    expect(S().past).toBe(past);
    const d = p.diff!;
    expect(d.added.filter((o) => o.type === 'building').length).toBe(4);
    expect(d.added.filter((o) => o.type === 'car').length).toBe(4);
    expect(d.removed).toEqual([]);
    expect(d.terrain!.up).toBe(3);
    expect(d.terrain!.area).toBeGreaterThan(400);
    expect(d.roads!.added.length).toBeGreaterThanOrEqual(1);
    expect(d.instances.added.map((i) => i.type)).toEqual(['blast', 'fire']);
    expect(d.groupNames).toBe(true);
    expect(d.any).toBe(true);
    // Confirming: the same intents on the document — the same plans (hash), the same world (up to the random ids).
    const r = okRun(runIntents(st, intents(...SCRIPT), emptyContext()));
    expect(r.hash).toBe(p.result.ok ? p.result.hash : '');
    const fork = scratchWorld(createEmptyDocument());
    fork.getState().applyEdit({ roads: drawRoad(fork.getState().doc.roads, [[-60, 0], [60, 0]], { curved: false, profile: defaultProfile() }).network });
    const again = okRun(runIntents(fork, intents(...SCRIPT), emptyContext()));
    expect(again.hash).toBe(r.hash);
    expect(canonicalFingerprint(fork.getState().doc)).toBe(canonicalFingerprint(S().doc));
    expect(terrainBitsHash(fork.getState().doc)).toBe(terrainBitsHash(S().doc));
    // (the plain fingerprint differs: object ids are random)
    expect(worldFingerprint(fork.getState().doc)).not.toBe(worldFingerprint(S().doc));
  });

  it('moved and removed objects, and a failed preview', () => {
    const st = town();
    const doc = st.getState().doc;
    const p = previewIntents(doc, intents('move type:car by=0,0,2', 'delete type:tree:conifer'), emptyContext());
    expect(p.diff!.moved.length).toBe(9);
    expect(p.diff!.moved.every((m) => m.after.transform.position[2] - m.before.transform.position[2] === 2)).toBe(true);
    expect(p.diff!.removed.length).toBe(6);
    expect(p.diff!.added).toEqual([]);
    expect(p.diff!.terrain).toBeNull();
    const bad = previewIntents(doc, intents('move type:crate by=1,0,0'), emptyContext());
    expect(bad.result.ok).toBe(false);
    expect(bad.diff).toBeNull();
    expect(st.getState().doc).toBe(doc);
  });

  it('the plan hash is the same text on the same document — and another for another document, text or context', () => {
    const doc = street().getState().doc;
    const h = (d: WorldDocument, ctx: CommandContext, ...lines: string[]) => {
      const p = previewIntents(d, intents(...lines), ctx);
      if (!p.result.ok) throw new Error(JSON.stringify(p.result.failure));
      return p.result.hash;
    };
    const a = h(doc, emptyContext(), 'place building:house count=3 along=road:main side=north gap=2', 'group last name="A"');
    expect(h(doc, emptyContext(), 'place building:house count=3 along=road:main side=north gap=2', 'group last name="A"')).toBe(a);
    expect(h(doc, emptyContext(), 'place building:house count=3 along=road:main side=north gap=3', 'group last name="A"')).not.toBe(a);
    expect(h(doc, emptyContext(), 'place building:house count=3 along=road:main side=north gap=2', 'group last name="B"')).not.toBe(a);
    const seeded = { ...doc, settings: { ...doc.settings, simulation: { ...doc.settings.simulation, seed: 99 } } };
    expect(h(seeded, emptyContext(), 'place tree count=2 at=0,30')).not.toBe(h(doc, emptyContext(), 'place tree count=2 at=0,30'));
    // "Here" is part of the plan (the context goes into plans — and only into plans).
    expect(h(doc, { ...emptyContext(), cursor: [1, 30] }, 'place tree at=cursor')).not.toBe(h(doc, { ...emptyContext(), cursor: [2, 30] }, 'place tree at=cursor'));
  });
});

describe('while a simulation runs on the document', () => {
  it('editing commands are refused with the reason; a disaster is written without an undo step, as with the mouse', () => {
    const st = town();
    const S = () => st.getState();
    S().setLocked(true);
    const sim: CommandContext = { ...emptyContext(), simulating: true, runtime: { time: 2, summary: {}, instances: [] } };
    const before = bits(S().doc), past = S().past;
    expect(runIntents(st, intents('move type:car by=1,0,0'), sim)).toMatchObject({ ok: false, failure: { error: { key: 'cmd37.err.simulating' } } });
    expect(bits(S().doc)).toBe(before);
    const r = okRun(runIntents(st, intents('count type:car', 'disaster blast at=0,0 energy=2e9 now'), sim));
    expect(S().doc.scenario.experiment?.instances.map((i) => i.id)).toEqual(['p1']);
    expect(S().past).toBe(past);
    expect(r.effects).toEqual([{ fx: 'runInstances', ids: ['p1'] }]);
    expect(r.lines[1].plan.warnings.map((w) => w.key)).toContain('cmd37.warn.noHistory');
    S().setLocked(false);
  });
});
