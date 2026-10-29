// Phase 25 benchmark (production build, real GPU): structural destruction in the browser.
//   scenes: street earthquake collapse (apartment + house + cars), 9 apartments at 1.1 g, 12 houses
//   blast walls, 1000 houses + 1 GJ wave (the Phase 24 scene), 1000 houses at 1.3 g (facade losses)
//   per scene: FPS / worst frame / CPU tick over a window that starts just before the collapse;
//   collapse / damage / physics cost per tick, peak draw calls, GPU geometries / textures / programs,
//   heap, active falling blocks, moving / total fragments, rubble heaps; then exit → geometries back.
//
//   npm run build && npx vite preview --port 4191 --strictPort &
//   node scripts/bench-structure.mjs http://localhost:4191/ [out.json]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';

const [url = 'http://localhost:4191/', outFile] = process.argv.slice(2);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SIM_MS = Number(process.env.SIM_MS ?? 5000);
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,900', '--enable-precise-memory-info', '--js-flags=--expose-gc'],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 }, protocolTimeout: 1_800_000, timeout: 180_000,
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
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
  const ds = window.__ds, ws = ds.world, B = ds.buildingLib;
  const designs = {};
  const D = (p) => (designs[p] ??= B.createDesign(B.presetSpec(p), p));
  window.__view = (x = 0, z = 0, back = 110, h = 90) => { const st = window.__r3f.get(); st.camera.position.set(x + back * 0.64, h, z + back); st.controls.target.set(x, 0, z); st.controls.update(); };
  const tf = (x, z) => ({ position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] });
  const world = (add) => { ds.actions.newProject(); if (add.length) ws.getState().applyEdit({ add }); };
  const houses = (n) => {
    const out = [], step = n <= 100 ? 16 : n <= 500 ? 8.5 : 6;
    for (let z = -94; z <= 94 && out.length < n; z += step) for (let x = -94; x <= 94 && out.length < n; x += step) { if (Math.hypot(x, z) < 12) continue; out.push({ type: 'building', building: D('house'), seed: out.length + 1, transform: tf(x, z) }); }
    return out;
  };
  const quake = (pga) => ({ event: 'earthquake', magnitude: 7.5, pga, duration: 20, seed: 3 });
  const blast = (x = {}) => ({ event: 'blast', position: [0, 0], height: 1, energy: 2e9, model: 'weakShock', waveform: 'nWave', startTime: 0.5, ...x });
  window.__scenes = {
    'street-quake-1.1g': {
      make: () => world([{ type: 'building', building: D('apartment'), seed: 1, transform: tf(0, 0) }, { type: 'building', building: D('house'), seed: 2, transform: tf(18, 0) }, ...[0, 1, 2, 3, 4].map((k) => ({ type: 'car', seed: 20 + k, transform: tf(-12 + k * 6, 10) }))]),
      events: () => [quake(1.1)], t0: 3.0, view: [0, 0, 60, 45],
    },
    'apartments9-quake-1.1g': {
      make: () => world([0, 1, 2, 3, 4, 5, 6, 7, 8].map((k) => ({ type: 'building', building: D('apartment'), seed: k + 1, transform: tf(-36 + (k % 3) * 36, -30 + Math.floor(k / 3) * 30) }))),
      events: () => [quake(1.1)], t0: 3.0,
    },
    'houses12-blast': {
      make: () => world(houses(12).map((h, k) => ({ ...h, transform: tf(-30 + (k % 6) * 12, k < 6 ? 12 : -12) }))),
      events: () => [blast()], t0: 0.45, view: [0, 0, 70, 55],
    },
    'houses1000-blast-1GJ': { make: () => world(houses(1000)), events: () => [blast({ energy: 1e9 })], t0: 0.45 },
    'houses1000-quake-1.3g': { make: () => world(houses(1000)), events: () => [quake(1.3)], t0: 5.2 },
  };
});

async function heapMB() {
  for (let i = 0; i < 2; i++) { await ev(() => window.gc?.()); await cdp.send('HeapProfiler.collectGarbage'); }
  return ev(() => +(performance.memory.usedJSHeapSize / 1048576).toFixed(1));
}

async function simRun(name) {
  const t0 = await ev((n) => window.__scenes[n].t0, name);
  const geo0 = await ev(() => window.__r3f.get().gl.info.memory.geometries);
  await ev(async (name) => {
    const ds = window.__ds, sc = window.__scenes[name];
    await ds.actions.enterSimulation();
    window.__view(...(sc.view ?? [0, 0]));
    await window.__frames(5);
    await ds.actions.runSimulation(sc.events());
    if (sc.t0 > 1) ds.sim.setSpeed?.(4);
  }, name);
  await page.waitForFunction((t) => window.__ds.sim.getTime() >= t, { timeout: 600_000, polling: 20 }, Math.max(0, t0 - 0.3));
  await ev(() => {
    window.__ds.sim.setSpeed?.(1);
    const P = window.__ds.profiler; P.enabled = true; P.snapshot();
    window.__calls = []; window.__peak = { blocks: 0, moving: 0 };
    const gl = window.__r3f.get().gl;
    const f = () => {
      window.__calls.push(gl.info.render.calls);
      const S = window.__ds.sim.getRuntime()?.structures;
      if (S) {
        let b = 0, m = 0;
        for (const e of S.active) for (const bl of e.modular.structure.model.blocks) if (bl.active) b++;
        for (const fr of S.fragments) if (!fr.structural.settled) m++;
        window.__peak.blocks = Math.max(window.__peak.blocks, b); window.__peak.moving = Math.max(window.__peak.moving, m);
      }
      if (window.__calls.length < 600) requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  const fps = await ev((ms) => window.__fps(ms), SIM_MS);
  const extra = await ev(() => {
    const ds = window.__ds;
    const prof = ds.profiler.snapshot();
    const gl = window.__r3f.get().gl;
    const S = ds.sim.getRuntime()?.structures;
    let failed = 0;
    for (const e of S?.all ?? []) failed += e.modular.structure.model.records.length;
    return {
      simTime: +ds.sim.getTime().toFixed(2),
      tickMs: +(prof.tickMs ?? 0).toFixed(2),
      collapseMsPerTick: +((prof.systems?.structuralCollapse ?? 0)).toFixed(3),
      damageMsPerTick: +((prof.systems?.damage ?? 0)).toFixed(3),
      seismicDamageMsPerTick: +((prof.systems?.seismicDamage ?? 0)).toFixed(3),
      blastMsPerTick: +((prof.systems?.blast ?? 0)).toFixed(3),
      physicsMsPerTick: +(prof.physicsMs ?? 0).toFixed(3),
      drawCallsPeak: window.__calls.length ? Math.max(...window.__calls) : 0,
      geometries: gl.info.memory.geometries, textures: gl.info.memory.textures, programs: gl.info.programs?.length ?? 0,
      models: S?.all.length ?? 0, failedMembers: failed, peakFallingBlocks: window.__peak.blocks, peakMovingFragments: window.__peak.moving,
      fragments: S?.fragments.length ?? 0, heaps: S?.rubble.heaps.length ?? 0,
    };
  });
  await ev(() => { window.__ds.profiler.enabled = false; });
  const heap = await heapMB();
  const r0 = Date.now();
  await ev(() => window.__ds.actions.exitSimulation());
  await wait(400);
  await ev(() => window.__frames(5));
  const geoAfter = await ev(() => window.__r3f.get().gl.info.memory.geometries);
  return { ...fps, ...extra, heapMB: heap, exitMs: Date.now() - r0 - 400, geometriesBefore: geo0, geometriesAfterExit: geoAfter };
}

const rows = [];
const only = process.env.SCENES?.split(',');
for (const name of await ev(() => Object.keys(window.__scenes))) {
  if (only && !only.includes(name)) continue;
  await ev(async (name) => { window.__scenes[name].make(); window.__view(...(window.__scenes[name].view ?? [0, 0])); await window.__frames(5); }, name);
  const objects = await ev(() => Object.keys(window.__ds.world.getState().doc.objects).length);
  const r = await simRun(name);
  const row = { scene: name, objects, load: +os.loadavg()[0].toFixed(1), ...r };
  console.log(JSON.stringify(row));
  rows.push(row);
}
console.log(errors.length ? `ERRORS ${errors.length}\n${errors.slice(0, 10).join('\n')}` : 'no console / page errors');
const out = { date: new Date().toISOString(), url, cpus: os.cpus()[0]?.model, load: os.loadavg().map((v) => +v.toFixed(1)), simWindowMs: SIM_MS, errors, rows };
if (outFile) fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
await browser.close();
