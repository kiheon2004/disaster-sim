// Phase 32.1: browser frame times of large celestial scenes — the same world, camera, viewport and simulated time on two
// builds (A/B: run against two preview servers). Per frame: frame time and the simulation tick time (simProfiler on:
// one performance.now() pair per section), so the frame splits into simulation and the rest (React, R3F, WebGL).
// p50 / p95 / p99, FPS mean and p5, long frames (> 50 ms), draw calls, triangles, geometries, textures, heap.
//   node scripts/bench-celestial-fps.mjs http://localhost:4199/ out.json [rounds=1] [scenes=town,town-off,objects]
import fs from 'node:fs';
import os from 'node:os';
import puppeteer from 'puppeteer-core';

const [url = 'http://localhost:4199/', out = 'fps.json', roundsArg = '1', scenesArg = 'town,town-off,objects'] = process.argv.slice(2);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,1000', '--enable-precise-memory-info', '--js-flags=--expose-gc'], defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 }, protocolTimeout: 3_600_000 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', (d) => d.accept());
await page.goto(url + '?devtools', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('ds.hazardTab', 'experiment'); localStorage.setItem('ds.bottomHeight', '420'); });
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2); };

const G = 6.6743e-11;
const SCENES = {
  // Chrome check 46: 1000 two-storey houses, a source of μ = 10⁵ m³/s² 40 m above the centre, ramp 10 s.
  town: { source: { center: [0, 40, 0], mass: 1e5 / G, softening: 3, capture: 2.5, ramp: 10 }, world: 'houses', camera: [0, 120, 160], at: 3 },
  'town-off': { source: null, world: 'houses', camera: [0, 120, 160], at: 3 },
  // 1000 cars and people pulled into a source 20 m up (bench scene 19).
  objects: { source: { center: [0, 20, 0], mass: 1e5 / G, softening: 3, capture: 2.5, ramp: 2 }, world: 'bodies', camera: [0, 90, 120], at: 3 },
};

async function runOnce(name) {
  const sc = SCENES[name];
  await ev(() => window.__ds.actions.newProject());
  await ev((kind) => {
    const ds = window.__ds;
    const add = [];
    if (kind === 'houses') {
      const d = ds.buildingLib.createDesign({ ...ds.buildingLib.presetSpec('house'), floors: 2 }, 'house');
      for (let z = -94; z <= 94 && add.length < 1000; z += 6) for (let x = -94; x <= 94 && add.length < 1000; x += 6) add.push({ type: 'building', building: d, seed: add.length + 1, transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] } });
    } else {
      const side = 32, sp = Math.min(6, 190 / side);
      for (let k = 0; k < 1000; k++) { const x = -95 + (k % side) * sp, z = -95 + Math.floor(k / side) * sp; add.push(k % 2 ? { type: 'human', seed: 1000 + k, transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] } } : { type: 'car', seed: 1000 + k, params: { length: Math.min(4.5, sp * 0.8) }, transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] } }); }
    }
    ds.world.getState().applyEdit({ add });
  }, sc.world);
  if (sc.source) {
    await ev((src) => window.__ds.actions.addPhenomenon('celestial', { event: 'celestial', scenario: 'custom', scale: 'educational', sources: [{ kind: 'blackHole', influence: 0, massPolicy: 'fixed', motion: 'fixed', ...src }], probes: [], accretion: { visual: false, particles: 0, inner: 6, outer: 20, particleMass: 1 }, duration: 3600, end: 'hold', tidal: true, lensing: false, limitPolicy: 'warn', startTime: 0 }), sc.source);
  } else await ev(() => window.__ds.actions.addPhenomenon('wind', { event: 'wind', speed: 0.5, direction: 'E', duration: 600 }));
  await wait(1500);
  const tPrep = Date.now();
  await ev(() => { for (const b of document.querySelectorAll('button')) if (/^\s*실험 실행|Run experiment/.test(b.textContent ?? '') && !b.disabled) { b.click(); return; } });
  await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status === 'running', { timeout: 600_000 });
  const prepMs = Date.now() - tPrep;
  await ev((at) => { const s = window.__ds.sim; s.pause(); s.advance(at - s.getTime()); }, sc.at);
  await ev((cam) => { const st = window.__r3f.get(); st.camera.position.set(cam[0], cam[1], cam[2]); st.controls.target.set(0, 0, 0); st.controls.update(); }, sc.camera);
  await ev(() => { const p = window.__ds.profiler; p.enabled = true; p.snapshot(); window.__ds.sim.play(); });
  await wait(1000);
  const r = await ev(() => new Promise((res) => {
    const p = window.__ds.profiler;
    const t = [], sim = [], steps = [], sys = {}; let last = performance.now();
    p.snapshot();
    const f = (now) => {
      t.push(now - last); last = now;
      const s = p.snapshot();
      sim.push(s.tickMs); steps.push(s.stepsPerTick);
      if (t.length > 30) { for (const [k, v] of Object.entries(s.systems)) sys[k] = (sys[k] ?? 0) + v; sys.physics = (sys.physics ?? 0) + s.physicsMs; }
      if (t.length < 360) requestAnimationFrame(f); else res({ t: t.slice(30), sim: sim.slice(30), steps: steps.slice(30), simT: window.__ds.sim.getTime(), sys });
    };
    requestAnimationFrame(f);
  }));
  const gl = await ev(() => { const g = window.__r3f.get().gl.info; return { calls: g.render.calls, triangles: g.render.triangles, geometries: g.memory.geometries, textures: g.memory.textures }; });
  await ev(() => { window.__ds.sim.pause(); window.__ds.profiler.enabled = false; });
  await ev(() => window.gc?.());
  const heap = await ev(() => +(performance.memory.usedJSHeapSize / 1048576).toFixed(1));
  await ev(() => window.__ds.actions.exitSimulation());
  await wait(800);
  const mean = r.t.reduce((a, b) => a + b, 0) / r.t.length, simMean = r.sim.reduce((a, b) => a + b, 0) / r.sim.length;
  const fpsEach = r.t.map((x) => 1000 / x);
  return {
    scene: name, frames: r.t.length, fps: +(1000 / mean).toFixed(1), fpsP5: q(fpsEach, 0.05), p50: q(r.t, 0.5), p95: q(r.t, 0.95), p99: q(r.t, 0.99), worst: +Math.max(...r.t).toFixed(1),
    longFrames: r.t.filter((x) => x > 50).length, simMsPerFrame: +simMean.toFixed(2), simShare: +(simMean / mean).toFixed(3), stepsPerFrame: +(r.steps.reduce((a, b) => a + b, 0) / r.steps.length).toFixed(2),
    simTimeEnd: +r.simT.toFixed(2), prepMs,
    systemsMsPerFrame: Object.fromEntries(Object.entries(r.sys).map(([k, v]) => [k, +(v / r.t.length).toFixed(2)]).sort((a, b) => b[1] - a[1]).slice(0, 12)), drawCalls: gl.calls, triangles: gl.triangles, geometries: gl.geometries, textures: gl.textures, heapMB: heap, load: os.loadavg().map((v) => +v.toFixed(1)),
  };
}

const rows = [];
for (let k = 0; k < Number(roundsArg); k++) for (const s of scenesArg.split(',')) { const row = await runOnce(s); console.log(JSON.stringify(row)); rows.push(row); }
fs.writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), url, cpus: os.cpus()[0]?.model, rows, errors }, null, 2));
await browser.close();
