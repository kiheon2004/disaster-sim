// Phase 26 benchmark (production build, real GPU): thermal physics in the browser.
//   scenes: warehouse heated by a 900 °C sphere (member temperature colors, heatmap), the RC apartment
//   thermal collapse (window just before the heat-triggered failure), 1000 houses + 5 MW source + wind,
//   300 trees + 3 MW, still water + 2 MW area source, and the Phase 25 1000-house earthquake without heat
//   (for an A/B against the Phase 25 build). Per scene: FPS / worst frame / CPU tick over a window,
//   thermal / collapse / physics cost per tick, peak draw calls, GPU geometries / textures / programs,
//   heap, thermal bodies / active tiles; then exit → geometries back.
//
//   npm run build && npx vite preview --port 4196 --strictPort &
//   node scripts/bench-thermal.mjs http://localhost:4196/ [out.json]
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
  const world = (add) => { ds.actions.newProject(); ds.sim.setInitialWaterState(null); if (add.length) ws.getState().applyEdit({ add }); };
  const houses = (n) => {
    const out = [], step = n <= 100 ? 16 : n <= 500 ? 8.5 : 6;
    for (let z = -94; z <= 94 && out.length < n; z += step) for (let x = -94; x <= 94 && out.length < n; x += step) { if (Math.hypot(x, z) < 12) continue; out.push({ type: 'building', building: D('house'), seed: out.length + 1, transform: tf(x, z) }); }
    return out;
  };
  const trees = (n) => Array.from({ length: n }, (_, k) => { const a = k * 2.399963, r = 6 + 3.2 * Math.sqrt(k); return { type: 'tree', seed: 500 + k, transform: tf(r * Math.cos(a), r * Math.sin(a)) }; });
  const atColumn = (id) => { const m = D(id).members.find((x) => x.type === 'column' && x.level === 0); return [m.position[0] + Math.sign(-m.position[0] || 1) * 1.8, m.position[2] + Math.sign(-m.position[2] || 1) * 1.8]; };
  const heat = (p) => ({ event: 'heatSource', kind: 'point', position: [0, 0], height: 2, radius: 3, input: 'power', power: 1e6, profile: 'constant', duration: 3000, ...p });
  const quake = (pga) => ({ event: 'earthquake', magnitude: 7.5, pga, duration: 20, seed: 3 });
  window.__scenes = {
    'warehouse-heating-900C': { make: () => world([{ type: 'building', building: D('warehouse'), seed: 1, transform: tf(0, 0) }]), events: () => [heat({ kind: 'temperature', temperature: 1173.15, radius: 2.6, height: 4, position: atColumn('warehouse') })], t0: 60, view: [0, 0, 55, 40], viz: { color: 'temperature' } },
    'apartment-thermal-collapse': { make: () => world([{ type: 'building', building: D('apartment'), seed: 1, transform: tf(0, 0) }]), events: () => [heat({ kind: 'temperature', temperature: 1373.15, radius: 3.2, height: 4, position: atColumn('apartment') })], t0: 841, view: [0, 0, 55, 40], viz: { color: 'temperature' } },
    'houses1000-5MW-wind': { make: () => world(houses(1000)), events: () => [{ event: 'wind', speed: 5, direction: 'W', duration: 600, gustStrength: 0 }, heat({ power: 5e6, height: 3 })], t0: 10 },
    'forest300-3MW': { make: () => world(trees(300)), events: () => [heat({ power: 3e6, height: 3 })], t0: 10, view: [0, 0, 90, 70] },
    'water-2MW': { make: () => { world([]); ds.floodStart(0.5); }, events: () => [{ event: 'waterSource', position: [90, 90], rate: 0.001, duration: 600, radius: 1 }, heat({ kind: 'area', radius: 10, power: 2e6, height: 0 })], t0: 20, view: [0, 0, 70, 50] },
    'houses1000-quake-0.9g-noheat': { make: () => world(houses(1000)), events: () => [quake(0.9)], t0: 3 },
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
    if (sc.viz && ds.view.getState().setThermalViz) { ds.view.getState().setStructureViz(sc.viz); ds.view.getState().setThermalViz({ field: 'surface', objects: true, isotherms: true }); }
    await ds.actions.runSimulation(sc.events());
    // Fast-forward to the window (synchronous fixed steps), then real-time play.
    ds.sim.pause();
    ds.sim.advance(Math.max(0, sc.t0 - ds.sim.getTime()));
    ds.sim.play();
  }, name);
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
    for (const e of S?.all ?? []) failed += e.modular.structure.model.records.filter((r) => r.cause !== 'facade').length;
    return {
      simTime: +ds.sim.getTime().toFixed(2),
      tickMs: +(prof.tickMs ?? 0).toFixed(2),
      collapseMsPerTick: +((prof.systems?.structuralCollapse ?? 0)).toFixed(3),
      damageMsPerTick: +((prof.systems?.damage ?? 0)).toFixed(3),
      seismicDamageMsPerTick: +((prof.systems?.seismicDamage ?? 0)).toFixed(3),
      thermalMsPerTick: +((prof.systems?.thermal ?? 0)).toFixed(3),
      thermalBodies: ds.thermalLib?.rt?.()?.stats.bodies ?? 0, thermalTiles: ds.thermalLib?.rt?.()?.world.terrain.tiles.length ?? 0,
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
