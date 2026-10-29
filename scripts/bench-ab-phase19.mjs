// Phase 20: the Phase 19 baseline scenes measured on a given build — run against a Phase 19
// build and this build alternately for a same-conditions comparison (machine load drifts).
//   scenes: Phase 19 "mixedCity" (mixedUrbanNatural environment, rain + wind), Phase 19
//   "mountain" (mountainValley environment), Phase 18 baseline (two avenues + 1000 houses,
//   earthquake + wind)
//
//   node scripts/bench-ab-phase19.mjs http://localhost:4184/ [label]   (Phase 19 build)
//   node scripts/bench-ab-phase19.mjs http://localhost:4183/ [label]   (this build)
import puppeteer from 'puppeteer-core';
import os from 'node:os';

const [url = 'http://localhost:4183/', label = url] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,900', '--enable-precise-memory-info', '--js-flags=--expose-gc'],
  defaultViewport: { width: 1600, height: 900 }, protocolTimeout: 1_800_000,
});
const page = await browser.newPage();
page.on('dialog', (d) => d.accept());
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.goto(url + '?devtools', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
const cdp = await page.createCDPSession();
const ev = (fn, ...a) => page.evaluate(fn, ...a);
await ev(() => {
  window.__frames = (n = 2) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  window.__fps = (ms) => new Promise((res) => { let frames = 0; const t0 = performance.now(); const f = () => { frames++; if (performance.now() - t0 < ms) requestAnimationFrame(f); else res(+(frames / ((performance.now() - t0) / 1000)).toFixed(1)); }; requestAnimationFrame(f); });
  window.__view = () => { const st = window.__r3f.get(); st.camera.position.set(110, 120, 150); st.controls.target.set(0, 0, 0); st.controls.update(); };
});
async function heapMB() {
  for (let i = 0; i < 2; i++) { await ev(() => window.gc?.()); await cdp.send('HeapProfiler.collectGarbage'); }
  return ev(() => +(performance.memory.usedJSHeapSize / 1048576).toFixed(1));
}
async function measure(name, sim) {
  await ev(() => { window.__view(); return window.__frames(3); });
  const row = { scene: name, objects: await ev(() => Object.keys(window.__ds.world.getState().doc.objects).length) };
  row.editorFps = await ev(() => window.__fps(3000));
  row.drawCalls = await ev(() => window.__r3f.get().gl.info.render.calls);
  row.heapMB = await heapMB();
  Object.assign(row, await ev(() => {
    const L = window.__ds.buildLib;
    const t0 = performance.now();
    const json = L.serializeDocument(window.__ds.world.getState().doc, false);
    const t1 = performance.now();
    L.parseDocument(json);
    return { saveMs: Math.round(t1 - t0), loadMs: Math.round(performance.now() - t1), fileKB: Math.round(json.length / 1024) };
  }));
  await ev(() => { window.__ds.profiler.enabled = true; });
  const t0 = Date.now();
  await ev((s) => window.__ds.actions.runSimulation(s), sim);
  await page.waitForFunction(() => window.__ds.simStore.getState().status === 'running', { timeout: 300_000 });
  row.simLoadMs = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 1500));
  await ev(() => window.__ds.profiler.snapshot());
  row.simFps = await ev(() => window.__fps(5000));
  Object.assign(row, await ev(() => {
    const p = window.__ds.profiler.snapshot();
    return { tickMs: +p.tickMs.toFixed(2), waterMs: +((p.systems.waterSolver ?? 0)).toFixed(2), simSpeed: +p.simSpeed.toFixed(2) };
  }));
  row.simHeapMB = await heapMB();
  await ev(() => window.__ds.actions.exitSimulation());
  await ev(() => window.__frames(2));
  return row;
}
const out = { label, url, load: os.loadavg().map((v) => +v.toFixed(1)), scenes: [] };
for (const [name, kind] of [['mixedCity', 'mixedUrbanNatural'], ['mountain', 'mountainValley']]) {
  await ev(() => window.__ds.actions.newProject());
  await ev(async (k) => { window.__ds.natureActions.applyEnvironment(k, 1); await window.__frames(2); }, kind);
  out.scenes.push(await measure(name, [{ event: 'rain', intensity: 80, duration: 600 }, { event: 'wind', speed: 30, direction: 'E', duration: 60, gustStrength: 0.2, rampDuration: 2 }]));
}
await ev(() => window.__ds.actions.newProject());
await ev(async () => {
  const L = window.__ds.roadLib, B = window.__ds.buildingLib, ws = window.__ds.world;
  let n = ws.getState().doc.roads; const P = L.defaultProfile();
  n = L.drawRoad(n, [[-96, 0], [96, 0]], { curved: false, profile: P }).network;
  n = L.drawRoad(n, [[0, -96], [0, 96]], { curved: false, profile: P }).network;
  ws.getState().applyEdit({ roads: n });
  const design = B.createDesign({ ...B.presetSpec('house'), floors: 2, width: 5, depth: 4 }, 'house');
  const roads = ws.getState().doc.roads; const inputs = [];
  for (let z = -96; z <= 96 && inputs.length < 1000; z += 5) for (let x = -96; x <= 96 && inputs.length < 1000; x += 6) {
    if (L.footprintOnRoad(roads, { x, z, hx: 2.5, hz: 2, yaw: 0 }, 0.5)) continue;
    inputs.push({ type: 'building', building: design, seed: inputs.length + 1, transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] } });
  }
  ws.getState().applyEdit({ add: inputs });
  await window.__frames(3);
});
out.scenes.push(await measure('phase18RoadsBuildings1000', [{ event: 'earthquake', magnitude: 6.8, pga: 0.5, duration: 20, seed: 2 }, { event: 'wind', speed: 30, direction: 'E', duration: 30, gustStrength: 0.25, rampDuration: 2 }]));
out.loadEnd = os.loadavg().map((v) => +v.toFixed(1));
console.log(JSON.stringify(out));
await browser.close();
