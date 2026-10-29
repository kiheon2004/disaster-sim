// Phase 19: the Phase 18 baseline scene (two crossing avenues + 1000 modular houses) measured
// on a given build — run it against two builds alternately for a same-conditions comparison.
//
//   node scripts/bench-ab-baseline.mjs http://localhost:4174/   (e.g. Phase 18 build)
//   node scripts/bench-ab-baseline.mjs http://localhost:4173/   (this build)
import puppeteer from 'puppeteer-core';
import os from 'node:os';

const [url = 'http://localhost:4173/'] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,900', '--enable-precise-memory-info', '--js-flags=--expose-gc'],
  defaultViewport: { width: 1600, height: 900 }, protocolTimeout: 1_800_000,
});
const page = await browser.newPage();
page.on('dialog', (d) => d.accept());
await page.goto(url + '?devtools', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
const cdp = await page.createCDPSession();
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const row = { url, load: os.loadavg().map((v) => +v.toFixed(1)) };
Object.assign(row, await ev(async () => {
  window.__frames = (n = 2) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  window.__fps = (ms) => new Promise((res) => { let frames = 0; const t0 = performance.now(); const f = () => { frames++; if (performance.now() - t0 < ms) requestAnimationFrame(f); else res(+(frames / ((performance.now() - t0) / 1000)).toFixed(1)); }; requestAnimationFrame(f); });
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
  const t0 = performance.now();
  ws.getState().applyEdit({ add: inputs });
  await window.__frames(3);
  const commitMs = performance.now() - t0;
  const st = window.__r3f.get(); st.camera.position.set(110, 120, 150); st.controls.target.set(0, 0, 0); st.controls.update();
  await window.__frames(3);
  const editorFps = await window.__fps(3000);
  const gl = st.gl;
  // Terrain strokes (raise) next to the crossing: edit latency incl. roads / buildings refit.
  const strokes = [];
  for (let k = 0; k < 5; k++) {
    ws.getState().beginTerrainStroke();
    for (let d = 0; d < 8; d++) ws.getState().terrainDab({ op: 'raise', x: 20 + k * 10, z: 12, brush: { radius: 6, strength: 0.5 }, dt: 0.05 });
    const s0 = performance.now();
    ws.getState().endTerrainStroke();
    const s1 = performance.now();
    await window.__frames(1);
    strokes.push([s1 - s0, performance.now() - s0]);
  }
  strokes.sort((a, b) => a[0] - b[0]);
  const Lb = window.__ds.buildLib;
  const j0 = performance.now(); const json = Lb.serializeDocument(ws.getState().doc, false); const j1 = performance.now(); Lb.parseDocument(json); const j2 = performance.now();
  return { buildingsCommitMs: Math.round(commitMs), editorFps, drawCalls: gl.info.render.calls, strokeCommitMs: +strokes[2][0].toFixed(1), strokeToFrameMs: +strokes[2][1].toFixed(1), saveMs: Math.round(j1 - j0), loadMs: Math.round(j2 - j1), fileKB: Math.round(json.length / 1024) };
}));
for (let i = 0; i < 2; i++) { await ev(() => window.gc?.()); await cdp.send('HeapProfiler.collectGarbage'); }
row.heapMB = await ev(() => +(performance.memory.usedJSHeapSize / 1048576).toFixed(1));
await ev(() => { window.__ds.profiler.enabled = true; });
await ev(() => window.__ds.actions.runSimulation([{ event: 'earthquake', magnitude: 6.8, pga: 0.5, duration: 20, seed: 2 }, { event: 'wind', speed: 30, direction: 'E', duration: 30, gustStrength: 0.25, rampDuration: 2 }]));
await page.waitForFunction(() => window.__ds.simStore.getState().status === 'running', { timeout: 300_000 });
await new Promise((r) => setTimeout(r, 1500));
await ev(() => window.__ds.profiler.snapshot());
row.simFps = await ev(() => window.__fps(5000));
Object.assign(row, await ev(() => { const p = window.__ds.profiler.snapshot(); return { tickMs: +p.tickMs.toFixed(2), simSpeed: +p.simSpeed.toFixed(2) }; }));
console.log(JSON.stringify(row));
await browser.close();
