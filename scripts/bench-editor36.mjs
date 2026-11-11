// Phase 36 editor scale + leak benchmark (spec §70 / §72), production build, real GPU (patterns of bench-build.mjs).
//
//   npx vite build && npx vite preview --port 4173 --strictPort &
//   node scripts/bench-editor36.mjs 4173 100,500,1000,2500,5000 docs/bench-phase36-editor.json            (scale)
//   MODE=leak LEAK_N=100 node scripts/bench-editor36.mjs 4173 1000 docs/bench-phase36-leak.json           (leak loop)
//
// The first argument is a port of `vite preview` on localhost (or a full URL). Run it on an IDLE machine: every number is
// wall-clock. Env: CHROME (browser path), MODE (scale | leak), LEAK_N (iterations, default 100), SAMPLE_EVERY (leak sample
// interval, default 10), IDLE_MS / ORBIT_MS (FPS windows, default 3000).
//
// scale, per object count (stress scene): FPS idle and while orbiting (camera moved every frame), CPU frame time (time
// inside requestAnimationFrame callbacks per frame: the R3F loop = scene update + render submission), JS heap after GC,
// select latency (real mouse click on a building → selection set and two frames shown; includes the CDP round trip),
// drag latency (the gizmo's write path: one transaction, a transform written every frame with history off — frame
// time while dragging), undo time of that drag, save (serialize) and load (parse + replace + first frames) time.
//
// leak: LEAK_N iterations of object create / delete, terrain stroke (+ undo), road create / delete, disaster place /
// delete, editor ⇄ simulation switch and save / load; every SAMPLE_EVERY iterations after GC: renderer.info geometries /
// textures / programs, JS heap, scene object count and the event listener counts on window and document (CDP).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const [target = '4173', countsArg = '100,500,1000,2500,5000', outFile] = process.argv.slice(2);
const url = /^\d+$/.test(target) ? `http://localhost:${target}/` : target;
const counts = countsArg.split(',').map(Number);
const MODE = process.env.MODE ?? 'scale';
const LEAK_N = Number(process.env.LEAK_N ?? 100);
const SAMPLE_EVERY = Number(process.env.SAMPLE_EVERY ?? 10);
const IDLE_MS = Number(process.env.IDLE_MS ?? 3000);
const ORBIT_MS = Number(process.env.ORBIT_MS ?? 3000);
const SELECT_N = Number(process.env.SELECT_N ?? 5);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,900', '--enable-precise-memory-info', '--js-flags=--expose-gc'],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 }, protocolTimeout: 1_800_000,
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
    // CPU time per frame: every rAF callback is timed and summed per frame timestamp (R3F runs one per frame).
    if (!window.__rafPatched) {
      const raf = window.requestAnimationFrame.bind(window);
      window.__cpu = null;
      window.requestAnimationFrame = (cb) => raf((t) => {
        const a = performance.now();
        try { cb(t); } finally { if (window.__cpu) window.__cpu.set(t, (window.__cpu.get(t) ?? 0) + performance.now() - a); }
      });
      window.__rafPatched = true;
    }
    const pct = (v, p) => { const s = [...v].sort((a, b) => a - b); return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2) : null; };
    const mean = (v) => (v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null);
    window.__stat = (v) => ({ mean: mean(v), p50: pct(v, 0.5), p95: pct(v, 0.95), max: pct(v, 1) });
    /** FPS + CPU frame time + draw calls over `ms`; `orbit` moves the camera around its target every frame. */
    window.__measure = async (ms, orbit = false) => {
      const st = window.__r3f.get();
      const gl = st.gl, cam = st.camera, ctl = st.controls;
      const target = ctl.target.clone(), off = cam.position.clone().sub(target);
      let frames = 0, calls = 0, tris = 0, renders = 0, run = true;
      const render = gl.render;
      gl.render = function (...a) { gl.info.reset(); render.apply(this, a); calls += gl.info.render.calls; tris += gl.info.render.triangles; renders++; };
      window.__cpu = new Map();
      const t0 = performance.now();
      const loop = (t) => {
        if (!run) return;
        frames++;
        if (orbit) {
          const a = ((t - t0) / 1000) * 0.6, c = Math.cos(a), s = Math.sin(a);
          cam.position.set(target.x + off.x * c - off.z * s, target.y + off.y, target.z + off.x * s + off.z * c);
          ctl.update();
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      await new Promise((r) => setTimeout(r, ms));
      run = false;
      gl.render = render;
      const cpu = [...window.__cpu.values()];
      window.__cpu = null;
      if (orbit) { cam.position.copy(target).add(off); ctl.update(); }
      return { fps: +((frames * 1000) / (performance.now() - t0)).toFixed(1), cpuFrameMs: window.__stat(cpu), drawCalls: Math.round(calls / Math.max(1, renders)), triangles: Math.round(tris / Math.max(1, renders)) };
    };
    window.__view = (x, z, h, back) => { const st = window.__r3f.get(); st.camera.position.set(x, h, z + back); st.controls.target.set(x, 0, z); st.controls.update(); };
  });
  return page;
}

const heap = (page) => page.evaluate(async () => { window.gc?.(); await new Promise((r) => setTimeout(r, 300)); return +(performance.memory.usedJSHeapSize / 1048576).toFixed(1); });

async function scaleRow(n) {
  const page = await openPage();
  const row = { n };
  row.loadMs = await page.evaluate(async (n) => { const t0 = performance.now(); window.__ds.actions.loadStressScene(n); await window.__frames(); return +(performance.now() - t0).toFixed(0); }, n);
  await page.evaluate(() => window.__view(0, 0, 70, 90));
  await wait(1500);
  row.heapMB = await heap(page);
  row.idle = await page.evaluate((ms) => window.__measure(ms, false), IDLE_MS);
  row.orbit = await page.evaluate((ms) => window.__measure(ms, true), ORBIT_MS);

  // Select latency: real clicks on the roofs of the SELECT_N buildings nearest the map centre, each seen from above. The
  // first click also pays for the inspector's first mount, so the row keeps it apart (selectFirstMs) from the median of the rest.
  const picks = await page.evaluate((k) => {
    const objs = Object.values(window.__ds.world.getState().doc.objects).filter((o) => o.type === 'building');
    objs.sort((a, b) => Math.hypot(a.transform.position[0], a.transform.position[2]) - Math.hypot(b.transform.position[0], b.transform.position[2]));
    return objs.slice(0, k).map((o) => ({ id: o.id, x: o.transform.position[0], y: o.transform.position[1], z: o.transform.position[2] }));
  }, SELECT_N);
  const pick = picks[0] ?? null;
  const selectTimes = [];
  for (const p of picks) {
    await page.evaluate(({ x, y, z }) => { window.__ds.editor.getState().select(null); window.__view(x, z, y + 80, 0.5); }, p);
    await wait(600);
    const [sx, sy] = await page.evaluate(({ x, y, z }) => {
      const st = window.__r3f.get(), r = st.gl.domElement.getBoundingClientRect();
      const v = st.camera.position.clone().set(x, y + 1, z).project(st.camera);
      return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
    }, p);
    await page.mouse.move(sx - 10, sy - 6);
    await page.mouse.move(sx, sy, { steps: 3 });
    await wait(200);
    const t0 = performance.now();
    await page.mouse.click(sx, sy);
    const ok = await page.waitForFunction((id) => window.__ds.editor.getState().selectedIds.includes(id), { timeout: 10_000 }, p.id).then(() => true, () => false);
    await page.evaluate(() => window.__frames());
    selectTimes.push(ok ? +(performance.now() - t0).toFixed(1) : null);
    await wait(1600); // past the 1.5 s overlap-cycling window, so the next click is a fresh pick
  }
  const rest = selectTimes.slice(1).filter((t) => t != null).sort((a, b) => a - b);
  row.selectFirstMs = selectTimes[0] ?? null;
  row.selectMs = rest.length ? rest[Math.floor((rest.length - 1) / 2)] : row.selectFirstMs; // median of the clicks after the first
  row.selectTimes = selectTimes;
  if (pick) {
    await page.evaluate(({ id, x, y, z }) => { window.__ds.editor.getState().select(id); window.__view(x, z, y + 80, 0.5); }, pick);
    await wait(600);
    // Drag latency: the gizmo's write path (transaction + a transform per frame, history off), 90 frames.
    Object.assign(row, await page.evaluate(async (id) => {
      const w = window.__ds.world;
      const start = [...w.getState().doc.objects[id].transform.position];
      window.__cpu = new Map();
      const gaps = [];
      w.getState().beginTransaction();
      let last = performance.now();
      for (let k = 1; k <= 90; k++) {
        await new Promise((r) => requestAnimationFrame(r));
        const now = performance.now();
        gaps.push(now - last);
        last = now;
        w.getState().updateTransform(id, { position: [start[0] + k * 0.05, start[1], start[2]] }, { history: false });
      }
      w.getState().commitTransaction();
      const cpu = [...window.__cpu.values()];
      window.__cpu = null;
      await window.__frames();
      const t0 = performance.now();
      w.getState().undo();
      await window.__frames();
      return { dragFrameMs: window.__stat(gaps), dragCpuFrameMs: window.__stat(cpu), undoMs: +(performance.now() - t0).toFixed(1) };
    }, pick.id));
  }

  // Save / load (serialize; parse + replace + first frames).
  Object.assign(row, await page.evaluate(async () => {
    const L = window.__ds.buildLib, doc = window.__ds.world.getState().doc;
    let t0 = performance.now();
    const json = L.serializeDocument(doc, false);
    const saveMs = performance.now() - t0;
    t0 = performance.now();
    window.__ds.world.getState().replaceDocument(L.parseDocument(json).doc);
    await window.__frames();
    return { saveMs: +saveMs.toFixed(0), loadMs2: +(performance.now() - t0).toFixed(0), fileKB: Math.round(json.length / 1024) };
  }));
  row.heapEndMB = await heap(page);
  await page.close();
  return row;
}

async function leakRun(n) {
  const page = await openPage();
  const cdp = await page.target().createCDPSession();
  const listeners = async () => {
    const out = {};
    for (const expr of ['window', 'document']) {
      const { result } = await cdp.send('Runtime.evaluate', { expression: expr });
      const { listeners: ls } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
      out[expr] = ls.length;
    }
    return out;
  };
  await page.evaluate((n) => window.__ds.actions.loadStressScene(n), n);
  await page.evaluate(() => window.__view(0, 0, 90, 110));
  await wait(1500);
  const sample = async (i) => {
    const gpu = await page.evaluate(async () => {
      window.gc?.();
      await new Promise((r) => setTimeout(r, 400));
      const st = window.__r3f.get();
      let objects = 0;
      st.scene.traverse(() => objects++);
      return { geometries: st.gl.info.memory.geometries, textures: st.gl.info.memory.textures, programs: st.gl.info.programs?.length ?? null, sceneObjects: objects, heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) };
    });
    return { i, ...gpu, listeners: await listeners() };
  };
  const samples = [await sample(0)];
  const times = { objects: [], terrain: [], road: [], disaster: [], simSwitch: [], saveLoad: [] };
  for (let i = 1; i <= LEAK_N; i++) {
    const t = await page.evaluate(async (i) => {
      const ds = window.__ds, W = ds.world, f = () => window.__frames();
      const out = {};
      let t0 = performance.now();
      const ids = W.getState().addObjects(Array.from({ length: 10 }, (_, k) => ({ type: 'tree', transform: { position: [-60 + k * 3, 0, -80], rotation: [0, 0, 0], scale: [1, 1, 1] } })));
      await f();
      W.getState().remove(ids);
      await f();
      out.objects = performance.now() - t0;
      t0 = performance.now();
      W.getState().beginTerrainStroke();
      for (let k = 0; k < 5; k++) W.getState().terrainDab({ op: 'raise', x: 70, z: 70, brush: { radius: 6, strength: 0.5 }, dt: 0.05 });
      W.getState().endTerrainStroke();
      await f();
      W.getState().undo();
      await f();
      out.terrain = performance.now() - t0;
      t0 = performance.now();
      const L = ds.roadLib;
      const r = L.drawRoad(W.getState().doc.roads, [[-40, 85], [40, 85]], { curved: false, profile: { ...L.defaultProfile() } });
      W.getState().applyEdit({ roads: r.network });
      await f();
      W.getState().applyEdit({ roads: L.deleteSegments(W.getState().doc.roads, r.segments) });
      await f();
      out.road = performance.now() - t0;
      t0 = performance.now();
      ds.placement.armPlacement('fire');
      const id = ds.placement.placeAt([20 + (i % 5), -70]);
      await f();
      if (id) ds.placement.deleteInstance(id);
      ds.placement.disarmPlacement();
      await f();
      out.disaster = performance.now() - t0;
      t0 = performance.now();
      await ds.actions.enterSimulation();
      await f();
      ds.actions.exitSimulation();
      await f();
      out.simSwitch = performance.now() - t0;
      t0 = performance.now();
      const Lb = ds.buildLib;
      W.getState().replaceDocument(Lb.parseDocument(Lb.serializeDocument(W.getState().doc, false)).doc);
      await f();
      out.saveLoad = performance.now() - t0;
      return out;
    }, i);
    for (const k of Object.keys(times)) times[k].push(t[k]);
    if (i % SAMPLE_EVERY === 0) {
      const s = await sample(i);
      samples.push(s);
      console.log(JSON.stringify(s));
    }
  }
  const stat = (v) => page.evaluate((v) => window.__stat(v), v);
  const iterMs = {};
  for (const k of Object.keys(times)) iterMs[k] = await stat(times[k]);
  await page.close();
  const first = samples[0], last = samples[samples.length - 1];
  return { n, iterations: LEAK_N, samples, iterMs, growth: { geometries: last.geometries - first.geometries, textures: last.textures - first.textures, heapMB: +(last.heapMB - first.heapMB).toFixed(1), windowListeners: last.listeners.window - first.listeners.window, documentListeners: last.listeners.document - first.listeners.document } };
}

const results = { date: new Date().toISOString(), url, mode: MODE, rows: [] };
const save = () => { if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 2)); };
for (const n of counts) {
  const row = MODE === 'leak' ? await leakRun(n) : await scaleRow(n);
  console.log(JSON.stringify(MODE === 'leak' ? { n, growth: row.growth, iterMs: row.iterMs } : row));
  results.rows.push(row);
  save();
}
await browser.close();
