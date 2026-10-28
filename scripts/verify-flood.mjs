// Browser verification of the flood simulation (Phase 14): runs flood scenarios in a real
// Chrome (production build), exercises the display modes, the flood inspector, the results
// panel and the command console, and saves screenshots + a JSON summary.
//
//   npm run build && npx vite preview --port 4173 &
//   npm i --no-save puppeteer-core
//   node scripts/verify-flood.mjs http://localhost:4173/ ./shots
//   LANG_UI=en node scripts/verify-flood.mjs …
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
  protocolTimeout: 900_000,
});
const errors = [];
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
await page.goto(url + '?devtools&perf', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds);
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('ds.hazardTab', 'flood'); });
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds);
const lang = process.env.LANG_UI ?? 'ko';
const shot = (name) => page.screenshot({ path: path.join(out, `${name}-${lang}.png`) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const focus = (dist, target) => page.evaluate((d, t) => window.__ds.view.getState().requestFocus(t, d), dist, target);
const simTime = () => page.evaluate(() => window.__ds.sim.getTime());
const until = async (t) => page.waitForFunction((t) => window.__ds.sim.getTime() >= t, { timeout: 600_000, polling: 250 }, t);
const sample = () => page.evaluate(() => {
  const f = window.__ds.simStore.getState().flood;
  const ev = window.__ds.sim.getDamageEvents();
  const by = {};
  for (const e of ev) if (e.hazard === 'flood') by[e.eventType] = (by[e.eventType] ?? 0) + 1;
  return { t: +window.__ds.sim.getTime().toFixed(1), flood: f && { volume: +f.volume.toFixed(1), area: Math.round(f.floodedArea), maxDepth: +f.maxDepth.toFixed(3), maxSpeed: +f.maxSpeed.toFixed(2), rain: f.rain, relErr: f.relativeError, substeps: f.substeps }, floodEvents: by };
});

await page.evaluate((l) => window.__ds.locale.getState().setLocale(l), lang);
await page.evaluate(() => window.__ds.actions.loadSampleTown());

// ── Scenario A: sample town (flat) — heavy rain + rising water from the south edge ──
await page.evaluate(() => {
  const w = window.__ds.world.getState();
  w.setFloodScenario({
    rain: { event: 'rain', intensity: 120, duration: 600 },
    risingWater: { event: 'risingWater', boundary: 'S', level: 1.1, riseRate: 1.2, duration: 600 },
    sources: [{ event: 'waterSource', position: [-20, -30], rate: 8, duration: 400 }],
    enabled: { rain: true, risingWater: true, sources: true },
  });
});
await wait(600);
await shot('01-flood-form');
// Run through the form's button (real UI path).
await page.evaluate(() => { for (const b of document.querySelectorAll('button')) if (/홍수 시뮬레이션 실행|Run flood simulation/.test(b.textContent ?? '')) { b.click(); break; } });
await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().flood !== null, { timeout: 120_000 });
await page.evaluate(() => window.__ds.sim.setSpeed(8));
await focus(95, [0, 0, 20]);
const samples = [];
for (const [i, t] of [[2, 20], [3, 60], [4, 120]]) {
  await until(t);
  await page.evaluate(() => window.__ds.sim.pause());
  await wait(500);
  samples.push(await sample());
  await shot(`0${i}-water-t${t}`);
  await page.evaluate(() => window.__ds.sim.play());
}
await until(150);
await page.evaluate(() => window.__ds.sim.pause());
// Display modes.
for (const mode of ['depth', 'flow', 'speed', 'normal']) {
  await page.evaluate((m) => window.__ds.view.getState().setFloodViz({ mode: m }), mode);
  await wait(500);
  await shot(`05-mode-${mode}`);
}
// Flood inspector: a real click on the ground / water in the viewport.
await focus(45, [-5, 0, 10]);
await wait(1200);
const canvas = await page.$('canvas');
const box = await canvas.boundingBox();
await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.62);
await wait(600);
let probe = await page.evaluate(() => window.__ds.view.getState().waterProbe);
if (!probe) {
  await page.evaluate(() => window.__ds.view.getState().setWaterProbe({ x: -5, z: 10 }));
  probe = { programmatic: true };
}
await wait(400);
await shot('06-inspector-probe');
const inspectorText = await page.evaluate(() => document.querySelector('[data-testid="flood-inspector"]')?.textContent ?? null);
// A flooded car with its live flood response.
const carId = await page.evaluate(() => {
  const rt = window.__ds.sim.getRuntime();
  const c = [...rt.entities.values()].filter((e) => e.source.type === 'car' && e.flood).sort((a, b) => b.flood.depth - a.flood.depth)[0];
  window.__ds.actions.focusObject(c.id);
  return c.id;
});
await wait(1200);
await shot('07-car-inspector');
await page.evaluate(() => window.__ds.editor.getState().select(null));
// Results panel.
await page.evaluate(() => { for (const b of document.querySelectorAll('button')) if (/결과|Results/.test(b.textContent ?? '')) { b.click(); break; } });
await wait(800);
await shot('08-results');
const resultsOk = await page.evaluate(() => !!document.querySelector('[data-testid="flood-results"]'));
await page.keyboard.press('Escape');
const summaryA = await page.evaluate(() => {
  const m = window.__ds.sim.getMetrics();
  return { flood: m.flood, totalEvents: m.totalDamageEvents, hazards: [...new Set(window.__ds.sim.getDamageEvents().map((e) => e.hazard))] };
});
const perfA = await page.evaluate(() => {
  const hud = document.body.innerText.match(/Draw calls\s*(\d+)/);
  return { drawCalls: hud ? +hud[1] : null, waterRender: window.__ds.waterRenderStats };
});

// ── Scenario B: command console on the lowland floodplain ──
await page.evaluate(() => window.__ds.actions.exitSimulation());
await page.evaluate(() => window.__ds.world.getState().applyTerrainPreset('lowland', 2));
await wait(800);
await focus(150, [0, 0, 25]);
await wait(800);
await shot('09-lowland-editor');
const cmd = lang === 'ko' ? '시간당 80mm의 비를 30분 동안 내려줘 그리고 서쪽 경계에서 수위를 0.8m까지 올려줘' : 'Start rainfall at 80 mm/h for 30 minutes then raise the western boundary water level to 0.8 meters';
const input = await page.$('input[placeholder*="Enter"], textarea[placeholder*="Enter"]');
await input.click({ clickCount: 3 });
await input.type(cmd);
await wait(800);
await shot('10-command-preview');
await page.keyboard.press('Enter');
await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().flood !== null, { timeout: 120_000 });
await page.evaluate(() => window.__ds.sim.setSpeed(16));
await until(150);
await page.evaluate(() => window.__ds.sim.pause());
await focus(170, [0, 0, 20]);
await wait(1200);
await shot('11-lowland-flood');
const summaryB = await sample();
const events = await page.evaluate(() => window.__ds.simStore.getState().events.map((e) => ({ type: e.type, start: e.start, duration: e.duration })));

fs.writeFileSync(path.join(out, `flood-summary-${lang}.json`), JSON.stringify({ samples, summaryA, perfA, probe, inspectorText, carId, resultsOk, summaryB, events, errors }, null, 2));
console.log(JSON.stringify({ samples, flood: summaryA.flood && { ...summaryA.flood, budget: summaryA.flood.budget }, hazards: summaryA.hazards, perfA, probe, inspectorOk: !!inspectorText, resultsOk, summaryB, events, errors }, null, 2));
await browser.close();
