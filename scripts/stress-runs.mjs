// Long-running resource check (Phase 23, Phase 22 residual 2.1 — a browser tab closed once during
// a long verification run). Cycles heavy experiments through run → reset → re-run → exit and,
// after a forced GC at the end of every cycle, records:
//   JS heap (CDP), DOM nodes and JS event listeners (CDP Performance metrics), three.js
//   geometries / textures / shader programs (renderer.info), live Rapier worlds (created − freed),
//   and the resident memory of every Chrome process (renderer, GPU, browser) from `ps`.
// A leak shows as a steady rise across cycles; one-time caches show as a step that flattens.
//
//   npm run build && npx vite preview --port 4191 --strictPort &
//   node scripts/stress-runs.mjs http://localhost:4191/ [cycles] [out.json]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';

const [url = 'http://localhost:4191/', cyclesArg = '12', outFile] = process.argv.slice(2);
const CYCLES = Number(cyclesArg);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,1000', '--enable-precise-memory-info', '--js-flags=--expose-gc'],
  defaultViewport: { width: 1600, height: 1000 }, protocolTimeout: 1_800_000,
});
const errors = [];
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', (d) => d.accept());
let crashed = false;
page.on('error', (e) => { crashed = true; errors.push(`CRASH ${e.message}`); });
await page.goto(url + '?devtools', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
const cdp = await page.createCDPSession();
await cdp.send('Performance.enable');
const ev = (fn, ...a) => page.evaluate(fn, ...a);

/** RSS (MB) of the Chrome process tree started by puppeteer, by process type. */
function chromeRss() {
  const root = browser.process()?.pid;
  if (!root) return null;
  const rows = execSync('ps -Ao pid=,ppid=,rss=,command=').toString().trim().split('\n').map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return m ? { pid: +m[1], ppid: +m[2], rss: +m[3], cmd: m[4] } : null;
  }).filter(Boolean);
  const tree = new Set([root]);
  for (let changed = true; changed;) { changed = false; for (const r of rows) if (!tree.has(r.pid) && tree.has(r.ppid)) { tree.add(r.pid); changed = true; } }
  const out = { renderer: 0, gpu: 0, browser: 0, other: 0 };
  for (const r of rows) {
    if (!tree.has(r.pid)) continue;
    const kind = /--type=renderer/.test(r.cmd) ? 'renderer' : /--type=gpu-process/.test(r.cmd) ? 'gpu' : r.pid === root ? 'browser' : 'other';
    out[kind] += r.rss / 1024;
  }
  for (const k of Object.keys(out)) out[k] = +out[k].toFixed(0);
  return out;
}

async function measure(cycle, label) {
  for (let i = 0; i < 3; i++) { await ev(() => window.gc?.()); await cdp.send('HeapProfiler.collectGarbage'); }
  const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
  const three = await ev(() => { const gl = window.__r3f.get().gl; return { geometries: gl.info.memory.geometries, textures: gl.info.memory.textures, programs: gl.info.programs?.length ?? 0 }; });
  const rapier = await ev(() => ({ ...window.__ds.deformLib.rapierWorlds }));
  const row = { cycle, label, heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), nodes: m.Nodes, listeners: m.JSEventListeners, ...three, rapierLive: rapier.live, rapierCreated: rapier.created, rss: chromeRss(), load: +os.loadavg()[0].toFixed(1) };
  console.log(JSON.stringify(row));
  return row;
}

const SCENARIOS = {
  sinkholeTown: () => {
    const ds = window.__ds, L = ds.roadLib, d = L.presetDesign('house', 1), add = [];
    for (let z = -40; z <= 40; z += 10) for (let x = -40; x <= 40; x += 10) add.push({ type: 'building', building: d, seed: add.length + 1, transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] } });
    for (let k = 0; k < 10; k++) add.push({ type: 'car', seed: 100 + k, transform: { position: [-45 + k * 9, 0, 45], rotation: [0, 0, 0], scale: [1, 1, 1] } });
    ds.world.getState().applyEdit({ add });
    ds.world.getState().applyEdit({ roads: L.drawRoad(ds.world.getState().doc.roads, [[-90, 5], [90, 5]], { curved: false, profile: L.defaultProfile() }).network });
    ds.actions.addPhenomenon('sinkhole', { event: 'sinkhole', center: [0, 0], cavityRadius: 5, cavityHeight: 8, cover: 5, initiation: 'supportLoss', supportLoss: 0.9, duration: 2 });
  },
  landslideRain: () => {
    const ds = window.__ds, S = ds.world.getState(), t0 = S.doc.terrain, heights = new Float32Array(t0.heights.length), tb = Math.tan((32 * Math.PI) / 180);
    for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) { const x = t0.originX + ix * t0.cellSize; heights[iz * t0.nx + ix] = x < 0 ? Math.min(90, -x) * tb : 0; }
    S.applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length) } } });
    ds.actions.addPhenomenon('rain', { ...ds.deformLib.phenomena.implemented('rain').defaults(), intensity: 100, duration: 60 });
    ds.actions.addPhenomenon('landslide', { event: 'landslide', area: { kind: 'circle', center: [-30, 0], radius: 20 }, thickness: 2, saturation: 1, trigger: 'user', duration: 0 });
  },
  allHazards: () => {
    const ds = window.__ds;
    ds.world.getState().replaceDocument(ds.blueprintLib.buildTemplate('mountainVillage', 3));
    ds.actions.addPhenomenon('earthquake', { ...ds.deformLib.phenomena.implemented('earthquake').defaults(), magnitude: 6.5, duration: 10 });
    ds.actions.addPhenomenon('rain', { ...ds.deformLib.phenomena.implemented('rain').defaults(), intensity: 80, duration: 60 });
    ds.actions.addPhenomenon('terrainDeformation', { event: 'terrainDeformation', kind: 'subsidence', center: [20, 20], radius: 25, amount: 1.5, duration: 4, profile: 'smooth', falloff: 'smooth' });
    ds.actions.addPhenomenon('sinkhole', { event: 'sinkhole', center: [-20, -20], cavityRadius: 4, cavityHeight: 8, cover: 5, initiation: 'supportLoss', supportLoss: 0.9, duration: 2 });
  },
};

async function runTo(t) {
  await page.waitForFunction((t) => window.__ds.sim.getTime() >= t || window.__ds.simStore.getState().status === 'finished', { timeout: 300_000, polling: 200 }, t);
}

const rows = [await measure(0, 'start')];
const names = Object.keys(SCENARIOS);
for (let c = 1; c <= CYCLES && !crashed; c++) {
  const name = names[(c - 1) % names.length];
  try {
    await ev((src) => { window.__ds.actions.newProject(); (0, eval)(`(${src})`)(); }, SCENARIOS[name].toString());
    await ev(() => window.__ds.actions.runExperiment());
    await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status === 'running', { timeout: 60_000 });
    await runTo(15);
    await ev(() => window.__ds.actions.resetSimulation());
    await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status !== 'loading', { timeout: 60_000 });
    await ev(() => window.__ds.sim.play?.());
    await runTo(6);
    await ev(() => window.__ds.actions.exitSimulation());
    await new Promise((r) => setTimeout(r, 500));
    rows.push(await measure(c, name));
  } catch (e) {
    errors.push(`cycle ${c} ${name}: ${e.message}`);
    console.log('ERROR', c, name, e.message);
    if (/Target closed|Session closed/.test(e.message)) { crashed = true; break; }
  }
}
const out = { date: new Date().toISOString(), url, cycles: CYCLES, crashed, errors: errors.slice(0, 20), rows };
if (outFile) fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ crashed, errors: errors.length }));
await browser.close();
