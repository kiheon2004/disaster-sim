// Phase 28 benchmark (production build, real GPU): the volcano in the browser.
//   scenes: a single vent on a slope, a fissure, a viscous andesite flow, lava into a lake, lava through a
//   conifer stand (secondary fire), lava against houses, ash fall with wind, three vents, and towns of 100 /
//   500 / 1000 houses with a vent in a corner. Per scene: FPS / worst frame / CPU tick over a window, thermal
//   (+ volcano, fire) / collapse / physics cost per tick, the volcano's last step, peak draw calls, GPU
//   geometries / textures / programs, heap, active lava / hot deposits / drawn volcano instances; then exit →
//   geometries back.
//
//   npm run build && npx vite preview --port 4198 --strictPort &
//   node scripts/bench-volcano.mjs http://localhost:4198/ [out.json]
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
  const world = (add) => { ds.actions.newProject(); ds.sim.setInitialWaterState(null); if (add.length) ws.getState().applyEdit({ add }); };

  const presetEvents = (id) => () => ds.world.getState().doc.scenario.experiment.instances.map((i) => ({ ...i.spec, startTime: i.start.at ?? 0 }));
  const slope = (deg, x1 = 40) => (x) => Math.round((x < x1 ? (x1 - Math.max(-100, x)) * Math.tan((deg * Math.PI) / 180) : 0) * 100) / 100;
  const corner = (deg) => (x, z) => Math.round(Math.max(0, (100 - (x + z) / 2) * Math.tan((deg * Math.PI) / 180) - 40 * Math.tan((deg * Math.PI) / 180)) * 100) / 100;
  const terrain = (h) => { const t0 = ws.getState().doc.terrain; const heights = new Float32Array(t0.heights.length); for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) heights[iz * t0.nx + ix] = h(t0.originX + ix * t0.cellSize, t0.originZ + iz * t0.cellSize); ws.getState().applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length) } } }); };
  const town = (n, h) => { const out = [], step = n <= 100 ? 16 : n <= 500 ? 8.5 : 6; for (let z = -94; z <= 94 && out.length < n; z += step) for (let x = -94; x <= 94 && out.length < n; x += step) { if (x + z < -120) continue; out.push({ type: 'building', building: D('house'), seed: out.length + 1, transform: { position: [x, h(x, z), z], rotation: [0, 0, 0], scale: [1, 1, 1] } }); } return out; };
  const erupt = (p) => ({ event: 'volcano', vents: [{ kind: 'central', position: [-70, 0], radius: 2 }], material: 'basalt', temperature: 1150, rate: 3, duration: 3600, profile: 'constant', ...p });
  const vpreset = (id) => () => { ds.actions.newProject(); ds.sim.setInitialWaterState(null); ds.actions.loadVolcanoPreset(id); };
  window.__scenes = {
    'single-vent-slope': { make: () => { world([]); terrain(slope(6)); }, events: () => [erupt({})], t0: 150, view: [-45, 0, 60, 45] },
    'fissure-flow': { make: vpreset('fissureFlow'), events: presetEvents('fissureFlow'), t0: 200, view: [-45, 0, 70, 50] },
    'andesite-flow': { make: () => { world([]); terrain(slope(6)); }, events: () => [erupt({ material: 'andesite', temperature: 1050 })], t0: 150, view: [-60, 0, 40, 30] },
    'lava-into-lake': { make: vpreset('lavaWater'), events: presetEvents('lavaWater'), t0: 200, view: [25, 0, 60, 40] },
    'lava-forest-fire': { make: vpreset('vegetationFire'), events: presetEvents('vegetationFire'), t0: 200, view: [-40, 0, 55, 40] },
    'lava-houses': { make: vpreset('buildings'), events: presetEvents('buildings'), t0: 200, view: [-40, 6, 50, 35] },
    'ash-fall-wind': { make: vpreset('ashFall'), events: presetEvents('ashFall'), t0: 150, view: [-20, 0, 90, 70] },
    'three-vents': { make: () => { world([]); terrain(slope(6)); }, events: () => [erupt({ rate: 6, vents: [{ kind: 'central', position: [-70, -30], radius: 2 }, { kind: 'central', position: [-70, 0], radius: 2 }, { kind: 'central', position: [-70, 30], radius: 2 }] })], t0: 150, view: [-45, 0, 80, 60] },
    'town100-corner-vent': { make: () => { world([]); terrain(corner(5)); ws.getState().applyEdit({ add: town(100, corner(5)) }); }, events: () => [erupt({ vents: [{ kind: 'central', position: [-90, -90], radius: 2 }] })], t0: 180, view: [-60, -60, 90, 70] },
    'town500-corner-vent': { make: () => { world([]); terrain(corner(5)); ws.getState().applyEdit({ add: town(500, corner(5)) }); }, events: () => [erupt({ vents: [{ kind: 'central', position: [-90, -90], radius: 2 }] })], t0: 180, view: [-60, -60, 90, 70] },
    'town1000-corner-vent': { make: () => { world([]); terrain(corner(5)); ws.getState().applyEdit({ add: town(1000, corner(5)) }); }, events: () => [erupt({ vents: [{ kind: 'central', position: [-90, -90], radius: 2 }] })], t0: 180, view: [-60, -60, 90, 70] },
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
      burningItems: ds.fireLib?.rt?.()?.stats.burningItems ?? 0,
      volcanoMsLast: +(ds.volcanoLib?.rt?.()?.ms ?? 0).toFixed(3), volcanoSplit: ds.volcanoLib?.rt?.()?.stats.ms,
      activeLava: ds.volcanoLib?.rt?.()?.stats.activeLava ?? 0, hotDeposits: ds.volcanoLib?.rt?.()?.stats.hotDeposits ?? 0, refined: ds.thermalLib?.rt?.()?.refined ?? 0,
      volcanoInstances: (() => { let n = 0; window.__r3f.get().scene.traverse((o) => { if (o.name === 'volcano-layer') o.traverse((m) => { if (m.isInstancedMesh) n += m.count; if (m.isPoints) n += m.geometry.drawRange.count; }); }); return n; })(),
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
