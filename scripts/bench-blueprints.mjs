// Phase 20 benchmark (production build, real GPU): blueprints in the editor.
//   scenes: buildings 100 / 500 / 1000, roads + buildings, nature (mountain + river + forest),
//   city + nature, repeated placement of one blueprint, large undo / redo.
//   metrics: preview FPS (ghost moved every frame), preview draw calls, plan (validation) ms,
//   placement ms (commit → next frame), editor FPS after placement, undo / redo ms (→ frame),
//   terrain merge (terrain-only placement) and road rebuild ms, world save / load ms, file
//   sizes, heap after GC, heap growth over repeated placements, machine load.
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/bench-blueprints.mjs http://localhost:4173/ [out.json]
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
  window.__fps = (ms, each) => new Promise((res) => { let frames = 0; const t0 = performance.now(); const f = () => { frames++; each?.(frames, performance.now() - t0); if (performance.now() - t0 < ms) requestAnimationFrame(f); else res(+(frames / ((performance.now() - t0) / 1000)).toFixed(1)); }; requestAnimationFrame(f); });
  window.__view = () => { const st = window.__r3f.get(); st.camera.position.set(110, 120, 150); st.controls.target.set(0, 0, 0); st.controls.update(); };
  const ds = window.__ds;
  /** Source scenes (same generators as src/bench/blueprints.bench.test.ts). */
  window.__source = (kind, n) => {
    const ws = ds.world.getState();
    ds.actions.newProject();
    const L = ds.roadLib;
    if (kind === 'buildings' || kind === 'roadsBuildings') {
      if (kind === 'roadsBuildings') {
        let net = ds.world.getState().doc.roads;
        net = L.drawRoad(net, [[-96, 0], [96, 0]], { curved: false, profile: L.defaultProfile() }).network;
        net = L.drawRoad(net, [[0, -96], [0, 96]], { curved: false, profile: L.defaultProfile() }).network;
        ds.world.getState().applyEdit({ roads: net });
      }
      const designs = [L.presetDesign('house', 2), L.presetDesign('house', 1), L.presetDesign('apartment', 4)];
      const step = n <= 100 ? 16 : n <= 500 ? 8.5 : 6;
      const inputs = [];
      for (let z = -94; z <= 94 && inputs.length < n; z += step) for (let x = -94; x <= 94 && inputs.length < n; x += step) {
        if (kind === 'roadsBuildings' && (Math.abs(x) < 8 || Math.abs(z) < 8)) continue;
        inputs.push({ type: 'building', building: n > 100 ? designs[1] : designs[inputs.length % 3], seed: inputs.length + 1, transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] } });
      }
      ds.world.getState().applyEdit({ add: inputs });
      return ds.blueprintLib.captureBlueprint(ds.world.getState().doc, { shape: { kind: 'rect', x0: -99, z0: -99, x1: 99, z1: 99 } }, { roads: 'clip' }).blueprint;
    }
    const tpl = kind === 'nature' ? ds.blueprintLib.buildTemplate('mountainVillage', 2) : ds.blueprintLib.buildTemplate('riverValley', 3);
    ws.replaceDocument(tpl);
    const r = kind === 'nature' ? [-99, -99, 99, 40] : [-99, -99, 99, 99];
    return ds.blueprintLib.captureBlueprint(ds.world.getState().doc, { shape: { kind: 'rect', x0: r[0], z0: r[1], x1: r[2], z1: r[3] } }, { roads: 'clip', nature: 'clip' }).blueprint;
  };
});
async function heapMB() {
  for (let i = 0; i < 2; i++) { await ev(() => window.gc?.()); await cdp.send('HeapProfiler.collectGarbage'); }
  return ev(() => +(performance.memory.usedJSHeapSize / 1048576).toFixed(1));
}
const stats = () => ev(() => { const gl = window.__r3f.get().gl; return { drawCalls: gl.info.render.calls, trianglesK: Math.round(gl.info.render.triangles / 1000) }; });

async function scene(name, kind, n, opts) {
  const row = { scene: name };
  // Source → blueprint (saved to the library like the UI does).
  Object.assign(row, await ev(async (kind, n) => {
    window.__source(kind, n);
    const area = kind === 'nature' ? [-99, -99, 99, 40] : [-99, -99, 99, 99];
    const t0 = performance.now();
    const bp = window.__ds.blueprintLib.captureBlueprint(window.__ds.world.getState().doc, { shape: { kind: 'rect', x0: area[0], z0: area[1], x1: area[2], z1: area[3] } }, { roads: 'clip', nature: 'clip' }).blueprint;
    const captureMs = Math.round(performance.now() - t0);
    const text = window.__ds.blueprintLib.serializeBlueprint(bp);
    await window.__ds.library.getState().init();
    const e = await window.__ds.library.getState().saveBlueprint(bp);
    window.__bpId = e.id;
    const c = bp.preview.counts;
    return { objects: c.objects, trees: c.vegetation, roads: c.roads, features: c.features, captureMs, blueprintKB: Math.round(text.length / 1024) };
  }, kind, n));
  // Destination on gentle hills.
  await ev(async () => { window.__ds.actions.newProject(); window.__ds.world.getState().applyTerrainPreset('gentleHills', 4); window.__view(); await window.__frames(3); });
  row.heapBeforeMB = await heapMB();
  // Preview: ghost moved every frame for 3 s (never validated while moving).
  await ev(async (opts) => {
    await window.__ds.blueprintActions.startPlacement(window.__bpId);
    window.__ds.blueprints.getState().setPlaceOptions(opts);
    window.__ds.blueprints.getState().setPlace({ hover: [0, 0] });
    await window.__frames(4);
  }, opts);
  const ghostBuild = await ev(async () => { const t0 = performance.now(); await window.__frames(2); return Math.round(performance.now() - t0); });
  row.previewFps = await ev(() => window.__fps(3000, (k, t) => { const a = t / 600; window.__ds.blueprints.getState().setPlace({ hover: [Math.round(30 * Math.cos(a)), Math.round(30 * Math.sin(a))] }); }));
  Object.assign(row, Object.fromEntries(Object.entries(await stats()).map(([k, v]) => [`preview${k[0].toUpperCase()}${k.slice(1)}`, v])));
  row.previewHeapMB = await heapMB();
  void ghostBuild;
  // Pin, validate, confirm.
  Object.assign(row, await ev(async () => {
    const A = window.__ds.blueprintActions, B = window.__ds.blueprints;
    B.getState().setPlace({ hover: [0, 0], pinned: [0, 0] });
    const t0 = performance.now();
    const plan = A.computePlan([0, 0]);
    const planMs = Math.round(performance.now() - t0);
    B.getState().setPlace({ plan });
    await window.__frames(3);
    window.__ds.roadStats.lastBakeMs = 0;
    const t1 = performance.now();
    A.confirmPlacement();
    const commitMs = Math.round(performance.now() - t1);
    await window.__frames(2);
    const placeToFrameMs = Math.round(performance.now() - t1);
    return { planMs, commitMs, placeToFrameMs, roadBakeMs: +window.__ds.roadStats.lastBakeMs.toFixed(1), warnings: plan.report.warnings.map((w) => w.code).join(',') };
  }));
  await ev(async () => { window.__ds.blueprintActions.backToLibrary(); window.__ds.editor.getState().setTool('select'); window.__view(); await window.__frames(3); });
  row.editorFps = await ev(() => window.__fps(3000));
  Object.assign(row, await stats());
  Object.assign(row, await ev(async () => {
    const ws = window.__ds.world;
    let t0 = performance.now();
    ws.getState().undo();
    const undoMs = Math.round(performance.now() - t0);
    await window.__frames(2);
    const undoFrameMs = Math.round(performance.now() - t0);
    t0 = performance.now();
    ws.getState().redo();
    const redoMs = Math.round(performance.now() - t0);
    await window.__frames(2);
    const redoFrameMs = Math.round(performance.now() - t0);
    const L = window.__ds.buildLib;
    t0 = performance.now();
    const json = L.serializeDocument(ws.getState().doc, false);
    const saveMs = Math.round(performance.now() - t0);
    t0 = performance.now();
    const r = L.parseDocument(json);
    const loadMs = Math.round(performance.now() - t0);
    return { undoMs, undoFrameMs, redoMs, redoFrameMs, saveMs, loadMs, worldKB: Math.round(json.length / 1024), recomposed: r.ok ? r.landscape.recomposedVertices : -1 };
  }));
  row.heapAfterMB = await heapMB();
  // Terrain merge alone (terrain layers + features, no objects / roads) on a fresh destination.
  row.terrainMergeMs = await ev(async () => {
    window.__ds.world.getState().undo();
    const bp = await window.__ds.library.getState().loadBlueprint(window.__bpId);
    const o = { ...window.__ds.blueprintLib.defaultPlacement(), ...window.__ds.blueprints.getState().place.options, x: 0, z: 0, include: { buildings: false, objects: false, vegetation: false, roads: false, landforms: true, water: true, waterState: true, terrain: true } };
    const t0 = performance.now();
    const plan = window.__ds.blueprintLib.planPlacement(window.__ds.world.getState().doc, bp, o);
    if (!plan.edit.landscape) return null;
    window.__ds.world.getState().applyEdit(plan.edit);
    await window.__frames(1);
    return Math.round(performance.now() - t0);
  });
  console.log(JSON.stringify(row));
  return row;
}

const results = { url, loadStart: os.loadavg().map((v) => +v.toFixed(1)), scenes: [] };
results.scenes.push(await scene('buildings100', 'buildings', 100, { terrain: 'offset' }));
results.scenes.push(await scene('buildings500', 'buildings', 500, { terrain: 'offset' }));
results.scenes.push(await scene('buildings1000', 'buildings', 1000, { terrain: 'offset' }));
results.scenes.push(await scene('roadsBuildings', 'roadsBuildings', 300, { terrain: 'offset', roads: 'connect' }));
results.scenes.push(await scene('natureMountainRiverForest', 'nature', 0, { terrain: 'apply' }));
results.scenes.push(await scene('cityNature', 'cityNature', 0, { terrain: 'blend', roads: 'snap' }));

// Repeated placement of one blueprint: 30 copies of the detached house, heap growth after GC.
await ev(async () => { window.__ds.actions.newProject(); window.__ds.world.getState().applyTerrainPreset('gentleHills', 4); await window.__ds.blueprintActions.startPlacement('builtin-house'); await window.__frames(3); });
const heap0 = await heapMB();
results.repeat = await ev(async () => {
  const A = window.__ds.blueprintActions, B = window.__ds.blueprints;
  const times = [];
  for (let k = 0; k < 30; k++) {
    const at = [-85 + (k % 6) * 34, -80 + Math.floor(k / 6) * 34];
    B.getState().setPlace({ hover: at, pinned: at, yaw: (k * Math.PI) / 5 });
    const t0 = performance.now();
    A.confirmPlacement();
    await window.__frames(1);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { copies: 30, medianPlaceToFrameMs: Math.round(times[15]), maxMs: Math.round(times[29]), objects: Object.keys(window.__ds.world.getState().doc.objects).length, designs: new Set(Object.values(window.__ds.world.getState().doc.objects).filter((o) => o.building).map((o) => o.building)).size };
});
results.repeat.heapGrowthMB = +((await heapMB()) - heap0).toFixed(1);
results.repeat.undoAllMs = await ev(async () => { const t0 = performance.now(); for (let k = 0; k < 30; k++) window.__ds.world.getState().undo(); await window.__frames(2); return Math.round(performance.now() - t0); });
results.repeat.heapAfterUndoMB = +((await heapMB()) - heap0).toFixed(1);
console.log('repeat', JSON.stringify(results.repeat));
results.loadEnd = os.loadavg().map((v) => +v.toFixed(1));
if (outFile) fs.writeFileSync(outFile, JSON.stringify({ date: new Date().toISOString(), ...results }, null, 2));
await browser.close();
