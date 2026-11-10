// Browser verification of Blueprints, the library, world templates and the world creation
// wizard (Phase 20): 22 scenarios through the real UI (Blueprints tab, viewport drags / clicks,
// keys, file chooser, downloads, dialogs) with state checks after each step.
//
//   npx vite --port 5201 &     (or a production preview)
//   node scripts/verify-blueprints.mjs http://localhost:5201/ ./docs/verify/blueprints     (LANG_UI=en)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [url = 'http://localhost:5201/', out = './docs/verify/blueprints'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const lang = process.env.LANG_UI ?? 'ko';
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-dl-'));
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,1000'],
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 }, protocolTimeout: 900_000,
});
const errors = [];
const results = [];
const page = await browser.newPage();
// Phase 35.5 compatibility: the right panel has tabs and the command console is a drawer — before an old selector / page function
// is used, the tab (or drawer) that holds it is shown. (The checks themselves are unchanged.)
{
  const _ev = page.evaluate.bind(page);
  const where = (s) => (/-settings"|-settings\]/.test(s) ? 'settings' : /-probe"|-probe\]|road-sim/.test(s) ? 'analysis' : /홍수 시뮬레이션 실행|Run flood|flood-form/.test(s) ? 'legacy:flood' : /지진 실행|Run earthquake|eq-form/.test(s) ? 'legacy:earthquake' : /"시뮬레이션 실행"|"Run simulation"|wind-form/.test(s) ? 'legacy:wind' : /-inspector"|-inspector\]/.test(s) ? 'selection' : /실험 실행|Run experiment|실험 적용|Apply now|현상 추가|Add phenomenon|시나리오 비교|Compare/.test(s) ? 'phenomena' : /data-instance|exp-edit|experiment-panel|exp-issue|exp-invalid|exp-advanced|atmos-preview|-preview"/.test(s) ? 'phenomena' : /placeholder\*="Enter"|cmd-|command-input/.test(s) ? 'command' : null);
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
page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Renamed by test' : undefined));
const bcdp = await browser.target().createCDPSession();
await bcdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
await page.goto(url + '?devtools', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
await page.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('ds.library'); });
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
async function screenOf(x, z) {
  return ev(([x, z]) => {
    const st = window.__r3f.get();
    const y = window.__ds.buildLib.samplerFor(window.__ds.world.getState().doc.terrain).sampleHeight(x, z);
    const v = st.camera.position.clone().set(x, y, z).project(st.camera);
    const r = st.gl.domElement.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  }, [x, z]);
}
async function clickWorld(x, z, count = 1) {
  const [sx, sy] = await screenOf(x, z);
  await page.mouse.move(sx, sy);
  await wait(60);
  await page.mouse.click(sx, sy, { count });
  await wait(200);
}
async function moveWorld(x, z) {
  const [sx, sy] = await screenOf(x, z);
  await page.mouse.move(sx, sy, { steps: 4 });
  await wait(120);
}
async function dragWorld([x0, z0], [x1, z1]) {
  let a = await screenOf(x0, z0), b = await screenOf(x1, z1);
  // Phase 35.5: the 3D view is taller — a corner may now lie under a viewport overlay (toolbar); the same rectangle is
  // then dragged from the opposite corner.
  const onCanvas = (p) => ev(([x, y]) => document.elementFromPoint(x, y)?.tagName === 'CANVAS', p);
  if (!(await onCanvas(a)) && (await onCanvas(b))) [a, b] = [b, a];
  await page.mouse.move(a[0], a[1]);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) { await page.mouse.move(a[0] + ((b[0] - a[0]) * k) / 10, a[1] + ((b[1] - a[1]) * k) / 10); await wait(25); }
  await page.mouse.up();
  await wait(500);
}
async function top(h = 230) {
  await ev((h) => { const st = window.__r3f.get(); st.camera.position.set(0, h, h * 0.01); st.controls.target.set(0, 0, 0); st.controls.update(); st.camera.lookAt(0, 0, 0); }, h);
  await wait(300);
}
async function topAt(x, z, h = 140) {
  await ev(([x, z, h]) => { const st = window.__r3f.get(); st.camera.position.set(x, h, z + h * 0.01); st.controls.target.set(x, 0, z); st.controls.update(); st.camera.lookAt(x, 0, z); }, [x, z, h]);
  await wait(300);
}
/** Select a library card (a click on a selected card deselects it). */
async function pick(id) {
  if ((await ev((id) => document.querySelector(`[data-entry="${id}"]`)?.getAttribute('aria-pressed'), id)) !== 'true') await page.click(`[data-entry="${id}"]`);
  await wait(250);
}
async function oblique() {
  await ev(() => { const st = window.__r3f.get(); st.camera.position.set(95, 115, 150); st.controls.target.set(0, 0, 0); st.controls.update(); });
  await wait(500);
}
const lib = () => ev(() => window.__ds.library.getState().entries.map((e) => ({ id: e.id, name: e.name, kind: e.kind, category: e.category, counts: e.counts, favorite: e.favorite })));
const doc = () => ev(() => { const d = window.__ds.world.getState().doc; return { objects: Object.keys(d.objects).length, roads: Object.keys(d.roads.segments).length, features: d.landscape.features.length, past: window.__ds.world.getState().past.length, name: d.meta.name }; });
const fingerprint = () => ev(() => window.__ds.blueprintLib.worldFingerprint(window.__ds.world.getState().doc));
const capture = () => ev(() => { const c = window.__ds.blueprints.getState().capture; return c.result ? { counts: c.result.report.counts, deps: c.result.blueprint.dependencies.map((d) => [d.kind, d.resolution, d.refs.length]), mask: !!c.result.blueprint.terrain?.mask, category: c.result.blueprint.meta.category } : null; });
const plan = () => ev(() => { const p = window.__ds.blueprints.getState().place; return { pinned: p.pinned, yaw: p.yaw, options: p.options, report: p.plan ? { errors: p.plan.report.errors.map((e) => e.code), warnings: p.plan.report.warnings.map((e) => e.code), terrain: p.plan.report.terrain.policy, snapped: p.plan.report.roads.snapped, connections: p.plan.report.connections.length, counts: p.plan.report.counts } : null }; });
async function newCapture(kind) {
  await page.click('[data-testid="bp-new"]');
  await wait(150);
  await page.click(`[data-testid="bp-capture-${kind}"]`);
  await wait(300);
}
async function saveCapture(name) {
  await page.click('[data-testid="bp-name"]', { clickCount: 3 });
  await page.type('[data-testid="bp-name"]', name);
  await page.click('[data-testid="bp-capture-save"]');
  await wait(900);
}
/** Set an input's value the way React sees typing (number inputs cannot be select-all'd reliably). */
const setInput = (sel, value) => ev(([sel, value]) => {
  const el = document.querySelector(sel);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, [sel, value]);
const tab = async () => { await page.click('[data-testid="tab-blueprints"]'); await wait(500); };

// ── Source world: mixed city + nature (roads, buildings, river, lake, hill, forest) ─────────
await ev(() => window.__ds.actions.newProject());
await ev(() => window.__ds.natureActions.applyEnvironment('mixedUrbanNatural', 1));
await wait(800);
await tab();
await top();

// 1. Building blueprint (rectangle around a few buildings).
const b0 = await ev(() => Object.values(window.__ds.world.getState().doc.objects).filter((o) => o.type === 'building').map((o) => o.transform.position)[0]);
await newCapture('rect');
await dragWorld([b0[0] - 14, b0[2] - 14], [b0[0] + 14, b0[2] + 14]);
let C = await capture();
await page.select('[data-testid="bp-category"]', 'residential');
await shot('01-building-capture');
await saveCapture('Houses / 주택');
let L = await lib();
check('1 building blueprint (rectangle capture → library)', C && C.counts.buildings >= 1 && L.some((e) => e.name === 'Houses / 주택' && e.category === 'residential' && e.counts.buildings >= 1), { C, L });

// 2. Road district (rectangle around a junction, roads cut at the boundary).
await newCapture('rect');
await dragWorld([-55, -85], [-5, -35]);
C = await capture();
await saveCapture('Junction / 교차로');
L = await lib();
const ext = C?.deps.find((d) => d[0] === 'roadExternal');
check('2 road district blueprint (junction, cut road ends recorded)', C && C.counts.roads >= 3 && ext && ext[2] >= 3, C);

// 3. Nature blueprint (polygon: hill + forest).
await newCapture('polygon');
await topAt(68, -52);
for (const [x, z] of [[42, -90], [94, -90], [94, -15]]) await clickWorld(x, z);
await clickWorld(42, -15, 2);
await wait(600);
C = await capture();
await top();
await shot('03-nature-capture');
await saveCapture('Forest hill / 숲 언덕');
check('3 nature blueprint (polygon capture: hill + forest, terrain mask)', C && C.counts.features >= 1 && C.counts.vegetation > 5 && C.mask, C);

// 4. City + nature blueprint (rectangle over river, lake, roads, buildings).
await newCapture('rect');
await dragWorld([-94, -30], [94, 92]);
C = await capture();
await saveCapture('Riverside city / 강변 도시');
check('4 city + nature blueprint (roads, buildings, river, lake)', C && C.counts.roads > 0 && C.counts.buildings > 0 && C.counts.water >= 2 && C.category === 'mixed', C);

// 5. Library search.
await page.type('[data-testid="bp-search"]', 'Junction /');
await wait(300);
const found = await ev(() => [...document.querySelectorAll('[data-testid="bp-library"] [data-entry]')].map((e) => e.getAttribute('data-entry')));
const junctionId = (await lib()).find((e) => e.name.startsWith('Junction')).id;
check('5 library search (by name)', found.length === 1 && found[0] === junctionId, found);
await setInput('[data-testid="bp-search"]', '');
await wait(200);

// 6. Favorites.
await page.click(`[data-star="${junctionId}"]`);
await page.click('[data-filter="favorites"]');
await wait(300);
const favs = await ev(() => [...document.querySelectorAll('[data-testid="bp-library"] [data-entry]')].map((e) => e.getAttribute('data-entry')));
check('6 favorites (star → favorites filter)', favs.length === 1 && favs[0] === junctionId, favs);
await page.click('[data-filter="all"]');
await shot('06-library');

// ── Destination: a new world with a straight road on x = 0 ───────────────────────────────
await ev(() => window.__ds.actions.newProject());
await ev(() => { const L = window.__ds.roadLib; window.__ds.world.getState().applyEdit({ roads: L.drawRoad(window.__ds.world.getState().doc.roads, [[0, -96], [0, 96]], { curved: false, profile: L.defaultProfile() }).network }); });
await wait(500);
const before7 = await doc();

// 7. Preview (ghost follows the cursor, the world is untouched).
await pick(junctionId);
await page.click('[data-testid="bp-place"]');
await wait(500);
await moveWorld(40, 20);
await moveWorld(45, 25);
await wait(400);
const ghost = await ev(() => { let n = 0; window.__r3f.get().scene.traverse((o) => { if (o.isMesh && o.material?.transparent && o.visible) n++; }); return window.__ds.blueprints.getState().place.hover ? n : -1; });
await oblique();
await moveWorld(45, 25);
await shot('07-preview');
await top();
check('7 preview (ghost, nothing written to the world)', JSON.stringify(await doc()) === JSON.stringify(before7) && ghost > 0 && (await plan()).pinned === null, { ghost, d: await doc() });

// 8. Rotation and position (R / T keys, click to pin, click again to move the pin).
await page.keyboard.press('r');
await page.keyboard.press('t');
await clickWorld(30, 10);
await wait(400);
let P = await plan();
const yaw8 = P.yaw;
await clickWorld(25, 0);
await wait(400);
P = await plan();
check('8 rotation (R = 90°, T = fine step) and position (pin, re-pin)', Math.abs(yaw8 - (Math.PI / 2 + Math.PI / 12)) < 1e-6 && P.pinned && Math.abs(P.pinned[0] - 25) < 1.01 && Math.abs(P.pinned[1]) < 1.01, P);
// Back to 0° for the road test.
await setInput('[data-testid="bp-yaw"]', '0');
await wait(400);

// 9. Terrain merge policy (apply → plan uses it, blend shows the width slider).
await page.click('[data-terrain-policy="apply"]');
await wait(500);
P = await plan();
const ok9 = P.options.terrain === 'apply' && P.report?.terrain === 'apply';
await page.click('[data-terrain-policy="blend"]');
await wait(400);
const slider = await ev(() => !!document.querySelector('[data-testid="bp-placement"] input[type="range"]'));
await page.click('[data-terrain-policy="offset"]');
await wait(400);
check('9 terrain merge policy selection (apply / blend / offset)', ok9 && slider && (await plan()).options.terrain === 'offset', P);

// 10. Road connection: snap the open west end of the junction onto the road at x = 0.
await page.click('[data-road-policy="snap"]');
await wait(600);
P = await plan();
await oblique();
await shot('10-road-connection');
await top();
check('10 road connection (snap endpoints, connection preview)', P.report && P.report.snapped >= 1 && P.report.connections >= 1 && !P.report.errors.length, P.report);

// 11. Paste (confirm) — one undo step.
const fpBefore = await fingerprint();
const past11 = (await doc()).past;
await page.click('[data-testid="bp-confirm"]');
await wait(900);
const after11 = await doc();
const fpAfter = await fingerprint();
check('11 blueprint placed (roads + objects, ONE undo step)', after11.roads > before7.roads && after11.past === past11 + 1, after11);

// 12. Undo / redo.
await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
await wait(600);
const fpUndo = await fingerprint();
await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('z'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
await wait(600);
check('12 undo restores the world exactly; redo restores the placement', fpUndo === fpBefore && (await fingerprint()) === fpAfter);
await page.click('[data-testid="bp-place-close"]');
await wait(300);

// 13. Export (download a .blueprint.json).
await pick(junctionId);
await page.click('[data-testid="bp-export"]');
let file = null;
for (let k = 0; k < 40 && !file; k++) { await wait(150); file = fs.readdirSync(downloads).find((f) => f.endsWith('.blueprint.json')); }
const exported = file ? JSON.parse(fs.readFileSync(path.join(downloads, file), 'utf8')) : null;
check('13 export (file downloaded, format v2, local ids)', exported && exported.format === 'disaster-sim/blueprint' && exported.version === 2 && exported.roads.segments.every((s) => /^s\d+$/.test(s.id)), file);

// 14. Import: the exported file (duplicate → added as a copy) and a broken file (rejected).
const n14 = (await lib()).length;
{
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('[data-testid="bp-import"]')]);
  await chooser.accept([path.join(downloads, file)]);
}
await page.waitForSelector('[data-testid="bp-import-dialog"]');
const dup = await ev(() => !!document.querySelector('[data-testid="bp-import-dup"]'));
await shot('14-import');
await page.click('[data-testid="bp-import-add"]');
await wait(600);
const bad = path.join(downloads, 'broken.blueprint.json');
fs.writeFileSync(bad, JSON.stringify({ ...exported, roads: { ...exported.roads, segments: [{ ...exported.roads.segments[0], a: 'n999' }] } }));
{
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('[data-testid="bp-import"]')]);
  await chooser.accept([bad]);
}
await page.waitForSelector('[data-testid="bp-import-error"]');
const errText = await ev(() => document.querySelector('[data-testid="bp-import-error"]').textContent);
await page.keyboard.press('Escape');
await wait(300);
check('14 import (validated preview, duplicate handled as a copy; broken references refused)', dup && (await lib()).length === n14 + 1 && /n999/.test(errText), errText);

// 15. Save the current world as a template.
await page.click('[data-testid="bp-save-template"]');
await page.waitForSelector('[data-testid="bp-template-dialog"]');
await page.click('[data-testid="bp-template-name"]', { clickCount: 3 });
await page.type('[data-testid="bp-template-name"]', 'Junction world');
await page.click('[data-testid="bp-template-save"]');
await wait(800);
L = await lib();
check('15 world template saved (library, Complete Worlds)', L.some((e) => e.kind === 'world' && e.name === 'Junction world' && e.category === 'world'), L.filter((e) => e.kind === 'world'));

// 16. New world from a template (wizard: name → template → seed → preview → create).
await page.click('[data-testid="topbar-new-world"]');
await page.waitForSelector('[data-testid="world-wizard"]');
await page.type('[data-testid="wiz-name"]', 'Wizard Valley');
await page.click('[data-testid="wiz-next"]');
await wait(600);
await page.click('[data-template="builtin-tpl-riverValley"]');
await page.click('[data-testid="wiz-next"]');
await setInput('[data-testid="wiz-seed"]', '7');
await page.click('[data-testid="wiz-next"]');
await page.waitForSelector('[data-testid="wiz-stats"]', { timeout: 60_000 });
await shot('16-wizard');
await page.click('[data-testid="wiz-next"]');
await page.click('[data-testid="wiz-create"]');
await wait(1500);
const d16 = await doc();
const mode16 = await ev(() => [window.__ds.editor.getState().mode, window.__ds.editor.getState().tool]);
check('16 world created from a template (wizard → build mode)', d16.name === 'Wizard Valley' && d16.objects > 20 && d16.features > 0 && d16.past === 0 && mode16[0] === 'editor' && mode16[1] === 'select', { d16, mode16 });
await oblique();
await shot('16-created');

// 17. Save / load (top bar): edits after saving are replaced by the saved world.
await ev(() => window.__ds.actions.saveProject());
const fpSaved = await fingerprint();
await ev(() => window.__ds.world.getState().applyEdit({ remove: Object.keys(window.__ds.world.getState().doc.objects).slice(0, 5) }));
await ev(() => window.__ds.actions.loadProject());
await wait(800);
check('17 save / load round trip (fingerprint identical)', (await fingerprint()) === fpSaved);

// 18–21. Hazards on the template world; 22. original world restored.
const fp0 = await fingerprint();
async function run(specs, seconds) {
  await ev(async (s) => { await window.__ds.actions.runSimulation(s); window.__ds.sim.pause(); }, specs);
  await page.waitForFunction(() => window.__ds.sim.isLoaded(), { timeout: 300_000 });
  await ev(() => window.__ds.sim.play());
  await page.waitForFunction((t) => window.__ds.sim.getTime() >= t, { timeout: 300_000 }, seconds);
  await ev(() => window.__ds.sim.pause());
  await wait(500);
  return ev(() => {
    const env = window.__ds.sim.getEnvironment();
    const e = window.__ds.sim.getDamageEvents();
    const by = { wind: 0, earthquake: 0, flood: 0 };
    for (const x of e) by[x.hazard] = (by[x.hazard] ?? 0) + 1;
    return { events: e.length, by, water: env.flood.field ? Math.round(env.flood.field.totalVolume()) : 0, err: env.flood.field ? env.flood.field.budget.error : 0 };
  });
}
await oblique();
const r18 = await run([{ event: 'wind', speed: 50, direction: 'E', duration: 30, gustStrength: 0.35, rampDuration: 3 }], 12);
await shot('18-typhoon');
check('18 typhoon on a template world', r18.by.wind > 0, r18);
await ev(() => window.__ds.actions.exitSimulation());
const r19 = await run([{ event: 'earthquake', magnitude: 7.2, pga: 0.8, duration: 12, seed: 5 }], 13);
check('19 earthquake', r19.by.earthquake > 0, r19);
await ev(() => window.__ds.actions.exitSimulation());
const r20 = await run([{ event: 'rain', intensity: 150, duration: 600 }], 15);
await shot('20-flood');
check('20 flood (river water + rain, mass budget closed)', r20.water > 500 && Math.abs(r20.err) < 1e-3 * r20.water, r20);
await ev(() => window.__ds.actions.exitSimulation());
const r21 = await run([{ event: 'wind', speed: 40, direction: 'E', duration: 30, gustStrength: 0.3, rampDuration: 2 }, { event: 'earthquake', magnitude: 6.8, pga: 0.6, duration: 10, seed: 2 }, { event: 'rain', intensity: 120, duration: 600 }], 12);
check('21 multi-hazard (wind + earthquake + rain)', r21.events > 0 && r21.water > 0, r21);
await ev(() => window.__ds.actions.exitSimulation());
await wait(500);
check('22 original world restored after every run', (await fingerprint()) === fp0);

// Panel screenshots in this language.
await tab();
await page.click('[data-filter="all"]');
await wait(300);
await pick('builtin-mixedDistrict');
await wait(1500);
await shot('23-detail');
await page.click('[data-testid="bp-place"]');
await wait(800);
await oblique();
await moveWorld(0, 0);
await clickWorld(0, 0);
await wait(1500);
await shot('24-placement');
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
await wait(300);

console.log(JSON.stringify({ errors }, null, 1));
fs.writeFileSync(path.join(out, `results-${lang}.json`), JSON.stringify({ results, errors }, null, 2));
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
fs.rmSync(downloads, { recursive: true, force: true });
await browser.close();
