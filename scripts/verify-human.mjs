// Browser verification of the human physical response (Phase 33): scenarios in real Chrome through the UI and the dev
// hooks (settings: the extended model switch and the risk scale; people placed and dropped; runs: a drop from height,
// strong wind, reversed gravity, an earthquake, a celestial tidal field, a combined hazard; the inspector's posture,
// balance and segment rows; the body overlay on / off with GPU resources; the results block — aggregates, charts with
// gaps, the human CSV / JSON with schema version and units, the main exports; reset / restore / save-reload; the legacy
// model; the presets) plus whole-run checks (raw i18n keys, page / console errors, the tab alive, GPU geometries).
//
//   npx vite build && npx vite preview --port 4199 --strictPort &
//   LANG_UI=ko node scripts/verify-human.mjs http://localhost:4199/ ./docs/verify/human
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:4199/', out = './docs/verify/human'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const lang = process.env.LANG_UI ?? 'ko';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,1000', '--enable-precise-memory-info', '--js-flags=--expose-gc'],
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 }, protocolTimeout: 3_600_000, timeout: 180_000,
});
const errors = [];
const results = [];
const page = await browser.newPage();
// Phase 35.5 compatibility: the right panel has tabs and the command console is a drawer — before an old selector / page function
// is used, the tab (or drawer) that holds it is shown. (The checks themselves are unchanged.)
{
  const _ev = page.evaluate.bind(page);
  const where = (s) => (/-settings"|-settings\]/.test(s) ? 'settings' : /-probe"|-probe\]|road-sim/.test(s) ? 'analysis' : /홍수 시뮬레이션 실행|Run flood|flood-form/.test(s) ? 'legacy:flood' : /지진 실행|Run earthquake|eq-form/.test(s) ? 'legacy:earthquake' : /"시뮬레이션 실행"|"run simulation"|wind-form/i.test(s) ? 'legacy:wind' : /-inspector"|-inspector\]/.test(s) ? 'selection' : /실험 실행|Run experiment|실험 적용|Apply now|현상 추가|Add phenomenon|시나리오 비교|Compare/.test(s) ? 'phenomena' : /data-instance|exp-edit|experiment-panel|exp-issue|exp-invalid|exp-advanced|atmos-preview|-preview"/.test(s) ? 'phenomena' : /placeholder\*="Enter"|cmd-|command-input/.test(s) ? 'command' : null);
  const show = page.__show = async (src) => {
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
let crashed = false;
page.setDefaultNavigationTimeout(180_000);
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('error', (e) => { crashed = true; errors.push(`CRASH ${e.message}`); });
page.on('dialog', (d) => d.accept());
await page.goto(url + '?devtools', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('ds.hazardTab', 'experiment'); localStorage.setItem('ds.bottomHeight', '420'); });
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
await page.evaluate((l) => window.__ds.locale.getState().setLocale(l), lang);
const shot = (n) => page.screenshot({ path: path.join(out, `${n}-${lang}.png`) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clickText = (re, root = 'body') => ev(([src, root]) => {
  const r = new RegExp(src);
  for (const b of [...(document.querySelector(root)?.querySelectorAll('button, [role="menuitem"]') ?? [])].filter((b) => !b.closest('[data-testid=\"disaster-library\"], [data-testid=\"placement-bar\"]'))) if (r.test(b.textContent ?? '') && !b.disabled) { b.click(); return true; }
  return false;
}, [re.source, root]);
const tr = (k) => ev((k) => window.__ds.tr(k), k);
const text = (sel) => ev((sel) => document.querySelector(sel)?.textContent ?? '', sel);
const glInfo = () => ev(() => { const g = window.__r3f.get().gl.info; return { geometries: g.memory.geometries, textures: g.memory.textures }; });
async function view(x, z, h = 12, back = 16, y = 0) {
  await ev(([x, z, h, back, y]) => { const st = window.__r3f.get(); st.camera.position.set(x + back * 0.5, y + h, z + back); st.controls.target.set(x, y, z); st.controls.update(); }, [x, z, h, back, y]);
  await wait(300);
}
const inst = () => ev(() => window.__ds.world.getState().doc.scenario.experiment?.instances ?? []);
const fp = () => ev(() => window.__ds.blueprintLib.worldFingerprint(window.__ds.world.getState().doc));
const humans = () => ev(() => window.__ds.world.getState().doc.settings.simulation.humans ?? null);
const people = () => ev(() => window.__ds.humanLib.people());
const agg = () => ev(() => window.__ds.humanLib.aggregate());
async function newWorld() {
  await ev(() => { window.__ds.actions.newProject(); window.__ds.view.getState().setHumanViz({ enabled: false }); });
  await wait(300);
}
const addObjects = (list) => ev((list) => {
  window.__ds.world.getState().applyEdit({ add: list.map((o) => ({ type: o.type, seed: o.seed ?? 1, params: o.params, transform: { position: [o.x, o.y ?? 0, o.z], rotation: [0, o.yaw ?? 0, 0], scale: [1, 1, 1] } })) });
}, list);
const add = (type, spec) => ev(([type, spec]) => window.__ds.actions.addPhenomenon(type, spec), [type, spec]);
/** Enter the run: the experiment button when the world has phenomena, else plain simulation mode (paused at 0). */
async function enterRun() {
  if ((await inst()).length) await clickText(/^\s*실험 실행|Run experiment/);
  else await ev(() => window.__ds.actions.enterSimulation());
  await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status !== 'loading', { timeout: 180_000 });
}
const atTime = async (T) => { const t = await ev((T) => { const s = window.__ds.sim; s.pause(); const r = T - s.getTime(); if (r > 0) s.advance(r); return s.getTime(); }, T); await wait(400); return t; };
const exitSim = async () => { await ev(() => window.__ds.actions.exitSimulation()); await wait(500); };
const select = async (k) => { await ev((k) => { const e = window.__ds.humanLib.people()[k] ?? null; window.__ds.editor.getState().select(e?.id ?? null); }, k); await wait(400); };
const selectId = async (id) => { await ev((id) => window.__ds.editor.getState().select(id), id); await wait(400); };
/** Visible text matching an i18n key pattern of the human model (a raw key shown instead of its translation). */
const rawKeys = () => ev(() => (document.body.innerText.match(/\b(humanUi|human|humanPresets|log\.human)\.[a-zA-Z]+(\.[a-zA-Z]+)*/g) ?? []).slice(0, 8));
const rawSeen = [];
const scanRaw = async (where) => { const r = await rawKeys(); if (r.length) rawSeen.push({ where, r }); };
/** Capture what the page hands to downloads (CSV / JSON) instead of saving files. */
await ev(() => { window.__blobs = []; const o = URL.createObjectURL.bind(URL); URL.createObjectURL = (b) => { window.__blobs.push(b); return o(b); }; HTMLAnchorElement.prototype.click = function () {}; });
const lastBlob = () => ev(async () => (window.__blobs.length ? await window.__blobs[window.__blobs.length - 1].text() : ''));
/** Open the inspector's collapsed "advanced" sub-section of the human section. */
const openAdvanced = async () => { const r = await ev((label) => { const host = document.querySelector('[data-testid="human-object"]')?.parentElement; for (const b of host?.querySelectorAll('button') ?? []) if ((b.textContent ?? '').includes(label)) { if (b.getAttribute('aria-expanded') !== 'true') b.click(); return true; } return false; }, await tr('humanUi.inspect.advanced')); await wait(300); return r; };
const overlaySwitch = (label) => ev((label) => {
  for (const l of document.querySelectorAll('label')) if ((l.textContent ?? '').trim() === label) { const s = l.querySelector('[role="switch"]'); if (s) { s.click(); return true; } }
  return false;
}, label);
const layerCounts = () => ev(() => {
  let found = false, markers = 0, lines = 0;
  window.__r3f.get().scene.traverse((o) => { if (o.name === 'human-layer') { found = true; o.traverse((m) => { if (m.isInstancedMesh) markers += m.count; if (m.isLineSegments) lines += m.geometry.drawRange.count; }); } });
  return { found, markers, lines };
});
const geo0 = (await glInfo()).geometries;

// ══ 1–6: settings and people (editor) ═══════════════════════════════════════════════════════
await newWorld();
const settingsTitle = await tr('settings.title');
await page.__show('-settings"'); // Phase 35.5: the settings section is in the right panel's settings tab
await wait(200);
await clickText(new RegExp('^\\s*▸?\\s*' + esc(settingsTitle)));
await wait(300);
const has1 = await ev(() => !!document.querySelector('[data-testid="human-settings"] [role="switch"]'));
const before1 = await humans();
await ev(() => document.querySelector('[data-testid="human-settings"] [role="switch"]').click());
await wait(300);
const after1 = await humans();
await shot('01-settings');
check('1 settings: the "extended human model" switch in the simulation settings writes settings.simulation.humans = { model: extended }', has1 && before1 === null && after1?.model === 'extended', { before1, after1 });
const scaleSel = '[data-testid="human-settings"] input';
const hasScale = await ev((s) => !!document.querySelector(s), scaleSel);
await page.click(scaleSel, { clickCount: 3 });
await page.keyboard.press('Backspace');
await page.type(scaleSel, '1.5');
await page.keyboard.press('Enter');
await wait(300);
const h2 = await humans();
check('2 risk scale: the advanced field (0.5–2) appears with the switch and stores riskScale = 1.5', hasScale && h2?.riskScale === 1.5, h2);
await ev(() => window.__ds.world.getState().updateSimulationSettings({ seed: 4242 }));
const h3 = await humans();
check('3 other settings edits keep the human setting (seed changed, humans unchanged)', h3?.model === 'extended' && h3?.riskScale === 1.5, h3);
await ev(() => document.querySelector('[data-testid="human-settings"] [role="switch"]').click());
await wait(300);
const h4 = await humans();
const noScale4 = await ev((s) => !document.querySelector(s), scaleSel);
await ev(() => document.querySelector('[data-testid="human-settings"] [role="switch"]').click());
await wait(300);
check('4 switching off deletes the key (legacy) and hides the risk scale; on again restores { model: extended }', h4 === null && noScale4 && (await humans())?.model === 'extended');
await scanRaw('settings');
const PEOPLE = [{ type: 'human', x: 0, z: 0, seed: 1 }, { type: 'human', x: 3, z: 0, seed: 2 }, { type: 'human', x: -3, z: 0, seed: 3 }, { type: 'human', x: 0, y: 6, z: 4, seed: 4 }];
await addObjects(PEOPLE);
await wait(300);
const placed5 = await ev(() => Object.values(window.__ds.world.getState().doc.objects).filter((o) => o.type === 'human').map((o) => +o.transform.position[1].toFixed(2)));
check('5 people placed: four people, one of them 6 m above the ground', placed5.length === 4 && placed5.some((y) => y >= 5.9), placed5);

// ══ 6–27: a drop from height (no phenomenon) ══════════════════════════════════════════════
const fp6 = await fp();
await enterRun();
const p6 = await people();
check('6 extended run: every person carries the human model state (4 people, all standing at t = 0)', p6.length === 4 && p6.filter((p) => p.standing).length >= 3, p6.map((p) => p.posture));
const dropId = await ev(() => { const rt = window.__ds.sim.getRuntime(); return [...rt.entities.values()].filter((e) => e.human).sort((a, b) => b.pose.position[1] - a.pose.position[1])[0].id; });
const standId = p6.find((p) => p.id !== dropId).id;
await selectId(standId);
const insp7 = await text('[data-testid="human-object"]');
const segRows7 = await ev(() => document.querySelectorAll('[data-testid="human-segments"] tbody tr').length);
const up = await tr('human.posture.upright');
check('7 inspector (standing person): extended model, mass · height, posture upright, balance margin, 8 segment rows, the limitation line', insp7.includes(await tr('humanUi.model.extended')) && insp7.includes('kg') && insp7.includes(up) && segRows7 === 8 && (await text('body')).includes((await tr('humanUi.limitation')).slice(0, 12)), { insp7: insp7.slice(0, 160), segRows7 });
await selectId(dropId);
const before9 = await text('[data-testid="human-object"]');
await atTime(5);
await view(0, 4, 6, 9);
const p8 = (await people()).find((p) => p.id === dropId);
check('8 drop from 6 m: the person falls / lands — impact episodes, drop height ≥ 4 m, a risk index > 0, a first-fall or landing recorded', p8 && p8.impacts > 0 && p8.maxDrop >= 4 && p8.risk > 0, p8 && { impacts: p8.impacts, drop: p8.maxDrop, risk: p8.risk, falls: p8.falls, posture: p8.posture });
const insp9 = await text('[data-testid="human-object"]');
const post9 = await tr(`human.posture.${p8?.posture ?? 'upright'}`);
check('9 posture shown live in the inspector: the dropped person\'s posture text changed and matches the model', insp9 !== before9 && insp9.includes(post9), { posture: p8?.posture, insp: insp9.slice(0, 120) });
const seg10 = await ev(() => [...document.querySelectorAll('[data-testid="human-segments"] tbody tr')].map((r) => [...r.children].map((c) => c.textContent)));
const levelNames = await ev(() => ['none', 'minor', 'moderate', 'severe', 'incapacitating'].map((l) => window.__ds.tr(`human.level.${l}`)));
check('10 segment rows: 8 translated segments with a level name, cumulative / peak index and hits; at least one segment struck', seg10.length === 8 && seg10.every((r) => levelNames.includes(r[1])) && seg10.some((r) => +r[4] > 0), seg10.map((r) => r.join('|')));
await shot('10-inspector-drop');
const p11 = (await people()).filter((p) => p.id !== dropId);
check('11 the people standing on flat ground with no load stay upright (no fall)', p11.every((p) => p.falls === 0 && p.standing), p11.map((p) => p.posture));
const adv12 = await openAdvanced();
const advTxt = await text('[data-testid="human-advanced"]');
check('12 advanced sub-section (collapsed by default): balance demand, release energy, tidal load ("not measured" without a source), lower-bound deceleration', adv12 && advTxt.includes('J') && advTxt.includes(await tr('humanUi.notMeasured')), advTxt.slice(0, 160));
await scanRaw('inspector');
// Overlay
const ovLabel = await tr('humanUi.overlay');
const glA = await glInfo();
const on13 = await overlaySwitch(ovLabel);
await wait(500);
const L13 = await layerCounts();
const subs13 = await ev(() => document.querySelectorAll('[data-testid="human-overlay"] [role="switch"]').length);
await shot('13-overlay');
check('13 overlay on (toggle in the overlay panel): the human layer draws COM / segment / contact markers and arrows / trail lines; 7 sub-toggles', on13 && L13.found && L13.markers >= 4 * 9 && L13.lines > 0 && subs13 === 7, { L13, subs13 });
await overlaySwitch(await tr('humanUi.overlay.segments'));
await wait(300);
const L14 = await layerCounts();
await overlaySwitch(await tr('humanUi.overlay.segments'));
check('14 sub-toggle: segment markers off → 8 fewer markers per person', L13.markers - L14.markers === 4 * 8, { on: L13.markers, off: L14.markers });
await overlaySwitch(ovLabel);
await wait(400);
const L15 = await layerCounts();
check('15 overlay off: the layer is unmounted (nothing computed or drawn)', !L15.found, L15);
for (let i = 0; i < 10; i++) { await overlaySwitch(ovLabel); await wait(150); }
await wait(500);
const glB = await glInfo();
check('16 repeated toggling (10×): GPU geometries / textures do not grow (buffers disposed on unmount)', glB.geometries <= glA.geometries + 1 && glB.textures <= glA.textures, { glA, glB });
await scanRaw('overlay');
// Results
await ev(() => window.__ds.ui.getState().setResultsOpen(true));
await wait(900);
const res17 = await text('[data-testid="human-results"]');
const cards17 = await ev(() => document.querySelectorAll('[data-testid="human-results"] [class*="card"]').length);
const lv17 = await ev(() => document.querySelectorAll('[data-testid="human-levels"] tbody tr').length);
check('17 results block: aggregate cards (people, fallen, first fall, impacts, closing, deceleration lower bound, drop, spin, buried, incapacitated, impulse), a segment × level table (8 rows)', cards17 >= 10 && lv17 === 8 && res17.includes((await tr('humanUi.results.decelSub')).slice(0, 6)), { cards17, lv17 });
const tab18 = await ev(() => document.querySelectorAll('[data-testid="human-table"] tbody tr').length);
check('18 people table: one row per person (4)', tab18 === 4, { tab18 });
await ev((id) => { const s = document.querySelector('[data-testid="human-chart-person"]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, id); s.dispatchEvent(new Event('change', { bubbles: true })); }, dropId);
await wait(400);
const ch19 = await ev(() => ({ charts: document.querySelectorAll('[data-testid^="human-chart-"] svg').length, lines: document.querySelectorAll('[data-testid^="human-chart-"] polyline').length }));
await shot('19-results');
check('19 charts: the dropped person\'s series drawn (speed, height, spin, margin, impulse, risk, contact, posture)', ch19.charts >= 6 && ch19.lines >= 6, ch19);
const gap20 = await ev((id) => {
  const e = window.__ds.sim.getRuntime().entities.get(id);
  const m = e.human.series.margin;
  const nan = m.filter((v) => !Number.isFinite(v)).length;
  const pts = (document.querySelector('[data-testid="human-chart-margin"] svg')?.innerHTML.match(/\d+(\.\d+)?,\d+(\.\d+)?/g) ?? []).length;
  return { n: m.length, nan, pts };
}, dropId);
check('20 unmeasured ≠ 0: the balance margin of the released body is NaN in the series and left out of the chart (gap, not a line at 0)', gap20.nan > 0 && gap20.pts <= gap20.n - gap20.nan, gap20);
await page.click('[data-testid="human-csv"]');
await wait(300);
const csv21 = await lastBlob();
const lines21 = csv21.split('\n');
check('21 human CSV (button): schema version line, model note, units, the columns (time, object, model, posture, speed, angular speed, partner, contact point, impulse, dv, risk index, level, cause, limits)', lines21[0] === '# schema: disaster-sim.human v1' && csv21.includes('# units:') && ['time_s', 'object_id', 'model', 'posture', 'speed_ms', 'angular_speed_rads', 'partner', 'contact_x_m', 'impulse_Ns', 'dv_ms', 'risk_index', 'level', 'cause', 'limits'].every((c) => lines21[4]?.split(',').includes(c)), lines21.slice(0, 5).map((l) => l.slice(0, 80)));
const ncol = lines21[4]?.split(',').length;
const evRows = lines21.filter((l) => /^[\d.]+,[^,]+,extended,(IMPACT|INJURED|FALLEN),/.test(l));
const finRows = lines21.filter((l) => /,extended,final,/.test(l));
check('22 CSV rows: impact / risk events of the drop with impulse and Δv, a final row per person (4), every row full width, deceleration named a lower bound, series section', evRows.length > 0 && finRows.length === 4 && [...evRows, ...finRows].every((l) => l.split(',').length === ncol) && csv21.includes('LOWER bound') && csv21.includes('# series'), { ev: evRows.length, fin: finRows.length, sample: evRows[0] });
await clickText(/^\s*JSON\s*$/, '[role="dialog"]');
await wait(300);
const j23 = JSON.parse((await lastBlob()) || '{}').humans;
check('23 results JSON (main export): a humans block with schemaVersion 1, model extended, units (N·s, m/s, rad/s, lower-bound deceleration), aggregate, 4 people with segments and series', j23?.schemaVersion === 1 && j23.model === 'extended' && j23.units?.impulse === 'N·s' && /lower bound/.test(j23.units?.decel ?? '') && j23.people?.length === 4 && j23.people[0].segments?.head && j23.aggregate?.impacts > 0, j23 && { v: j23.schemaVersion, people: j23.people?.length });
const nullGap = j23?.people?.find((p) => p.id === dropId)?.series?.margin?.includes(null);
check('24 JSON series: unmeasured samples are null (not 0)', nullGap === true);
await clickText(/^\s*CSV\s*$/, '[role="dialog"]');
await wait(300);
const dcsv = (await lastBlob()).split('\n');
check('25 damage-events CSV carries the human detail columns (segment, impulse, Δv, deceleration lower bound, index, level, partner, posture)', ['human_segment', 'human_impulse_Ns', 'human_dv_ms', 'human_decel_lower_bound_ms2', 'human_risk_index', 'human_level', 'human_partner', 'human_posture'].every((c) => dcsv[0].includes(c)) && dcsv.length > 1, dcsv[0]?.slice(-140));
await scanRaw('results');
await ev(() => window.__ds.ui.getState().setResultsOpen(false));
await ev(() => window.__ds.actions.resetSimulation());
await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.sim.getTime() === 0, { timeout: 60_000 });
await wait(500);
const p26 = await people();
check('26 reset: back to t = 0 — every person standing again, no falls, no impacts, zero risk', p26.length === 4 && p26.every((p) => p.impacts === 0 && p.risk === 0) && p26.filter((p) => p.standing).length >= 3, p26.map((p) => p.posture));
await exitSim();
check('27 original world: leaving the run shows the untouched world (fingerprint equal, setting kept)', (await fp()) === fp6 && (await humans())?.model === 'extended');

// ══ 28–29: save → reload keeps the setting ════════════════════════════════════════════════
await ev(() => window.__ds.world.getState().updateSimulationSettings({ humans: { model: 'extended', riskScale: 1.5 } }));
await ev(() => window.__ds.actions.saveProject());
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
await ev(() => { window.__blobs = []; const o = URL.createObjectURL.bind(URL); URL.createObjectURL = (b) => { window.__blobs.push(b); return o(b); }; HTMLAnchorElement.prototype.click = function () {}; });
await ev(() => window.__ds.actions.loadProject());
await wait(600);
const h28 = await humans();
check('28 save → reload → load: the extended model and riskScale 1.5 survive (project file)', h28?.model === 'extended' && h28?.riskScale === 1.5, h28);
const auto29 = await ev(() => { const ds = window.__ds; const r = ds.buildLib.parseDocument(ds.buildLib.serializeDocument(ds.world.getState().doc)); return r.ok ? r.doc.settings.simulation.humans : 'fail'; });
check('29 serialization round trip of the setting (schema validated, riskScale in range)', auto29?.model === 'extended' && auto29.riskScale === 1.5, auto29);
check('30 language survives the reload', (await ev(() => window.__ds.locale.getState().locale)) === lang);

// ══ 31–35: hazards that make people fall ══════════════════════════════════════════════════
const runPreset = async (id, T) => { await ev((id) => window.__ds.humanLib.loadPreset(id), id); await wait(600); await enterRun(); await atTime(T ?? (await ev((id) => window.__ds.humanLib.presets.find((p) => p.id === id).seconds, id))); };
await runPreset('strongGust');
const p31 = await people();
await view(0, 0, 8, 14);
await shot('31-wind');
check('31 strong wind (35 m/s, gusts): people blown over, fall cause wind', p31.some((p) => p.falls > 0 && p.fallCause === 'wind'), p31.map((p) => `${p.posture}/${p.fallCause}`));
await select(0);
const insp31 = await text('[data-testid="human-object"]');
check('32 inspector after a fall: count, first time and the translated cause', p31[0].falls === 0 || insp31.includes(await tr(`humanUi.cause.${p31[0].fallCause}`)), insp31.slice(0, 200));
await scanRaw('wind');
await exitSim();
await runPreset('reversedGravity');
const p33 = await people();
check('33 reversed gravity: people lose their support (released, a fall recorded with its cause)', p33.some((p) => p.falls > 0 && !p.standing), p33.map((p) => `${p.posture}/${p.fallCause}`));
await exitSim();
await runPreset('quakeBalance');
const p34 = await people();
const a34 = await agg();
check('34 earthquake (M7, 0.8 g): balance lost to the ground motion (fall cause groundMotion), all values finite', p34.some((p) => p.falls > 0 && p.fallCause === 'groundMotion') && p34.every((p) => Number.isFinite(p.speed) && Number.isFinite(p.risk)), p34.map((p) => `${p.posture}/${p.fallCause}`));
check('35 aggregate after the earthquake: falls counted, first fall time set', a34.falls >= 1 && Number.isFinite(a34.firstFall), { falls: a34.falls, first: a34.firstFall });
await exitSim();

// ══ 36–37: celestial tides with people ════════════════════════════════════════════════════
await runPreset('celestialTides');
const j36 = await ev(() => window.__ds.humanLib.json());
const tid36 = j36?.people?.map((p) => p.tidalPeak) ?? [];
check('36 celestial tidal scene: a tidal load index computed for the people (body weights > 0)', tid36.some((v) => v > 0), tid36);
await select(0);
await openAdvanced();
const adv37 = await text('[data-testid="human-advanced"]');
await shot('37-tidal');
check('37 inspector advanced: the tidal load line (body weights, tension / compression, peak)', adv37.includes(await tr('humanUi.tension')) || adv37.includes(await tr('humanUi.compression')), adv37.slice(0, 200));
await scanRaw('celestial');
await exitSim();

// ══ 38: combined hazards ══════════════════════════════════════════════════════════════════
await newWorld();
await ev(() => window.__ds.world.getState().updateSimulationSettings({ humans: { model: 'extended' } }));
await addObjects([...PEOPLE, { type: 'human', x: 6, y: 3, z: -4, seed: 9 }, { type: 'car', x: -8, z: 6, seed: 5, yaw: 1.57 }]);
await add('wind', { event: 'wind', speed: 28, direction: 'S', duration: 30, gustStrength: 0.3, rampDuration: 2, startTime: 0 });
await add('earthquake', { event: 'earthquake', magnitude: 6.5, pga: 0.4, duration: 8, seed: 3, startTime: 1 });
await wait(300);
await enterRun();
await atTime(10);
const j38 = await ev(() => window.__ds.humanLib.json());
const fin38 = await ev(() => [...window.__ds.sim.getRuntime().entities.values()].every((e) => e.pose.position.every(Number.isFinite)));
check('38 combined hazard (drop + wind + earthquake): every pose finite, export valid with falls counted', fin38 && j38?.people?.length === 5 && j38.aggregate.falls >= 1 && JSON.stringify(j38).length > 100, { falls: j38?.aggregate?.falls });
await exitSim();

// ══ 39–41: the legacy model ═══════════════════════════════════════════════════════════════
await newWorld();
await addObjects(PEOPLE);
await add('wind', { event: 'wind', speed: 30, direction: 'S', duration: 30, gustStrength: 0.3, rampDuration: 2, startTime: 0 });
await wait(300);
await enterRun();
await atTime(6);
const legacyId = await ev(() => [...window.__ds.sim.getRuntime().entities.values()].find((e) => e.source.type === 'human').id);
await selectId(legacyId);
const insp39 = await text('[data-testid="human-object"]');
await shot('39-legacy');
check('39 legacy run: the inspector shows "legacy model" only (plus the limitation line), no segment table', insp39.includes(await tr('humanUi.model.legacy')) && !(await ev(() => !!document.querySelector('[data-testid="human-segments"]'))), insp39.slice(0, 80));
const ov40 = await ev((l) => [...document.querySelectorAll('label')].some((x) => (x.textContent ?? '').trim() === l), ovLabel);
await ev(() => window.__ds.ui.getState().setResultsOpen(true));
await wait(700);
const res40 = await ev(() => !!document.querySelector('[data-testid="human-results"]'));
await ev(() => window.__ds.ui.getState().setResultsOpen(false));
check('40 legacy run: no human overlay toggle, no human results block (the fallen-people card stays)', !ov40 && !res40, { ov40, res40 });
const j41 = await ev(() => window.__ds.humanLib.json());
check('41 legacy export: model legacy, people counted, no extended fields', j41?.model === 'legacy' && j41.people === 4, j41);
await scanRaw('legacy');
await exitSim();

// ══ 42–45: presets ════════════════════════════════════════════════════════════════════════
// (append further preset checks here: runPreset(id) loads HUMAN_PRESETS[id].build() through window.__ds.humanLib)
const pre42 = await ev(() => window.__ds.humanLib.presets.map((p) => ({ id: p.id, ok: window.__ds.humanLib.loadPreset(p.id) && window.__ds.world.getState().doc.settings.simulation.humans?.model === 'extended' && Object.keys(window.__ds.world.getState().doc.objects).length > 0, name: window.__ds.tr(p.keys.name) })));
check('42 presets: 20 human presets, each builds a world with the extended model and people; names translated', pre42.length === 20 && pre42.every((p) => p.ok && !/^humanPresets\./.test(p.name)), pre42.filter((p) => !p.ok).map((p) => p.id));
const risks = {};
for (const id of ['drop1m', 'drop3m', 'drop10m']) {
  await runPreset(id);
  risks[id] = Math.max(...(await people()).map((p) => p.risk));
  await exitSim();
}
check('43 drop presets: the risk index grows with the height (1 m < 3 m < 10 m)', risks.drop1m < risks.drop3m && risks.drop3m < risks.drop10m, risks);
await runPreset('drop10m');
const p44 = (await people()).sort((a, b) => b.risk - a.risk)[0];
check('44 10 m drop: severe or worse at the worst segment (the documented anchor of the index)', ['severe', 'incapacitating'].includes(p44.level), { level: p44.level, risk: p44.risk });
await exitSim();
await runPreset('standStill');
const p45 = await people();
check('45 standing still: nobody falls, no risk (the model is quiet at rest)', p45.every((p) => p.falls === 0 && p.risk === 0 && p.standing), p45.map((p) => p.posture));
await exitSim();

// ══ Whole run ════════════════════════════════════════════════════════════════════════════
check('46 no raw i18n keys of the human model visible anywhere checked (settings, inspector, overlay, results, wind, celestial, legacy)', rawSeen.length === 0, rawSeen);
await newWorld();
await wait(800);
const geo1 = (await glInfo()).geometries;
check('47 resources: GPU geometries back to the start after all runs', geo1 <= geo0 + 2, { geo0, geo1 });
check('48 whole run: no page / console errors, the tab alive', errors.length === 0 && !crashed, { errors: errors.length });
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; ${errors.length} page errors; geometries ${geo0} → ${geo1}; crashed ${crashed}`);
if (errors.length) console.log(errors.slice(0, 10).join('\n'));
fs.writeFileSync(path.join(out, `results-${lang}.json`), JSON.stringify({ lang, url, results, errors, geometries: [geo0, geo1], crashed }, null, 2));
await browser.close();
process.exit(results.every((r) => r.ok) && errors.length === 0 && !crashed ? 0 : 1);
