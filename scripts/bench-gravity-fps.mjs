// Phase 31: browser frame times of gravity scenes — the same world, camera, viewport and simulated time with and without
// the gravity experiment (and, run against the Phase 30 build, the same world there: the experiment is dropped when the
// build has no 'gravity' phenomenon). p50 / p95 / p99, gravity ms per frame, draw calls, heap, GPU geometries / textures.
//   node scripts/bench-gravity-fps.mjs http://localhost:4199/ out.json [rounds=2]
import fs from 'node:fs';
import os from 'node:os';
import puppeteer from 'puppeteer-core';

const [url = 'http://localhost:4199/', out = 'fps.json', roundsArg = '2'] = process.argv.slice(2);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,1000', '--enable-precise-memory-info', '--js-flags=--expose-gc'], defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 }, protocolTimeout: 3_600_000 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
await page.goto(url + '?devtools', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('ds.hazardTab', 'experiment'); localStorage.setItem('ds.bottomHeight', '420'); });
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2); };
const HAS = await ev(() => !!window.__ds.gravityLib);

const SCENES = {
  // 1000 houses under a 2.5 g ramp (every building's structural model re-loaded).
  town: () => {
    const ds = window.__ds;
    const d = ds.buildingLib.createDesign(ds.buildingLib.presetSpec('house'), 'house');
    const add = [];
    for (let z = -94; z <= 94 && add.length < 1000; z += 6) for (let x = -94; x <= 94 && add.length < 1000; x += 6) add.push({ type: 'building', building: d, seed: add.length + 1, transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] } });
    ds.world.getState().applyEdit({ add });
    return { event: 'gravity', scenario: 'ramp', global: true, magnitude: 24.5, direction: [0, -1, 0], transition: 'vector', profile: 'linear', ramp: 20, duration: 600, end: 'hold', sources: [] };
  },
  // 500 dynamic bodies falling at Moon-like gravity with a local well.
  bodies: () => {
    const ds = window.__ds;
    const add = [];
    for (let k = 0; k < 500; k++) { const x = -90 + (k % 23) * 8, z = -90 + Math.floor(k / 23) * 8; add.push(k % 2 ? { type: 'human', seed: 1000 + k, transform: { position: [x, 2, z], rotation: [0, 0, 0], scale: [1, 1, 1] } } : { type: 'car', seed: 1000 + k, transform: { position: [x, 2, z], rotation: [0, 0, 0], scale: [1, 1, 1] } }); }
    ds.world.getState().applyEdit({ add });
    return { event: 'gravity', scenario: 'well', global: true, magnitude: 1.62, direction: [0, -1, 0], transition: 'vector', profile: 'smooth', ramp: 3, duration: 600, end: 'hold', sources: [{ kind: 'radial', center: [0, 2, 0], radius: 40, falloff: 'smooth', edge: 10, strength: 15, r0: 6, law: 'inverseSquare', softening: 4, followProfile: true }] };
  },
};

async function runOnce(scene, withGravity) {
  await ev(() => window.__ds.actions.newProject());
  const spec = await ev((s) => (0, eval)(`(${s})`)(), SCENES[scene].toString());
  if (withGravity && HAS) await ev((spec) => window.__ds.actions.addPhenomenon('gravity', spec), spec);
  else await ev(() => window.__ds.actions.addPhenomenon('wind', { event: 'wind', speed: 0.5, direction: 'E', duration: 600 }));
  await wait(1500);
  await ev(() => { for (const b of document.querySelectorAll('button')) if (/^\s*실험 실행|Run experiment/.test(b.textContent ?? '') && !b.disabled) { b.click(); return; } });
  await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status === 'running', { timeout: 300_000 });
  await ev(() => { const s = window.__ds.sim; s.pause(); s.advance(30 - s.getTime()); });
  await ev(() => { const st = window.__r3f.get(); st.camera.position.set(45, 90, 110); st.controls.target.set(0, 0, 0); st.controls.update(); window.__ds.sim.play(); });
  await wait(1500);
  const r = await ev(() => new Promise((res) => {
    const t = [], gms = []; let last = performance.now();
    const f = (now) => { t.push(now - last); last = now; gms.push(window.__ds.simStore.getState().gravity?.ms ?? 0); if (t.length < 600) requestAnimationFrame(f); else res({ t: t.slice(30), gms: gms.slice(30) }); };
    requestAnimationFrame(f);
  }));
  const gl = await ev(() => { const g = window.__r3f.get().gl.info; return { calls: g.render.calls, geometries: g.memory.geometries, textures: g.memory.textures }; });
  await ev(() => window.gc?.());
  const heap = await ev(() => +(performance.memory.usedJSHeapSize / 1048576).toFixed(1));
  await ev(() => window.__ds.actions.exitSimulation());
  await wait(800);
  const mean = r.t.reduce((a, b) => a + b, 0) / r.t.length;
  return { scene, gravity: withGravity && HAS, build: HAS ? 'phase31' : 'phase30', frames: r.t.length, fps: +(1000 / mean).toFixed(1), p50: q(r.t, 0.5), p95: q(r.t, 0.95), p99: q(r.t, 0.99), worst: +Math.max(...r.t).toFixed(1), gravityMsMean: +(r.gms.reduce((a, b) => a + b, 0) / r.gms.length).toFixed(3), drawCalls: gl.calls, geometries: gl.geometries, textures: gl.textures, heapMB: heap, load: os.loadavg().map((v) => +v.toFixed(1)) };
}

const rows = [];
for (let k = 0; k < Number(roundsArg); k++) for (const scene of Object.keys(SCENES)) for (const g of HAS ? [true, false] : [false]) { const row = await runOnce(scene, g); console.log(JSON.stringify(row)); rows.push(row); }
fs.writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), cpus: os.cpus()[0]?.model, rows, errors }, null, 2));
await browser.close();
