// Phase 19 benchmark (production build, real GPU): natural landscapes.
//   scenes: mountain terrain, rivers + lakes, trees 100 / 500 / 1000 / 2000, mixed city
//   (roads + buildings + river), complex coastline, repeated terrain edits, and the Phase 18
//   baseline scene (roads + 1000 modular buildings) for comparison.
//   metrics: editor / simulation FPS, draw calls, terrain edit latency (sculpt stroke, feature
//   edit), collider build, flood bed (water grid) build, water solver time, save / load,
//   heap after GC, machine load.
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/bench-nature.mjs http://localhost:4173/ [out.json]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';

const [url = 'http://localhost:4173/', outFile] = process.argv.slice(2);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
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
await ev(() => {
  window.__frames = (n = 2) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  window.__fps = (ms) => new Promise((res) => { let frames = 0; const t0 = performance.now(); const f = () => { frames++; if (performance.now() - t0 < ms) requestAnimationFrame(f); else res(+(frames / ((performance.now() - t0) / 1000)).toFixed(1)); }; requestAnimationFrame(f); });
  window.__view = () => { const st = window.__r3f.get(); st.camera.position.set(110, 120, 150); st.controls.target.set(0, 0, 0); st.controls.update(); };
});
async function heapMB() {
  for (let i = 0; i < 2; i++) { await ev(() => window.gc?.()); await cdp.send('HeapProfiler.collectGarbage'); }
  return ev(() => +(performance.memory.usedJSHeapSize / 1048576).toFixed(1));
}
const stats = () => ev(() => { const gl = window.__r3f.get().gl; return { drawCalls: gl.info.render.calls, trianglesK: Math.round(gl.info.render.triangles / 1000) }; });

/** Editor + simulation measurements of the current world. */
async function measure(name, sim = [{ event: 'rain', intensity: 80, duration: 600 }, { event: 'wind', speed: 30, direction: 'E', duration: 60, gustStrength: 0.2, rampDuration: 2 }]) {
  await ev(() => { window.__view(); return window.__frames(3); });
  const row = { scene: name, objects: await ev(() => Object.keys(window.__ds.world.getState().doc.objects).length), features: await ev(() => window.__ds.world.getState().doc.landscape.features.length) };
  row.editorFps = await ev(() => window.__fps(3000));
  Object.assign(row, await stats());
  row.heapMB = await heapMB();
  Object.assign(row, await ev(() => {
    const L = window.__ds.buildLib;
    const t0 = performance.now();
    const json = L.serializeDocument(window.__ds.world.getState().doc, false);
    const t1 = performance.now();
    const res = L.parseDocument(json);
    const t2 = performance.now();
    return { saveMs: +(t1 - t0).toFixed(0), loadMs: +(t2 - t1).toFixed(0), fileKB: Math.round(json.length / 1024), recomposed: res.ok ? res.landscape.recomposedVertices : -1 };
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
    const env = window.__ds.sim.getEnvironment();
    return { tickMs: +p.tickMs.toFixed(2), waterMs: +((p.systems.waterSolver ?? 0)).toFixed(2), simSpeed: +p.simSpeed.toFixed(2), colliderMs: +window.__ds.sim.terrainBuildMs.toFixed(1), floodBedMs: +(env.flood.buildMs ?? 0).toFixed(1), water: env.flood.field ? +env.flood.field.totalVolume().toFixed(0) : 0 };
  }));
  row.simHeapMB = await heapMB();
  await ev(() => window.__ds.actions.exitSimulation());
  await ev(() => window.__frames(2));
  console.log(JSON.stringify(row));
  return row;
}

const results = { loadStart: os.loadavg().map((v) => +v.toFixed(1)), scenes: [], edits: null, trees: [] };

// Presets as the mountain / river+lake / mixed-city / coastline scenes.
for (const [name, kind] of [['mountain', 'mountainValley'], ['riversLakes', 'lakeDistrict'], ['mixedCity', 'mixedUrbanNatural'], ['coastline', 'coastalPlain']]) {
  await ev(() => window.__ds.actions.newProject());
  const ms = await ev(async (k) => { const t0 = performance.now(); window.__ds.natureActions.applyEnvironment(k, 1); await window.__frames(2); return Math.round(performance.now() - t0); }, kind);
  const row = await measure(name);
  row.generateMs = ms;
  results.scenes.push(row);
}

// Complex coastline: a 12-point shoreline on hills.
await ev(() => window.__ds.actions.newProject());
await ev(() => {
  const pts = []; for (let k = 0; k < 12; k++) pts.push([-99 + k * 18, 30 + 18 * Math.sin(k * 1.3)]);
  window.__ds.world.getState().setWaterLevel(0);
  window.__ds.world.getState().setFeatures([{ id: 'f1', kind: 'coast', points: pts, seaSide: 1, beachSlope: 0.05, beachWidth: 15, offshoreSlope: 0.08, maxDepth: 6, material: 2 }], 2);
});
results.scenes.push(await measure('complexCoast'));

// Trees 100 / 500 / 1000 / 2000 on gentle hills (forest planner, one edit).
for (const n of [100, 500, 1000, 2000]) {
  await ev(() => window.__ds.actions.newProject());
  const gen = await ev(async (n) => {
    const ds = window.__ds;
    ds.world.getState().applyTerrainPreset?.('gentleHills', 2);
    const pts = []; const side = Math.ceil(Math.sqrt(n * 1.15));
    for (let i = 0; i < side * side; i++) pts.push([-95 + (190 / side) * ((i % side) + 0.5), -95 + (190 / side) * (Math.floor(i / side) + 0.5)]);
    const t0 = performance.now();
    const plan = ds.natureActions.planForest(pts, { coniferShare: 0.5, density: 1, spacing: 2, radius: 10, seed: 3, slopeLimit: 60, minElevation: -40, maxElevation: 80, variation: true });
    const inputs = plan.inputs.slice(0, n);
    const t1 = performance.now();
    ds.world.getState().applyEdit({ add: inputs });
    await window.__frames(2);
    return { trees: inputs.length, planMs: Math.round(t1 - t0), commitMs: Math.round(performance.now() - t1) };
  }, n);
  const row = await measure(`trees${n}`, [{ event: 'wind', speed: 35, direction: 'E', duration: 60, gustStrength: 0.3, rampDuration: 2 }]);
  Object.assign(row, gen);
  results.trees.push(row);
}

// Terrain edit latency: sculpt strokes and feature edits on the mixed city (roads + river).
await ev(() => window.__ds.actions.newProject());
await ev(() => window.__ds.natureActions.applyEnvironment('mixedUrbanNatural', 1));
results.edits = await ev(async () => {
  const ws = window.__ds.world;
  const strokes = [], features = [], toFrame = [];
  for (let k = 0; k < 8; k++) {
    const x = -60 + k * 15, z = k % 2 ? 70 : -80;
    ws.getState().beginTerrainStroke();
    for (let d = 0; d < 10; d++) ws.getState().terrainDab({ op: 'raise', x: x + d * 0.5, z, brush: { radius: 8, strength: 0.6 }, dt: 0.05 });
    const t0 = performance.now();
    ws.getState().endTerrainStroke();
    strokes.push(performance.now() - t0);
    await window.__frames(1);
    toFrame.push(performance.now() - t0);
  }
  for (let k = 0; k < 6; k++) {
    const fs = ws.getState().doc.landscape.features;
    const hill = fs.find((f) => f.kind === 'hill');
    const t0 = performance.now();
    ws.getState().setFeatures(fs.map((f) => (f === hill ? { ...f, height: f.height + (k % 2 ? -1 : 1) } : f)));
    features.push(performance.now() - t0);
  }
  const riverT = performance.now();
  const fs = ws.getState().doc.landscape.features;
  const river = fs.find((f) => f.kind === 'river');
  ws.getState().setFeatures(fs.map((f) => (f === river ? { ...f, width: f.width + 1 } : f)));
  const riverMs = performance.now() - riverT;
  const med = (a) => +a.sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(1);
  return { strokeCommitMs: med(strokes), strokeToFrameMs: med(toFrame), hillEditMs: med(features), riverEditMs: +riverMs.toFixed(1), roadBakeMs: +window.__ds.roadStats.lastBakeMs.toFixed(1) };
});
console.log('edits', JSON.stringify(results.edits));

// Phase 18 baseline: two crossing avenues + 1000 modular houses (bench-roads "city 1000").
await ev(() => window.__ds.actions.newProject());
await ev(async () => {
  const L = window.__ds.roadLib, B = window.__ds.buildingLib, ws = window.__ds.world.getState();
  let n = ws.doc.roads; const P = L.defaultProfile();
  n = L.drawRoad(n, [[-96, 0], [96, 0]], { curved: false, profile: P }).network;
  n = L.drawRoad(n, [[0, -96], [0, 96]], { curved: false, profile: P }).network;
  ws.applyEdit({ roads: n });
  const design = B.createDesign({ ...B.presetSpec('house'), floors: 2, width: 5, depth: 4 }, 'house');
  const roads = window.__ds.world.getState().doc.roads; const inputs = [];
  for (let z = -96; z <= 96 && inputs.length < 1000; z += 5) for (let x = -96; x <= 96 && inputs.length < 1000; x += 6) {
    if (L.footprintOnRoad(roads, { x, z, hx: 2.5, hz: 2, yaw: 0 }, 0.5)) continue;
    inputs.push({ type: 'building', building: design, seed: inputs.length + 1, transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] } });
  }
  window.__ds.world.getState().applyEdit({ add: inputs });
  await window.__frames(3);
});
results.baseline = await measure('phase18RoadsBuildings1000', [{ event: 'earthquake', magnitude: 6.8, pga: 0.5, duration: 20, seed: 2 }, { event: 'wind', speed: 30, direction: 'E', duration: 30, gustStrength: 0.25, rampDuration: 2 }]);

results.loadEnd = os.loadavg().map((v) => +v.toFixed(1));
if (outFile) fs.writeFileSync(outFile, JSON.stringify({ url, date: new Date().toISOString(), ...results }, null, 2));
await browser.close();
