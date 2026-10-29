// Phase 29 benchmark (production build, real GPU): the atmosphere in the browser.
//   scenes: the presets (standard, gradual removal, restoration, heated plume, pressure-driven flow, wind and
//   density, smoke, volcanic ash, fire in a reduced atmosphere) and towns of 100 / 500 / 1000 houses during a
//   removal with wind — each with an overlay, flow arrows and streamlines on. Per scene: FPS / worst frame / CPU
//   tick over a window, thermal (+ atmosphere, fire, volcano) cost per tick, the atmosphere's last step, peak
//   draw calls, GPU geometries / textures / programs, heap; then exit → geometries back.
//
//   npm run build && npx vite preview --port 4198 --strictPort &
//   node scripts/bench-atmosphere.mjs http://localhost:4198/ [out.json]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';

const [url = 'http://localhost:4198/', outFile] = process.argv.slice(2);
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
  const presetEvents = () => () => ds.world.getState().doc.scenario.experiment.instances.map((i) => ({ ...i.spec, startTime: i.start.at ?? 0 }));
  const apreset = (id) => () => { ds.actions.newProject(); ds.sim.setInitialWaterState(null); ds.actions.loadAtmosPreset(id); };
  const town = (n) => { const out = [], step = n <= 100 ? 16 : n <= 500 ? 8.5 : 6; for (let z = -94; z <= 94 && out.length < n; z += step) for (let x = -94; x <= 94 && out.length < n; x += step) out.push({ type: 'building', building: D('house'), seed: out.length + 1, transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] } }); return out; };
  const townRun = (n) => ({ make: () => { ds.actions.newProject(); ds.sim.setInitialWaterState(null); ws.getState().applyEdit({ add: town(n) }); }, events: () => [{ event: 'atmosphere', altitude: 0, boundary: 'open', removal: 'linear', extent: 'uniform', target: 0.3, duration: 120, startTime: 0 }, { event: 'wind', speed: 20, direction: 'W', duration: 600, startTime: 0 }], t0: 60, view: [0, 0, 120, 100], overlay: 'pressure' });
  const P = (id, t0, overlay, view) => ({ make: apreset(id), events: presetEvents(), t0, overlay, view });
  window.__scenes = {
    'standard': P('standard', 10, 'pressure', [0, 0, 100, 80]),
    'gradual-removal': P('gradualRemoval', 300, 'density', [0, 0, 100, 80]),
    'restoration': P('restoration', 420, 'pressureChange', [0, 0, 100, 80]),
    'heated-plume': P('heatedPlume', 60, 'updraft', [0, 0, 60, 50]),
    'pressure-flow': P('pressureFlow', 60, 'speed', [0, 0, 70, 60]),
    'wind-density': P('windDensity', 90, 'density', [0, 0, 100, 80]),
    'smoke': P('smoke', 60, 'smoke', [-20, 0, 80, 60]),
    'volcanic-ash': P('volcanicAsh', 200, 'gas', [-30, 0, 90, 70]),
    'fire-reduced': P('fireReduced', 90, 'oxygen', [0, 0, 60, 50]),
    'town100-removal': townRun(100),
    'town500-removal': townRun(500),
    'town1000-removal': townRun(1000),
  };
});

async function heapMB() {
  for (let i = 0; i < 2; i++) { await ev(() => window.gc?.()); await cdp.send('HeapProfiler.collectGarbage'); }
  return ev(() => +(performance.memory.usedJSHeapSize / 1048576).toFixed(1));
}

async function simRun(name) {
  const geo0 = await ev(() => window.__r3f.get().gl.info.memory.geometries);
  await ev(async (name) => {
    const ds = window.__ds, sc = window.__scenes[name];
    await ds.actions.enterSimulation();
    window.__view(...(sc.view ?? [0, 0]));
    await window.__frames(5);
    await ds.actions.runSimulation(sc.events());
    ds.view.getState().setAtmosViz({ overlay: sc.overlay ?? 'off', arrows: true, streamlines: true });
    ds.sim.pause();
    ds.sim.advance(Math.max(0, sc.t0 - ds.sim.getTime()));
    ds.sim.play();
  }, name);
  await ev(() => {
    window.__ds.sim.setSpeed?.(1);
    const P = window.__ds.profiler; P.enabled = true; P.snapshot();
    window.__calls = [];
    const gl = window.__r3f.get().gl;
    const f = () => { window.__calls.push(gl.info.render.calls); if (window.__calls.length < 600) requestAnimationFrame(f); };
    requestAnimationFrame(f);
  });
  const fps = await ev((ms) => window.__fps(ms), SIM_MS);
  const extra = await ev(() => {
    const ds = window.__ds;
    const prof = ds.profiler.snapshot();
    const gl = window.__r3f.get().gl;
    const a = ds.atmosLib?.rt?.();
    return {
      simTime: +ds.sim.getTime().toFixed(2),
      tickMs: +(prof.tickMs ?? 0).toFixed(2),
      thermalMsPerTick: +((prof.systems?.thermal ?? 0)).toFixed(3),
      windForceMsPerTick: +((prof.systems?.windForce ?? 0)).toFixed(3),
      atmosMsLast: +(a?.ms ?? 0).toFixed(3),
      share: a ? +a.stats.share.toFixed(3) : null, peakFlow: a ? +a.stats.peakSpeed.toFixed(2) : null,
      thermalBodies: ds.thermalLib?.rt?.()?.stats.bodies ?? 0, thermalTiles: ds.thermalLib?.rt?.()?.stats.activeTiles ?? 0,
      physicsMsPerTick: +(prof.physicsMs ?? 0).toFixed(3),
      drawCallsPeak: window.__calls.length ? Math.max(...window.__calls) : 0,
      geometries: gl.info.memory.geometries, textures: gl.info.memory.textures, programs: gl.info.programs?.length ?? 0,
    };
  });
  await ev(() => { window.__ds.profiler.enabled = false; });
  const heap = await heapMB();
  await ev(() => window.__ds.actions.exitSimulation());
  await wait(400);
  await ev(() => window.__frames(5));
  const geoAfter = await ev(() => window.__r3f.get().gl.info.memory.geometries);
  return { ...fps, ...extra, heapMB: heap, geometriesBefore: geo0, geometriesAfterExit: geoAfter };
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
