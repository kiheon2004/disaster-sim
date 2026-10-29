// Phase 17 §2: retained-heap benchmark for selection / gizmo / render-path changes in edit mode.
// Every scenario runs N cycles; the heap is measured after forced GCs (Chrome --expose-gc and
// CDP HeapProfiler.collectGarbage) before and after, so transient allocations do not count.
// Also reports renderer.info.memory (GPU-side geometries / textures) and the number of event
// listeners on the canvas and document (leaked controls keep listeners alive).
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/bench-selection-memory.mjs http://localhost:4173/ [cycles=40] [objects=1000] [out.json]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const [url = 'http://localhost:4173/', cyclesArg = '40', objectsArg = '1000', outFile] = process.argv.slice(2);
const N = Number(cyclesArg);
const OBJECTS = Number(objectsArg);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,900', '--enable-precise-memory-info', '--js-flags=--expose-gc'],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 }, protocolTimeout: 900_000,
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.goto(url + '?devtools', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
const cdp = await page.createCDPSession();
await cdp.send('HeapProfiler.enable');

await page.evaluate(async (n) => {
  window.__frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.__ds.actions.loadStressScene(n);
  await window.__frames();
  const s = window.__r3f.get();
  s.camera.position.set(48, 42, 62);
  s.controls.target.set(0, 0, 0);
  s.controls.update();
}, OBJECTS);
await new Promise((r) => setTimeout(r, 1500));

async function collect() {
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.gc?.());
    await cdp.send('HeapProfiler.collectGarbage');
  }
  await new Promise((r) => setTimeout(r, 300));
}

async function listeners() {
  const count = async (expr) => {
    const { result } = await cdp.send('Runtime.evaluate', { expression: expr });
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    return listeners.length;
  };
  return { canvas: await count('window.__r3f.get().gl.domElement'), document: await count('document') };
}

async function snapshot() {
  await collect();
  const mem = await page.evaluate(() => {
    const gl = window.__r3f.get().gl;
    return { heapMB: performance.memory.usedJSHeapSize / 1048576, geometries: gl.info.memory.geometries, textures: gl.info.memory.textures, programs: gl.info.programs?.length ?? 0 };
  });
  return { ...mem, listeners: await listeners() };
}

/** Scenario bodies run in the page; `i` = cycle index. */
const scenarios = {
  // Same object: select → deselect.
  sameObject: async (i, ids) => {
    const ed = window.__ds.editor.getState();
    ed.select(ids[0]);
    await window.__frames();
    ed.select(null);
    await window.__frames();
  },
  // A different object every cycle (then deselect).
  differentObjects: async (i, ids) => {
    const ed = window.__ds.editor.getState();
    ed.select(ids[(i * 7) % ids.length]);
    await window.__frames();
    ed.select(null);
    await window.__frames();
  },
  // Switch selection directly between objects without deselecting.
  switchObjects: async (i, ids) => {
    window.__ds.editor.getState().select(ids[(i * 13) % ids.length]);
    await window.__frames();
  },
  // Multi-selection of 20 objects → none (GroupSelection adapter + group gizmo).
  multiSelect: async (i, ids) => {
    const ed = window.__ds.editor.getState();
    ed.setSelection(ids.slice((i * 3) % 100, ((i * 3) % 100) + 20));
    await window.__frames();
    ed.setSelection([]);
    await window.__frames();
  },
  // Gizmo mode changes on a kept selection (no remount of the controls).
  gizmoModes: async (i, ids) => {
    const ed = window.__ds.editor.getState();
    if (i === 0) ed.select(ids[1]);
    ed.setTransformMode(['translate', 'rotate', 'scale'][i % 3]);
    await window.__frames();
  },
  // Render path switch: single (React view + gizmo) ↔ multi (group adapter) ↔ batched.
  renderPath: async (i, ids) => {
    const ed = window.__ds.editor.getState();
    ed.select(ids[2]);
    await window.__frames();
    ed.setSelection([ids[2], ids[3]]);
    await window.__frames();
    ed.setSelection([]);
    await window.__frames();
  },
  // Hover outline (HoverBox) on / off.
  hover: async (i, ids) => {
    const ed = window.__ds.editor.getState();
    ed.hover(ids[(i * 5) % ids.length]);
    await window.__frames();
    ed.hover(null);
    await window.__frames();
  },
};

const results = [];
for (const [name, body] of Object.entries(scenarios)) {
  await page.evaluate(() => { window.__ds.editor.getState().setSelection([]); window.__ds.editor.getState().hover(null); });
  // Warm-up (first-use allocations: shader programs, caches) — not counted.
  await page.evaluate(async (src, warm) => {
    const fn = eval(`(${src})`);
    const ids = Object.keys(window.__ds.world.getState().doc.objects).sort();
    for (let i = 0; i < warm; i++) await fn(i, ids);
    window.__ds.editor.getState().setSelection([]);
    window.__ds.editor.getState().hover(null);
    await window.__frames();
  }, body.toString(), 3);
  const before = await snapshot();
  const t0 = Date.now();
  await page.evaluate(async (src, n) => {
    const fn = eval(`(${src})`);
    const ids = Object.keys(window.__ds.world.getState().doc.objects).sort();
    for (let i = 0; i < n; i++) await fn(i, ids);
    window.__ds.editor.getState().setSelection([]);
    window.__ds.editor.getState().hover(null);
    await window.__frames();
  }, body.toString(), N);
  const ms = Date.now() - t0;
  const after = await snapshot();
  const row = {
    scenario: name,
    cycles: N,
    retainedMB: +(after.heapMB - before.heapMB).toFixed(2),
    perCycleKB: +(((after.heapMB - before.heapMB) * 1024) / N).toFixed(1),
    geometries: after.geometries - before.geometries,
    textures: after.textures - before.textures,
    canvasListeners: after.listeners.canvas - before.listeners.canvas,
    documentListeners: after.listeners.document - before.listeners.document,
    ms,
  };
  results.push(row);
  console.log(JSON.stringify(row));
}
if (outFile) fs.writeFileSync(outFile, JSON.stringify({ url, objects: OBJECTS, results }, null, 2));
await browser.close();
// ASSERT=1: regression check (the gizmo leak retained ≈ 330 KB and one document listener per mount).
if (process.env.ASSERT) {
  const bad = results.filter((r) => r.perCycleKB > 50 || r.documentListeners > 0 || r.canvasListeners > 0 || r.geometries > 0);
  if (bad.length) {
    console.error('memory regression:', bad.map((r) => r.scenario).join(', '));
    process.exit(1);
  }
  console.log('memory check passed');
}
