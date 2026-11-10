// Browser verification of fire (Phase 27): 30 scenarios in real Chrome through the UI (experiment tab:
// add a fire scenario, fields, pick on the map, target, preview, world conditions, presets; run; flames /
// smoke / overlays / member colors, HUD, inspector, timeline, results, ledgers, reset, save / load) with
// state checks after each step, plus whole-run checks: page errors, the tab staying alive, GPU
// geometries, heap, text not cut.
//
//   npm run build && npx vite preview --port 4196 --strictPort &
//   LANG_UI=ko node scripts/verify-fire.mjs http://localhost:4196/ ./docs/verify/fire
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:4196/', out = './docs/verify/fire'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const lang = process.env.LANG_UI ?? 'ko';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,1000', '--enable-precise-memory-info', '--js-flags=--expose-gc'],
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 }, protocolTimeout: 1_800_000, timeout: 180_000,
});
const errors = [];
const results = [];
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
let crashed = false;
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
const cdp = await page.createCDPSession();
const shot = (n) => page.screenshot({ path: path.join(out, `${n}-${lang}.png`) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
};
const clickText = (re, root = 'body') => ev(([src, root]) => {
  const r = new RegExp(src);
  for (const b of [...(document.querySelector(root).querySelectorAll('button, [role="menuitem"]'))].filter((b) => !b.closest('[data-testid=\"disaster-library\"], [data-testid=\"placement-bar\"]'))) if (r.test(b.textContent ?? '') && !b.disabled) { b.click(); return true; }
  return false;
}, [re.source, root]);
const tr = (k) => ev((k) => window.__ds.tr(k), k);
async function heapMB() {
  for (let i = 0; i < 2; i++) { await ev(() => window.gc?.()); await cdp.send('HeapProfiler.collectGarbage'); }
  return ev(() => +(performance.memory.usedJSHeapSize / 1048576).toFixed(1));
}
const geometries = () => ev(() => window.__r3f.get().gl.info.memory.geometries);
async function screenOf(x, z, y = null) {
  return ev(([x, z, y]) => {
    const st = window.__r3f.get();
    const t = window.__ds.world.getState().doc.terrain;
    const h = y ?? window.__ds.buildLib.samplerFor(t).sampleHeight(x, z);
    const v = st.camera.position.clone().set(x, h, z).project(st.camera);
    const r = st.gl.domElement.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  }, [x, z, y]);
}
async function clickWorld(x, z, y = null) {
  const [sx, sy] = await screenOf(x, z, y);
  await page.mouse.move(sx, sy);
  await wait(80);
  await page.mouse.click(sx, sy);
  await wait(300);
}
async function view(x, z, h = 60, back = 70) {
  await ev(([x, z, h, back]) => { const st = window.__r3f.get(); st.camera.position.set(x + back * 0.5, h, z + back); st.controls.target.set(x, 0, z); st.controls.update(); }, [x, z, h, back]);
  await wait(300);
}
const inst = () => ev(() => window.__ds.world.getState().doc.scenario.experiment?.instances ?? []);
const fp = () => ev(() => window.__ds.blueprintLib.worldFingerprint(window.__ds.world.getState().doc));
async function newWorld() {
  await ev(() => { window.__ds.actions.newProject(); const v = window.__ds.view.getState(); v.setGroundPreview(null); v.setGroundPick(null); v.setWaterProbe(null); v.setSimMember(null); v.setStructureViz({ color: 'normal' }); });
  await wait(300);
}
const place = (items) => ev((items) => {
  const ds = window.__ds;
  return ds.world.getState().applyEdit({ add: items.map(([type, x, z, preset], k) => ({ type, ...(type === 'building' ? { building: ds.buildingLib.createDesign(ds.buildingLib.presetSpec(preset ?? 'house'), preset ?? 'house') } : {}), seed: k + 1, transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] } })) });
}, items);
async function expand(id) {
  const open = await ev((id) => document.querySelector(`[data-testid="exp-edit-${id}"]`)?.getAttribute('aria-expanded') === 'true', id);
  if (!open) await page.click(`[data-testid="exp-edit-${id}"]`);
  await wait(300);
}
const setNumber = async (id, field, value) => {
  const sel = `[data-instance="${id}"] [data-field="${field}"] input`;
  await page.click(sel, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type(sel, String(value));
  await page.keyboard.press('Enter');
  await wait(200);
};
const setSelect = (id, field, value) => ev(([id, field, value]) => {
  const s = document.querySelector(`[data-instance="${id}"] select[data-field="${field}"]`);
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(s, value);
  s.dispatchEvent(new Event('change', { bubbles: true }));
}, [id, field, value]);
const setSpec = (id, patch) => ev(([id, patch]) => { const a = window.__ds.actions; const i = window.__ds.world.getState().doc.scenario.experiment.instances.find((x) => x.id === id); const spec = { ...i.spec, ...patch }; for (const k of Object.keys(patch)) if (patch[k] === null) delete spec[k]; a.updatePhenomenon(id, { spec }); }, [id, patch]);
async function enterRun() {
  await clickText(/^\s*실험 실행|Run experiment/);
  await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status === 'running', { timeout: 60_000 });
}
/** Pause and step to exactly simulation time T. */
const atTime = (T) => ev((T) => { const s = window.__ds.sim; s.pause(); const r = T - s.getTime(); if (r > 0) s.advance(r); return s.getTime(); }, T);
const exitSim = async () => { await ev(() => window.__ds.actions.exitSimulation()); await wait(500); };
const th = () => ev(() => window.__ds.simStore.getState().thermal);
const thHash = () => ev(() => {
  const rt = window.__ds.thermalLib.rt(); if (!rt) return null;
  const w = rt.world, B = w.bodies; let s = 0, k = 1;
  for (let i = 0; i < B.n; i++) { s += (B.ES[i] + B.EC[i]) * k; k = (k * 1.000003) % 7.1; }
  w.terrain.forActive((c) => { s += w.terrain.E[c * w.terrain.nl] * 1e-3; });
  return `${B.n}|${w.terrain.tiles.length}|${s.toExponential(12)}|${w.ledger.added.toExponential(12)}`;
});
const fr = () => ev(() => window.__ds.simStore.getState().fire);
const frHash = () => ev(() => {
  const r = window.__ds.fireLib.rt(); if (!r) return null;
  const fw = r.fw; let s = 0, k = 1;
  for (let i = 0; i < fw.n; i++) { s += (fw.m[i] + fw.E[i] * 1e-6 + fw.state[i]) * k; k = (k * 1.000003) % 7.1; }
  return `${fw.n}|${s.toExponential(12)}|${fw.ledger.released.toExponential(12)}`;
});
const ms = () => ev(() => window.__ds.simStore.getState().milestones.map((m) => m.kind));
const objCount = (name) => ev((name) => { let n = 0; window.__r3f.get().scene.traverse((o) => { if (o.name === name) o.traverse((m) => { if (m.isInstancedMesh) n += m.count; if (m.isPoints) n += m.geometry.drawRange.count; }); }); return n; }, name);
/** Elements whose text is cut (horizontal overflow) inside the given panels. */
const clipped = (sels) => ev((sels) => {
  const out = [];
  for (const sel of sels) for (const root of document.querySelectorAll(sel)) for (const el of root.querySelectorAll('*')) {
    if (!el.childNodes.length || ![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    if (cs.overflow === 'visible' && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && cs.display !== 'inline') out.push(`${sel}: ${el.textContent.trim().slice(0, 40)}`);
  }
  return out;
}, sels);
const heap0 = await heapMB();
const geo0 = await geometries();

// ══ 1–8: the editor ═══════════════════════════════════════════════════════════════════════════
await newWorld();
await place([['building', 0, 0, 'house'], ['tree', 9.5, 0], ['car', -14, 6], ['human', -12, -12]]);
await clickText(/^\s*현상 추가|Add phenomenon/);
await wait(250);
await clickText(new RegExp('^\\s*' + (await tr('phen.fire')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$'));
await wait(300);
let I = await inst();
const id = I.find((i) => i.type === 'fire')?.id;
await expand(id);
await shot('01-editor');
check('1 fire scenario added from the Experiment tab (ignition point, height, radius, watch time)', !!id && I[0].spec.event === 'fire', I[0]?.spec);
const fields1 = await ev((id) => [...document.querySelectorAll(`[data-instance="${id}"] [data-field]`)].map((e) => e.getAttribute('data-field')), id);
check('1b only scenario fields — no fuel recipe, device or intensity field', ['x', 'z', 'height', 'radius', 'duration'].every((f) => fields1.includes(f)) && fields1.length === 5, fields1);
// The number field clamps typed values to the allowed range; a spec from a file / command is validated with reasons.
await setNumber(id, 'radius', 30);
const clamped2 = (await inst())[0].spec.radius;
await setSpec(id, { radius: 0 });
await wait(300);
const invalid2 = await ev(() => document.querySelector('[data-testid="exp-invalid"]')?.textContent ?? '');
const reason2 = await tr('fire.invalid.radius');
await setSpec(id, { radius: 1 });
check('2 radius limited in the field (30 → 10 m); an impossible radius from a file is rejected with its reason', clamped2 === 10 && invalid2.includes(reason2.slice(0, 10)), { clamped2, invalid2 });
await view(0, 0, 45, 50);
await page.click('[data-testid="fire-pick"]');
await wait(200);
await clickWorld(10, 0.5);
I = await inst();
check('3 ignition point picked on the map with a click', Math.abs(I[0].spec.position[0] - 10) < 1 && Math.abs(I[0].spec.position[1]) < 1.5, I[0].spec.position);
await setNumber(id, 'height', 7);
await setNumber(id, 'radius', 2);
const targets4 = await ev(() => [...document.querySelectorAll('[data-testid="fire-target"] option')].map((o) => o.value));
const treeId = await ev(() => Object.values(window.__ds.world.getState().doc.objects).find((o) => o.type === 'tree').id);
check('4 target object: the objects the ignition sphere reaches are offered (the tree)', targets4.includes(treeId), targets4);
await page.click('[data-testid="fire-preview"]');
await wait(800);
const prev5 = await ev(() => { let n = 0; window.__r3f.get().scene.traverse((o) => { if (o.name === 'fire-preview') n++; }); return n; });
const sum5 = await ev(() => document.querySelector('[data-testid="fire-summary"]')?.textContent ?? '');
await shot('05-preview-tree');
check('5 preview: ignition sphere and fuel marks drawn; a live (150 %) crown is reported as too wet', prev5 > 0 && sum5.length > 20 && sum5.includes((await tr('fire.outlook.moist')).slice(0, 8)), sum5.slice(0, 160));
// Into the house: room, openings and reference exposure.
await setSpec(id, { position: [0, 0], height: 1, radius: 1 });
await wait(500);
const sum6 = await ev(() => document.querySelector('[data-testid="fire-summary"]')?.textContent ?? '');
const out6 = await ev(() => window.__ds.fireLib.outlook(window.__ds.world.getState().doc.scenario.experiment.instances[0].spec));
await shot('06-preview-room');
check('6 preview in a room: story, floor, contents, window area, fuel / ventilation peaks, reference exposure distances', out6.room && out6.room.contentsKg > 0 && out6.r12 > 0 && sum6.includes('kW/m²'), { room: out6.room, r12: out6.r12, r5: out6.r5 });
await ev(() => window.__ds.world.getState().updateSimulationSettings({ fire: { openings: 'windowsOpen', foliageMoisture: 0.25 } }));
await wait(300);
const world7 = await ev(() => window.__ds.world.getState().doc.settings.simulation.fire);
const seg7 = await ev(() => document.querySelector('[data-testid="fire-world"]')?.textContent ?? '');
check('7 world fire conditions set (crown moisture, openings, heat ignition) and shown', world7.openings === 'windowsOpen' && world7.foliageMoisture === 0.25 && world7.heatIgnition === false && seg7.length > 10, world7);
const fp8 = await fp();

// ══ 8–16: run (timber house, windows open, dry tree beside) ════════════════════════════════════
await enterRun();
await atTime(240);
let F = await fr();
check('8 room fire grows as the EN 1991-1-2 t² curve (≈ 0.64 MW at 240 s)', F && F.hrr > 0.5e6 && F.hrr < 0.75e6, { hrr: F?.hrr });
await atTime(900);
F = await fr();
let M = await ms();
check('9 window glass breaks from heat and the room flashes over (milestones)', M.includes('windowBreak') && M.includes('flashover') && F.flashovers >= 1, M.filter((k) => !['start', 'end'].includes(k)));
await ev(() => { const v = window.__ds.view.getState(); v.setThermalViz({ field: 'off', objects: false, isotherms: false }); v.setFireViz({ flames: true, smoke: true, embers: true, glow: true, overlay: 'off' }); });
await view(0, 0, 14, 24);
await wait(1200);
const flames10 = await objCount('fire-layer');
await shot('10-flashover');
check('10 flames, smoke and embers drawn from the computed fire (external flames at the openings)', flames10 > 0 && F.ledger.releasedExternal > 0, { instances: flames10, external: F.ledger.releasedExternal });
const hud11 = await ev(() => document.querySelector('[data-testid="fire-hud"]')?.textContent ?? '');
check('11 fire HUD: heat release, objects, rooms, consumed fuel, smoke, ledger residual', hud11.includes('MW') && /kg/.test(hud11), hud11.slice(0, 120));
check('12 oxygen-limited room burning: the excess burns outside (milestone, ledger)', M.includes('oxygenLimited') && F.ventLimited >= 0 && F.ledger.releasedExternal > 0, { vl: F.ventLimited });
const legends = {};
for (const o of ['state', 'fuel', 'hrr', 'smoke', 'rooms']) {
  await ev((o) => window.__ds.view.getState().setFireViz({ overlay: o }), o);
  await wait(700);
  legends[o] = { legend: await ev(() => document.querySelector('[data-testid="fire-legend"]')?.textContent ?? ''), n: await objCount('fire-layer') };
  if (o === 'rooms' || o === 'state') await shot(`13-overlay-${o}`);
}
await ev(() => window.__ds.view.getState().setFireViz({ overlay: 'off' }));
check('13 overlays with legends: fire state, fuel left, heat release, smoke visibility, room state', Object.values(legends).every((l) => l.legend.length > 0), Object.fromEntries(Object.entries(legends).map(([k, v]) => [k, v.legend.slice(0, 40)])));
await ev(() => window.__ds.view.getState().setStructureViz({ color: 'fire' }));
await wait(900);
await shot('14-member-fire-colors');
await ev(() => window.__ds.view.getState().setStructureViz({ color: 'normal' }));
const houseId = await ev(() => [...window.__ds.sim.getRuntime().entities.values()].find((e) => e.source.type === 'building').id);
await ev((id) => window.__ds.editor.getState().select(id), houseId);
await wait(600);
const insp15 = await ev(() => [document.querySelector('[data-testid="fire-object"]')?.textContent ?? '', [...document.querySelectorAll('[data-testid="fire-room"]')].map((e) => e.textContent).join(' | ')]);
await shot('15-inspector-house');
check('14–15 member fire colors; inspector: fuel items, heat release, rooms (gas, O₂, smoke, openings, flashover)', insp15[0].length > 20 && insp15[1].length > 20, insp15.map((s) => s.slice(0, 80)));
await atTime(2400);
M = await ms();
const tree16 = await ev(() => { const e = [...window.__ds.sim.getRuntime().entities.values()].find((x) => x.source.type === 'tree'); return { burned: e.visual.burned ?? 0, state: e.state }; });
const treeSel = await ev(() => [...window.__ds.sim.getRuntime().entities.values()].find((x) => x.source.type === 'tree').id);
await ev((id) => window.__ds.editor.getState().select(id), treeSel);
await wait(500);
const insp16 = await ev(() => [...document.querySelectorAll('[data-testid="fire-item"]')].map((e) => e.textContent).join(' | '));
await shot('16-tree');
check('16 spread by computed heat to the dry tree beside the house (fireSpread); crown burned, inspector shows its fuel item', M.includes('fireSpread') && tree16.burned > 0.5 && insp16.length > 20, { tree16, insp16: insp16.slice(0, 100) });
F = await fr();
const st17 = await ev(() => { const e = [...window.__ds.sim.getRuntime().entities.values()].find((x) => x.source.type === 'building'); const m = e.modular.structure.model; return { fire: m.records.filter((r) => r.hazard === 'fire' && r.cause !== 'facade').length, causes: [...new Set(m.records.map((r) => r.cause))] }; });
await view(0, 0, 18, 26);
await wait(800);
await shot('17-structure');
check('17 fire-weakened timber members fail through the structural engine (hazard fire; charred sections)', st17.fire > 0 && F.charredMembers > 0 && M.includes('fireFailure'), { st17, charred: F.charredMembers });
await ev(() => window.__ds.ui.getState().setResultsOpen(true));
await wait(700);
const res18 = await ev(() => document.querySelector('[data-testid="fire-results"]')?.textContent ?? '');
const csv18 = await ev(() => !!document.querySelector('[data-testid="fire-csv"]'));
await shot('18-results');
const clip18 = await clipped(['[data-testid="fire-results"]']);
await ev(() => window.__ds.ui.getState().setResultsOpen(false));
check('18 results: ignited / burned-out objects, consumed fuel, released energy, peak HRR, room temperature, smoke, structure; CSV', res18.length > 80 && csv18 && clip18.length === 0, { res: res18.slice(0, 120), clip18 });
F = await fr();
check('19 ledgers: chemical energy = released + remaining, fuel and smoke residuals at round-off; combustion heat = thermal combustion account', Math.abs(F.ledger.chemResidual) / F.ledger.chemRegistered < 1e-9 && Math.abs(F.ledger.fuelResidual) / F.ledger.fuelRegistered < 1e-9 && Math.abs(F.ledger.smokeResidual) < 1e-6 * F.ledger.smokeProduced && Math.abs((await th()).combustion - F.ledger.released) < 1e-6 * F.ledger.released, F.ledger);
check('20 timeline milestones: ignition, spread, heat release, O₂-limited, flashover, glass, member failure', ['ignition', 'fireSpread', 'heatRelease', 'oxygenLimited', 'flashover', 'windowBreak', 'fireFailure'].every((k) => M.includes(k)), M.filter((k) => !['start', 'end'].includes(k)));
const clip21 = await clipped(['[data-testid="fire-hud"]', '[data-testid="fire-overlay"]']);
check('21 HUD and overlay panel text not cut', clip21.length === 0, clip21);
const h22a = await frHash();
await ev(() => window.__ds.actions.resetSimulation());
await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status !== 'loading', { timeout: 60_000 });
const r22 = await ev(() => ({ fire: window.__ds.fireLib.rt() === null, t: window.__ds.sim.getTime() }));
await ev(() => window.__ds.sim.play());
await atTime(2400);
const h22b = await frHash();
check('22 reset restores the original world; the same ignition / spread / collapse order follows', r22.fire && r22.t === 0 && h22a === h22b, { r22, h22a, h22b });
await exitSim();
check('23 leaving the simulation leaves the document untouched (fingerprint)', (await fp()) === fp8);

// ══ 24: ignition where nothing burns ════════════════════════════════════════════════════════════
await newWorld();
await place([['car', 0, 0]]);
await ev(() => window.__ds.actions.addPhenomenon('fire', { event: 'fire', position: [0, 0], height: 0.5, radius: 2, duration: 60 }));
I = await inst();
await expand(I[0].id);
await page.click('[data-testid="fire-preview"]');
await wait(500);
const sum24 = await ev(() => document.querySelector('[data-testid="fire-summary"]')?.textContent ?? '');
await enterRun();
await atTime(3);
const F24 = await fr();
const hud24 = await ev(() => document.querySelector('[data-testid="fire-hud"]')?.textContent ?? '');
await shot('24-rejected');
await exitSim();
check('24 ignition with no fuel (a car): warned in the preview, rejected in the run with the reason', sum24.includes((await tr('fire.outlook.noFuel')).slice(0, 8)) && F24?.ignitions[0]?.reason === 'fire.reject.noFuel' && hud24.length > 0, F24?.ignitions);

// ══ 25: presets (vegetation, wind, water) through the panel ═════════════════════════════════════
await newWorld();
await ev(() => window.__ds.actions.addPhenomenon('fire'));
I = await inst();
await expand(I[0].id);
await ev(() => { const s = document.querySelector('[data-testid="fire-preset-select"]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'vegetation'); s.dispatchEvent(new Event('change', { bubbles: true })); });
await wait(300);
const asm25 = await ev(() => document.querySelector('[data-testid="fire-presets"]')?.textContent ?? '');
await shot('25-presets');
await page.click('[data-testid="fire-preset-load"]');
await wait(800);
const n25 = await ev(() => Object.keys(window.__ds.world.getState().doc.objects).length);
await enterRun();
await atTime(60);
const F25 = await fr();
await ev(() => { const v = window.__ds.view.getState(); v.setThermalViz({ field: 'off', objects: false }); });
await view(0, 0, 22, 30);
await wait(900);
await shot('25-vegetation');
await exitSim();
check('25 preset with its assumptions loads a vegetation scene; dry crowns burn one after another', asm25.length > 40 && n25 === 12 && F25.ignitedObjects >= 6, { n25, ignited: F25.ignitedObjects });
await ev(() => window.__ds.actions.loadFirePreset('windFire'));
await wait(800);
await enterRun();
await atTime(90);
const F26 = await fr();
await view(0, 0, 26, 40);
await wait(900);
await shot('26-wind');
await exitSim();
check('26 wind preset: crowns 7 m apart (a gap fire does not cross in calm air) burn downwind', F26.ignitedObjects >= 6, { ignited: F26.ignitedObjects, peak: F26.peakHrr });
await ev(() => window.__ds.actions.loadFirePreset('waterCooling'));
await wait(800);
await enterRun();
await atTime(120);
const F27 = await fr();
await shot('27-rain');
await exitSim();
const share25 = F25.ledger.fuelConsumed / F25.ledger.fuelRegistered, share27 = F27.ledger.fuelConsumed / F27.ledger.fuelRegistered;
check('27 water cooling: rain wets burning crowns above the moisture of extinction, they go out (evaporation booked); far less fuel burns than without rain', F27.extinguishedItems > 0 && F27.ledger.waterEvaporated > 0 && share27 < 0.6 * share25, { ext: F27.extinguishedItems, evap: F27.ledger.waterEvaporated, share25, share27 });

// ══ 28: heat-source ignition only when enabled ═════════════════════════════════════════════════
const heatRun = async (on) => {
  await newWorld();
  await place([['tree', 0, 0]]);
  await ev((on) => { const a = window.__ds.actions; window.__ds.world.getState().updateSimulationSettings({ fire: { foliageMoisture: 0.2, heatIgnition: on, openings: 'asBuilt' } }); a.addPhenomenon('heatSource', { event: 'heatSource', kind: 'point', position: [4, 0], height: 5.5, radius: 2, input: 'power', power: 4e6, profile: 'constant', duration: 200 }); }, on);
  await enterRun();
  await atTime(120);
  const r = await ev(() => ({ fire: window.__ds.simStore.getState().fire, rt: window.__ds.fireLib.rt() !== null }));
  await exitSim();
  return r;
};
const off28 = await heatRun(false);
const on28 = await heatRun(true);
check('28 heat sources ignite fuel only with heat ignition on (off: no combustion model, Phase 26 behaviour)', !off28.rt && on28.rt && on28.fire.ignitedObjects >= 1, { off: off28.rt, on: on28.fire?.ignitedObjects });

// ══ 29: save / load ════════════════════════════════════════════════════════════════════════════
const saved29 = await ev(() => {
  const ds = window.__ds, d = ds.world.getState().doc;
  ds.world.getState().updateSimulationSettings({ fire: { foliageMoisture: 0.4, openings: 'closed', heatIgnition: true } });
  ds.actions.addPhenomenon('fire', { event: 'fire', position: [3, 4], height: 2, radius: 1.5, duration: 900 });
  const text = ds.buildLib.serializeDocument(ds.world.getState().doc, false);
  const r = ds.buildLib.parseDocument(text);
  void d;
  return { ok: r.ok, version: JSON.parse(text).schemaVersion, fire: r.ok ? r.doc.settings.simulation.fire : null, spec: r.ok ? r.doc.scenario.experiment.instances.find((i) => i.type === 'fire')?.spec : null };
});
check('29 fire scenario and fire settings saved and reloaded (schema 7)', saved29.ok && saved29.version === 7 && saved29.fire?.openings === 'closed' && saved29.fire?.foliageMoisture === 0.4 && saved29.spec?.radius === 1.5, saved29);

// ══ 30: panels in this language without cut text ═════════════════════════════════════════════════
await newWorld();
await ev(() => window.__ds.actions.addPhenomenon('fire'));
I = await inst();
await expand(I[0].id);
await wait(400);
const clip30 = await clipped(['[data-testid="fire-tools"]']);
await shot('30-tools');
check('30 fire tools panel text not cut in this language', clip30.length === 0, clip30);

// ── Whole run ─────────────────────────────────────────────────────────────────────────────────
await newWorld();
await wait(800);
const heap1 = await heapMB();
const geo1 = await geometries();
console.log(JSON.stringify({ heap0, heap1, geo0, geo1, crashed }));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; ${errors.length} page errors; heap ${heap0} → ${heap1} MB; geometries ${geo0} → ${geo1}; crashed ${crashed}`);
if (errors.length) console.log(errors.slice(0, 10).join('\n'));
fs.writeFileSync(path.join(out, `results-${lang}.json`), JSON.stringify({ lang, url, results, errors, heap: [heap0, heap1], geometries: [geo0, geo1], crashed }, null, 2));
await browser.close();
process.exit(results.every((r) => r.ok) && errors.length === 0 && !crashed ? 0 : 1);
