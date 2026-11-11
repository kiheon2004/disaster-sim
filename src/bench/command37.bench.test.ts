/**
 * Phase 37 §22 — cost of the command layer without a rendering context:
 *
 *   parser      every sentence of the corpus through `interpret` (median / p95 / max per sentence, by language)
 *   plan        interpret + plan on a 5000-object scene: selection queries (target p95 < 50 ms), "place 100 buildings"
 *               (target < 300 ms), large placements, deletes, terrain
 *   draft       what one keystroke costs while typing: the preview (fork + run + diff) of the same commands
 *   commit      confirm / undo / redo of batch steps (objects, a mixed script with terrain), with the store's batch
 *
 *   BENCH=1 npx vitest run src/bench/command37 --silent=false --maxWorkers=1     (BENCH_OUT=file.json to save)
 *
 * The frame-rate side (typing with 5000 objects on screen, 1000 preview ghosts, the leak laps) is measured in Chrome
 * by scripts/bench-command37.mjs.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import type { WorldDocument } from '@/core/model';
import { drawRoad } from '@/roads/network';
import { defaultProfile } from '@/roads/types';
import { createEmptyDocument, type CreateObjectInput } from '@/world/WorldDocument';
import { stressScene } from '@/world/stressScene';
import { scratchWorld } from '@/world/worldStore';
import { emptyContext, envOf, type CommandContext } from '@/command/context';
import { loadCorpus } from '@/command/corpus';
import type { Intent } from '@/command/intent';
import { interpret } from '@/command/interpret';
import { planIntent } from '@/command/plan';
import { previewIntents, runIntents } from '@/command/run';

const ms = (t0: number) => performance.now() - t0;
const round = (v: number, d = 2) => +v.toFixed(d);

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: s.length, p50: round(at(0.5), 3), p95: round(at(0.95), 3), max: round(s[s.length - 1], 3), mean: round(s.reduce((a, b) => a + b, 0) / s.length, 3) };
}

/**
 * 5000 objects (the stress scene's mix) with two crossing streets and one empty quarter (x, z > 4) — room for the
 * "place 100 buildings" plan, so that the planner places them instead of rejecting every spot.
 */
function scene(n: number) {
  const inRoad = (x: number, z: number) => Math.abs(x) < 9 || Math.abs(z) < 9;
  const keep = (o: CreateObjectInput) => {
    const [x, , z] = o.transform.position;
    return !(x > 4 && z > 4) && !inRoad(x, z);
  };
  let pool: CreateObjectInput[] = [];
  for (let ask = Math.round(n * 1.5); pool.length < n; ask = Math.round(ask * 1.2)) pool = stressScene(ask).filter(keep);
  pool.length = n;
  const st = scratchWorld(createEmptyDocument('bench'));
  let net = drawRoad(st.getState().doc.roads, [[-96, 0], [96, 0]], { curved: false, profile: defaultProfile() }).network;
  net = drawRoad(net, [[0, -96], [0, 96]], { curved: false, profile: defaultProfile() }).network;
  st.getState().applyEdit({ roads: net, add: pool });
  return st;
}

function intentsOf(lines: readonly string[]): Intent[] {
  return lines.flatMap((l) => {
    const r = interpret(l);
    if (r.kind !== 'ok') throw new Error(`not understood: ${l} ${JSON.stringify(r)}`);
    return r.intents;
  });
}

const seedOf = (doc: WorldDocument) => doc.settings.simulation.seed;

describe.skipIf(!process.env.BENCH)('command layer cost', () => {
  it('parser, plan, draft, commit / undo / redo', { timeout: 1_800_000 }, () => {
    const out: Record<string, unknown> = {};

    // ---- parser: the whole corpus --------------------------------------------------------------------------------
    const corpus = loadCorpus();
    const sentences = corpus.flatMap((f) => f.cases.map((c) => ({ lang: f.lang, text: c.text })));
    const canonical = corpus.flatMap((f) => f.cases.flatMap((c) => ('expect' in c ? c.expect : [])));
    for (const s of sentences) interpret(s.text); // warm-up pass (JIT, lazily built tables)
    const parser: Record<string, unknown> = {};
    for (const lang of ['ko', 'en'] as const) {
      const list = sentences.filter((s) => s.lang === lang);
      const best = list.map(() => Infinity);
      let understood = 0;
      for (let rep = 0; rep < 5; rep++) {
        list.forEach((s, k) => {
          const t0 = performance.now();
          const r = interpret(s.text);
          best[k] = Math.min(best[k], ms(t0));
          if (rep === 0 && r.kind === 'ok') understood++;
        });
      }
      const worst = list.map((s, k) => [best[k], s.text] as const).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([t, text]) => ({ ms: round(t, 3), text }));
      parser[lang] = { sentences: list.length, understood, perSentenceMs: stats(best), slowest: worst };
    }
    {
      const best = canonical.map(() => Infinity);
      for (let rep = 0; rep < 5; rep++) canonical.forEach((c, k) => { const t0 = performance.now(); interpret(c); best[k] = Math.min(best[k], ms(t0)); });
      parser.canonical = { lines: canonical.length, perLineMs: stats(best) };
    }
    out.parser = parser;

    // ---- 5000-object scene ---------------------------------------------------------------------------------------
    const N = Number(process.env.BENCH_N ?? 5000);
    const t0 = performance.now();
    const st = scene(N);
    const S = () => st.getState();
    const buildMs = round(ms(t0), 0);
    expect(Object.keys(S().doc.objects).length).toBe(N);
    const trees = Object.values(S().doc.objects).filter((o) => o.type === 'tree').map((o) => o.id);
    const someTrees = trees.slice(0, 200);
    const ctx: CommandContext = { ...emptyContext(), selection: someTrees, primary: someTrees[0], cursor: [50, 50], view: [0, 0] };
    /** 1000 selected objects: the largest previews (1000 ghosts) come from duplicating / moving a large selection. */
    const ctx1000: CommandContext = { ...ctx, selection: trees.slice(0, 1000), primary: trees[0] };

    /** interpret + plan of one line, repeated: per-run ms. */
    const planRow = (line: string, reps: number, c: CommandContext = ctx) => {
      const samples: number[] = [];
      let info = '';
      for (let k = 0; k < reps; k++) {
        const t = performance.now();
        const r = interpret(line);
        if (r.kind !== 'ok') throw new Error(`not understood: ${line}`);
        const p = planIntent(r.intents[0], envOf(S().doc, c), { seed: seedOf(S().doc) });
        samples.push(ms(t));
        if (k === 0) info = p.ok ? `ops ${p.plan.ops.length}, items ${p.plan.items.length} (rejected ${p.plan.items.filter((i) => i.status === 'rejected').length}), create ${p.plan.counts.create} change ${p.plan.counts.change} remove ${p.plan.counts.remove}, result ${p.plan.resultIds.length}${p.plan.table ? `, rows ${p.plan.table.rows.length}` : ''}` : `stopped ${JSON.stringify(p).slice(0, 160)}`;
      }
      return { line, ...stats(samples), info };
    };
    const QUERIES = [
      'select type:tree',
      'select type:building where floors>=5',
      'select type:tree where near 0,0 r=30',
      'select type:building tallest',
      'select type:car nearest cursor',
      'select type:human nearest cursor first 10',
      'count type:building',
      'count all',
      'list all where near 0,0 r=40',
      'count all where hidden',
      'list type:building where floors>=8',
      'info selection',
      'measure selection',
      'focus type:building largest',
    ];
    const queries = QUERIES.map((q) => planRow(q, 40));
    out.queries = { target: 'p95 < 50 ms', worstP95: Math.max(...queries.map((r) => r.p95)), rows: queries };

    const PLANS = [
      'place building:house count=100 at=52,52 gap=1',
      'place building:house count=20 along=road:n1-n2 side=north gap=2',
      'place tree count=1000 at=52,52 gap=0.5',
      'place car count=40 along=road:n1-n2',
      'move selection by=3,0,0',
      'rotate type:car by=15',
      'align selection axis=x mode=min ref=origin',
      'distribute selection axis=auto',
      'delete type:car',
      'delete type:tree',
      'duplicate selection offset=2,2',
      'terrain raise circle 50,50 r=30 by=2',
      'paint circle 50,50 r=30 ground=grass',
      'forest circle 52,52 r=40 density=high seed=2',
      'road 30,30 -> 90,90 preset=street',
      'disaster blast at=50,50 energy=1e9',
    ];
    const plans = PLANS.map((p) => planRow(p, 10));
    plans.push({ ...planRow('duplicate selection offset=1,1', 10, ctx1000), line: 'duplicate selection offset=1,1  (1000 selected)' });
    plans.push({ ...planRow('move selection by=0,0,2', 10, ctx1000), line: 'move selection by=0,0,2  (1000 selected)' });
    out.plans = { target: '"place 100 buildings" < 300 ms', note: 'more than 2000 objects in one command is refused (§19): "delete type:tree" shows the cost of that refusal', rows: plans };

    // ---- draft: one keystroke's preview (fork the document, run on the fork, diff) ---------------------------------
    const draftRow = (line: string, reps: number, c: CommandContext = ctx) => {
      const intents = intentsOf([line]);
      const samples: number[] = [];
      let info = '';
      for (let k = 0; k < reps; k++) {
        const t = performance.now();
        const p = previewIntents(S().doc, intents, c);
        samples.push(ms(t));
        if (k === 0) info = p.diff ? `added ${p.diff.added.length} removed ${p.diff.removed.length} moved ${p.diff.moved.length} changed ${p.diff.changed.length} rewritten ${p.diff.rewritten}${p.diff.terrain ? ` terrain ${round(p.diff.terrain.area, 0)} m²` : ''}` : 'no diff';
      }
      return { line, ...stats(samples), info };
    };
    out.drafts = {
      note: 'previewIntents on the 5000-object document (what the live preview pays per change of the text)',
      rows: ['select type:tree', 'place building:house count=3 along=road:n1-n2 side=north gap=2', 'place building:house count=100 at=52,52 gap=1', 'place tree count=1000 at=52,52 gap=0.5', 'move selection by=3,0,0', 'delete type:car', 'terrain raise circle 50,50 r=30 by=2', 'forest circle 52,52 r=40 density=high seed=2'].map((l) => draftRow(l, 8)),
    };
    (out.drafts as { rows: unknown[] }).rows.push({ ...draftRow('duplicate selection offset=1,1', 8, ctx1000), line: 'duplicate selection offset=1,1  (1000 selected → 1000 ghosts)' });

    // ---- commit / undo / redo --------------------------------------------------------------------------------------
    const commitRow = (name: string, lines: readonly string[], c: CommandContext = ctx) => {
      const intents = intentsOf(lines);
      const steps = S().past.length;
      let t = performance.now();
      const r = runIntents(st, intents, c);
      const commitMs = ms(t);
      if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.failure).slice(0, 300)}`);
      const objects = Object.keys(S().doc.objects).length;
      expect(S().past.length).toBe(steps + (r.changed ? 1 : 0));
      t = performance.now();
      S().undo();
      const undoMs = ms(t);
      t = performance.now();
      S().redo();
      const redoMs = ms(t);
      t = performance.now();
      S().undo();
      const undo2Ms = ms(t);
      expect(Object.keys(S().doc.objects).length).toBe(N);
      return { name, lines: lines.length, objectsAfter: objects, commitMs: round(commitMs, 1), undoMs: round(undoMs, 1), redoMs: round(redoMs, 1), undoAgainMs: round(undo2Ms, 1) };
    };
    out.commits = [
      commitRow('place 3 houses on the road', ['place building:house count=3 along=road:n1-n2 side=north gap=2']),
      commitRow('place 100 houses', ['place building:house count=100 at=52,52 gap=1']),
      commitRow('place 1000 trees', ['place tree count=1000 at=52,52 gap=0.5']),
      commitRow('move 200 selected trees', ['move selection by=3,0,0']),
      commitRow('duplicate 1000 selected trees', ['duplicate selection offset=1,1'], ctx1000),
      commitRow('move 1000 selected trees', ['move selection by=0,0,2'], ctx1000),
      commitRow('rotate every car', ['rotate type:car by=15']),
      commitRow('delete every car', ['delete type:car']),
      commitRow('terrain: raise a 30 m circle', ['terrain raise circle 50,50 r=30 by=2']),
      commitRow('terrain + paint + forest', ['terrain raise circle 50,50 r=30 by=2', 'paint circle 50,50 r=30 ground=grass', 'forest circle 52,52 r=28 density=high seed=2']),
      commitRow('mixed script (objects, group, road, terrain, forest, disasters)', [
        'place building:house count=10 at=40,40 gap=2',
        'group last name="bench block"',
        'road 30,70 -> 90,70 preset=street',
        'terrain raise circle 70,30 r=15 by=3',
        'forest circle 70,30 r=16 density=low seed=4',
        'place car count=6 along=road:nearest(60,70)',
        'move group:"bench block" by=0,0,3',
        'disaster blast at=50,50 energy=1e9 start=5',
        'disaster fire at=60,60',
        'hide type:car where near 0,0 r=60',
      ]),
    ];

    const head = (() => { try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })();
    const result = { date: new Date().toISOString(), commit: head, node: process.version, cpus: os.cpus()[0]?.model, load: os.loadavg().map((v) => +v.toFixed(1)), objects: N, sceneBuildMs: buildMs, ...out };
    process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
    if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, `${JSON.stringify(result, null, 2)}\n`);
  });
});
