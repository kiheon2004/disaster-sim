// Phase 16 edit-mode benchmark (production build, real GPU): bulk placement, multi-selection,
// group move, undo / redo, save / load, idle FPS, draw calls, heap and GC — at 100/500/1000/2000
// objects. Every timing includes the frames needed to show the result (two rAFs after the call).
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/bench-build.mjs http://localhost:4173/ 100,500,1000,2000 [out.json]
//   MODE=legacy node scripts/bench-build.mjs http://localhost:4174/ …   (Phase 15 build: idle / load / select only)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const [url = 'http://localhost:4173/', countsArg = '100,500,1000,2000', outFile] = process.argv.slice(2);
const counts = countsArg.split(',').map(Number);
const legacy = process.env.MODE === 'legacy';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,900', '--enable-precise-memory-info', '--js-flags=--expose-gc'],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 }, protocolTimeout: 900_000,
});

async function gcTrace(page, ms) {
  await page.tracing.start({ categories: ['devtools.timeline', 'v8', 'disabled-by-default-devtools.timeline'] });
  await new Promise((r) => setTimeout(r, ms));
  const buf = await page.tracing.stop();
  const ev = JSON.parse(Buffer.from(buf).toString()).traceEvents;
  const mains = ev.filter((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
  const score = (m) => ev.filter((e) => e.pid === m.pid && e.tid === m.tid && e.name === 'FireAnimationFrame').length;
  const main = mains.sort((a, b) => score(b) - score(a))[0];
  const evs = ev.filter((e) => e.pid === main.pid && e.tid === main.tid && e.ph === 'X');
  const gc = evs.filter((e) => /GC/.test(e.name) && !/Allocation/.test(e.name)).reduce((a, e) => a + e.dur / 1000, 0);
  return +(gc / (ms / 1000)).toFixed(1);
}

const results = [];
for (const n of counts) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(url + '?devtools', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__ds && window.__r3f);
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__ds && window.__r3f);
  await page.evaluate(() => {
    window.__frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    window.__fps = async (ms) => {
      const st = window.__r3f.get();
      const gl = st.gl;
      let frames = 0, calls = 0, renders = 0, run = true;
      const o = gl.render;
      gl.render = function (...a) { gl.info.reset(); o.apply(this, a); calls += gl.info.render.calls; renders++; };
      const loop = () => { if (run) { frames++; requestAnimationFrame(loop); } };
      const t0 = performance.now();
      requestAnimationFrame(loop);
      await new Promise((r) => setTimeout(r, ms));
      run = false;
      gl.render = o;
      return { fps: +((frames * 1000) / (performance.now() - t0)).toFixed(1), drawCalls: Math.round(calls / Math.max(1, renders)), subscribers: st.internal.subscribers.length };
    };
    const s = window.__r3f.get();
    s.camera.position.set(48, 42, 62);
    s.controls.target.set(0, 0, 0);
    s.controls.update();
  });
  const row = { n };
  const heap = () => page.evaluate(() => +(performance.memory.usedJSHeapSize / 1048576).toFixed(1));
  const collect = async () => { await page.evaluate(() => window.gc?.()); await new Promise((r) => setTimeout(r, 300)); };

  // Scene load (the same stress scene as docs/PERFORMANCE.md).
  row.loadMs = await page.evaluate(async (n) => {
    const t0 = performance.now();
    window.__ds.actions.loadStressScene(n);
    await window.__frames();
    return +(performance.now() - t0).toFixed(0);
  }, n);
  await new Promise((r) => setTimeout(r, 1500));
  await collect();
  row.heapStartMB = await heap();
  Object.assign(row, { idle: await page.evaluate(() => window.__fps(3000)) });
  row.gcIdleMsPerS = await gcTrace(page, 2500);

  // Multi-selection of everything (+ FPS while selected).
  row.selectAllMs = await page.evaluate(async () => {
    const t0 = performance.now();
    window.__ds.editor.getState().setSelection(Object.keys(window.__ds.world.getState().doc.objects));
    await window.__frames();
    return +(performance.now() - t0).toFixed(0);
  });
  row.selected = await page.evaluate(() => window.__fps(2000));

  if (!legacy) {
    // Group move of the whole selection (one undo step), then undo / redo of it.
    row.groupMoveMs = await page.evaluate(async () => {
      const t0 = performance.now();
      window.__ds.buildActions.transformSelection({ dx: 3, dy: 0, dz: -2, dyaw: 0.3 });
      await window.__frames();
      return +(performance.now() - t0).toFixed(0);
    });
    row.groupUndoMs = await page.evaluate(async () => { const t0 = performance.now(); window.__ds.world.getState().undo(); await window.__frames(); return +(performance.now() - t0).toFixed(0); });
    await page.evaluate(() => window.__ds.editor.getState().setSelection([]));
    await page.evaluate(() => window.__frames());

    // Save / load (serialize + parse + replace + first frame).
    Object.assign(row, await page.evaluate(async () => {
      const L = window.__ds.buildLib;
      const doc = window.__ds.world.getState().doc;
      let t0 = performance.now();
      const json = L.serializeDocument(doc, false);
      const saveMs = performance.now() - t0;
      t0 = performance.now();
      const res = L.parseDocument(json);
      window.__ds.world.getState().replaceDocument(res.doc);
      await window.__frames();
      return { saveMs: +saveMs.toFixed(0), loadParseMs: +(performance.now() - t0).toFixed(0), fileKB: Math.round(json.length / 1024) };
    }));

    // Bulk placement of n MORE objects with the real planner (area fill, collision checks on).
    Object.assign(row, await page.evaluate(async (n) => {
      const L = window.__ds.buildLib;
      const w = window.__ds.world;
      w.getState().replaceDocument(L.createEmptyDocument('bench'));
      await window.__frames();
      const step = Math.sqrt(32000 / n);
      let t0 = performance.now();
      const pts = L.areaFill({ kind: 'rect', x0: -92, z0: -92, x1: 92, z1: 92 }, { mode: 'grid', spacing: step, density: 0, jitter: 0.3, seed: 3 }).slice(0, n).map(([x, z]) => ({ x, z }));
      const ctx = { terrain: L.samplerFor(w.getState().doc.terrain), existing: L.FootprintIndex.fromObjects(Object.values(w.getState().doc.objects)) };
      const plan = L.planPlacement({ type: 'human', randomize: true }, pts, { ...L.DEFAULT_PLACEMENT, seed: 5, avoidCollisions: true }, ctx);
      const planMs = performance.now() - t0;
      t0 = performance.now();
      const ids = window.__ds.buildActions.commitPlan(plan, null);
      const commitMs = performance.now() - t0;
      await window.__frames();
      const placeTotalMs = performance.now() - t0 + planMs;
      t0 = performance.now(); w.getState().undo(); await window.__frames(); const undoMs = performance.now() - t0;
      t0 = performance.now(); w.getState().redo(); await window.__frames(); const redoMs = performance.now() - t0;
      return { placed: ids.length, planMs: +planMs.toFixed(0), commitMs: +commitMs.toFixed(1), placeTotalMs: +placeTotalMs.toFixed(0), undoMs: +undoMs.toFixed(0), redoMs: +redoMs.toFixed(0), batches: window.__ds.editorBatches()?.stats };
    }, n));
  }

  // Back to the stress scene: heap growth after the whole cycle (after GC).
  await page.evaluate((n) => window.__ds.actions.loadStressScene(n), n);
  await new Promise((r) => setTimeout(r, 1200));
  await collect();
  row.heapEndMB = await heap();
  console.log(JSON.stringify(row));
  results.push(row);
  await page.close();
}
if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
await browser.close();
