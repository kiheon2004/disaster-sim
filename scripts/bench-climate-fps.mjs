// Phase 30 audit §12: frame times of the 1000-house snowfall town in KO and EN, interleaved (KO, EN, KO, EN …) in one
// headless Chrome (same build, world, camera, viewport, simulated time) — p50 / p95 / p99, climate ms per frame, load.
//   node scripts/bench-climate-fps.mjs http://localhost:4199/ out.json [rounds=2]
import fs from 'node:fs';
import os from 'node:os';
import puppeteer from 'puppeteer-core';

const [url = 'http://localhost:4199/', out = 'fps.json', roundsArg = '2'] = process.argv.slice(2);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,1000'], defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 }, protocolTimeout: 3_600_000 });
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

async function runOnce(lang) {
  await ev((l) => window.__ds.locale.getState().setLocale(l), lang);
  await ev(() => {
    const ds = window.__ds;
    ds.actions.newProject();
    const d = ds.buildingLib.createDesign(ds.buildingLib.presetSpec('house'), 'house');
    const add = [];
    for (let z = -94; z <= 94 && add.length < 1000; z += 6) for (let x = -94; x <= 94 && add.length < 1000; x += 6) add.push({ type: 'building', building: d, seed: add.length + 1, transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] } });
    ds.world.getState().applyEdit({ add });
    ds.actions.addPhenomenon('climate', { event: 'climate', scenario: 'snowfall', forcing: 'flux', temperature: 270.15, target: 270.15, profile: 'constant', duration: 1800, humidity: 0.9, precipitation: 10, precipPhase: 'snow', solar: 'off', soilMoisture: 0.25, initialSnow: 0.2 });
  });
  await wait(1500);
  await ev(() => { for (const b of document.querySelectorAll('button')) if (/^\s*실험 실행|Run experiment/.test(b.textContent ?? '') && !b.disabled) { b.click(); return; } });
  await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status === 'running', { timeout: 300_000 });
  await ev(() => { const s = window.__ds.sim; s.pause(); s.advance(60 - s.getTime()); });
  await ev(() => { const st = window.__r3f.get(); st.camera.position.set(45, 90, 110); st.controls.target.set(0, 0, 0); st.controls.update(); window.__ds.sim.play(); });
  await wait(1500);
  const r = await ev(() => new Promise((res) => {
    const t = [], cms = []; let last = performance.now();
    const f = (now) => { t.push(now - last); last = now; cms.push(window.__ds.simStore.getState().climate?.ms ?? 0); if (t.length < 600) requestAnimationFrame(f); else res({ t: t.slice(30), cms: cms.slice(30) }); };
    requestAnimationFrame(f);
  }));
  const calls = await ev(() => window.__r3f.get().gl.info.render.calls);
  await ev(() => window.__ds.actions.exitSimulation());
  await wait(800);
  const mean = r.t.reduce((a, b) => a + b, 0) / r.t.length;
  return { lang, frames: r.t.length, fps: +(1000 / mean).toFixed(1), p50: q(r.t, 0.5), p95: q(r.t, 0.95), p99: q(r.t, 0.99), worst: +Math.max(...r.t).toFixed(1), climateMsMean: +(r.cms.reduce((a, b) => a + b, 0) / r.cms.length).toFixed(2), drawCalls: calls, load: os.loadavg().map((v) => +v.toFixed(1)) };
}

const rows = [];
for (let k = 0; k < Number(roundsArg); k++) for (const lang of ['ko', 'en']) { const row = await runOnce(lang); console.log(JSON.stringify(row)); rows.push(row); }
fs.writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), cpus: os.cpus()[0]?.model, rows, errors }, null, 2));
await browser.close();
