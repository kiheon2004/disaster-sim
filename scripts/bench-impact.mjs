// Phase 23 benchmark (production build, real GPU): meteoroid / asteroid impacts in the browser.
//   scenes: small / medium impact, slope, rock, loose fill, road, dense buildings, river + lake,
//   impact + landslide, impact + flood, 100 / 500 / 1000 buildings, repeated impacts
//   per scene: editor FPS; simulation FPS / worst frame / CPU tick over a window that starts at
//   the impact, without (A) and with (B) the impact, and (C) a Phase 22 sinkhole of comparable size
//   at the same point; impact / ground / engine / collider / water / object cost, draw calls,
//   GPU geometries / textures / programs, heap.
//
//   npm run build && npx vite preview --port 4191 --strictPort &
//   node scripts/bench-impact.mjs http://localhost:4191/ [out.json]
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
  const medium = (x = {}) => ({ event: 'impact', target: [0, 0], material: 'iron', diameter: 2, speed: 12000, angle: 60, azimuth: 90, entry: 'atmosphere', ...x });
  const small = (x = {}) => ({ event: 'impact', target: [0, 0], material: 'stony', diameter: 0.6, speed: 6000, angle: 75, azimuth: 90, entry: 'direct', ...x });
  const town = (n, roads) => {
    ds.actions.newProject();
    if (roads) { let net = ws.getState().doc.roads; for (const p of [[[-96, 0], [96, 0]], [[0, -96], [0, 96]]]) net = L.drawRoad(net, p, { curved: false, profile: L.defaultProfile() }).network; ws.getState().applyEdit({ roads: net }); }
    const d = L.presetDesign('house', 1), add = [];
    const step = n <= 100 ? 16 : n <= 500 ? 8.5 : 6;
    for (let z = -94; z <= 94 && add.length < n; z += step) for (let x = -94; x <= 94 && add.length < n; x += step) { if (roads && (Math.abs(x) < 6 || Math.abs(z) < 6)) continue; add.push({ type: 'building', building: d, seed: add.length + 1, transform: tf(x, z) }); }
    if (add.length) ws.getState().applyEdit({ add });
  };
  const soil = (k) => { ds.actions.newProject(); ws.getState().doc.terrain.soil.fill(k); };
  const sinkAt = (c, r) => ({ event: 'sinkhole', center: c, cavityRadius: Math.max(0.5, r), cavityHeight: Math.max(1, r), cover: Math.max(1, r * 0.7), initiation: 'supportLoss', supportLoss: 0.95, duration: 1 });
  window.__scenes = {
    small: { make: flat, base: () => [], ground: () => [small()], phase21: () => [sinkAt([0, 0], 5)], at: [0, 0] },
    medium: { make: flat, base: () => [], ground: () => [medium()], phase21: () => [sinkAt([0, 0], 9.7)], at: [0, 0] },
    slope: { make: () => slope(28), base: () => [], ground: () => [medium({ target: [-15, 0] })], phase21: () => [sinkAt([-15, 0], 9)], at: [-15, 0] },
    rock: { make: () => soil(0), base: () => [], ground: () => [medium()], phase21: () => [sinkAt([0, 0], 9)], at: [0, 0] },
    'loose-fill': { make: () => soil(3), base: () => [], ground: () => [medium()], phase21: () => [sinkAt([0, 0], 9)], at: [0, 0] },
    road: { make: () => town(0, true), base: () => [], ground: () => [medium()], at: [0, 0] },
    'dense-buildings': { make: () => town(300, true), base: () => [], ground: () => [medium({ target: [20, 20] })], at: [20, 20] },
    'river-lake': { make: () => template('riverValley'), base: () => [], ground: () => [medium({ target: [10, 10] })], at: [10, 10] },
    'impact+landslide': { make: () => slope(34), base: () => [{ event: 'landslide', area: { kind: 'circle', center: [-12, 0], radius: 10 }, thickness: 1.5, saturation: 0.3, trigger: 'slope', duration: 1 }], ground: () => [small({ target: [-4, 0], diameter: 1.2, speed: 8000 })], at: [-8, 0] },
    'impact+flood': { make: flat, base: () => [rain(120)], ground: () => [medium()], at: [0, 0] },
    buildings100: { make: () => town(100), base: () => [], ground: () => [medium()], at: [0, 0] },
    buildings500: { make: () => town(500), base: () => [], ground: () => [medium()], at: [0, 0] },
    buildings1000: { make: () => town(1000), base: () => [], ground: () => [medium()], at: [0, 0] },
    'repeated-6': { make: () => town(100, true), base: () => [], ground: () => [-60, -30, 0, 30, 60, 0].map((x, k) => medium({ target: [x, k === 5 ? 40 : -20], startTime: k * 4, seed: k + 1 })), at: [0, 0] },
  };
});

async function heapMB() {
  for (let i = 0; i < 2; i++) { await ev(() => window.gc?.()); await cdp.send('HeapProfiler.collectGarbage'); }
  return ev(() => +(performance.memory.usedJSHeapSize / 1048576).toFixed(1));
}

/** One simulation run of a scene with the chosen events; FPS while it runs. */
/** Impact time of a scene's first impact (B), so A / B / C are measured over the same window. */
async function impactTime(name) {
  return ev((name) => { const ds = window.__ds, sc = window.__scenes[name]; const s = sc.ground()[0]; return (s.startTime ?? 0) + ds.groundLib.impactPlan(s).timeToImpact; }, name);
}

/** One run of a scene: fast-forward (8×) to just before the impact, then measure at 1×. */
async function simRun(name, which, t0) {
  await ev(async (name, which) => {
    const ds = window.__ds, sc = window.__scenes[name];
    await ds.actions.enterSimulation();
    window.__view(...(sc.at ?? [0, 0]));
    await window.__frames(5);
    ds.deformLib.terrainStats.reset();
    const extra = which === 'B' ? sc.ground() : which === 'C' ? sc.phase21() : [];
    await ds.actions.runSimulation([...sc.base(), ...extra]);
    ds.sim.setSpeed?.(8);
  }, name, which);
  await page.waitForFunction((t) => window.__ds.sim.getTime() >= t, { timeout: 300_000, polling: 50 }, Math.max(0, t0 - 0.5));
  await ev(() => { window.__ds.sim.setSpeed?.(1); const P = window.__ds.profiler; P.enabled = true; P.snapshot(); window.__calls = []; const gl = window.__r3f.get().gl; const f = () => { window.__calls.push(gl.info.render.calls); if (window.__calls.length < 400) requestAnimationFrame(f); }; requestAnimationFrame(f); });
  const fps = await ev((ms) => window.__fps(ms), SIM_MS);
  const extra = await ev(() => {
    const ds = window.__ds, env = ds.sim.getEnvironment(), g = env.groundFailure, st = g.stats, ts = ds.deformLib.terrainStats, dst = env.deformation.stats, is = env.impact.stats;
    const prof = ds.profiler.snapshot();
    const gl = window.__r3f.get().gl;
    const calls = window.__calls.length ? Math.max(...window.__calls) : 0;
    return {
      simTime: +ds.sim.getTime().toFixed(1),
      tickMs: +(prof.tickMs ?? 0).toFixed(2),
      impactMeanMs: is.updates ? +(is.totalMs / is.updates).toFixed(3) : 0,
      impactObjectsMs: +is.objectsMs.toFixed(2),
      groundMeanMs: st.updates ? +(st.totalMs / st.updates).toFixed(2) : 0,
      deformMeanMs: dst && dst.updates ? +(dst.totalMs / dst.updates).toFixed(2) : 0,
      colliderMeanMs: dst && dst.updates ? +(dst.colliderTotalMs / dst.updates).toFixed(2) : 0,
      waterMs: +((prof.systems?.waterSolver ?? 0)).toFixed(2),
      meshMeanMs: ts.meshUpdates ? +(ts.meshMs / ts.meshUpdates).toFixed(2) : 0,
      drawCallsPeak: calls,
      geometries: gl.info.memory.geometries, textures: gl.info.memory.textures, programs: gl.info.programs?.length ?? 0,
    };
  });
  await ev(() => { window.__ds.profiler.enabled = false; });
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
  const t0 = await impactTime(name);
  const A = await simRun(name, 'A', t0);
  const B = await simRun(name, 'B', t0);
  const C = (await ev((n) => !!window.__scenes[n].phase21, name)) ? await simRun(name, 'C', t0) : null;
  const row = { scene: name, ...counts, editorFps: editor.fps, editorHeapMB: editorHeap, load: os.loadavg()[0].toFixed(1), A, B, C };
  console.log(JSON.stringify(row));
  rows.push(row);
}
const out = { date: new Date().toISOString(), url, cpus: os.cpus()[0]?.model, load: os.loadavg().map((v) => +v.toFixed(1)), simWindowMs: SIM_MS, rows };
if (outFile) fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
await browser.close();
