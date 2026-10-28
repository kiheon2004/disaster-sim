// Browser frame benchmark (production build, real GPU via ANGLE/Metal).
//
//   npm run build && npx vite preview --port 4173 &
//   npm i --no-save puppeteer-core
//   node scripts/bench-browser.mjs http://localhost:4173/ after 100,500,1000 5
//
// Same scene (stress scene, seed 99), same camera, same wind (42 m/s E, gust 25 %), fast-forwarded
// 6 s before measuring. Reports FPS / frame time / simulation speed / draw calls / triangles
// (uninstrumented windows) plus a per-stage CPU breakdown and GPU timer queries (instrumented
// window). CHROME=/path/to/chrome overrides the browser. TERRAIN=gentleHills runs the same scenes
// on a terrain preset. On a loaded machine run before/after
// alternately and compare medians.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const [url, label, countsArg = '100,500,1000', winArg = '5'] = process.argv.slice(2);
const counts = countsArg.split(',').map(Number);
const WIN = Number(winArg) * 1000;
// HAZARD=wind (default) | earthquake | both — earthquake: M6.8, PGA 0.3 g, 90 s, seed 7.
const HAZARD = process.env.HAZARD ?? 'wind';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info',
    '--window-size=1600,900', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
  protocolTimeout: 600_000,
});

const INIT = () => {
  const B = (window.__bench = { on: false, raf: 0, react: 0, frames: 0, t: {}, c: {} });
  const oRAF = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => oRAF((ts) => {
    const s = performance.now();
    try { cb(ts); } finally { if (B.on) B.raf += performance.now() - s; }
  });
  const d = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
  Object.defineProperty(MessagePort.prototype, 'onmessage', {
    configurable: true,
    get() { return d.get.call(this); },
    set(fn) {
      d.set.call(this, fn && function (ev) {
        const s = performance.now();
        try { return fn.call(this, ev); } finally { if (B.on) B.react += performance.now() - s; }
      });
    },
  });
};

async function measure(page, name, bare = false) {
  return page.evaluate(async (WIN, bare) => {
    const B = window.__bench;
    const sim = window.__ds.sim;
    const st = window.__r3f;
    const gl = st.gl;
    B.t = {}; B.c = {}; B.raf = 0; B.react = 0;
    let frames = 0, calls = 0, tris = 0, renders = 0, shadowCalls = 0;
    const subs = st.get().internal.subscribers;
    // classify useFrame subscribers by their source (minified, but property names survive)
    const subT = new Map();
    const t0Sim = sim.getTime();
    let gpu = 0, gpuN = 0;
    const ctx = gl.getContext();
    const ext = bare ? null : ctx.getExtension('EXT_disjoint_timer_query_webgl2');
    const pending = [];
    const stop = [];
    // wrap gl.render
    const oRender = gl.render;
    gl.render = function (...a) {
      gl.info.reset();
      let q = null;
      if (ext) { q = ctx.createQuery(); ctx.beginQuery(ext.TIME_ELAPSED_EXT, q); }
      const s = performance.now();
      oRender.apply(this, a);
      B.t.render = (B.t.render ?? 0) + performance.now() - s;
      if (q) { ctx.endQuery(ext.TIME_ELAPSED_EXT); pending.push(q); }
      calls += gl.info.render.calls; tris += gl.info.render.triangles; renders++;
      for (let i = pending.length - 1; i >= 0; i--) {
        const pq = pending[i];
        if (ctx.getQueryParameter(pq, ctx.QUERY_RESULT_AVAILABLE)) {
          if (!ctx.getParameter(ext.GPU_DISJOINT_EXT)) { gpu += ctx.getQueryParameter(pq, ctx.QUERY_RESULT) / 1e6; gpuN++; }
          ctx.deleteQuery(pq); pending.splice(i, 1);
        }
      }
    };
    stop.push(() => (gl.render = oRender));
    const wrapT = (obj, key, nm) => {
      if (!obj || typeof obj[key] !== 'function') return;
      const f = obj[key];
      obj[key] = function (...a) { const s = performance.now(); try { return f.apply(this, a); } finally { B.t[nm] = (B.t[nm] ?? 0) + performance.now() - s; } };
      stop.push(() => (obj[key] = f));
    };
    if (!bare) {
    wrapT(gl.shadowMap, 'render', 'shadow');
    wrapT(st.get().scene, 'updateMatrixWorld', 'matrixWorld');
    wrapT(sim, 'tick', 'simTick');
    wrapT(sim.physics, 'step', 'physics');
    for (const s of sim.systems ?? []) wrapT(s, 'update', 'sys.' + s.name);
    const oShadowRender = gl.shadowMap.render;
    gl.shadowMap.render = function (...a) {
      const before = gl.info.render.calls;
      oShadowRender.apply(this, a);
      shadowCalls += gl.info.render.calls - before;
    };
    stop.push(() => (gl.shadowMap.render = oShadowRender));
    for (const sub of subs) {
      const r = sub.ref;
      const f = r.current;
      const src = String(f);
      const key = src.length > 400 ? src.slice(0, 120) : src.slice(0, 120);
      r.current = function (...a) { const s = performance.now(); try { return f.apply(this, a); } finally { subT.set(key, (subT.get(key) ?? 0) + performance.now() - s); } };
      stop.push(() => (r.current = f));
    }
    }
    const subCount = subs.length;
    // frame counter
    let run = true;
    const loop = () => { if (!run) return; frames++; requestAnimationFrame(loop); };
    B.on = true;
    const t0 = performance.now();
    requestAnimationFrame(loop);
    await new Promise((r) => setTimeout(r, WIN));
    run = false;
    B.on = false;
    const wall = performance.now() - t0;
    stop.reverse().forEach((f) => f());
    const simDt = sim.getTime() - t0Sim;
    const per = (v) => +(v / frames).toFixed(2);
    const t = Object.fromEntries(Object.entries(B.t).map(([k, v]) => [k, per(v)]));
    const subsSorted = [...subT].sort((a, b) => b[1] - a[1]);
    const subTotal = subsSorted.reduce((a, [, v]) => a + v, 0);
    const mem = performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(0) : null;
    return {
      fps: +((frames * 1000) / wall).toFixed(1),
      frameMs: +(wall / frames).toFixed(1),
      simSpeed: +(simDt / (wall / 1000)).toFixed(2),
      drawCalls: Math.round(calls / renders),
      shadowDrawCalls: Math.round(shadowCalls / renders),
      triangles: Math.round(tris / renders),
      gpuMs: gpuN ? +(gpu / gpuN).toFixed(2) : null,
      rafMs: per(B.raf),
      reactMs: per(B.react),
      useFrameMs: per(subTotal),
      subscribers: subCount,
      ...t,
      topSubs: subsSorted.slice(0, 8).map(([k, v]) => [per(v), k.replace(/\s+/g, ' ').slice(0, 70)]),
      heapMB: mem,
    };
  }, WIN, bare);
}

async function setCamera(page) {
  await page.evaluate(() => {
    const s = window.__r3f.get();
    s.camera.position.set(48, 42, 62);
    s.controls?.target.set(0, 0, 0);
    s.controls?.update();
  });
}

async function traceBreakdown(page, ms) {
  await page.tracing.start({ categories: ['devtools.timeline', 'v8', 'disabled-by-default-devtools.timeline'] });
  await new Promise((r) => setTimeout(r, ms));
  const buf = await page.tracing.stop();
  const ev = JSON.parse(Buffer.from(buf).toString()).traceEvents;
  const mains = ev.filter((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
  const score = (m) => ev.filter((e) => e.pid === m.pid && e.tid === m.tid && e.name === 'FireAnimationFrame').length;
  const main = mains.sort((a, b) => score(b) - score(a))[0];
  const evs = ev.filter((e) => e.pid === main.pid && e.tid === main.tid && e.ph === 'X');
  const sum = (pred) => evs.filter(pred).reduce((a, e) => a + e.dur / 1000, 0);
  const fafs = evs.filter((e) => e.name === 'FireAnimationFrame');
  const inFaf = (e) => fafs.some((f) => e.ts >= f.ts && e.ts < f.ts + f.dur);
  const tasks = sum((e) => e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask');
  return {
    busyPct: +((tasks / ms) * 100).toFixed(0),
    rafMsPerSec: +(sum((e) => e.name === 'FireAnimationFrame') / (ms / 1000)).toFixed(0),
    microtasksOutsideRaf: +(sum((e) => e.name === 'RunMicrotasks' && !inFaf(e)) / (ms / 1000)).toFixed(0),
    styleLayout: +(sum((e) => ['UpdateLayoutTree', 'Layout'].includes(e.name)) / (ms / 1000)).toFixed(0),
    paint: +(sum((e) => ['Paint', 'PrePaint', 'Layerize', 'Commit', 'UpdateLayer'].includes(e.name)) / (ms / 1000)).toFixed(0),
    gc: +(sum((e) => /GC/.test(e.name) && !/Allocation/.test(e.name)) / (ms / 1000)).toFixed(0),
  };
}

const results = [];
for (const n of counts) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(INIT);
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.goto(url + '?devtools', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__ds && window.__r3f);
  await page.evaluate(() => localStorage.clear());
  await page.evaluate((n) => window.__ds.actions.loadStressScene(n), n);
  // TERRAIN=gentleHills|valley|coastal: same scene on a terrain preset (objects re-seated).
  if (process.env.TERRAIN) await page.evaluate((p) => window.__ds.world.getState().applyTerrainPreset(p, 1), process.env.TERRAIN);
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate(async () => {
    await window.__ds.actions.enterSimulation();
  });
  await page.waitForFunction(() => window.__ds.simStore.getState().status === 'paused', { timeout: 120_000 });
  await setCamera(page);
  // identical starting state: fast-forward synchronously past the ramp, then play
  await page.evaluate((hazard) => {
    const sim = window.__ds.sim;
    if (hazard !== 'earthquake') sim.addEvent({ event: 'wind', speed: 42, direction: 'E', duration: 300, gustStrength: 0.25, rampDuration: 4 });
    if (hazard !== 'wind') sim.addEvent({ event: 'earthquake', magnitude: 6.8, pga: 0.3, duration: 90, epicenter: [40, -30], depth: 10, seed: 7 });
    sim.advance(6);
  }, HAZARD);
  const row = { label, hazard: HAZARD, objects: n };
  // paused frame (render only)
  await new Promise((r) => setTimeout(r, 1500));
  row.pausedBare = await measure(page, 'paused', true);
  row.paused = await measure(page, 'paused');
  await page.evaluate(() => window.__ds.sim.play());
  await new Promise((r) => setTimeout(r, 2000));
  row.bare = await measure(page, 'full', true);
  row.full = await measure(page, 'full');
  row.trace = await traceBreakdown(page, 2500);
  await page.evaluate(() => window.__ds.view.setState({ showWind: false }));
  await new Promise((r) => setTimeout(r, 800));
  row.vizOff = await measure(page, 'vizOff', true);
  await page.evaluate(() => window.__ds.view.setState({ showWind: true }));
  await page.evaluate(() => { const gl = window.__r3f.get().gl; gl.shadowMap.autoUpdate = false; });
  await new Promise((r) => setTimeout(r, 800));
  row.noShadow = await measure(page, 'noShadow', true);
  await page.evaluate(() => { const gl = window.__r3f.get().gl; gl.shadowMap.autoUpdate = true; });
  row.simTime = await page.evaluate(() => window.__ds.sim.getTime());
  row.damageEvents = await page.evaluate(() => window.__ds.sim.getDamageEvents().length);
  console.log(JSON.stringify(row));
  results.push(row);
  await page.close();
}
await browser.close();
fs.writeFileSync(`results-${label}${HAZARD === 'wind' ? '' : `-${HAZARD}`}.json`, JSON.stringify(results, null, 1));
