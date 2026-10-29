// Phase 17 benchmark (production build, real GPU): legacy vs modular buildings at 100 / 500 / 1000,
// one complex modular building, and a mixed mid-size city. Editor and simulation are reported
// separately. Every scene records the machine's load average — scenes run interleaved in one
// browser so legacy / modular comparisons see the same conditions.
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/bench-buildings.mjs http://localhost:4173/ [out.json] [counts=100,500,1000]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';

const [url = 'http://localhost:4173/', outFile, countsArg = '100,500,1000'] = process.argv.slice(2);
const counts = countsArg.split(',').map(Number);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,900', '--enable-precise-memory-info', '--js-flags=--expose-gc'],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 }, protocolTimeout: 1_800_000,
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function gcTrace(page, ms) {
  await page.tracing.start({ categories: ['devtools.timeline', 'v8', 'disabled-by-default-devtools.timeline'] });
  await wait(ms);
  const buf = await page.tracing.stop();
  const ev = JSON.parse(Buffer.from(buf).toString()).traceEvents;
  const mains = ev.filter((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
  const score = (m) => ev.filter((e) => e.pid === m.pid && e.tid === m.tid && e.name === 'FireAnimationFrame').length;
  const main = mains.sort((a, b) => score(b) - score(a))[0];
  const evs = ev.filter((e) => e.pid === main.pid && e.tid === main.tid && e.ph === 'X');
  const gc = evs.filter((e) => /GC/.test(e.name) && !/Allocation/.test(e.name)).reduce((a, e) => a + e.dur / 1000, 0);
  return +(gc / (ms / 1000)).toFixed(1);
}

async function newPage(attempt = 0) {
  let page;
  try {
    page = await browser.newPage();
    await wait(200);
  } catch (e) {
    if (attempt > 3) throw e;
    await wait(2000);
    return newPage(attempt + 1);
  }
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(url + '?devtools', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__ds && window.__r3f);
  await page.evaluate(() => {
    window.__frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    window.__fps = async (ms) => {
      const st = window.__r3f.get();
      const gl = st.gl;
      let frames = 0, calls = 0, tris = 0, renders = 0, run = true;
      const o = gl.render;
      gl.render = function (...a) { gl.info.reset(); o.apply(this, a); calls += gl.info.render.calls; tris += gl.info.render.triangles; renders++; };
      const loop = () => { if (run) { frames++; requestAnimationFrame(loop); } };
      const t0 = performance.now();
      requestAnimationFrame(loop);
      await new Promise((r) => setTimeout(r, ms));
      run = false;
      gl.render = o;
      return { fps: +((frames * 1000) / (performance.now() - t0)).toFixed(1), drawCalls: Math.round(calls / Math.max(1, renders)), trianglesK: Math.round(tris / Math.max(1, renders) / 1000), subscribers: st.internal.subscribers.length };
    };
    const s = window.__r3f.get();
    s.camera.position.set(60, 70, 110);
    s.controls.target.set(0, 0, 0);
    s.controls.update();
  });
  return page;
}

/** Build a scene in the page; returns the load time (ms, incl. the frames to show it). */
const SCENE = String((kind, n) => {
  const ds = window.__ds;
  const L = ds.buildingLib;
  const doc = ds.buildLib.createEmptyDocument(`${kind} ${n}`);
  ds.world.getState().replaceDocument(doc);
  const inputs = [];
  const T = (x, z) => ({ position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] });
  // Two building kinds, equivalent in size: a 2-story timber house and a 4-story RC block.
  const house = L.createDesign({ ...L.presetSpec('house') }, 'house');
  const block = L.createDesign({ ...L.presetSpec('apartment'), width: 12, depth: 10, floors: 4, floorHeight: 3.2, groundFloorHeight: 3.2, core: false }, 'apartment');
  const legacy = [{ floors: 2, width: 8, depth: 7, floorHeight: 2.85, sign: false, rooftopUnits: 1 }, { floors: 4, width: 12, depth: 10, floorHeight: 3.2, sign: false, rooftopUnits: 2 }];
  if (kind === 'legacy' || kind === 'modular') {
    const side = Math.ceil(Math.sqrt(n));
    const pitch = 190 / side;
    for (let i = 0; i < n; i++) {
      const x = -95 + pitch * ((i % side) + 0.5);
      const z = -95 + pitch * (Math.floor(i / side) + 0.5);
      inputs.push(kind === 'legacy' ? { type: 'building', params: legacy[i % 2], seed: i + 1, transform: T(x, z) } : { type: 'building', building: i % 2 ? block : house, seed: i + 1, transform: T(x, z) });
    }
  } else if (kind === 'complex') {
    inputs.push({ type: 'building', building: L.createDesign({ ...L.presetSpec('tower'), floors: 40, floorHeight: 3.4, width: 42, depth: 42, bay: 6 }), seed: 1, transform: T(0, 0) });
  } else if (kind === 'city' || kind === 'cityLegacy') {
    // Same layout either way: 600 stress-scene objects (people, cars, trees, poles …) + 30
    // buildings of five kinds + one tower — modular, or legacy boxes of the same size.
    const stress = ds.buildLib.stressScene(600).filter((o) => o.type !== 'building');
    inputs.push(...stress);
    const kinds = ['house', 'apartment', 'office', 'warehouse', 'industrial'];
    const designs = Object.fromEntries([...kinds, 'tower'].map((k) => [k, L.createDesign(L.presetSpec(k), k)]));
    const put = (k, seed, x, z) => {
      const d = designs[k];
      if (kind === 'city') inputs.push({ type: 'building', building: d, seed, transform: T(x, z) });
      else {
        const p = L.deriveFields(d, seed).params;
        inputs.push({ type: 'building', params: { floors: p.floors, width: p.width, depth: p.depth, floorHeight: p.floorHeight, color: p.color, sign: false, rooftopUnits: p.rooftopUnits }, seed, transform: T(x, z) });
      }
    };
    let i = 0;
    for (let gx = -80; gx <= 80; gx += 40) for (let gz = -80; gz <= 80; gz += 32) put(kinds[i++ % kinds.length], i, gx, gz);
    put('tower', 99, 0, 0);
  }
  return inputs;
});

async function scene(page, kind, n) {
  return page.evaluate(async (src, kind, n) => {
    const build = eval(`(${src})`);
    const t0 = performance.now();
    const inputs = build(kind, n);
    const t1 = performance.now();
    window.__ds.world.getState().applyEdit({ add: inputs });
    const t2 = performance.now();
    await window.__frames();
    const objs = Object.values(window.__ds.world.getState().doc.objects);
    return {
      objects: objs.length,
      buildings: objs.filter((o) => o.type === 'building').length,
      members: objs.reduce((t, o) => t + (o.building?.members.length ?? 0), 0),
      designMs: +(t1 - t0).toFixed(0),
      commitMs: +(t2 - t1).toFixed(0),
      loadMs: +(performance.now() - t0).toFixed(0),
    };
  }, SCENE, kind, n);
}

const heap = (page) => page.evaluate(() => +(performance.memory.usedJSHeapSize / 1048576).toFixed(1));
const collect = async (page) => { await page.evaluate(() => window.gc?.()); await wait(300); };

async function measure(kind, n) {
  const page = await newPage();
  const row = { kind, n, load: os.loadavg().map((v) => +v.toFixed(1)) };
  Object.assign(row, await scene(page, kind, n));
  await wait(1200);
  await collect(page);
  row.heapMB = await heap(page);
  row.editor = await page.evaluate(() => window.__fps(3000));
  row.editorGcMsPerS = await gcTrace(page, 2000);
  // Building generation / analysis per building (pure, in the page).
  row.generation = await page.evaluate((kind) => {
    const L = window.__ds.buildingLib;
    const spec = kind === 'complex' ? { ...L.presetSpec('tower'), floors: 40, floorHeight: 3.4, width: 42, depth: 42, bay: 6 } : L.presetSpec('apartment');
    const t0 = performance.now();
    const d = L.createDesign(spec);
    const t1 = performance.now();
    const a = L.analyzeBuilding(d);
    const t2 = performance.now();
    L.deriveFields(d, 1);
    const t3 = performance.now();
    return { members: d.members.length, generateMs: +(t1 - t0).toFixed(1), analyzeMs: +(t2 - t1).toFixed(1), deriveMs: +(t3 - t2).toFixed(1), unsupported: a.unsupported.length };
  }, kind);
  // Select one building (React view + gizmo), and an edit (add floor) on it.
  row.select = await page.evaluate(async () => {
    const o = Object.values(window.__ds.world.getState().doc.objects).find((x) => x.type === 'building');
    const t0 = performance.now();
    window.__ds.editor.getState().select(o.id);
    await window.__frames();
    const selectMs = +(performance.now() - t0).toFixed(0);
    let addFloorMs = null;
    if (o.building) {
      const t1 = performance.now();
      const ok = o.building.spec.floors < 40 ? window.__ds.buildingActions.addFloorTo(o.id) : window.__ds.buildingActions.removeFloorFrom(o.id);
      await window.__frames();
      addFloorMs = +(performance.now() - t1).toFixed(0);
      if (ok) window.__ds.world.getState().undo();
    }
    window.__ds.editor.getState().select(null);
    await window.__frames();
    return { selectMs, addFloorMs };
  });
  // Save / load.
  Object.assign(row, await page.evaluate(async () => {
    const L = window.__ds.buildLib;
    const doc = window.__ds.world.getState().doc;
    let t0 = performance.now();
    const json = L.serializeDocument(doc, false);
    const saveMs = performance.now() - t0;
    t0 = performance.now();
    const res = L.parseDocument(json);
    const parseMs = performance.now() - t0;
    window.__ds.world.getState().replaceDocument(res.doc);
    await window.__frames();
    return { saveMs: +saveMs.toFixed(0), loadMs2: +(performance.now() - t0).toFixed(0), parseMs: +parseMs.toFixed(0), fileKB: Math.round(json.length / 1024) };
  }));
  // Simulation: earthquake (structural model, member damage) + moderate wind.
  await page.evaluate(() => window.__ds.profiler.enabled = true);
  const t0 = Date.now();
  await page.evaluate(() => window.__ds.actions.runSimulation([{ event: 'earthquake', magnitude: 6.8, pga: 0.5, duration: 20, seed: 3 }, { event: 'wind', speed: 30, direction: 'E', duration: 40 }]));
  await page.waitForFunction(() => window.__ds.simStore.getState().status === 'running', { timeout: 300_000 });
  row.simLoadMs = Date.now() - t0;
  await wait(1500);
  await page.evaluate(() => window.__ds.profiler.snapshot());
  row.sim = await page.evaluate(() => window.__fps(5000));
  const p = await page.evaluate(() => window.__ds.profiler.snapshot());
  row.simProfile = {
    tickMs: +p.tickMs.toFixed(2), physicsMs: +p.physicsMs.toFixed(2), stepsPerTick: +p.stepsPerTick.toFixed(2), simSpeed: +p.simSpeed.toFixed(2),
    structuralMs: +(p.systems.structural ?? 0).toFixed(2), seismicDamageMs: +(p.systems.seismicDamage ?? 0).toFixed(2), damageMs: +(p.systems.damage ?? 0).toFixed(2), windMs: +(p.systems.windForce ?? 0).toFixed(2),
  };
  row.simGcMsPerS = await gcTrace(page, 2000);
  await collect(page);
  row.simHeapMB = await heap(page);
  row.simEvents = await page.evaluate(() => {
    const ev = window.__ds.sim.getDamageEvents();
    return { total: ev.length, failed: ev.filter((e) => e.eventType === 'FAILED').length, collapsed: ev.filter((e) => e.eventType === 'COLLAPSED' || e.eventType === 'STORY_COLLAPSED').length };
  });
  await page.evaluate(() => window.__ds.actions.exitSimulation());
  await page.close();
  console.log(JSON.stringify(row));
  return row;
}

const results = [];
for (const n of counts) {
  results.push(await measure('legacy', n));
  results.push(await measure('modular', n));
}
results.push(await measure('complex', 1));
results.push(await measure('cityLegacy', 1));
results.push(await measure('city', 1));
if (outFile) fs.writeFileSync(outFile, JSON.stringify({ url, date: new Date().toISOString(), cpus: os.cpus().length, results }, null, 2));
await browser.close();
