// Phase 17 browser verification (real Chrome, real mouse / keyboard): the 14 scenarios of the
// brief in Korean or English —
//  1 create a building in an empty world   2 change floors and size   3 add column / wall / window
//  4 change materials                      5 place on sloped terrain   6 duplicate
//  7 undo / redo                           8 save and load             9 typhoon
// 10 earthquake                           11 flood                    12 combined hazards
// 13 damage state (inspector)             14 original world restored
// plus console errors. Buttons are found by their localized labels (window.__ds.tr).
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/verify-buildings.mjs http://localhost:4173/ ./shots          (LANG_UI=en for English)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:4173/', out = './shots'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const lang = process.env.LANG_UI ?? 'ko';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,1000'],
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 }, protocolTimeout: 900_000,
});
const errors = [];
const results = [];
let step = 'setup';
const page = await browser.newPage();
// Phase 35.5 compatibility: the right panel has tabs and the command console is a drawer — before an old selector / page function
// is used, the tab (or drawer) that holds it is shown. (The checks themselves are unchanged.)
{
  const _ev = page.evaluate.bind(page);
  const where = (s) => (/-settings"|-settings\]/.test(s) ? 'settings' : /-probe"|-probe\]/.test(s) ? 'analysis' : /data-instance|exp-edit|experiment-panel|exp-issue|exp-invalid|exp-advanced|atmos-preview|-preview"/.test(s) ? 'phenomena' : /placeholder\*="Enter"|cmd-|command-input/.test(s) ? 'command' : null);
  const show = async (src) => {
    const t = where(String(src));
    if (!t) return;
    const done = await _ev((t) => { const u = window.__ds?.ui?.getState(); if (!u) return true; if (t === 'command') { if (u.commandOpen) return true; u.setCommandOpen(true); return false; } if (u.rightTab === t && u.rightOpen) return true; u.setRightTab(t); return false; }, t).catch(() => true);
    if (!done) await new Promise((r) => setTimeout(r, 150));
  };
  for (const m of ['click', '$', '$$', 'type', 'focus', 'select', 'waitForSelector', '$eval', '$$eval']) {
    const o = page[m].bind(page);
    page[m] = async (sel, ...rest) => { await show(sel); return o(sel, ...rest); };
  }
  page.evaluate = async (fn, ...rest) => { await show(fn); return _ev(fn, ...rest); };
}
page.on('pageerror', (e) => errors.push(`[${step}] pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${step}] console: ${m.text()}`); });
page.on('dialog', (d) => d.accept());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (n) => page.screenshot({ path: path.join(out, `bld-${n}-${lang}.png`) });
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); step = `after ${name.split(' ')[0]}`; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const ds = (fn, ...args) => page.evaluate(fn, ...args);
const tr = (key) => ds((k) => window.__ds.tr(k), key);
const objects = () => ds(() => Object.values(window.__ds.world.getState().doc.objects).map((o) => ({ id: o.id, type: o.type, modular: !!o.building, members: o.building?.members.length ?? 0, floors: o.building?.spec.floors, width: o.building?.spec.width, cladding: o.building?.spec.claddingMaterial, pos: o.transform.position })));
/** Canonical (key-order independent) content of the world's objects. */
const fingerprint = () => ds(() => {
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  return JSON.stringify(canon(window.__ds.world.getState().doc.objects));
});
const key = async (k, mods = []) => { for (const m of mods) await page.keyboard.down(m); await page.keyboard.press(k); for (const m of mods.reverse()) await page.keyboard.up(m); await wait(300); };

/** Click the first button whose text contains `label` (inside `scope`). */
async function clickButton(label, scope = 'body') {
  const ok = await page.evaluate((label, scope) => {
    const b = [...document.querySelectorAll(`${scope} button`)].find((x) => x.textContent.trim().includes(label) && !x.disabled);
    if (!b) return false;
    b.click();
    return true;
  }, label, scope);
  await wait(300);
  return ok;
}
/** Type a value into the number input of the field labelled `label` inside `scope`. */
async function setNumber(label, value, scope = '[data-testid="spec-form"]') {
  const handle = await page.evaluateHandle((label, scope) => {
    const rows = [...document.querySelectorAll(`${scope} span`)].filter((s) => s.textContent.trim() === label);
    for (const r of rows) {
      const input = r.parentElement?.querySelector('input');
      if (input) return input;
    }
    return null;
  }, label, scope);
  const el = handle.asElement();
  if (!el) return false;
  await el.click();
  await page.keyboard.type(String(value));
  await page.keyboard.press('Enter');
  await wait(300);
  return true;
}
async function setSelect(label, value, scope = '[data-testid="spec-form"]') {
  const ok = await page.evaluate((label, value, scope) => {
    const span = [...document.querySelectorAll(`${scope} span`)].find((s) => s.textContent.trim() === label);
    const sel = span?.parentElement?.querySelector('select');
    if (!sel) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, value);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, label, value, scope);
  await wait(300);
  return ok;
}
const toScreen = (x, y, z) => ds(([x, y, z]) => {
  const s = window.__r3f.get();
  const v = s.camera.position.clone().set(x, y, z).project(s.camera);
  const r = s.gl.domElement.getBoundingClientRect();
  return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
}, [x, y, z]);
const clickWorld = async (p, opts = {}) => {
  const s = await toScreen(...p);
  if (opts.shift) await page.keyboard.down('Shift');
  await page.mouse.move(s[0] - 3, s[1] - 3);
  await page.mouse.move(s[0], s[1], { steps: 3 });
  await wait(120);
  await page.mouse.click(s[0], s[1]);
  if (opts.shift) await page.keyboard.up('Shift');
  await wait(350);
};
const camera = (pos, target) => ds(([p, t]) => {
  const s = window.__r3f.get();
  s.camera.position.set(...p);
  s.controls.target.set(...t);
  s.controls.update();
}, [pos, target]);
const simTime = () => ds(() => window.__ds.simStore.getState().time);
async function runUntil(seconds, timeout = 240_000) {
  await page.waitForFunction(() => window.__ds.simStore.getState().status === 'running', { timeout: 60_000 });
  await page.waitForFunction((s) => window.__ds.simStore.getState().time >= s || window.__ds.simStore.getState().status === 'finished', { timeout, polling: 500 }, seconds);
}
const events = () => ds(() => window.__ds.sim.getDamageEvents().map((e) => ({ t: e.eventType, h: e.hazard, o: e.objectId, k: e.componentKind, m: e.memberType })));
const exitSim = async () => { await ds(() => window.__ds.actions.exitSimulation()); await wait(800); };

await page.goto(url + '?devtools', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
await ds(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
await ds((l) => window.__ds.locale.getState().setLocale(l), lang);
await ds(() => window.__ds.actions.newProject());
await camera([0, 55, 75], [0, 0, 0]);
await wait(1000);

// ── 1. Create a building in an empty world ─────────────────────────────
await page.click('[data-testid="tab-building"]');
await page.click('[data-preset="apartment"]');
await page.click('[data-testid="building-place"]');
await clickWorld([0, 0, 0]);
await key('Escape');
let objs = await objects();
check('1 create: modular building placed by clicking the viewport', objs.length === 1 && objs[0].modular && objs[0].members > 300, `${objs.length} object(s), ${objs[0]?.members} members`);
const apt = objs[0].id;
await ds((id) => window.__ds.editor.getState().select(id), apt);
await wait(600);
await shot('01-created');

// ── 2. Change floors and size (form + Apply), Add Floor button ─────────
await setNumber(await tr('building.field.floors'), 8);
await setNumber(await tr('building.field.width'), 21);
const preview = await ds(() => !!document.querySelector('[data-testid="building-apply"]'));
objs = await objects();
check('2a parameter edit is a preview until Apply', preview && objs[0].floors === 6, `doc floors ${objs[0].floors}`);
await page.click('[data-testid="building-apply"]');
await wait(500);
objs = await objects();
check('2b Apply: floors 8, width 21 m', objs[0].floors === 8 && objs[0].width === 21, `${objs[0].floors} floors, ${objs[0].width} m`);
await page.click('[data-testid="add-floor"]');
await wait(500);
objs = await objects();
check('2c Add Floor', objs[0].floors === 9, `${objs[0].floors} floors`);
await shot('02-floors');

// ── 3. Add column, wall, window (Building Edit Mode) ───────────────────
await page.click('[data-testid="edit-members"]');
await wait(500);
const inMode = await ds(() => window.__ds.editor.getState().tool === 'building' && !!document.querySelector('[data-testid="building-edit-bar"]'));
check('3a Building Edit Mode opens with its toolbar', inMode);
await camera([22, 14, 32], [12, 2, 10]);
await wait(600);
const m0 = (await objects())[0].members;
await page.click('[data-testid="building-edit-bar"] [data-member="column"]');
await clickWorld([16, 0, 12]); // outside the footprint, on the ground → snaps to grid
await page.click('[data-testid="building-edit-bar"] [data-member="wall"]');
await clickWorld([16, 0, 16]);
await page.click('[data-testid="building-edit-bar"] [data-member="window"]');
await clickWorld([16, 1.5, 16]);
await key('Escape');
const m1 = (await objects())[0].members;
check('3b column, wall and window added (3 members, 3 undo steps)', m1 - m0 === 3, `${m0} → ${m1}`);
await page.click('[data-testid="toggle-load-path"]');
await wait(500);
await shot('03-members');
await page.click('[data-testid="toggle-load-path"]');

// Member selection by clicking + member inspector material change.
await camera([0, 40, 55], [0, 6, 0]);
await wait(500);
await clickWorld([10.5, 1.5, 6]); // a ground-story perimeter column at the east facade
const selected = await ds(() => document.querySelector('[data-testid="member-model"]') !== null);
check('3c clicking a member selects it (member inspector)', selected);

// ── 4. Materials: cladding via the Creator (Apply), a member via the inspector ──
await key('Escape');
await key('Escape');
await ds((id) => window.__ds.editor.getState().select(id), apt);
await wait(400);
await setSelect(await tr('building.field.claddingMaterial'), 'lightCladding');
const massBefore = await ds((id) => window.__ds.world.getState().doc.objects[id].physics.mass, apt);
await page.click('[data-testid="building-apply"]');
await wait(500);
objs = await objects();
const massAfter = await ds((id) => window.__ds.world.getState().doc.objects[id].physics.mass, apt);
check('4 material change: light cladding, lower mass', objs[0].cladding === 'lightCladding' && massAfter < massBefore, `${Math.round(massBefore / 1000)} t → ${Math.round(massAfter / 1000)} t`);
await shot('04-material');

// ── 5. Sloped terrain ──────────────────────────────────────────────────
await ds(() => window.__ds.actions.applyTerrainPreset('gentleHills', 5));
await wait(1200);
const slope = await ds(() => {
  const L = window.__ds.buildLib;
  const s = L.samplerFor(window.__ds.world.getState().doc.terrain);
  let best = [0, 0, 0];
  for (let x = -70; x <= 70; x += 7) for (let z = -70; z <= 70; z += 7) {
    if (Math.hypot(x, z) < 30) continue;
    const g = Math.abs(s.sampleHeight(x + 4, z) - s.sampleHeight(x - 4, z)) + Math.abs(s.sampleHeight(x, z + 4) - s.sampleHeight(x, z - 4));
    if (g > best[2]) best = [x, z, g];
  }
  return { x: best[0], z: best[1], y: s.sampleHeight(best[0], best[1]) };
});
await camera([slope.x + 18, slope.y + 16, slope.z + 22], [slope.x, slope.y, slope.z]);
await page.click('[data-testid="tab-building"]');
await page.click('[data-testid="new-building"]');
await wait(300);
await page.click('[data-preset="house"]');
await page.click('[data-testid="building-place"]');
await clickWorld([slope.x, slope.y, slope.z]);
await key('Escape');
objs = await objects();
const house = objs.find((o) => o.id !== apt);
const fc = await ds((id) => {
  const o = window.__ds.world.getState().doc.objects[id];
  return { plinth: window.__ds.buildingLib.foundationContact(o, window.__ds.buildLib.samplerFor(window.__ds.world.getState().doc.terrain)) };
}, house?.id);
check('5 placed on a slope: foundation reaches the ground (plinth, full contact)', house && fc.plinth.plinth > 0.05 && fc.plinth.contact === 1, `plinth ${fc.plinth.plinth.toFixed(2)} m, contact ${(fc.plinth.contact * 100).toFixed(0)} %, slope ${fc.plinth.slope.toFixed(1)}°`);
await ds((id) => window.__ds.editor.getState().select(id), house.id);
await wait(600);
await shot('05-slope');

// ── 6. Duplicate (Ctrl+D) ───────────────────────────────────────────────
const n6 = objs.length;
await page.mouse.move(800, 400);
await key('d', ['Control']);
objs = await objects();
const copy = objs.find((o) => o.id !== apt && o.id !== house.id);
const sameDesign = copy && await ds(([a, b]) => JSON.stringify(window.__ds.world.getState().doc.objects[a].building) === JSON.stringify(window.__ds.world.getState().doc.objects[b].building), [house.id, copy.id]);
check('6 duplicate: new id, same design', objs.length === n6 + 1 && copy && copy.id !== house.id && sameDesign, `${n6} → ${objs.length}`);

// ── 7. Undo / Redo ──────────────────────────────────────────────────────
await key('z', ['Control']);
const afterUndo = (await objects()).length;
await key('z', ['Control', 'Shift']);
const afterRedo = (await objects()).length;
check('7 undo / redo of the duplicate', afterUndo === n6 && afterRedo === n6 + 1, `${afterUndo} / ${afterRedo}`);

// ── 8. Save and load ────────────────────────────────────────────────────
const fpSaved = await fingerprint();
await clickButton(await tr('topbar.save'), 'header');
await ds((id) => window.__ds.world.getState().remove([id]), copy.id);
await clickButton(await tr('topbar.load'), 'header');
await wait(800);
const fpLoaded = await fingerprint();
check('8 save → change → load restores the saved world exactly', fpLoaded === fpSaved, `${(await objects()).length} objects`);

// ── 9. Typhoon ──────────────────────────────────────────────────────────
await camera([40, 60, 90], [0, 5, 0]);
const fpOriginal = await fingerprint();
await clickButton(await tr('hazard.tab.wind'), 'section');
// Wind form: 55 m/s (its speed slider), then its Run button.
await page.evaluate(() => {
  // The wind form keeps its state in a persisted store; set the speed through its slider input.
  const r = [...document.querySelectorAll('section input[type=range]')][0];
  if (r) { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(r, '55'); r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); }
});
await wait(300);
await clickButton(await tr('wind.run'), 'section');
await ds(() => window.__ds.sim.setSpeed(4));
await runUntil(40);
let ev = await events();
const windEv = ev.filter((e) => e.h === 'wind');
check('9 typhoon: wind damage on the buildings (envelope parts)', windEv.some((e) => e.k === 'cladding' || e.k === 'window' || e.k === 'roof'), `${windEv.length} wind events`);
await shot('09-typhoon');
await exitSim();

// ── 10. Earthquake + 13. damage state ──────────────────────────────────
await clickButton(await tr('hazard.tab.earthquake'), 'section');
await ds(() => window.__ds.world.getState().setEarthquakeScenario({ event: 'earthquake', magnitude: 7, pga: 0.75, epicenter: [0, 0], depth: 10, duration: 20 }));
await wait(300);
await clickButton(await tr('eq.form.run'), 'section');
await ds(() => window.__ds.sim.setSpeed(2));
await runUntil(18);
ev = await events();
const eqEv = ev.filter((e) => e.h === 'earthquake');
check('10 earthquake: structural response and damage', eqEv.some((e) => e.t === 'CRACKED') && eqEv.length > 5, `${eqEv.length} events, ${eqEv.filter((e) => e.t === 'FAILED').length} member failures, ${eqEv.filter((e) => e.t === 'STORY_COLLAPSED' || e.t === 'COLLAPSED').length} collapses`);
await ds((id) => window.__ds.editor.getState().select(id), apt);
await wait(1200);
const compare = await ds(() => document.querySelector('[data-testid="building-compare"]')?.textContent ?? '');
const drifts = await ds(() => document.querySelectorAll('[data-testid="story-drifts"] > div').length);
check('13 damage state: before / after comparison and story drifts in the inspector', compare.length > 20 && drifts > 5, `${drifts - 1} story bars`);
await camera([30, 30, 45], [0, 10, 0]);
await wait(800);
await shot('10-earthquake');
await exitSim();

// ── 11. Flood ───────────────────────────────────────────────────────────
await clickButton(await tr('hazard.tab.flood'), 'section');
const level = await ds(() => {
  const s = window.__ds.buildLib.samplerFor(window.__ds.world.getState().doc.terrain);
  let lo = Infinity;
  for (let z = -95; z <= 95; z += 5) lo = Math.min(lo, s.sampleHeight(-99, z));
  return lo + 3;
});
await ds((lv) => window.__ds.world.getState().setFloodScenario({ risingWater: { event: 'risingWater', boundary: 'W', level: lv, riseRate: 3, duration: 900 }, enabled: { rain: false, risingWater: true, sources: false } }), level);
await wait(300);
await clickButton(await tr('flood.form.run'), 'section');
await ds(() => window.__ds.sim.setSpeed(16));
await runUntil(420, 300_000);
const flooded = await ds(() => [...window.__ds.sim.getRuntime().entities.values()].filter((e) => e.flood && e.flood.peakDepth > 0.05).length);
check('11 flood: water reaches buildings (flood state, loads, interior fill)', flooded >= 1, `${flooded} building(s) wet`);
await shot('11-flood');
await exitSim();

// ── 12. Combined hazards (experiment: wind + earthquake + flood) ────────
await clickButton(await tr('hazard.tab.wind'), 'section');
await clickButton(await tr('exp.addFromForm'), 'section');
await clickButton(await tr('hazard.tab.earthquake'), 'section');
await clickButton(await tr('exp.addFromForm'), 'section');
await clickButton(await tr('hazard.tab.flood'), 'section');
await clickButton(await tr('exp.addFromForm'), 'section');
await clickButton(await tr('hazard.tab.experiment'), 'section');
const planned = await ds(() => window.__ds.world.getState().doc.scenario.experiment.instances.length);
await clickButton(await tr('exp.run'), 'section');
await ds(() => window.__ds.sim.setSpeed(4));
await runUntil(24);
ev = await events();
const hz = new Set(ev.map((e) => e.h));
check('12 combined hazards run together; several hazards cause damage', planned >= 3 && hz.size >= 2, `${planned} phenomena, hazards: ${[...hz].join(', ')}`);
await shot('12-combined');

// ── 14. Original world restored ─────────────────────────────────────────
await exitSim();
const fpAfter = await fingerprint();
check('14 original world: geometry, members, materials, foundation, damage and ids unchanged', fpAfter === fpOriginal);
await ds((id) => window.__ds.editor.getState().select(id), apt);
await wait(600);
await shot('14-restored');

check('no console / page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
fs.writeFileSync(path.join(out, `verify-buildings-${lang}.json`), JSON.stringify({ lang, results, errors }, null, 2));
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
