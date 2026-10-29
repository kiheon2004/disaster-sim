// Phase 24 benchmark (production build, real GPU): atmospheric pressure waves in the browser.
//   scenes: empty, vehicles + people, infrastructure, 100 / 500 / 1000 buildings, road city, mountain,
//   multiple waves, impact + air blast (A = the Phase 23 impact without it), blast + flood, blast +
//   earthquake, repeated waves
//   per scene: simulation FPS / worst frame / CPU tick over a window that starts just before the
//   release, without (A) and with (B) the wave; blast / structural / physics cost per tick, draw
//   calls, GPU geometries / textures / programs, heap.
//
//   npm run build && npx vite preview --port 4191 --strictPort &
//   node scripts/bench-blast.mjs http://localhost:4191/ [out.json]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';

const [url = 'http://localhost:4191/', outFile] = process.argv.slice(2);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SIM_MS = Number(process.env.SIM_MS ?? 5000);
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
  const tf = (x, z, yaw = 0) => ({ position: [x, 0, z], rotation: [0, yaw, 0], scale: [1, 1, 1] });
  const world = (o = {}) => {
    ds.actions.newProject();
    if (o.slope) {
      const t0 = ws.getState().doc.terrain, heights = new Float32Array(t0.heights.length), tb = Math.tan((o.slope * Math.PI) / 180);
      for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) { const x = t0.originX + ix * t0.cellSize; heights[iz * t0.nx + ix] = x > 30 ? Math.min(60, (x - 30) * tb) : 0; }
      ws.getState().applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length) } } });
    }
    if (o.roads) { let net = ws.getState().doc.roads; for (const p of [[[-96, 0], [96, 0]], [[0, -96], [0, 96]]]) net = L.drawRoad(net, p, { curved: false, profile: L.defaultProfile() }).network; ws.getState().applyEdit({ roads: net }); }
    const d = L.presetDesign('house', 1), add = [];
    const n = o.buildings ?? 0, step = n <= 100 ? 16 : n <= 500 ? 8.5 : 6;
    for (let z = -94; z <= 94 && add.length < n; z += step) for (let x = -94; x <= 94 && add.length < n; x += step) { if (Math.hypot(x, z) < 12) continue; if (o.roads && (Math.abs(x) < 6 || Math.abs(z) < 6)) continue; add.push({ type: 'building', building: d, seed: add.length + 1, transform: tf(x, z) }); }
    for (let k = 0; k < (o.cars ?? 0); k++) add.push({ type: 'car', seed: 1000 + k, transform: tf(-80 + (k % 10) * 16, -30 + Math.floor(k / 10) * 60) });
    for (let k = 0; k < (o.people ?? 0); k++) add.push({ type: 'human', seed: 2000 + k, transform: tf(-85 + (k % 12) * 15, 20 + Math.floor(k / 12) * 10) });
    const types = ['streetLight', 'sign', 'wall'];
    for (let k = 0; k < (o.infra ?? 0); k++) add.push({ type: types[k % 3], seed: 3000 + k, transform: tf(-90 + (k % 15) * 12, -60 + Math.floor(k / 15) * 30, k % 2 ? Math.PI / 2 : 0) });
    if (add.length) ws.getState().applyEdit({ add });
  };
  const blast = (x = {}) => ({ event: 'blast', position: [0, 0], height: 1, energy: 1e9, model: 'weakShock', waveform: 'nWave', startTime: 0.5, ...x });
  const rain = () => ({ ...ds.deformLib.phenomena.implemented('rain').defaults(), intensity: 100, duration: 30 });
  const quake = () => ({ event: 'earthquake', magnitude: 6.5, pga: 0.25, duration: 10 });
  const impact = (air) => ({ event: 'impact', target: [6, 6], material: 'stony', diameter: 1, speed: 8000, angle: 70, azimuth: 45, entry: 'direct', ...(air ? { airBlast: true } : {}) });
  window.__scenes = {
    empty: { make: () => world(), base: () => [], extra: () => [blast()], t0: 0.5 },
    'vehicles+people': { make: () => world({ cars: 30, people: 36 }), base: () => [], extra: () => [blast()], t0: 0.5 },
    infrastructure: { make: () => world({ infra: 75 }), base: () => [], extra: () => [blast()], t0: 0.5 },
    buildings100: { make: () => world({ buildings: 100 }), base: () => [], extra: () => [blast()], t0: 0.5 },
    buildings500: { make: () => world({ buildings: 500 }), base: () => [], extra: () => [blast()], t0: 0.5 },
    buildings1000: { make: () => world({ buildings: 1000 }), base: () => [], extra: () => [blast()], t0: 0.5 },
    'road-city': { make: () => world({ buildings: 300, roads: true, cars: 20, infra: 30 }), base: () => [], extra: () => [blast({ position: [20, 20] })], t0: 0.5, at: [20, 20] },
    mountain: { make: () => world({ buildings: 100, slope: 30 }), base: () => [], extra: () => [blast({ position: [-20, 0] })], t0: 0.5 },
    'multiple-3': { make: () => world({ buildings: 100, cars: 20 }), base: () => [], extra: () => [blast(), blast({ position: [-60, 50], energy: 3e8, startTime: 0.8 }), blast({ position: [70, -40], energy: 3e8, height: 20, startTime: 1.1 })], t0: 0.5 },
    'impact+airBlast': { make: () => world({ buildings: 100, cars: 10 }), base: () => [], A: () => [impact(false)], extra: () => [impact(true)], t0: 0.2, at: [6, 6] },
    'blast+flood': { make: () => world({ buildings: 100 }), base: () => [rain()], extra: () => [blast({ startTime: 3 })], t0: 3 },
    'blast+earthquake': { make: () => world({ buildings: 100 }), base: () => [quake()], extra: () => [blast({ startTime: 3 })], t0: 3 },
    'repeated-6': { make: () => world({ buildings: 100, cars: 10 }), base: () => [], extra: () => [-60, -30, 0, 30, 60, 0].map((x, k) => blast({ position: [x, k === 5 ? 40 : -20], energy: 3e8, startTime: 0.5 + k * 1.5 })), t0: 0.5 },
  };
});

async function heapMB() {
  for (let i = 0; i < 2; i++) { await ev(() => window.gc?.()); await cdp.send('HeapProfiler.collectGarbage'); }
  return ev(() => +(performance.memory.usedJSHeapSize / 1048576).toFixed(1));
}

async function simRun(name, which) {
  const t0 = await ev((n) => window.__scenes[n].t0, name);
  await ev(async (name, which) => {
    const ds = window.__ds, sc = window.__scenes[name];
    await ds.actions.enterSimulation();
    window.__view(...(sc.at ?? [0, 0]));
    await window.__frames(5);
    const events = which === 'B' ? [...sc.base(), ...sc.extra()] : sc.A ? sc.A() : sc.base();
    await ds.actions.runSimulation(events);
    if (t0 > 1) ds.sim.setSpeed?.(4);
  }, name, which);
  await page.waitForFunction((t) => window.__ds.sim.getTime() >= t, { timeout: 300_000, polling: 20 }, Math.max(0, t0 - 0.3));
  await ev(() => { window.__ds.sim.setSpeed?.(1); const P = window.__ds.profiler; P.enabled = true; P.snapshot(); window.__calls = []; const gl = window.__r3f.get().gl; const f = () => { window.__calls.push(gl.info.render.calls); if (window.__calls.length < 400) requestAnimationFrame(f); }; requestAnimationFrame(f); });
  const fps = await ev((ms) => window.__fps(ms), SIM_MS);
  const extra = await ev(() => {
    const ds = window.__ds, env = ds.sim.getEnvironment(), st = env.blast?.stats;
    const prof = ds.profiler.snapshot();
    const gl = window.__r3f.get().gl;
    return {
      simTime: +ds.sim.getTime().toFixed(2),
      tickMs: +(prof.tickMs ?? 0).toFixed(2),
      blastMsPerTick: +((prof.systems?.blast ?? 0)).toFixed(3),
      structuralMsPerTick: +((prof.systems?.structural ?? 0)).toFixed(3),
      physicsMsPerTick: +(prof.physicsMs ?? 0).toFixed(3),
      blastActivationMs: st ? +st.fieldTotalMs.toFixed(1) : 0,
      blastResponseMs: st ? +st.forceTotalMs.toFixed(1) : 0,
      drawCallsPeak: window.__calls.length ? Math.max(...window.__calls) : 0,
      geometries: gl.info.memory.geometries, textures: gl.info.memory.textures, programs: gl.info.programs?.length ?? 0,
      events: ds.sim.getDamageEvents().length,
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
  const objects = await ev(() => Object.keys(window.__ds.world.getState().doc.objects).length);
  const A = await simRun(name, 'A');
  const B = await simRun(name, 'B');
  const row = { scene: name, objects, load: +os.loadavg()[0].toFixed(1), A, B };
  console.log(JSON.stringify(row));
  rows.push(row);
}
const out = { date: new Date().toISOString(), url, cpus: os.cpus()[0]?.model, load: os.loadavg().map((v) => +v.toFixed(1)), simWindowMs: SIM_MS, rows };
if (outFile) fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
await browser.close();
