// Browser verification of the Road Network & City Builder (Phase 18).
//
//   npx vite --port 5199 &    (or: npm run build && npx vite preview --port 4173 &)
//   node scripts/verify-roads.mjs http://localhost:5199/ ./shots/roads     (LANG_UI=en for English)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:5199/', out = './shots/roads'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,1000'],
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 }, protocolTimeout: 900_000,
});
const errors = [];
const results = [];
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
await page.goto(url + '?devtools', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds);
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds);
const lang = process.env.LANG_UI ?? 'ko';
await page.evaluate((l) => window.__ds.locale.getState().setLocale(l), lang);
const shot = (n) => page.screenshot({ path: path.join(out, `${n}-${lang}.png`) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
const ev = (fn, ...a) => page.evaluate(fn, ...a);

/** Screen position of a world point (x, y, z) using the R3F camera. */
async function screenOf(x, y, z) {
  return ev(([x, y, z]) => {
    const st = window.__r3f;
    const v = st.camera.position.clone().set(x, y, z).project(st.camera);
    const r = st.gl.domElement.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  }, [x, y, z]);
}
async function clickWorld(x, z, opts = {}) {
  const [sx, sy] = await screenOf(x, 0, z);
  await page.mouse.move(sx, sy);
  await wait(60);
  await page.mouse.click(sx, sy, opts);
  await wait(120);
}
/** Look straight down at the area around (x, z). */
async function topView(x = 0, z = 0, h = 150) {
  await ev(([x, z, h]) => {
    const st = window.__r3f;
    st.camera.position.set(x, h, z + 0.01);
    st.camera.lookAt(x, 0, z);
    if (st.controls) { st.controls.target.set(x, 0, z); st.controls.update(); }
  }, [x, z, h]);
  await wait(300);
}
async function obliqueView(x = 0, z = 0, d = 90) {
  await ev(([x, z, d]) => {
    const st = window.__r3f;
    st.camera.position.set(x + d * 0.6, d * 0.55, z + d * 0.8);
    if (st.controls) { st.controls.target.set(x, 0, z); st.controls.update(); }
    st.camera.lookAt(x, 0, z);
  }, [x, z, d]);
  await wait(400);
}

// 1. Road tab + draw a straight road by clicking in the viewport.
await page.click('[data-testid="tab-roads"]');
await wait(300);
await topView(0, 0, 160);
await clickWorld(-60, 0);
await clickWorld(60, 0);
await wait(200);
await shot('01-draw-preview');
await page.keyboard.press('Enter');
await wait(600);
let segs = await ev(() => Object.keys(window.__ds.world.getState().doc.roads.segments).length);
check('draw straight road', segs === 1, `segments=${segs}`);
await shot('02-straight');

console.log(JSON.stringify({ errors }, null, 1));
fs.writeFileSync(path.join(out, `results-${lang}.json`), JSON.stringify({ results, errors }, null, 2));
await browser.close();
