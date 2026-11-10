// Phase 35.5 UI comparison screenshots (spec §56): the same views at 1920×1080, 1440×900, 1366×768 and 1280×720, in Korean and
// English, for the UI before and after the redesign. Also measures layout problems that can be found from the DOM: buttons
// overlapping, text clipped in buttons, horizontal scroll, the visible 3D area.
//
//   node scripts/shots-ux355.mjs http://localhost:5173/ ./docs/verify/ux355 before
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:5173/', out = './docs/verify/ux355', tag = 'after'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SIZES = (process.env.SIZES ?? '1920x1080,1440x900,1366x768,1280x720').split(',').map((s) => s.split('x').map(Number));
const LANGS = (process.env.LANGS ?? 'ko,en').split(',');
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1920,1080'],
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 }, protocolTimeout: 600_000, timeout: 180_000,
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('dialog', (d) => d.accept());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (fn, ...a) => page.evaluate(fn, ...a);

/** DOM layout audit of the current view. */
const audit = () => ev(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' ? r : null; };
  const btns = [...document.querySelectorAll('button, [role="tab"], input, select')].map((el) => [el, vis(el)]).filter(([, r]) => r);
  let overlaps = 0, clipped = 0, small = 0;
  const ex = [];
  for (let i = 0; i < btns.length; i++) {
    const [a, ra] = btns[i];
    if (a.scrollWidth > a.clientWidth + 2 && a.tagName === 'BUTTON') { clipped++; if (ex.length < 6) ex.push(`clip:${(a.textContent ?? '').trim().slice(0, 24)}`); }
    if (ra.width < 18 || ra.height < 18) small++;
    for (let j = i + 1; j < btns.length; j++) {
      const [b, rb] = btns[j];
      if (a.contains(b) || b.contains(a)) continue;
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 4 && h > 4) { overlaps++; if (ex.length < 6) ex.push(`over:${(a.textContent ?? a.getAttribute('aria-label') ?? '').trim().slice(0, 16)}|${(b.textContent ?? '').trim().slice(0, 16)}`); }
    }
  }
  const canvas = document.querySelector('canvas');
  const cr = canvas?.getBoundingClientRect();
  return {
    overlaps, clipped, small, examples: ex,
    hscroll: document.documentElement.scrollWidth > window.innerWidth + 1,
    viewport3d: cr ? Math.round(cr.width) + '×' + Math.round(cr.height) : null,
    viewportShare: cr ? +((cr.width * cr.height) / (window.innerWidth * window.innerHeight)).toFixed(3) : 0,
  };
});

await page.goto(url + '?devtools', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
const report = [];
for (const lang of LANGS) {
  for (const [w, h] of SIZES) {
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await ev(() => { localStorage.clear(); localStorage.setItem('ds.hazardTab', 'experiment'); });
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__ds && window.__r3f);
    await ev((l) => window.__ds.locale.getState().setLocale(l), lang);
    await wait(1500);
    const name = (v) => path.join(out, `${tag}-${v}-${w}x${h}-${lang}.png`);
    // 1. Start view (sample town, editor).
    await page.screenshot({ path: name('1-start') });
    report.push({ tag, lang, size: `${w}x${h}`, view: 'start', ...(await audit()) });
    // 2. The disaster list (old: experiment "Add" menu; new: the library).
    const opened = await ev(() => {
      const lib = document.querySelector('[data-testid="disaster-library"]');
      if (lib) { lib.scrollIntoView(); return 'library'; }
      for (const b of document.querySelectorAll('button')) if (/현상 추가|Add phenomenon/.test(b.textContent ?? '')) { b.click(); return 'menu'; }
      return null;
    });
    await wait(400);
    await page.screenshot({ path: name('2-list') });
    report.push({ tag, lang, size: `${w}x${h}`, view: `list(${opened})`, ...(await audit()) });
    // 3. Simulation running with a blast (no selection).
    await ev(() => window.__ds.actions.runSimulation([{ event: 'blast', position: [-40, 0], height: 1, energy: 5e7, model: 'weakShock', waveform: 'nWave' }]));
    await wait(2500);
    await page.screenshot({ path: name('3-sim') });
    report.push({ tag, lang, size: `${w}x${h}`, view: 'sim', ...(await audit()) });
    // 4. A building selected in the simulation.
    await ev(() => { const s = window.__ds.world.getState().doc; const b = Object.values(s.objects).find((o) => o.type === 'building'); if (b) window.__ds.editor.getState().select(b.id); });
    await wait(800);
    await page.screenshot({ path: name('4-building') });
    report.push({ tag, lang, size: `${w}x${h}`, view: 'building', ...(await audit()) });
    await ev(() => window.__ds.actions.leaveSimulation?.() ?? window.__ds.actions.exitSimulation?.());
    await wait(500);
  }
}
fs.writeFileSync(path.join(out, `${tag}-layout.json`), JSON.stringify({ errors, report }, null, 2));
for (const r of report) console.log(`${r.tag} ${r.lang} ${r.size} ${r.view}: overlaps ${r.overlaps} clipped ${r.clipped} small ${r.small} hscroll ${r.hscroll} 3D ${r.viewport3d} (${r.viewportShare}) ${r.examples.join(' ')}`);
console.log(`errors: ${errors.length}`, errors.slice(0, 5));
await browser.close();
