// Browser verification of the earthquake simulation (Phase 13): runs the sample town with an
// earthquake in a real Chrome (production build) and saves screenshots + a JSON summary.
//
//   npm run build && npx vite preview --port 4173 &
//   npm i --no-save puppeteer-core
//   node scripts/verify-earthquake.mjs http://localhost:4173/ ./shots
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:4173/', out = './shots'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,1000'],
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 },
  protocolTimeout: 600_000,
});
const errors = [];
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
await page.goto(url + '?devtools', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds);
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('ds.hazardTab', 'earthquake'); });
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds);
const shot = (name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const setCam = (p, t) => page.evaluate((p, t) => {
  const v = window.__ds.view.getState();
  v.requestFocus(t, p);
}, p, t);

const lang = process.env.LANG_UI ?? 'ko';
await page.evaluate((l) => window.__ds.locale.getState().setLocale(l), lang);
await page.evaluate(() => window.__ds.actions.loadClassicSampleTown());
await page.evaluate(() => window.__ds.world.getState().setEarthquakeScenario({ event: 'earthquake', magnitude: 7.0, pga: Number(new URLSearchParams(location.search).get('pga') ?? 0.7), duration: 25, epicenter: [60, -40], depth: 8, seed: 3 }));
await wait(800);
await shot(`01-editor-${lang}`);
await page.evaluate(async () => {
  const s = window.__ds.world.getState().doc.scenario.earthquake;
  await window.__ds.actions.runSimulation([s]);
  window.__ds.sim.pause();
});
await page.waitForFunction(() => window.__ds.sim.isLoaded());
await setCam(70, [0, 6, 0]);
await page.evaluate(() => window.__ds.sim.play());
const samples = [];
for (const [i, t] of [[2, 4], [3, 9], [4, 14], [5, 22]]) {
  await page.waitForFunction((t) => window.__ds.sim.getTime() >= t, { timeout: 120_000 }, t);
  await page.evaluate(() => window.__ds.sim.pause());
  await wait(400);
  samples.push(await page.evaluate(() => {
    const q = window.__ds.simStore.getState().quake;
    const ev = window.__ds.sim.getDamageEvents();
    return { t: window.__ds.sim.getTime(), accel: q?.accelH, phase: q?.phase, events: ev.length, quakeEvents: ev.filter((e) => e.hazard === 'earthquake').length };
  }));
  await shot(`0${i}-shaking-t${t}-${lang}`);
  await page.evaluate(() => window.__ds.sim.play());
}
// Close-up of a building with stress colors / cracks, inspector open on it.
await page.waitForFunction(() => window.__ds.sim.getTime() >= 30, { timeout: 120_000 });
await page.evaluate(() => window.__ds.sim.pause());
const bid = await page.evaluate(() => {
  const rt = window.__ds.sim.getRuntime();
  const b = [...rt.entities.values()].filter((e) => e.source.type === 'building').sort((a, b) => b.seismic.damage - a.seismic.damage)[0];
  window.__ds.actions.focusObject(b.id);
  return b.id;
});
await wait(1500);
await shot(`06-building-inspector-${lang}`);
await page.evaluate(() => window.__ds.editor.getState().select(null));
await page.evaluate(() => { const ui = document.querySelectorAll('button'); for (const b of ui) if (/결과|Results/.test(b.textContent ?? '')) { b.click(); break; } });
await wait(800);
await shot(`07-results-${lang}`);
const summary = await page.evaluate(() => {
  const m = window.__ds.sim.getMetrics();
  return { earthquake: m.earthquake, totalEvents: m.totalDamageEvents };
});
fs.writeFileSync(path.join(out, `summary-${lang}.json`), JSON.stringify({ samples, summary, building: bid, errors }, null, 2));
console.log(JSON.stringify({ samples, summary, errors }, null, 2));
await browser.close();
