// Exploratory browser probe of the volcano (not the verification script): load a preset, run, screenshots.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:4198/', out = '/private/tmp/claude-501/-Users-namkiheon/68e2ec97-7bb3-4aae-8451-657878337f81/scratchpad/probe/shots', preset = 'vegetationFire'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,1000'],
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 }, protocolTimeout: 900_000, timeout: 120_000,
});
const errors = [];
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('dialog', (d) => d.accept());
await page.goto(url + '?devtools', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('ds.hazardTab', 'experiment'); localStorage.setItem('ds.bottomHeight', '420'); });
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const shot = (n) => page.screenshot({ path: path.join(out, `${n}.png`) });
console.log('actions has loadVolcanoPreset', await ev(() => typeof window.__ds.actions.loadVolcanoPreset));
await ev((p) => window.__ds.actions.loadVolcanoPreset(p), preset);
await wait(800);
const id = await ev(() => window.__ds.world.getState().doc.scenario.experiment.instances.find((i) => i.type === 'volcano')?.id);
await ev((id) => { const b = document.querySelector(`[data-testid="exp-edit-${id}"]`); if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); }, id);
await wait(400);
await ev(() => { const st = window.__r3f.get(); st.camera.position.set(-20, 55, 70); st.controls.target.set(-55, 5, 0); st.controls.update(); });
await ev((id) => window.__ds.view.getState().setGroundPreview(id), id);
await wait(800);
await shot('01-editor-preview');
console.log('summary', await ev(() => document.querySelector('[data-testid="volcano-summary"]')?.textContent));
// Run.
await ev(() => { for (const b of document.querySelectorAll('button')) if (/실험 실행|Run experiment/.test(b.textContent ?? '') && !b.disabled) { b.click(); return; } });
await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status === 'running', { timeout: 60_000 });
for (const T of [30, 90, 180, 300]) {
  await ev((T) => { const s = window.__ds.sim; s.pause(); const r = T - s.getTime(); if (r > 0) s.advance(r); }, T);
  await wait(1500);
  await shot(`02-run-${T}`);
  const v = await ev(() => { const s = window.__ds.simStore.getState().volcano; return s && { rate: s.supplyRate, mobile: s.mobileVolume, area: s.area, solid: s.ledger.mass.solidified, maxT: s.maxT - 273.15, res: s.ledger.mass.residual / s.ledger.mass.supplied, objects: s.objects, ms: s.ms }; });
  const f = await ev(() => { const s = window.__ds.simStore.getState().fire; return s && { burning: s.burningObjects, ignited: s.ignitedObjects }; });
  console.log(T, JSON.stringify(v), JSON.stringify(f));
}
await ev(() => window.__ds.view.getState().setVolcanoViz({ overlay: 'temperature' }));
await wait(1200);
await shot('03-overlay-temperature');
await ev(() => window.__ds.view.getState().setVolcanoViz({ overlay: 'off' }));
const geo = await ev(() => window.__r3f.get().gl.info.memory);
console.log('gpu', JSON.stringify(geo));
console.log('errors', JSON.stringify(errors.slice(0, 10)));
await browser.close();
