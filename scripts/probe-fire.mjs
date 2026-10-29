import puppeteer from 'puppeteer-core';
const out = process.argv[2];
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,1000'], defaultViewport: { width: 1600, height: 1000 }, protocolTimeout: 600000 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', (d) => d.accept());
await page.goto('http://localhost:4196/?devtools', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (fn, ...a) => page.evaluate(fn, ...a);
for (const [preset, T, cam] of [['singleRoom', 850, [16, 12, 22]], ['vegetation', 25, [20, 22, 30]], ['windFire', 60, [10, 30, 45]]]) {
  await ev((p) => window.__ds.actions.loadFirePreset(p), preset);
  await wait(500);
  await ev(() => window.__ds.actions.runExperiment());
  await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status === 'running', { timeout: 60000 });
  await ev((T) => { const s = window.__ds.sim; s.pause(); s.advance(T - s.getTime()); }, T);
  await ev(([x, h, z]) => { const st = window.__r3f.get(); st.camera.position.set(x, h, z); st.controls.target.set(0, 3, 0); st.controls.update(); }, cam);
  await wait(1500);
  await page.screenshot({ path: `${out}/${preset}.png` });
  const f = await ev(() => { const s = window.__ds.simStore.getState().fire; return s && { hrr: s.hrr, burning: s.burningItems, rooms: s.roomsBurning, smoke: s.smokeAir }; });
  console.log(preset, JSON.stringify(f));
  await ev(() => window.__ds.actions.exitSimulation());
  await wait(500);
}
console.log('errors', errors.length, errors.slice(0, 5));
await browser.close();
