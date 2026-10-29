// Phase 21 benchmark (production build, real GPU): terrain deformation in the browser.
//   scenes: empty map local subsidence, wide uplift, buildings 100 / 500 / 1000, city with
//   roads, river + lake nature, flood + deformation, multi-hazard (earthquake + rain + deformation)
//   per scene: editor FPS; simulation FPS over the same window without (A) and with (B) the
//   deformation; deformation update cost split (field, collider, water bed, responses);
//   terrain mesh refresh ms (dirty rectangles), road mesh rebuild ms, heap after GC.
//
//   npm run build && npx vite preview --port 4191 --strictPort &
//   node scripts/bench-deformation.mjs http://localhost:4191/ [out.json]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';

const [url = 'http://localhost:4191/', outFile] = process.argv.slice(2);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SIM_MS = Number(process.env.SIM_MS ?? 6000);
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,900', '--enable-precise-memory-info', '--js-flags=--expose-gc'],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 }, protocolTimeout: 1_800_000,
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('pageerror', e.message));
page.on('dialog', (d) => d.accept());
await page.goto(url + '?devtools', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
const cdp = await page.createCDPSession();
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await ev(() => {
  window.__frames = (n = 2) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  window.__fps = (ms) => new Promise((res) => { let frames = 0, worst = 0, last = performance.now(); const t0 = last; const f = () => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; frames++; if (now - t0 < ms) requestAnimationFrame(f); else res({ fps: +(frames / ((now - t0) / 1000)).toFixed(1), worstFrameMs: Math.round(worst) }); }; requestAnimationFrame(f); });
  window.__view = () => { const st = window.__r3f.get(); st.camera.position.set(110, 120, 150); st.controls.target.set(0, 0, 0); st.controls.update(); };
  const ds = window.__ds;
  const def = (x) => ({ event: 'terrainDeformation', kind: 'subsidence', center: [0, 0], radius: 40, amount: 1.5, duration: 8, profile: 'smooth', falloff: 'smooth', ...x });
  const quake = () => ({ ...ds.deformLib.phenomena.implemented('earthquake').defaults(), magnitude: 6.5, duration: 20 });
  const rain = (mmh) => ({ ...ds.deformLib.phenomena.implemented('rain').defaults(), intensity: mmh, duration: 60 });
  const buildings = (n, roads) => {
    ds.actions.newProject();
    const L = ds.roadLib, ws = ds.world;
    if (roads) {
      let net = ws.getState().doc.roads;
      for (const p of [[[-96, 0], [96, 0]], [[0, -96], [0, 96]], [[-96, 40], [96, 40]]]) net = L.drawRoad(net, p, { curved: false, profile: L.defaultProfile() }).network;
      ws.getState().applyEdit({ roads: net });
    }
    const designs = [L.presetDesign('house', 2), L.presetDesign('house', 1), L.presetDesign('apartment', 4)];
    const step = n <= 100 ? 16 : n <= 500 ? 8.5 : 6;
    const inputs = [];
    for (let z = -94; z <= 94 && inputs.length < n; z += step) for (let x = -94; x <= 94 && inputs.length < n; x += step) {
      if (roads && (Math.abs(x) < 8 || Math.abs(z) < 8 || Math.abs(z - 40) < 8)) continue;
      inputs.push({ type: 'building', building: n > 100 ? designs[1] : designs[inputs.length % 3], seed: inputs.length + 1, transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] } });
    }
    if (inputs.length) ws.getState().applyEdit({ add: inputs });
  };
  window.__scenes = {
    'empty-local-subsidence': { make: () => buildings(0), base: () => [], deform: () => [def({ radius: 20, amount: 2 })] },
    'empty-wide-uplift': { make: () => buildings(0), base: () => [], deform: () => [def({ kind: 'uplift', radius: 120, amount: 1, duration: 10 })] },
    buildings100: { make: () => buildings(100), base: () => [], deform: () => [def({ radius: 60 })] },
    buildings500: { make: () => buildings(500), base: () => [], deform: () => [def({ radius: 60 })] },
    buildings1000: { make: () => buildings(1000), base: () => [], deform: () => [def({ radius: 60 })] },
    'city-roads': { make: () => buildings(300, true), base: () => [], deform: () => [def({ radius: 50, center: [10, 20] }), def({ kind: 'depression', radius: 8, amount: 1.2, center: [-40, 0], profile: 'instant' })] },
    'river-lake-nature': { make: () => { ds.actions.newProject(); ds.world.getState().replaceDocument(ds.blueprintLib.buildTemplate('riverValley', 3)); }, base: () => [], deform: () => [def({ radius: 40, amount: 1 }), def({ kind: 'uplift', radius: 30, amount: 0.8, center: [50, -40] })] },
    'flood-deformation': { make: () => buildings(100), base: () => [rain(80)], deform: () => [def({ radius: 50 })] },
    'multi-hazard': { make: () => buildings(300, true), base: () => [quake(), rain(60)], deform: () => [def({ radius: 50 }), def({ kind: 'ridge', radius: 8, length: 80, bearing: 60, amount: 1, center: [-30, -30] })] },
  };
});

async function heapMB() {
  for (let i = 0; i < 2; i++) { await ev(() => window.gc?.()); await cdp.send('HeapProfiler.collectGarbage'); }
  return ev(() => +(performance.memory.usedJSHeapSize / 1048576).toFixed(1));
}

/** One simulation run of a scene: base hazards (+ deformation), FPS while it runs. */
async function simRun(name, withDeform) {
  await ev(async (name, withDeform) => {
    const ds = window.__ds, sc = window.__scenes[name];
    await ds.actions.enterSimulation();
    window.__view();
    await window.__frames(5);
    ds.deformLib.terrainStats.reset();
    ds.roadStats.meshMs = 0; ds.roadStats.meshBuilds = 0;
    await ds.actions.runSimulation([...sc.base(), ...(withDeform ? sc.deform() : [])]);
  }, name, withDeform);
  const fps = await ev((ms) => window.__fps(ms), SIM_MS);
  const extra = await ev(() => {
    const ds = window.__ds, d = ds.simStore.getState().deform, ts = ds.deformLib.terrainStats, rs = ds.roadStats, st = ds.sim.getEnvironment().deformation.stats;
    return {
      simTime: +ds.sim.getTime().toFixed(1),
      deformUpdates: st?.updates ?? 0,
      deformMeanMs: st && st.updates ? +(st.totalMs / st.updates).toFixed(2) : 0,
      colliderMeanMs: st && st.updates ? +(st.colliderTotalMs / st.updates).toFixed(2) : 0,
      meshRefreshes: ts.deformUpdates,
      meshMeanMs: ts.meshUpdates ? +(ts.meshMs / ts.meshUpdates).toFixed(2) : 0,
      roadRebuilds: rs.meshBuilds,
      roadMeanMs: rs.meshBuilds ? +(rs.meshMs / rs.meshBuilds).toFixed(1) : 0,
      maxAbs: d ? +d.maxAbs.toFixed(2) : 0,
    };
  });
  const heap = await heapMB();
  await ev(() => window.__ds.actions.exitSimulation());
  await wait(400);
  return { ...fps, ...extra, heapMB: heap };
}

const rows = [];
const only = process.env.SCENES?.split(',');
for (const name of await ev(() => Object.keys(window.__scenes))) {
  if (only && !only.includes(name)) continue;
  await ev(async (name) => { window.__scenes[name].make(); window.__view(); await window.__frames(5); }, name);
  const counts = await ev(() => { const d = window.__ds.world.getState().doc; return { objects: Object.keys(d.objects).length, roads: Object.keys(d.roads.segments).length }; });
  const editor = await ev(() => window.__fps(3000));
  const editorHeap = await heapMB();
  const A = await simRun(name, false);
  const B = await simRun(name, true);
  const row = { scene: name, ...counts, editorFps: editor.fps, editorHeapMB: editorHeap, A, B };
  console.log(JSON.stringify(row));
  rows.push(row);
}
const out = { date: new Date().toISOString(), url, cpus: os.cpus()[0]?.model, load: os.loadavg().map((v) => +v.toFixed(1)), simWindowMs: SIM_MS, rows };
if (outFile) fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
await browser.close();
