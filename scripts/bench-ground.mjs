// Phase 22 benchmark (production build, real GPU): sinkholes and landslides in the browser.
//   scenes: empty sinkhole, sinkhole under a building, sinkhole under a road, small / large
//   landslide, landslide + river, landslide + flood, 100 / 500 / 1000 buildings at the toe,
//   mountain village (city-mountain world)
//   per scene: editor FPS; simulation FPS over the same window without (A) and with (B) ground
//   failure, and (C) a Phase 21 prescribed subsidence of the same footprint where one exists;
//   ground update cost (models / runout / objects), terrain mesh refresh ms, worst frame, heap.
//
//   npm run build && npx vite preview --port 4191 --strictPort &
//   node scripts/bench-ground.mjs http://localhost:4191/ [out.json]
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
  const ds = window.__ds, ws = ds.world, L = ds.roadLib;
  window.__view = (x = 0, z = 0) => { const st = window.__r3f.get(); st.camera.position.set(x + 70, 90, z + 110); st.controls.target.set(x, 0, z); st.controls.update(); };
  const tf = (x, z) => ({ position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] });
  const sink = (x = {}) => ({ event: 'sinkhole', center: [0, 0], cavityRadius: 5, cavityHeight: 8, cover: 5, initiation: 'supportLoss', supportLoss: 0.9, duration: 2, ...x });
  const slide = (x = {}) => ({ event: 'landslide', area: { kind: 'circle', center: [-30, 0], radius: 12 }, thickness: 1.5, saturation: 1, trigger: 'user', duration: 0, ...x });
  const sub = (center, radius, amount) => ({ event: 'terrainDeformation', kind: 'subsidence', center, radius, amount, duration: 3, profile: 'smooth', falloff: 'smooth' });
  const rain = (mmh) => ({ ...ds.deformLib.phenomena.implemented('rain').defaults(), intensity: mmh, duration: 60 });
  const flat = () => ds.actions.newProject();
  const slope = (deg, n = 0, roads = false) => {
    ds.actions.newProject();
    const t0 = ws.getState().doc.terrain;
    const heights = new Float32Array(t0.heights.length);
    const tb = Math.tan((deg * Math.PI) / 180);
    for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) { const x = t0.originX + ix * t0.cellSize; heights[iz * t0.nx + ix] = x < 0 ? Math.min(90, -x) * tb : 0; }
    ws.getState().applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length) } } });
    if (roads) ws.getState().applyEdit({ roads: L.drawRoad(ws.getState().doc.roads, [[3, -96], [3, 96]], { curved: false, profile: L.defaultProfile() }).network });
    const d = L.presetDesign('house', 1), add = [];
    const step = n <= 100 ? 9 : n <= 500 ? 5 : 3.6;
    for (let x = 8; x <= 96 && add.length < n; x += step) for (let z = -96; z <= 96 && add.length < n; z += step) add.push({ type: 'building', building: d, seed: add.length + 1, transform: tf(x, z) });
    if (add.length) ws.getState().applyEdit({ add });
  };
  const template = (k) => { ds.actions.newProject(); ws.getState().replaceDocument(ds.blueprintLib.buildTemplate(k, 3)); };
  const steepest = () => {
    const t = ws.getState().doc.terrain;
    let best = -1, bx = 0, bz = 0;
    for (let iz = 12; iz < t.nz - 12; iz += 4) for (let ix = 12; ix < t.nx - 12; ix += 4) {
      const i = iz * t.nx + ix;
      const g = Math.hypot(t.heights[i + 10] - t.heights[i - 10], t.heights[i + 10 * t.nx] - t.heights[i - 10 * t.nx]);
      if (g > best) { best = g; bx = t.originX + ix * t.cellSize; bz = t.originZ + iz * t.cellSize; }
    }
    return [bx, bz];
  };
  window.__scenes = {
    'empty-sinkhole': { make: flat, base: () => [], ground: () => [sink()], phase21: () => [sub([0, 0], 8, 3)], at: [0, 0] },
    'sinkhole-under-building': { make: () => { flat(); ws.getState().applyEdit({ add: [{ type: 'building', building: L.presetDesign('house', 2), seed: 1, transform: tf(0, 0) }, { type: 'building', building: L.presetDesign('apartment', 4), seed: 2, transform: tf(14, 4) }] }); }, base: () => [], ground: () => [sink()], phase21: () => [sub([0, 0], 8, 3)], at: [0, 0] },
    'sinkhole-under-road': { make: () => { flat(); ws.getState().applyEdit({ roads: L.drawRoad(ws.getState().doc.roads, [[-96, 0], [96, 0]], { curved: false, profile: L.defaultProfile() }).network }); }, base: () => [], ground: () => [sink()], phase21: () => [sub([0, 0], 8, 3)], at: [0, 0] },
    'landslide-small': { make: () => slope(30), base: () => [], ground: () => [slide({ area: { kind: 'circle', center: [-20, 0], radius: 8 } })], phase21: () => [sub([-20, 0], 8, 1.5)], at: [-10, 0] },
    'landslide-large': { make: () => slope(32), base: () => [], ground: () => [slide({ area: { kind: 'circle', center: [-45, 0], radius: 35 }, thickness: 2.5 })], phase21: () => [sub([-45, 0], 35, 2.5)], at: [-20, 0] },
    'landslide-river': { make: () => template('riverValley'), base: () => [], ground: () => [slide({ area: { kind: 'circle', center: steepest(), radius: 15 }, boundary: 'open' })], at: null },
    'landslide-flood': { make: () => slope(30), base: () => [rain(80)], ground: () => [slide({ area: { kind: 'circle', center: [-25, 0], radius: 12 } })], at: [-10, 0] },
    'buildings100-toe': { make: () => slope(32, 100, true), base: () => [], ground: () => [slide({ area: { kind: 'circle', center: [-20, 0], radius: 15 } })], at: [10, 0] },
    'buildings500-toe': { make: () => slope(32, 500, true), base: () => [], ground: () => [slide({ area: { kind: 'circle', center: [-20, 0], radius: 15 } })], at: [10, 0] },
    'buildings1000-toe': { make: () => slope(32, 1000, true), base: () => [], ground: () => [slide({ area: { kind: 'circle', center: [-20, 0], radius: 15 } })], at: [10, 0] },
    'mountain-village': { make: () => template('mountainVillage'), base: () => [rain(60)], ground: () => { const c = steepest(); return [slide({ area: { kind: 'circle', center: c, radius: 18 }, trigger: 'saturation', saturation: 0.5, targetSaturation: 1, duration: 8 }), sink({ center: [c[0] + 40, c[1]] })]; }, at: null },
  };
});

async function heapMB() {
  for (let i = 0; i < 2; i++) { await ev(() => window.gc?.()); await cdp.send('HeapProfiler.collectGarbage'); }
  return ev(() => +(performance.memory.usedJSHeapSize / 1048576).toFixed(1));
}

/** One simulation run of a scene with the chosen events; FPS while it runs. */
async function simRun(name, which) {
  await ev(async (name, which) => {
    const ds = window.__ds, sc = window.__scenes[name];
    await ds.actions.enterSimulation();
    window.__view(...(sc.at ?? [0, 0]));
    await window.__frames(5);
    ds.deformLib.terrainStats.reset();
    const extra = which === 'B' ? sc.ground() : which === 'C' ? sc.phase21() : [];
    await ds.actions.runSimulation([...sc.base(), ...extra]);
  }, name, which);
  const fps = await ev((ms) => window.__fps(ms), SIM_MS);
  const extra = await ev(() => {
    const ds = window.__ds, env = ds.sim.getEnvironment(), g = env.groundFailure, st = g.stats, ts = ds.deformLib.terrainStats, dst = env.deformation.stats;
    return {
      simTime: +ds.sim.getTime().toFixed(1),
      groundUpdates: st.updates,
      groundMeanMs: st.updates ? +(st.totalMs / st.updates).toFixed(2) : 0,
      lastFlowMs: +st.flowMs.toFixed(2), lastObjectsMs: +st.objectsMs.toFixed(2), lastSinkholeMs: +st.sinkholeMs.toFixed(2), lastStabilityMs: +st.stabilityMs.toFixed(2),
      deformMeanMs: dst && dst.updates ? +(dst.totalMs / dst.updates).toFixed(2) : 0,
      colliderMeanMs: dst && dst.updates ? +(dst.colliderTotalMs / dst.updates).toFixed(2) : 0,
      meshRefreshes: ts.deformUpdates,
      meshMeanMs: ts.meshUpdates ? +(ts.meshMs / ts.meshUpdates).toFixed(2) : 0,
      released: g.field ? +g.field.budget.released.toFixed(0) : 0,
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
  await ev(async (name) => { window.__scenes[name].make(); window.__view(...(window.__scenes[name].at ?? [0, 0])); await window.__frames(5); }, name);
  const counts = await ev(() => { const d = window.__ds.world.getState().doc; return { objects: Object.keys(d.objects).length, roads: Object.keys(d.roads.segments).length }; });
  const editor = await ev(() => window.__fps(3000));
  const editorHeap = await heapMB();
  const A = await simRun(name, 'A');
  const B = await simRun(name, 'B');
  const C = (await ev((n) => !!window.__scenes[n].phase21, name)) ? await simRun(name, 'C') : null;
  const row = { scene: name, ...counts, editorFps: editor.fps, editorHeapMB: editorHeap, load: os.loadavg()[0].toFixed(1), A, B, C };
  console.log(JSON.stringify(row));
  rows.push(row);
}
const out = { date: new Date().toISOString(), url, cpus: os.cpus()[0]?.model, load: os.loadavg().map((v) => +v.toFixed(1)), simWindowMs: SIM_MS, rows };
if (outFile) fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
await browser.close();
