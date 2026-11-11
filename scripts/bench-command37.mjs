// Phase 37 command-bar benchmark in real Chrome (spec §22), production build, real GPU, real keyboard for everything typed.
//
//   node scripts/bench-command37.mjs 4371 docs/bench-phase37-typing.json                 (MODE=typing, default)
//   MODE=ghosts node scripts/bench-command37.mjs 4371 docs/bench-phase37-ghosts.json
//   MODE=leak   node scripts/bench-command37.mjs 4371 docs/bench-phase37-leak.json
//
// typing  COUNTS (default 5000) objects of the stress scene on screen: FPS and CPU time per frame idle, then WHILE a command
//         is typed character by character (KEY_MS between keys, default 80 = fast typing); per sentence the cost of every
//         draft the bar made (session.draftMs), the longest task, and whether the live preview paused itself.
// ghosts  preview of 100 / 1000 objects (duplicates of a selection, so every one of them is a real ghost): FPS idle and
//         orbiting, draw calls, triangles, the time from Enter to the ghosts being in the scene, and whether typing on /
//         Enter rebuild them (the layer's build counter).
// leak    LEAK_N laps (default 100) of the Phase 36 editing lap (objects, terrain, road, disaster, simSwitch, saveLoad —
//         the same operations as bench-editor36.mjs) plus the command bar's: bar (open / close by key), plan (type → Enter
//         → Esc), confirm (type → Enter → Enter → undo). Sampled every SAMPLE_EVERY laps after two forced collections:
//         JS heap, geometries, textures, programs, scene objects, preview objects, window / document listeners.
//         LEAK_OPS=<comma list> runs a subset — one operation alone shows which one holds memory.
//
// Every result file records the commit, the 1 / 5 / 15 min load average and the free memory at start and end.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';

const [target = '4371', outFile] = process.argv.slice(2);
const url = /^\d+$/.test(target) ? `http://localhost:${target}/` : target;
const MODE = process.env.MODE ?? 'typing';
const COUNTS = (process.env.COUNTS ?? '5000').split(',').map(Number);
const KEY_MS = Number(process.env.KEY_MS ?? 80);
const LEAK_N = Number(process.env.LEAK_N ?? 100);
const SAMPLE_EVERY = Number(process.env.SAMPLE_EVERY ?? 10);
const ALL_OPS = ['objects', 'terrain', 'road', 'disaster', 'simSwitch', 'saveLoad', 'bar', 'plan', 'confirm'];
const LEAK_OPS = (process.env.LEAK_OPS ?? ALL_OPS.join(',')).split(',');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sh = (c) => { try { return execSync(c, { encoding: 'utf8' }).trim(); } catch { return ''; } };
const machine = () => ({ time: new Date().toISOString(), load: os.loadavg().map((v) => +v.toFixed(1)), freePercent: Number(/(\d+)%/.exec(sh('memory_pressure | grep "free percentage"'))?.[1] ?? NaN) });
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,900', '--enable-precise-memory-info', '--js-flags=--expose-gc'],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 }, protocolTimeout: 1_800_000,
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const INPUT = '[data-testid="command-input"]';

async function openPage() {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(url + '?devtools', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__ds && window.__r3f);
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__ds && window.__r3f);
  await page.evaluate(() => {
    window.__frames = (n = 2) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
    // CPU time per frame: every rAF callback is timed and summed per frame timestamp (as bench-editor36.mjs does).
    const raf = window.requestAnimationFrame.bind(window);
    window.__cpu = null;
    window.requestAnimationFrame = (cb) => raf((t) => {
      const a = performance.now();
      try { cb(t); } finally { if (window.__cpu) window.__cpu.set(t, (window.__cpu.get(t) ?? 0) + performance.now() - a); }
    });
    const pct = (v, p) => { const s = [...v].sort((a, b) => a - b); return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2) : null; };
    const mean = (v) => (v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null);
    window.__stat = (v) => ({ n: v.length, mean: mean(v), p50: pct(v, 0.5), p95: pct(v, 0.95), max: pct(v, 1) });
    /** Start measuring; the returned function stops and reports FPS, CPU frame time, frame gaps, draw calls, long tasks. */
    window.__startMeasure = (orbit = false) => {
      const st = window.__r3f.get();
      const gl = st.gl, cam = st.camera, ctl = st.controls;
      const target = ctl.target.clone(), off = cam.position.clone().sub(target);
      let frames = 0, calls = 0, tris = 0, renders = 0, run = true, last = 0;
      const gaps = [];
      const render = gl.render;
      gl.render = function (...a) { gl.info.reset(); render.apply(this, a); calls += gl.info.render.calls; tris += gl.info.render.triangles; renders++; };
      window.__cpu = new Map();
      const long = [];
      const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(e.duration); });
      try { po.observe({ entryTypes: ['longtask'] }); } catch { /* not supported: the gaps still show stalls */ }
      const t0 = performance.now();
      const loop = (t) => {
        if (!run) return;
        frames++;
        if (last) gaps.push(t - last);
        last = t;
        if (orbit) {
          const a = ((t - t0) / 1000) * 0.6, c = Math.cos(a), s = Math.sin(a);
          cam.position.set(target.x + off.x * c - off.z * s, target.y + off.y, target.z + off.x * s + off.z * c);
          ctl.update();
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      return () => {
        run = false;
        gl.render = render;
        po.disconnect();
        const cpu = [...window.__cpu.values()];
        window.__cpu = null;
        if (orbit) { cam.position.copy(target).add(off); ctl.update(); }
        return { fps: +((frames * 1000) / (performance.now() - t0)).toFixed(1), cpuFrameMs: window.__stat(cpu), frameGapMs: window.__stat(gaps), longTasks: { n: long.length, maxMs: long.length ? Math.round(Math.max(...long)) : 0 }, drawCalls: Math.round(calls / Math.max(1, renders)), triangles: Math.round(tris / Math.max(1, renders)) };
      };
    };
    window.__measure = async (ms, orbit = false) => { const stop = window.__startMeasure(orbit); await new Promise((r) => setTimeout(r, ms)); return stop(); };
    window.__view = (x, z, h, back) => { const st = window.__r3f.get(); st.camera.position.set(x, h, z + back); st.controls.target.set(x, 0, z); st.controls.update(); };
    // Every draft the bar makes: its cost as the session records it.
    window.__drafts = [];
    let lastMs = -1;
    window.__ds.command.session.subscribe((s) => { if (s.draftMs !== lastMs) { lastMs = s.draftMs; window.__drafts.push(+s.draftMs.toFixed(1)); } });
  });
  return page;
}
const focusBar = async (page) => { await page.focus(INPUT); await page.evaluate((s) => document.querySelector(s).select(), INPUT); await page.keyboard.press('Backspace'); };
const preview = (page) => page.evaluate(() => window.__ds.command.preview());
const sessionOf = (page) => page.evaluate(() => { const s = window.__ds.command.session.getState(); return { armed: s.plan?.armed ?? null, fb: s.feedback.k, understood: s.understood, draftMs: +s.draftMs.toFixed(1) }; });

// ── typing ───────────────────────────────────────────────────────────────────────────────────────────────────────────
async function typingRow(n) {
  const page = await openPage();
  await page.evaluate((n) => window.__ds.actions.loadStressScene(n), n);
  await page.evaluate(() => window.__view(0, 0, 90, 110));
  await wait(2000);
  const idle = await page.evaluate(() => window.__measure(3000));
  // 200 trees selected (setup) for the sentences that speak of "the selection".
  await page.evaluate(() => { const ds = window.__ds; const ids = Object.values(ds.world.getState().doc.objects).filter((o) => o.type === 'tree').slice(0, 200).map((o) => o.id); ds.editor.getState().setSelection(ids, ids[0]); });
  await wait(500);
  const idleSelected = await page.evaluate(() => window.__measure(2000));
  const SENTENCES = [
    ['query', '가장 높은 건물 보여 줘'],
    ['select', 'select every tree within 30 m of (0, 0)'],
    ['place 3', '(0, 0)에 나무 세 그루 간격 2 m'],
    ['place 100', 'place crate count=100 at=0,0 gap=0.3'],
    ['move 200 selected', '선택한 것 동쪽으로 3 m 옮겨'],
    ['duplicate 200 selected', 'duplicate selection offset=1,1'],
    ['terrain', '(40, 40) 반경 12 m 지면을 2 m 높여'],
    ['delete (kind)', 'delete all the cars'],
    ['not understood', 'paint the sky purple please'],
  ];
  const rows = [];
  for (const [name, text] of SENTENCES) {
    await focusBar(page);
    await wait(300);
    await page.evaluate(() => { window.__drafts.length = 0; window.__stop = window.__startMeasure(false); });
    const t0 = Date.now();
    await page.keyboard.type(text, { delay: KEY_MS });
    await wait(900); // the last debounced draft
    const m = await page.evaluate(() => window.__stop());
    const drafts = await page.evaluate(() => window.__drafts.slice());
    const s = await sessionOf(page);
    const hint = await page.evaluate(() => document.querySelector('[data-testid="command-hint"]')?.textContent ?? '');
    const p = await preview(page);
    rows.push({ name, text, chars: text.length, typedMs: Date.now() - t0, ...m, drafts: { n: drafts.length, maxMs: drafts.length ? Math.max(...drafts) : 0, all: drafts }, understood: s.understood, hint, ghosts: p.ghosts, moved: p.moved, removed: p.removed });
    console.log(JSON.stringify({ n, name, fps: m.fps, cpuP95: m.cpuFrameMs.p95, gapMax: m.frameGapMs.max, long: m.longTasks, drafts: drafts.length, draftMax: rows[rows.length - 1].drafts.maxMs, hint }));
    await page.keyboard.press('Escape');
    await wait(200);
  }
  await page.close();
  return { n, keyMs: KEY_MS, idle, idleSelected, sentences: rows };
}

// ── ghosts ───────────────────────────────────────────────────────────────────────────────────────────────────────────
async function ghostRow(kind, count) {
  const page = await openPage();
  // setup: an empty world with `count` objects on a grid, all selected — their duplicates are the ghosts.
  await page.evaluate(([kind, count]) => {
    const ds = window.__ds, W = ds.world;
    W.getState().replaceDocument(ds.buildLib.createEmptyDocument(''));
    const step = kind === 'house' ? 13 : 4.5, cols = Math.ceil(Math.sqrt(count));
    const inputs = Array.from({ length: count }, (_, k) => {
      const x = -((cols - 1) * step) / 2 + (k % cols) * step, z = -((cols - 1) * step) / 2 + Math.floor(k / cols) * step;
      const t = { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] };
      return kind === 'house' ? { type: 'building', transform: t, building: ds.buildingLib.createDesign(ds.buildingLib.presetSpec('house')) } : { type: 'tree', transform: t };
    });
    const ids = W.getState().addObjects(inputs);
    W.setState({ past: [], future: [] });
    ds.editor.getState().setSelection(ids, ids[0]);
  }, [kind, count]);
  await page.evaluate(() => window.__view(0, 0, 110, 120));
  await wait(1500);
  const before = await page.evaluate(() => window.__measure(2500));
  await focusBar(page);
  const off = kind === 'house' ? '6.5,6.5' : '2.2,2.2';
  await page.keyboard.type(`duplicate selection offset=${off}`, { delay: 5 });
  await wait(1500);
  const draft = await preview(page);
  const t0 = Date.now();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__ds.command.session.getState().plan?.armed === true && window.__ds.command.preview().sceneObjects > 0, { timeout: 120_000 });
  const enterMs = Date.now() - t0;
  await page.evaluate(() => window.__frames(3));
  const armed = await preview(page);
  const s = await sessionOf(page);
  const idle = await page.evaluate(() => window.__measure(3000));
  const orbit = await page.evaluate(() => window.__measure(3000, true));
  // The same plan again (a second Enter would confirm; Enter is not pressed): time passes, frames render — no rebuild.
  const later = await preview(page);
  await page.keyboard.press('Escape');
  await wait(400);
  const gone = await preview(page);
  const after = await page.evaluate(() => window.__measure(1500));
  await page.close();
  return { kind, count, ghosts: armed.ghosts, warned: armed.warned, planOnEnterMs: enterMs, draftMs: s.draftMs, noPlan: before, idle, orbit, addedDrawCalls: idle.drawCalls - before.drawCalls, builds: { draft: draft.builds, armed: armed.builds, later: later.builds }, afterCancel: { sceneObjects: gone.sceneObjects, drawCalls: after.drawCalls } };
}

// ── leak ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function leakRun(n) {
  const page = await openPage();
  const cdp = await page.target().createCDPSession();
  const listeners = async () => {
    const out = {};
    for (const expr of ['window', 'document']) {
      const { result } = await cdp.send('Runtime.evaluate', { expression: expr, objectGroup: 'lk' });
      const { listeners: ls } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
      out[expr] = ls.length;
    }
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'lk' });
    return out;
  };
  await page.evaluate((n) => window.__ds.actions.loadStressScene(n), n);
  await page.evaluate(() => window.__view(0, 0, 90, 110));
  await wait(1500);
  const sample = async (i) => {
    await cdp.send('HeapProfiler.collectGarbage');
    await wait(300);
    await cdp.send('HeapProfiler.collectGarbage');
    const { usedSize } = await cdp.send('Runtime.getHeapUsage');
    const gpu = await page.evaluate(async () => {
      await new Promise((r) => setTimeout(r, 100));
      const st = window.__r3f.get();
      let objects = 0;
      st.scene.traverse(() => objects++);
      return { geometries: st.gl.info.memory.geometries, textures: st.gl.info.memory.textures, programs: st.gl.info.programs?.length ?? null, sceneObjects: objects, previewObjects: window.__ds.command.preview().sceneObjects, history: window.__ds.command.session.getState().history.length };
    });
    return { i, ...gpu, heapKB: Math.round(usedSize / 1024), listeners: await listeners() };
  };
  const on = new Set(LEAK_OPS);
  const key = async (k, ms = 60) => { await page.keyboard.press(k); await wait(ms); };
  const samples = [await sample(0)];
  for (let i = 1; i <= LEAK_N; i++) {
    // The Phase 36 lap (bench-editor36.mjs, the same operations through the same calls).
    await page.evaluate(async ({ i, ops }) => {
      const ds = window.__ds, W = ds.world, f = () => window.__frames();
      const on = new Set(ops);
      if (on.has('objects')) {
        const ids = W.getState().addObjects(Array.from({ length: 10 }, (_, k) => ({ type: 'tree', transform: { position: [-60 + k * 3, 0, -80], rotation: [0, 0, 0], scale: [1, 1, 1] } })));
        await f();
        W.getState().remove(ids);
        await f();
      }
      if (on.has('terrain')) {
        W.getState().beginTerrainStroke();
        for (let k = 0; k < 5; k++) W.getState().terrainDab({ op: 'raise', x: 70, z: 70, brush: { radius: 6, strength: 0.5 }, dt: 0.05 });
        W.getState().endTerrainStroke();
        await f();
        W.getState().undo();
        await f();
      }
      if (on.has('road')) {
        const L = ds.roadLib;
        const r = L.drawRoad(W.getState().doc.roads, [[-40, 85], [40, 85]], { curved: false, profile: { ...L.defaultProfile() } });
        W.getState().applyEdit({ roads: r.network });
        await f();
        W.getState().applyEdit({ roads: L.deleteSegments(W.getState().doc.roads, r.segments) });
        await f();
      }
      if (on.has('disaster')) {
        ds.placement.armPlacement('fire');
        const id = ds.placement.placeAt([20 + (i % 5), -70]);
        await f();
        if (id) ds.placement.deleteInstance(id);
        ds.placement.disarmPlacement();
        await f();
      }
      if (on.has('simSwitch')) {
        await ds.actions.enterSimulation();
        await f();
        ds.actions.exitSimulation();
        await f();
      }
      if (on.has('saveLoad')) {
        const Lb = ds.buildLib;
        W.getState().replaceDocument(Lb.parseDocument(Lb.serializeDocument(W.getState().doc, false)).doc);
        await f();
      }
    }, { i, ops: LEAK_OPS });
    // The command bar, by the real keyboard. The typed commands differ from lap to lap (another count / place), as a
    // user's would: a cache keyed by the command text would show here.
    if (on.has('bar')) {
      await page.evaluate(() => document.activeElement?.blur());
      await key('Slash', 80);
      await page.keyboard.type('pla', { delay: 10 });
      await key('Tab', 60);
      await key('Escape', 40);
      await focusBar(page);
      await key('Escape', 40);
    }
    if (on.has('plan')) {
      await focusBar(page);
      await page.keyboard.type(`place crate count=${3 + (i % 5)} at=${-70 + (i % 9)},${70 - (i % 7)} gap=1`, { delay: 2 });
      await wait(250);
      await key('Enter', 250);
      await key('Escape', 120);
      await focusBar(page);
      await key('Escape', 40);
    }
    if (on.has('confirm')) {
      await focusBar(page);
      await page.keyboard.type(`place crate count=${2 + (i % 4)} at=${-70 + (i % 11)},${-60 - (i % 5)} gap=1`, { delay: 2 });
      await wait(250);
      await key('Enter', 250);
      await key('Enter', 350);
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
      await wait(200);
    }
    if (i % SAMPLE_EVERY === 0) {
      const s = await sample(i);
      samples.push(s);
      console.log(JSON.stringify(s));
    }
  }
  await page.close();
  const at = (i) => samples.find((s) => s.i === i);
  const first = samples[0], ten = at(10) ?? samples[1] ?? first, last = samples[samples.length - 1];
  const perLap = (a, b, k) => (b.i > a.i ? +(((b[k] - a[k])) / (b.i - a.i)).toFixed(2) : null);
  return {
    n, laps: LEAK_N, ops: LEAK_OPS, samples,
    growth: {
      heapKBPerLap_0_to_10: perLap(first, ten, 'heapKB'), heapKBPerLap_10_to_end: perLap(ten, last, 'heapKB'),
      geometries: last.geometries - ten.geometries, textures: last.textures - ten.textures, programs: (last.programs ?? 0) - (ten.programs ?? 0),
      sceneObjects: last.sceneObjects - ten.sceneObjects, previewObjects: last.previewObjects,
      windowListeners: last.listeners.window - ten.listeners.window, documentListeners: last.listeners.document - ten.listeners.document,
    },
  };
}

const results = { date: new Date().toISOString(), commit: sh('git rev-parse --short HEAD'), build: sh('cat ../dist1/BUILD.txt 2>/dev/null'), url, mode: MODE, chrome: await browser.version(), start: machine(), rows: [] };
const save = () => { results.end = machine(); if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 2)); };
if (MODE === 'typing') {
  for (const n of COUNTS) { results.rows.push(await typingRow(n)); save(); }
} else if (MODE === 'ghosts') {
  for (const [kind, count] of [['tree', 100], ['tree', 1000], ['house', 100]]) {
    const row = await ghostRow(kind, count);
    console.log(JSON.stringify(row));
    results.rows.push(row);
    save();
  }
} else {
  for (const n of COUNTS) {
    const row = await leakRun(n);
    console.log(JSON.stringify({ n, ops: row.ops, growth: row.growth }));
    results.rows.push(row);
    save();
  }
}
save();
await browser.close();
