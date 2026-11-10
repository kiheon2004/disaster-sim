// Browser verification of the Universal Phenomenon Engine (Phase 15): experiment tab,
// multi-phenomenon run, timeline lanes / milestones, inspector, results, comparison, commands.
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/verify-phenomena.mjs http://localhost:4173/ ./shots      (LANG_UI=en for English)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:4173/', out = './shots'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,1000'],
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 }, protocolTimeout: 900_000,
});
const errors = [];
const page = await browser.newPage();
// Phase 35.5 compatibility: the right panel has tabs and the command console is a drawer — before an old selector / page function
// is used, the tab (or drawer) that holds it is shown. (The checks themselves are unchanged.)
{
  const _ev = page.evaluate.bind(page);
  const where = (s) => (/-settings"|-settings\]/.test(s) ? 'settings' : /-probe"|-probe\]|road-sim/.test(s) ? 'analysis' : /홍수 시뮬레이션 실행|Run flood|flood-form/.test(s) ? 'legacy:flood' : /지진 실행|Run earthquake|eq-form/.test(s) ? 'legacy:earthquake' : /"시뮬레이션 실행"|"run simulation"|wind-form/i.test(s) ? 'legacy:wind' : /-inspector"|-inspector\]/.test(s) ? 'selection' : /실험 실행|Run experiment|실험 적용|Apply now|현상 추가|Add phenomenon|시나리오 비교|Compare/.test(s) ? 'phenomena' : /data-instance|exp-edit|experiment-panel|exp-issue|exp-invalid|exp-advanced|atmos-preview|-preview"/.test(s) ? 'phenomena' : /placeholder\*="Enter"|cmd-|command-input/.test(s) ? 'command' : null);
  const show = async (src) => {
    const t = where(String(src));
    if (!t) return;
    const done = await _ev((t) => { const u = window.__ds?.ui?.getState(); if (!u) return true; if (t === 'command') { if (u.commandOpen) return true; u.setCommandOpen(true); return false; } if (t.startsWith('legacy:')) { const k = t.slice(7); const tabs = { wind: /바람|Wind/, earthquake: /지진|Earthquake/, flood: /홍수|Flood/ }; if (u.rightTab !== 'phenomena' || !u.rightOpen) { u.setRightTab('phenomena'); return false; } const head = [...document.querySelectorAll('button')].find((b) => /상세 설정 폼|Detailed forms/.test(b.textContent ?? '')); if (!head) return true; if (head.getAttribute('aria-expanded') !== 'true') { head.click(); return false; } const box = head.parentElement; const tab = [...(box?.querySelectorAll('[role="tab"]') ?? [])].find((b) => tabs[k].test(b.textContent ?? '')); if (tab && tab.getAttribute('aria-selected') !== 'true') { tab.click(); return false; } return true; } if (u.rightTab === t && u.rightOpen) return true; u.setRightTab(t); return false; }, t).catch(() => true);
    if (!done) await new Promise((r) => setTimeout(r, 150));
  };
  for (const m of ['click', '$', '$$', 'type', 'focus', 'select', 'waitForSelector', '$eval', '$$eval']) {
    const o = page[m].bind(page);
    page[m] = async (sel, ...rest) => { await show(sel); return o(sel, ...rest); };
  }
  page.evaluate = async (fn, ...rest) => { await show(String(fn) + JSON.stringify(rest)); return _ev(fn, ...rest); };
}
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
await page.goto(url + '?devtools', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds);
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('ds.hazardTab', 'experiment'); localStorage.setItem('ds.bottomHeight', '330'); });
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds);
const lang = process.env.LANG_UI ?? 'ko';
const shot = (n) => page.screenshot({ path: path.join(out, `${n}-${lang}.png`) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clickText = (re) => page.evaluate((src) => {
  const r = new RegExp(src);
  for (const b of [...document.querySelectorAll('button')].filter((b) => !b.closest('[data-testid=\"disaster-library\"], [data-testid=\"placement-bar\"]'))) if (r.test(b.textContent ?? '') && !b.disabled) { b.click(); return true; }
  return false;
}, re.source);
await page.evaluate((l) => window.__ds.locale.getState().setLocale(l), lang);
await page.evaluate(() => window.__ds.actions.loadClassicSampleTown());
await wait(500);

// Experiment: typhoon at 0, earthquake 10 s after it starts, heavy rain via the real "Add" menu.
await page.evaluate(() => {
  const a = window.__ds.actions;
  a.addPhenomenon('wind', { event: 'wind', speed: 42, direction: 'S', duration: 50, gustStrength: 0.3, rampDuration: 4 });
  const q = a.addPhenomenon('earthquake', { event: 'earthquake', magnitude: 6.8, pga: 0.4, duration: 15 });
  a.updatePhenomenon(q, { start: { after: 'p1', anchor: 'start', offset: 10 } });
});
await clickText(/^\s*현상 추가|Add phenomenon/);
await wait(300);
await shot('01-add-menu');
await clickText(/^\s*폭우\s*$|^\s*Heavy rain\s*$/);
await page.evaluate(() => {
  const exp = window.__ds.world.getState().doc.scenario.experiment;
  const rain = exp.instances.find((i) => i.type === 'rain');
  window.__ds.actions.updatePhenomenon(rain.id, { spec: { event: 'rain', intensity: 120, duration: 600 }, start: { after: 'p1', anchor: 'start', offset: 20 } });
});
await page.evaluate(() => { for (const b of document.querySelectorAll('[aria-expanded]')) if (b.title && /파라미터|Parameters/.test(b.title)) { b.click(); break; } });
await wait(400);
await shot('02-experiment-panel');
const plan = await page.evaluate(() => window.__ds.world.getState().doc.scenario.experiment.instances.map((i) => ({ id: i.id, type: i.type, start: i.start })));

// Run it from the panel.
await clickText(/실험 실행|Run experiment/);
await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().events.length >= 3, { timeout: 120_000 });
await page.evaluate(() => window.__ds.sim.setSpeed(4));
await page.evaluate(() => window.__ds.view.getState().requestFocus([0, 5, 5], 85));
const samples = [];
for (const t of [12, 30]) {
  await page.waitForFunction((t) => window.__ds.sim.getTime() >= t, { timeout: 300_000, polling: 250 }, t);
  await page.evaluate(() => window.__ds.sim.pause());
  await wait(500);
  samples.push(await page.evaluate(() => {
    const s = window.__ds.simStore.getState();
    return { t: +window.__ds.sim.getTime().toFixed(1), active: s.events.filter((e) => e.status === 'active').map((e) => e.type), milestones: s.milestones.length, events: s.damageEvents.length, duplicates: window.__ds.sim.duplicateForces() };
  }));
  await shot(`03-running-t${t}`);
  await page.evaluate(() => window.__ds.sim.play());
}
await page.evaluate(() => window.__ds.sim.pause());
// Inspector: a building (forces / damage per hazard / history) and a person (exposure).
await page.evaluate(() => {
  const rt = window.__ds.sim.getRuntime();
  const b = [...rt.entities.values()].filter((e) => e.source.type === 'building').sort((a, b) => b.seismic.peakDrift - a.seismic.peakDrift)[0];
  window.__ds.actions.focusObject(b.id);
});
await wait(1000);
await shot('04-building-inspector');
await page.evaluate(() => {
  const rt = window.__ds.sim.getRuntime();
  const h = [...rt.entities.values()].find((e) => e.source.type === 'human' && e.exposure);
  window.__ds.actions.focusObject(h.id);
});
await wait(1000);
await shot('05-person-inspector');
const inspector = await page.evaluate(() => document.querySelector('[class*="inspector"], aside')?.innerText?.slice(0, 1500) ?? '');
await page.evaluate(() => window.__ds.editor.getState().select(null));
// Results: experiment timeline + models.
await page.evaluate(() => window.__ds.ui?.getState?.().setResultsOpen?.(true));
await clickText(/^\s*결과\s*$|^\s*Results\s*$/);
await wait(800);
await page.evaluate(() => { const b = document.querySelector('[data-testid="experiment-results"] button'); b?.click(); });
await wait(300);
await shot('06-results');
const resultsOk = await page.evaluate(() => !!document.querySelector('[data-testid="experiment-results"]'));
await page.keyboard.press('Escape');

// Comparison: each phenomenon alone and together.
await page.evaluate(() => window.__ds.world.getState().setExperiment({ compareDuration: 25 }));
await clickText(/시나리오 비교|Compare scenarios/);
await wait(400);
await clickText(/비교 실행|Run comparison/);
await page.waitForFunction(() => !!document.querySelector('[data-testid="comparison-table"]'), { timeout: 600_000, polling: 500 });
await wait(300);
await shot('07-comparison');
const comparison = await page.evaluate(() => [...document.querySelectorAll('[data-testid="comparison-table"] tbody tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ')));
await page.keyboard.press('Escape');
await page.evaluate(() => window.__ds.ui?.getState?.().setCompareOpen?.(false));

// Commands: relative start and a planned phenomenon.
const input = await page.$('input[placeholder*="Enter"], textarea[placeholder*="Enter"]');
const cmd1 = lang === 'ko' ? '태풍을 발생시키고 10초 후 지진을 발생시켜' : 'Start an earthquake 10 seconds after the typhoon begins';
await input.click({ clickCount: 3 });
await input.type(cmd1);
await wait(700);
await shot('08-command-relative');
await input.click({ clickCount: 3 });
await input.type(lang === 'ko' ? '블랙홀을 지도 중앙에 만들어줘' : 'Create a black hole in the center');
await wait(700);
await shot('09-command-planned');
const preview = await page.evaluate(() => document.body.innerText.match(/(미구현 현상|Not implemented)[^\n]*/)?.[0] ?? null);

fs.writeFileSync(path.join(out, `phenomena-summary-${lang}.json`), JSON.stringify({ plan, samples, inspector, resultsOk, comparison, preview, errors }, null, 2));
console.log(JSON.stringify({ plan, samples, resultsOk, comparison, preview, errors }, null, 2));
await browser.close();
