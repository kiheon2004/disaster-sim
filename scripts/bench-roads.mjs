// Phase 18 benchmark (production build, real GPU): road networks of 50 / 200 / 500 segments,
// roads + 100 / 500 / 1000 modular buildings, complex intersections, block generation.
// Reports editor / simulation FPS, draw calls, triangles, generation time, edit latency,
// intersection rebuild time, save / load time and size, heap after GC.
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/bench-roads.mjs http://localhost:4173/ [out.json]
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
  window.__fps = (ms) => new Promise((res) => {
    let frames = 0; const t0 = performance.now();
    const f = () => { frames++; if (performance.now() - t0 < ms) requestAnimationFrame(f); else res(+(frames / ((performance.now() - t0) / 1000)).toFixed(1)); };
    requestAnimationFrame(f);
  });
  window.__view = () => { const st = window.__r3f.get(); st.camera.position.set(110, 120, 150); st.controls.target.set(0, 0, 0); st.controls.update(); };
  /** k×k street grid over the world, through the real store (one atomic edit). */
  window.__grid = (k) => {
    const L = window.__ds.roadLib;
    const p = { ...L.defaultProfile(), width: 6, sidewalkWidth: 1.5 };
    let n = window.__ds.world.getState().doc.roads;
    const span = 180, step = span / (k - 1);
    for (let i = 0; i < k; i++) { const c = -span / 2 + i * step; n = L.drawRoad(n, [[-span / 2, c], [span / 2, c]], { curved: false, profile: p }).network; }
    for (let i = 0; i < k; i++) { const c = -span / 2 + i * step; n = L.drawRoad(n, [[c, -span / 2], [c, span / 2]], { curved: false, profile: p }).network; }
    return n;
  };
});

async function heapMB() {
  for (let i = 0; i < 2; i++) { await ev(() => window.gc?.()); await cdp.send('HeapProfiler.collectGarbage'); }
  return ev(() => +(performance.memory.usedJSHeapSize / 1048576).toFixed(1));
}

async function stats() {
  return ev(() => {
    const gl = window.__r3f.get().gl;
    const rb = window.__ds.roadBatches();
    return { drawCalls: gl.info.render.calls, triangles: gl.info.render.triangles, roadDrawCalls: rb?.drawCalls ?? 0, roadTriangles: rb?.triangles ?? 0, roadChunks: rb?.chunkCount ?? 0 };
  });
}

// Machine load (1/5/15 min) at start and end: other processes slow the simulation numbers down.
const results = { loadStart: os.loadavg().map((v) => +v.toFixed(1)), networks: [], city: [], intersections: null, blocks: null };

// ── Road networks 50 / 200 / 500 segments ─────────────────────────────────────────
for (const k of [6, 11, 16]) {
  await ev(() => window.__ds.actions.newProject());
  await ev(() => window.__frames(3));
  const gen = await ev(async (k) => {
    const t0 = performance.now();
    const n = window.__grid(k);
    const t1 = performance.now();
    window.__ds.world.getState().applyEdit({ roads: n });
    const t2 = performance.now();
    window.__view();
    await window.__frames(2);
    const t3 = performance.now();
    return { segments: Object.keys(n.segments).length, networkMs: +(t1 - t0).toFixed(0), bakeCommitMs: +(t2 - t1).toFixed(0), firstRenderMs: +(t3 - t2).toFixed(0), meshMs: +window.__ds.roadStats.lastMeshMs.toFixed(1) };
  }, k);
  const fps = await ev(() => window.__fps(3000));
  const st = await stats();
  // Edit latency: move an interior node 3 m (network op + bake + links + render of the next frame).
  const edit = await ev(async () => {
    const out = [];
    for (let rep = 0; rep < 5; rep++) {
      const n = window.__ds.world.getState().doc.roads;
      const node = Object.values(n.nodes).find((x) => Math.abs(x.x) < 40 && Math.abs(x.z) < 40);
      const t0 = performance.now();
      window.__ds.roadActions.moveRoadNode(node.id, node.x + (rep % 2 ? -3 : 3), node.z);
      const t1 = performance.now();
      await window.__frames(1);
      out.push({ commit: t1 - t0, frame: performance.now() - t0, bake: window.__ds.roadStats.lastBakeMs, mesh: window.__ds.roadStats.lastMeshMs });
    }
    const med = (k) => +out.map((o) => o[k]).sort((a, b) => a - b)[2].toFixed(1);
    const n = window.__ds.world.getState().doc.roads;
    const L = window.__ds.roadLib;
    const t0 = performance.now();
    const fresh = { ...n, segments: { ...n.segments } };
    L.intersectionsOf(fresh);
    const intersectionsMs = +(performance.now() - t0).toFixed(1);
    return { commitMs: med('commit'), toFrameMs: med('frame'), bakeMs: med('bake'), meshMs: med('mesh'), intersectionsMs };
  });
  const save = await ev(() => {
    const L = window.__ds.buildLib;
    const t0 = performance.now();
    const json = L.serializeDocument(window.__ds.world.getState().doc, false);
    const t1 = performance.now();
    const res = L.parseDocument(json);
    const t2 = performance.now();
    return { saveMs: +(t1 - t0).toFixed(0), loadParseMs: +(t2 - t1).toFixed(0), fileKB: Math.round(json.length / 1024), ok: res.ok };
  });
  const heap = await heapMB();
  const row = { segments: gen.segments, ...gen, editorFps: fps, ...st, ...edit, ...save, heapMB: heap };
  console.log('network', JSON.stringify(row));
  results.networks.push(row);
}

// ── Complex intersections: 6-way junction + acute angles ─────────────────────────
await ev(() => window.__ds.actions.newProject());
results.intersections = await ev(async () => {
  const L = window.__ds.roadLib;
  let n = window.__ds.world.getState().doc.roads;
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3 + 0.1;
    n = L.drawRoad(n, [[0, 0], [Math.cos(a) * 70, Math.sin(a) * 70]], { curved: false, profile: L.defaultProfile() }).network;
  }
  // Two roads crossing at a very acute angle (≈ 11°) away from the radial ones.
  n = L.drawRoad(n, [[-80, -80], [80, -70]], { curved: false, profile: L.defaultProfile() }).network;
  n = L.drawRoad(n, [[-80, -62], [80, -82]], { curved: false, profile: L.defaultProfile() }).network;
  const t0 = performance.now();
  window.__ds.world.getState().applyEdit({ roads: n });
  const t1 = performance.now();
  await window.__frames(2);
  const ints = [...L.intersectionsOf(n).values()];
  return { commitMs: +(t1 - t0).toFixed(0), maxDegree: Math.max(...ints.map((i) => i.roads.length)), warnings: ints.flatMap((i) => i.warnings), network: L.networkWarnings(n).map((w) => w.code) };
});
console.log('intersections', JSON.stringify(results.intersections));

// ── Roads + 100 / 500 / 1000 modular buildings (editor + simulation) ──────────────
for (const count of [100, 500, 1000]) {
  await ev(() => window.__ds.actions.newProject());
  const gen = await ev(async (count) => {
    const L = window.__ds.roadLib;
    const B = window.__ds.buildingLib;
    const ws = window.__ds.world.getState();
    const t0 = performance.now();
    // Two avenues crossing at the center (4 segments, one 4-way junction) + a ring road.
    let n = window.__ds.world.getState().doc.roads;
    const P = L.defaultProfile();
    n = L.drawRoad(n, [[-96, 0], [96, 0]], { curved: false, profile: P }).network;
    n = L.drawRoad(n, [[0, -96], [0, 96]], { curved: false, profile: P }).network;
    ws.applyEdit({ roads: n });
    const t1 = performance.now();
    // Small modular houses (one shared design) packed into the four quarters, never on roads.
    const design = B.createDesign({ ...B.presetSpec('house'), floors: 2, width: 5, depth: 4 }, 'house');
    const roads = window.__ds.world.getState().doc.roads;
    const inputs = [];
    for (let z = -96; z <= 96 && inputs.length < count; z += 5) {
      for (let x = -96; x <= 96 && inputs.length < count; x += 6) {
        if (L.footprintOnRoad(roads, { x, z, hx: 2.5, hz: 2, yaw: 0 }, 0.5)) continue;
        inputs.push({ type: 'building', building: design, seed: inputs.length + 1, transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] } });
      }
    }
    ws.applyEdit({ add: inputs });
    const t2 = performance.now();
    window.__view();
    await window.__frames(3);
    return { buildings: inputs.length, roadsMs: +(t1 - t0).toFixed(0), buildingsMs: +(t2 - t1).toFixed(0), firstRenderMs: +(performance.now() - t2).toFixed(0) };
  }, count);
  // City-building cost measured separately (Phase 17 residual C): street furniture + vehicles.
  const city = await ev(async () => {
    const t0 = performance.now();
    window.__ds.roadActions.addInfrastructure([], 'streetLight', 'both', 25, 1);
    const t1 = performance.now();
    window.__ds.roadActions.addVehiclesAlong([], 'parked', 20, 1);
    const t2 = performance.now();
    await window.__frames(2);
    const objs = Object.values(window.__ds.world.getState().doc.objects);
    return { infraMs: +(t1 - t0).toFixed(0), vehiclesMs: +(t2 - t1).toFixed(0), lights: objs.filter((o) => o.type === 'streetLight').length, cars: objs.filter((o) => o.type === 'car').length };
  });
  const editorFps = await ev(() => window.__fps(3000));
  const st = await stats();
  const heap = await heapMB();
  const save = await ev(() => {
    const L = window.__ds.buildLib;
    const t0 = performance.now();
    const json = L.serializeDocument(window.__ds.world.getState().doc, false);
    const t1 = performance.now();
    const res = L.parseDocument(json);
    const t2 = performance.now();
    window.__ds.world.getState().replaceDocument(res.doc);
    return { saveMs: +(t1 - t0).toFixed(0), loadMs: +(t2 - t1).toFixed(0), fileMB: +(json.length / 1048576).toFixed(2) };
  });
  // Simulation: earthquake 0.5 g + wind 30 m/s, 5 s measured after load.
  const sim = await ev(async () => {
    const t0 = performance.now();
    await window.__ds.actions.runSimulation([{ event: 'earthquake', magnitude: 6.8, pga: 0.5, duration: 20, seed: 2 }, { event: 'wind', speed: 30, direction: 'E', duration: 30, gustStrength: 0.25, rampDuration: 2 }]);
    const loadMs = performance.now() - t0;
    const simT0 = window.__ds.sim.getTime();
    const fps = await window.__fps(5000);
    const simRate = (window.__ds.sim.getTime() - simT0) / 5;
    const roads = window.__ds.sim.getRuntime().roads?.summary();
    window.__ds.actions.exitSimulation();
    await window.__frames(2);
    return { simLoadMs: +loadMs.toFixed(0), simFps: fps, simSpeed: +simRate.toFixed(2), roadsCracked: roads?.cracked ?? 0 };
  });
  const row = { ...gen, ...city, editorFps, ...st, heapMB: heap, ...save, ...sim };
  console.log('city', JSON.stringify(row));
  results.city.push(row);
}

// ── Block generation: zoned 5×5 grid filled ───────────────────────────────────────
await ev(() => window.__ds.actions.newProject());
results.blocks = await ev(async () => {
  const L = window.__ds.roadLib;
  const ws = window.__ds.world.getState();
  ws.applyEdit({ roads: window.__grid(6) });
  let n = window.__ds.world.getState().doc.roads;
  const t0 = performance.now();
  const blocks = L.blocksOf({ ...n, segments: { ...n.segments } });
  const detectMs = performance.now() - t0;
  const zones = ['residential', 'commercial', 'industrial', 'park', 'mixed'];
  blocks.forEach((b, i) => { n = { ...n, zones: { ...n.zones, [b.id]: zones[i % 5] } }; });
  ws.applyEdit({ roads: n });
  const t1 = performance.now();
  window.__ds.roadActions.fillBlocks([], 7, 1);
  const t2 = performance.now();
  await window.__frames(3);
  const objs = Object.values(window.__ds.world.getState().doc.objects);
  return { blocks: blocks.length, detectMs: +detectMs.toFixed(1), fillMs: +(t2 - t1).toFixed(0), buildings: objs.filter((o) => o.type === 'building').length, trees: objs.filter((o) => o.type === 'tree').length, designs: new Set(objs.map((o) => o.building).filter(Boolean)).size };
});
results.blocks.editorFps = await ev(() => window.__fps(3000));
Object.assign(results.blocks, await stats());
console.log('blocks', JSON.stringify(results.blocks));

results.loadEnd = os.loadavg().map((v) => +v.toFixed(1));
if (outFile) fs.writeFileSync(outFile, JSON.stringify({ url, date: new Date().toISOString(), ...results }, null, 2));
await browser.close();
