// Repeated volcano runs in Chrome (Phase 28): heap and GPU geometries after each run (leak check).
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,1000', '--enable-precise-memory-info', '--js-flags=--expose-gc'], defaultViewport: { width: 1600, height: 1000 }, protocolTimeout: 1800000 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
await page.goto((process.argv[2] ?? 'http://localhost:4198/') + '?devtools', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
const cdp = await page.createCDPSession();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (fn, ...a) => page.evaluate(fn, ...a);
async function heap() { for (let i = 0; i < 3; i++) { await ev(() => window.gc?.()); await cdp.send('HeapProfiler.collectGarbage'); await wait(200); } return ev(() => +(performance.memory.usedJSHeapSize / 1048576).toFixed(1)); }
const rows = [];
for (let k = 0; k < Number(process.env.N ?? 6); k++) {
  const preset = ['smallVent', 'vegetationFire', 'ashFall'][k % 3];
  await ev((p) => window.__ds.actions.loadVolcanoPreset(p), preset);
  await wait(400);
  await ev(() => window.__ds.actions.runExperiment());
  await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status === 'running', { timeout: 60000 });
  await ev(() => { const s = window.__ds.sim; s.pause(); s.advance(180); }).catch(() => {});
  await ev((T) => { const s = window.__ds.sim; s.pause(); s.advance(T - s.getTime()); }, 180);
  await wait(1200);
  await ev(() => window.__ds.actions.exitSimulation());
  await wait(800);
  await ev(() => window.__ds.actions.newProject());
  await wait(800);
  rows.push({ k, preset, heapMB: await heap(), geometries: await ev(() => window.__r3f.get().gl.info.memory.geometries), textures: await ev(() => window.__r3f.get().gl.info.memory.textures) });
  console.log(JSON.stringify(rows[rows.length - 1]));
}
console.log('errors', errors.length, errors.slice(0, 3));
if (process.env.OUT) (await import('node:fs')).writeFileSync(process.env.OUT, JSON.stringify({ rows, errors }, null, 1));
await browser.close();
