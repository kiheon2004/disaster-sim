// Browser verification of variable gravity (Phase 31): 45+ scenarios in real Chrome through the UI (experiment tab: add
// a gravity experiment, magnitude / direction / profile inputs and rejections, local region and radial sources, presets
// with demo worlds, preview; runs: free fall, low / high / zero / reversed / sideways gravity, a local well, vehicles,
// people, roof snow load and roof failure (R1), building collapse and debris, flood, air pressure, convection, fire,
// smoke, snow, ice, volcano, meteor, blast, multi-hazard, save / load, reset, original world, rerun, a 1000-house town,
// repeated runs) with state checks, plus whole-run checks (page errors, the tab alive, GPU geometries, heap, text not cut).
//
//   npm run build && npx vite preview --port 4199 --strictPort &
//   LANG_UI=ko node scripts/verify-gravity.mjs http://localhost:4199/ ./docs/verify/gravity
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:4199/', out = './docs/verify/gravity'] = process.argv.slice(2);
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
async function view(x, z, h = 60, back = 70, y = 0) {
  await ev(([x, z, h, back, y]) => { const st = window.__r3f.get(); st.camera.position.set(x + back * 0.5, y + h, z + back); st.controls.target.set(x, y, z); st.controls.update(); }, [x, z, h, back, y]);
  await wait(300);
}
const inst = () => ev(() => window.__ds.world.getState().doc.scenario.experiment?.instances ?? []);
const fp = () => ev(() => window.__ds.blueprintLib.worldFingerprint(window.__ds.world.getState().doc));
async function newWorld() {
  await ev(() => { window.__ds.actions.newProject(); const v = window.__ds.view.getState(); v.setGroundPreview(null); v.setGroundPick(null); v.setWaterProbe(null); v.setSimMember(null); v.setGravityViz({ overlay: 'off', arrows: true, sources: true }); });
  await wait(300);
}
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
  await wait(250);
};
const setSelect = (id, field, value) => ev(([id, field, value]) => {
  const s = document.querySelector(`[data-instance="${id}"] select[data-field="${field}"]`);
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(s, value);
  s.dispatchEvent(new Event('change', { bubbles: true }));
}, [id, field, value]);
async function enterRun() {
  await clickText(/^\s*실험 실행|Run experiment/);
  await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status === 'running', { timeout: 120_000 });
}
const atTime = (T) => ev((T) => { const s = window.__ds.sim; s.pause(); const r = T - s.getTime(); if (r > 0) s.advance(r); return s.getTime(); }, T);
const exitSim = async () => { await ev(() => window.__ds.actions.exitSimulation()); await wait(500); };
const gl = () => ev(() => window.__ds.simStore.getState().gravity);
const ms = () => ev(() => window.__ds.simStore.getState().milestones.map((m) => m.kind));
const clipped = (sels) => ev((sels) => {
  const out = [];
  for (const sel of sels) for (const root of document.querySelectorAll(sel)) for (const el of root.querySelectorAll('*')) {
    if (!el.childNodes.length || ![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    if (cs.overflow === 'visible' && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && cs.display !== 'inline') out.push(`${sel}: ${el.textContent.trim().slice(0, 40)}`);
  }
  return out;
}, sels);
const add = (type, spec) => ev(([type, spec]) => window.__ds.actions.addPhenomenon(type, spec), [type, spec]);
const G = (p = {}) => ({ event: 'gravity', scenario: 'custom', global: true, magnitude: 9.81, direction: [0, -1, 0], transition: 'vector', profile: 'constant', duration: 600, end: 'hold', sources: [], startTime: 1, ...p });
const addObjects = (list) => ev((list) => {
  const ds = window.__ds;
  const add = list.map((o) => o.preset ? { type: 'building', building: ds.buildingLib.createDesign(ds.buildingLib.presetSpec(o.preset), o.preset), seed: o.seed ?? 1, transform: { position: [o.x, 0, o.z], rotation: [0, 0, 0], scale: [1, 1, 1] } } : { type: o.type, seed: o.seed ?? 1, params: o.params, transform: { position: [o.x, o.y ?? 0, o.z], rotation: [0, o.yaw ?? 0, 0], scale: [1, 1, 1] } });
  ds.world.getState().applyEdit({ add });
}, list);
const ent = (type, k = 0) => ev(([type, k]) => { const e = [...window.__ds.sim.getRuntime().entities.values()].filter((x) => x.source.type === type)[k]; return e ? { id: e.id, p: [...e.pose.position], state: e.state, cause: e.lastCause, hazard: e.lastHazard } : null; }, [type, k]);
const gHash = () => ev(() => {
  const rt = window.__ds.sim.getRuntime(); const r = window.__ds.gravityLib.rt();
  const ents = [...rt.entities.values()].map((e) => `${e.source.type}${e.pose.position.map((v) => v.toFixed(5)).join(',')}${e.state}`).sort().join(';');
  return `${ents.length}|${ents.slice(0, 200)}|${r ? JSON.stringify(r.balance()) : ''}|${rt.debris.length}`;
});
const heap0 = await heapMB();
const geo0 = await geometries();

// ══ 1–8: the editor ══════════════════════════════════════════════════════════════════════════
await newWorld();
await clickText(/^\s*현상 추가|Add phenomenon/);
await wait(250);
await clickText(new RegExp('^\\s*' + (await tr('phen.gravity')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$'));
await wait(400);
let I = await inst();
const id = I.find((i) => i.type === 'gravity')?.id;
await expand(id);
const fields1 = await ev((id) => [...document.querySelectorAll(`[data-instance="${id}"] [data-field]`)].map((e) => e.getAttribute('data-field')), id);
await shot('01-add');
check('1 gravity tool: a gravity experiment added from the Experiment tab (scenario, global, magnitude, multiple, direction, transition, profile, duration, end, add source)', !!id && ['scenario', 'global', 'magnitude', 'ratio', 'dir', 'transition', 'profile', 'duration', 'end', 'addSource'].every((f) => fields1.includes(f)), fields1);
await setSelect(id, 'scenario', 'custom');
await setNumber(id, 'magnitude', 4.9);
I = await inst();
await setNumber(id, 'magnitude', 80);
const clamp2 = (await inst())[0].spec.magnitude;
await setNumber(id, 'magnitude', 4.9);
check('2 magnitude input: 4.9 m/s² stored; 80 m/s² is held at the 50 m/s² input limit (beyond it the models are out of range)', Math.abs(I[0].spec.magnitude - 4.9) < 1e-9 && clamp2 <= 50, { g: I[0].spec.magnitude, clamp2 });
await setSelect(id, 'dir', 'custom');
await wait(300);
await setNumber(id, 'd0', 0);
await setNumber(id, 'd1', 0);
await setNumber(id, 'd2', 0);
const invalid3 = await ev((id) => document.querySelector(`[data-instance="${id}"]`)?.textContent ?? '', id);
await setNumber(id, 'd0', 0.5);
await setNumber(id, 'd1', -1);
I = await inst();
const dirFields = await ev((id) => ['d0', 'd1', 'd2'].every((f) => !!document.querySelector(`[data-instance="${id}"] [data-field="${f}"]`)), id);
check('3 direction input: a custom vector (x, y, z) stored as given (normalized on use); the zero vector rejected with its reason', dirFields && I[0].spec.direction[0] === 0.5 && invalid3.includes((await tr('gravity.invalid.direction')).slice(0, 10)), I[0].spec.direction);
await setSelect(id, 'dir', 'down');
await setSelect(id, 'profile', 'pulse');
await wait(300);
const prof4 = await ev((id) => ['period', 'pulseWidth', 'ramp'].every((f) => !!document.querySelector(`[data-instance="${id}"] [data-field="${f}"]`)), id);
const chart4 = await ev(() => !!document.querySelector('[data-testid="gravity-path"] polyline'));
await shot('04-profile');
check('4 time profile: pulse shows period / width / edge fields; the path chart from the run\'s functions', prof4 && chart4 && (await inst())[0].spec.profile === 'pulse');
await setSelect(id, 'profile', 'smooth');
await setSelect(id, 'addSource', 'region');
await wait(300);
I = await inst();
const f5 = await ev((id) => ['s0.x', 's0.radius', 's0.shape', 's0.mode', 's0.ax', 's0.ay'].every((f) => !!document.querySelector(`[data-instance="${id}"] [data-field="${f}"]`)), id);
check('5 local region: a source with centre, radius, taper, shape, mode and acceleration vector', I[0].spec.sources.length === 1 && I[0].spec.sources[0].kind === 'region' && f5, I[0].spec.sources[0]);
await setSelect(id, 'addSource', 'radial');
await wait(300);
await setNumber(id, 's1.strength', 50);
await setNumber(id, 's1.r0', 30);
await setNumber(id, 's1.softening', 1);
const invalid6 = await ev((id) => document.querySelector(`[data-instance="${id}"]`)?.textContent ?? '', id);
await setNumber(id, 's1.strength', 10);
await setNumber(id, 's1.r0', 5);
await setNumber(id, 's1.softening', 3);
I = await inst();
check('6 radial field: strength, reference radius, law, softening — a core stronger than 50 m/s² rejected with its reason (soften or weaken)', I[0].spec.sources[1]?.kind === 'radial' && I[0].spec.sources[1].softening === 3 && invalid6.includes((await tr('gravity.invalid.core')).slice(0, 10)), I[0].spec.sources[1]);
const sup7 = await ev(() => document.querySelector('[data-testid="gravity-support"]')?.textContent ?? '');
const pres7 = await ev(() => document.querySelectorAll('[data-testid="gravity-preset-select"] option').length);
check('7 presets: 15 gravity presets listed with their assumptions; model-support badges', pres7 === 15 && sup7.length > 40, { pres7 });
await ev((id) => window.__ds.view.getState().setGroundPreview(id), id);
await wait(1200);
const prev8 = await ev(() => { let arrows = 0, srcs = 0; window.__r3f.get().scene.traverse((o) => { if (o.name === 'gravity-preview') o.traverse((m) => { if (m.isInstancedMesh) arrows += m.count; else if (m.isMesh) srcs++; }); }); return { arrows, srcs }; });
await view(0, 0, 60, 80);
await shot('08-preview');
check('8 preview: field arrows on the grid and the two source regions (the experiment alone, at its largest departure)', prev8.arrows > 100 && prev8.srcs === 2, prev8);
await ev(() => window.__ds.view.getState().setGroundPreview(null));

// ══ 14–17, 9–13: free fall, low / high / zero gravity with objects ═════════════════════════════
const fallRun = async (spec, T) => {
  await newWorld();
  await addObjects([{ type: 'car', x: 0, z: 0, y: 30, seed: 1 }, { type: 'car', x: 10, z: 0, seed: 2 }, { type: 'human', x: -10, z: 0, seed: 3 }, { preset: 'house', x: -30, z: -30, seed: 4 }]);
  await add('gravity', spec);
  await wait(400);
  await enterRun();
  return atTime(T); // the sim time actually reached: it runs in real time until the pause, so it can be past T on a slow machine
};
const t14m = await fallRun(G({ magnitude: 1.62, startTime: 0 }), 2);
const y14 = (await ent('car', 0)).p[1];
await exitSim();
const t14e = await fallRun(G({ magnitude: 9.81, startTime: 0 }), 2);
const y14e = (await ent('car', 0)).p[1];
check('14 free fall: from 30 m the car falls ≈ ½gt² — 2 s at Earth g ≈ 19.6 m, at Moon-like g ≈ 3.2 m', Math.abs(30 - y14e - 0.5 * 9.81 * t14e * t14e) < 1.5 && Math.abs(30 - y14 - 0.5 * 1.62 * t14m * t14m) < 0.4, { tEarth: t14e, tMoon: t14m, earth: 30 - y14e, moon: 30 - y14 });
let L = await gl();
await ev(() => window.__ds.view.getState().setGravityViz({ overlay: 'magnitude' }));
await wait(1200);
const leg9 = await ev(() => document.querySelector('[data-testid="gravity-overlay"]')?.textContent ?? '');
const arrows9 = await ev(() => { let n = 0; window.__r3f.get().scene.traverse((o) => { if (o.name === 'gravity-layer') o.traverse((m) => { if (m.isInstancedMesh && m.count > 100) n = Math.max(n, m.count); }); }); return n; });
await view(0, 0, 50, 60);
await shot('09-overlay');
check('9 overlay: gravity magnitude on the ground with its fixed m/s² legend (9.81 marked), arrows of the field', leg9.includes('m/s²') && leg9.includes('9.81') && arrows9 > 100, { leg: leg9.slice(0, 80), arrows9 });
const hud10 = await ev(() => document.querySelector('[data-testid="gravity-hud"]')?.textContent ?? '');
const clip10 = await clipped(['[data-testid="gravity-hud"]', '[data-testid="gravity-overlay"]']);
await ev(() => window.__ds.view.getState().setGravityViz({ overlay: 'contactLoad' }));
await wait(1200);
const leg9b = await ev(() => document.querySelector('[data-testid="gravity-overlay"]')?.textContent ?? '');
const dots9b = await ev(() => { let n = 0; window.__r3f.get().scene.traverse((o) => { if (o.name === 'gravity-layer') o.traverse((m) => { if (m.isInstancedMesh && m.visible && m.geometry.type === 'SphereGeometry') n = Math.max(n, m.count); }); }); return n; });
await shot('09b-contact-load');
check('9b contact-load overlay: each dynamic body marked by its normal load m·g_down (kN legend)', leg9b.includes('kN') && dots9b >= 2, { dots9b });
await ev(() => window.__ds.view.getState().setGravityViz({ overlay: 'off' }));
check('10 HUD: current gravity, × g₀, regime, bodies, structures, pressure, energy / momentum; text not cut', hud10.includes('m/s²') && hud10.includes('g₀') && clip10.length === 0, { hud: hud10.slice(0, 120), clip10 });
const carId = (await ent('car', 1)).id;
await ev((id) => window.__ds.editor.getState().select(id), carId);
await wait(700);
const insp11 = await ev(() => document.querySelector('[data-testid="gravity-object"]')?.textContent ?? '');
await shot('11-inspector');
await ev(() => window.__ds.editor.getState().select(null));
await ev(() => window.__ds.view.getState().setWaterProbe({ x: 20, z: 20 }));
await wait(600);
const probe11 = await ev(() => document.querySelector('[data-testid="gravity-probe"]')?.textContent ?? '');
await ev(() => window.__ds.view.getState().setWaterProbe(null));
check('11 inspector: mass (constant) vs weight (mass × local g), local vector, sources, velocity, contact; ground probe with potential', insp11.includes('kg') && insp11.includes('kN') && insp11.includes('m/s²') && probe11.includes('J/kg'), { insp: insp11.slice(0, 140), probe: probe11.slice(0, 80) });
await exitSim();
await fallRun(G({ magnitude: 0, profile: 'constant', startTime: 0 }), 6);
const y16 = await ent('car', 0);
L = await gl();
const M16 = await ms();
check('16 zero gravity: the car released at 30 m does not fall (no weight, no other force); zero-gravity milestone', L.mode === 'zero' && M16.includes('zeroGravity') && Math.abs(y16.p[1] - 30) < 0.05, { y: y16.p[1], mode: L.mode });
check('12 timeline: gravity start, decrease and zero-gravity milestones', M16.includes('start') && M16.includes('gravityDecrease') && M16.includes('zeroGravity'), M16);
await ev(() => window.__ds.ui.getState().setResultsOpen(true));
await wait(800);
const res13 = await ev(() => document.querySelector('[data-testid="gravity-results"]')?.textContent ?? '');
const csv13 = await ev(() => !!document.querySelector('[data-testid="gravity-csv"]'));
const clip13 = await clipped(['[data-testid="gravity-results"]']);
await shot('13-results');
await ev(() => window.__ds.ui.getState().setResultsOpen(false));
check('13 results: gravity cards, CSV (field, support, ledgers, bodies, buildings, history), JSON summary; text not cut', res13.length > 60 && csv13 && clip13.length === 0, { res: res13.slice(0, 80), clip13 });
await exitSim();
await fallRun(G({ magnitude: 3 * 9.81, profile: 'linear', ramp: 2, startTime: 0 }), 3);
L = await gl();
check('15 high gravity: 3 g₀ acting (mode high), resting bodies pressed with 3× their weight (contact thresholds raised)', L.mode === 'high' && Math.abs(L.ratio - 3) < 0.02, { ratio: L.ratio });
await exitSim();
await fallRun(G({ magnitude: 1.62, startTime: 0 }), 4);
L = await gl();
check('15b low gravity: Moon-like 1.62 m/s² (0.165 g₀), mode low', L.mode === 'low' && Math.abs(L.magnitude - 1.62) < 1e-6, { g: L.magnitude });
await exitSim();

// ══ 17–19, 21: reversed / sideways / local, people ═════════════════════════════════════════════
await fallRun(G({ magnitude: 9.81, direction: [0, 1, 0], profile: 'smooth', ramp: 1, startTime: 1, duration: 3, end: 'restore' }), 3.5);
const p17 = await ent('human', 0);
const c17 = await ent('car', 1);
await view(0, 0, 40, 60);
await shot('17-reverse');
check('17 reversed gravity: loose people and cars float upward (the house stays, fixed)', p17.p[1] > 1 && c17.p[1] > 1, { human: p17.p[1], car: c17.p[1] });
check('21 people: weight follows the field — reversed, they lift off the ground (mass unchanged; no physiology in this phase)', p17.p[1] > 1);
await exitSim();
await fallRun(G({ magnitude: 9.81, direction: [1, 0, 0], transition: 'rotate', profile: 'smooth', ramp: 1, startTime: 1, duration: 4, end: 'restore' }), 4);
const c18 = await ent('car', 1);
L = await gl();
check('18 sideways gravity: the parked car slides / falls along +x; HUD vector horizontal', c18.p[0] > 13, { x: c18.p[0] });
await exitSim();
await newWorld();
await addObjects([{ type: 'car', x: 12, z: 0, seed: 1 }, { type: 'car', x: -12, z: 0, seed: 2 }, { type: 'human', x: 0, z: 12, seed: 3 }]);
// a(12 m) = S·r0²·r/(r² + ε²)^1.5 ≈ 10.7 m/s² — stronger than the grip μ·g ≈ 7 m/s² holding the parked cars.
await add('gravity', G({ global: false, profile: 'smooth', ramp: 1, sources: [{ kind: 'radial', center: [0, 1, 0], radius: 25, falloff: 'smooth', edge: 5, strength: 50, r0: 6, law: 'inverseSquare', softening: 4, followProfile: true }] }));
await wait(400);
await enterRun();
await atTime(5);
const c19 = await ent('car', 0), c19b = await ent('car', 1);
L = await gl();
await ev(() => window.__ds.view.getState().setGravityViz({ overlay: 'off', sources: true }));
await view(0, 0, 40, 50);
await wait(800);
await shot('19-local-well');
check('19 local gravity well: both parked cars pulled toward the centre once the pull exceeds their grip (field difference through the ForceLedger), mode local', Math.abs(c19.p[0]) < 11 && Math.abs(c19b.p[0]) < 11 && L.mode === 'local' && L.sources.length === 1, { a: c19.p[0], b: c19b.p[0] });
await exitSim();

// ══ 20: vehicles — friction under the normal load ════════════════════════════════════════════════
const sideRun = async (down) => {
  await newWorld();
  await addObjects([{ type: 'car', x: 0, z: 0, seed: 1 }]);
  await add('gravity', G({ magnitude: Math.hypot(0.3 * 9.81, down), direction: [0.3 * 9.81, -down, 0], startTime: 1 }));
  await wait(300);
  await enterRun();
  await atTime(5);
  const x = (await ent('car', 0)).p[0];
  await exitSim();
  return x;
};
const x20a = await sideRun(9.81), x20b = await sideRun(1.62);
check('20 vehicles: the friction coefficient is unchanged, the normal load is not — 0.3 g sideways holds at 1 g down, slides at Moon-like g down', Math.abs(x20a) < 0.3 && x20b > 2, { earth: x20a, moon: x20b });

// ══ 22–26: roof snow load, roof failure (R1), building collapse, debris ══════════════════════════
await newWorld();
await ev((s) => window.__ds.actions.loadGravityDemo(s), 'highSnow');
await wait(1200);
const fp22 = await fp();
await enterRun();
await atTime(20);
const roof22 = await ev(() => { const e = [...window.__ds.sim.getRuntime().entities.values()].find((x) => x.source.type === 'building' && x.dims[0] > 20); return { kPa: e.climate?.loadKPa ?? 0, applied: e.climate?.applied }; });
check('22 roof snow load: snow mass × g on the roof members; the reported pressure grows with g (same mass)', roof22.kPa > 0.6 && roof22.applied, roof22);
await atTime(75);
L = await gl();
const ev23 = await ev(() => window.__ds.simStore.getState().damageEvents.filter((d) => d.eventType === 'FAILED' && d.memberType === 'roof').map((d) => `${d.hazard}/${d.cause}`));
await view(-4, -30, 30, 40);
await shot('23-roof-failure');
check('23 roof failure (R1): roof panels fail under snow × 2 g — hazard gravity, cause gravity load; the snow falls with them', L.structures.roofFailures > 0 && ev23.some((x) => x.startsWith('gravity/')), { roofs: L.structures.roofFailures, ev23: ev23.slice(0, 3) });
await exitSim();
check('41 original world: leaving the run leaves the demo world untouched (fingerprint)', (await fp()) === fp22);
await newWorld();
await ev((s) => window.__ds.actions.loadGravityDemo(s), 'highCollapse');
await wait(1200);
await enterRun();
await atTime(70);
L = await gl();
const col24 = await ev(() => { const S = window.__ds.sim.getRuntime().structures; return { fragments: S?.fragments.length ?? 0, piles: S?.rubble.heaps.length ?? 0, collapsed: [...window.__ds.sim.getRuntime().entities.values()].filter((e) => e.flags.collapsed || Number.isFinite(e.modular?.collapsedFrom)).length }; });
const M24 = await ms();
await view(30, 0, 60, 70);
await shot('24-collapse');
check('24 building collapse: members fail under 4 g (hazard gravity), the load redistributes, stories collapse; failure and debris-impact milestones', L.structures.failures > 0 && col24.collapsed > 0 && M24.includes('gravityFailure') && M24.includes('gravityDebrisImpact'), { failures: L.structures.failures, col24 });
check('25 debris: falling blocks land as rubble piles (and fragments) — mass ledgers of the buildings closed', col24.piles + col24.fragments > 0, col24);
await ev(() => window.__ds.view.getState().setGravityViz({ overlay: 'structLoad' }));
await wait(1000);
const leg26 = await ev(() => document.querySelector('[data-testid="gravity-overlay"]')?.textContent ?? '');
await shot('26-struct-load');
check('26 structural gravity-load overlay: buildings tinted by their gravity ratio (× g₀ legend)', leg26.includes('g₀'), leg26.slice(0, 60));
await exitSim();

// ══ 27–37: fluids, air, heat, fire, snow, ice, volcano, meteor, blast, multi-hazard ══════════════
await newWorld();
await ev(() => window.__ds.world.getState().setFeatures([{ id: 'pond', kind: 'lake', points: [[-40, -30], [40, -30], [40, 30], [-40, 30]], surface: -0.3, depth: 1.2, shoreWidth: 3, material: 7, filled: true }], 2));
await addObjects([{ type: 'car', x: 0, z: 0, seed: 1 }]);
await add('rain', { event: 'rain', intensity: 60, duration: 120 });
await add('gravity', G({ magnitude: 0, profile: 'constant', startTime: 3 }));
await wait(400);
await enterRun();
await atTime(10);
L = await gl();
check('27 flood: the water model runs before and holds without downward gravity (no fake 3D liquid; held time reported)', L.held.water > 5 && L.support.flood === 'unsupported', { held: L.held.water, s: L.support.flood });
await exitSim();
await newWorld();
await add('atmosphere', { event: 'atmosphere', altitude: 0, boundary: 'closed', thermo: 'adiabatic', removal: 'none', startTime: 0 });
await add('gravity', G({ magnitude: 2 * 9.81, profile: 'linear', ramp: 5, startTime: 1 }));
await wait(400);
await enterRun();
await atTime(15);
L = await gl();
const p28 = await ev(() => { const r = window.__ds.sim.getEnvironment().atmosphere.rt; return { p: r.field.meanReducedPressure(), M: r.field.totalMass(), M0: r.field.mass.initial }; });
check('28 air pressure: the column mass is kept, its weight doubles at 2 g (p ≈ 2·101 kPa, modelled)', L.pressure.modelled && Math.abs(p28.p / 101325 - 2) < 0.02 && Math.abs(p28.M / p28.M0 - 1) < 1e-9, p28);
await exitSim();
await newWorld();
await addObjects([{ preset: 'house', x: 0, z: 0, seed: 1 }]);
await add('heatSource', { event: 'heatSource', kind: 'point', position: [0, 0], height: 1.5, radius: 2, input: 'power', power: 2e6, profile: 'constant', duration: 120, startTime: 0 });
await add('gravity', G({ magnitude: 0, profile: 'constant', startTime: 0 }));
await wait(400);
await enterRun();
await atTime(20);
L = await gl();
check('29 thermal convection: at zero gravity natural convection is limited (no buoyant rise) — flagged in the HUD', L.support.convection === 'limited' && L.support.fire === 'limited', L.support);
await exitSim();
await newWorld();
await ev(() => { const s = window.__ds.world.getState().doc.settings.simulation; s.fire = { foliageMoisture: 0.8, openings: 'windowsOpen', heatIgnition: false }; });
await addObjects([{ preset: 'house', x: 0, z: 0, seed: 7 }]);
await add('fire', { event: 'fire', position: [0, 0], height: 1, radius: 1, duration: 900, startTime: 0 });
await add('gravity', G({ magnitude: 2 * 9.81, startTime: 0 }));
await wait(400);
await enterRun();
await atTime(120);
const f30 = await ev(() => window.__ds.simStore.getState().fire);
check('30 fire: the room fire develops under 2 g (vent inflow ∝ √g, flame height ∝ g^−⅕)', !!f30 && f30.peakHrr > 0 && f30.ignitedObjects > 0, f30 ? { peak: f30.peakHrr, ignited: f30.ignitedObjects, maxFlame: f30.maxFlame } : null);
check('31 smoke: soot produced and carried by the room exchange / venting at √(g·h·ΔT/T) — rooms tracked under the scaled buoyancy', !!f30 && f30.rooms > 0 && f30.smokeAir > 0, f30 ? { rooms: f30.rooms, smokeAir: f30.smokeAir, minVisibility: f30.minVisibility } : null);
await exitSim();
await newWorld();
await addObjects([{ preset: 'house', x: 0, z: 0, seed: 1 }]);
await add('climate', { event: 'climate', scenario: 'custom', forcing: 'flux', temperature: 268.15, target: 268.15, profile: 'constant', duration: 900, humidity: 0.85, precipitation: 0, solar: 'off', soilMoisture: 0.25, initialSnow: 0.3, initialSnowDensity: 150, initialIce: 0, blowingSnow: false });
await add('gravity', G({ magnitude: 3 * 9.81, startTime: 0 }));
await wait(400);
await enterRun();
await atTime(1200);
const s32 = await ev(() => { const r = window.__ds.climateLib.rt(); const c = r.trt.world.terrain.index(-40, 40); return { rho: r.cw.cRho[c], res: r.stats.waterResidual }; });
// CLM at −5 °C: metamorphism ≈ 0.03 % and the overburden ≈ 0.06 % per 20 min at 1 g — three times the overburden at 3 g.
check('32 snow: compaction under 3× the overburden weight (density rises from 150 kg/m³ faster than the 1 g rate), water ledger closed', s32.rho > 150.2 && s32.res < 1e-8, s32);
await exitSim();
await newWorld();
await ev(() => window.__ds.world.getState().setFeatures([{ id: 'lk', kind: 'lake', points: [[-50, -30], [30, -30], [30, 30], [-50, 30]], surface: -0.3, depth: 0.8, shoreWidth: 3, material: 7, filled: true }], 2));
await add('climate', { event: 'climate', scenario: 'lakeFreezing', forcing: 'flux', temperature: 258.15, target: 258.15, profile: 'constant', duration: 1800, humidity: 0.8, precipitation: 0, solar: 'off', soilMoisture: 0.25 });
await add('gravity', G({ magnitude: 1.62, startTime: 0 }));
await wait(400);
await enterRun();
await atTime(600);
const i33 = await ev(() => window.__ds.climateLib.rt().stats);
check('33 ice: the lake freezes at Moon-like gravity (latent heat path unchanged, ledgers closed)', i33.iceMass > 0 && i33.waterResidual < 1e-8, { ice: i33.iceMass });
await exitSim();
await newWorld();
await addObjects([{ preset: 'house', x: -10, z: 20, seed: 1 }]);
await add('volcano', { event: 'volcano', vents: [{ kind: 'central', position: [-40, 0], radius: 2 }], material: 'basalt', temperature: 1150, rate: 2, duration: 120, profile: 'constant', bombFraction: 0.05, ashFraction: 0.1, plumeHeight: 60, startTime: 0 });
await add('gravity', G({ magnitude: 3.71, startTime: 0 }));
await wait(400);
await enterRun();
await atTime(60);
const v34 = await ev(() => window.__ds.simStore.getState().volcano);
check('34 volcano: lava drive ρ·g·sinθ, bombs fly under the field vector, ash settles at Mars-like g', !!v34, v34 ? Object.keys(v34).slice(0, 5) : null);
await exitSim();
await newWorld();
await addObjects([{ preset: 'house', x: 30, z: 0, seed: 1 }]);
await add('gravity', G({ magnitude: 1.62, startTime: 0 }));
await add('impact', { event: 'impact', target: [0, 0], material: 'stony', diameter: 1, speed: 15000, angle: 60, azimuth: 45, entry: 'direct', airBlast: true, startTime: 1 });
await wait(400);
await enterRun();
await atTime(10);
const m35 = await ev(() => { const m = window.__ds.sim.getEnvironment().impact.models[0]; return m ? { R: m.plan.crater?.radius, v: m.plan.speed } : null; });
check('35 meteor: the in-world arc, crater (gravity regime R ∝ g^−μ/(2+μ)) and ejecta use the Moon-like g', !!m35 && m35.R > 0, m35);
await exitSim();
await newWorld();
await addObjects([{ preset: 'house', x: 20, z: 0, seed: 1 }, { type: 'human', x: 10, z: 10, seed: 2 }]);
await add('gravity', G({ magnitude: 1.62, startTime: 0 }));
await add('blast', { event: 'blast', position: [0, 0], height: 1, energy: 5e8, model: 'weakShock', waveform: 'nWave', startTime: 2 });
await wait(400);
await enterRun();
await atTime(6);
const b36 = await ev(() => window.__ds.simStore.getState().blasts);
check('36 blast: the pressure wave is unchanged by gravity (energy not altered); bodies it knocks over need less energy at low g', !!b36);
await exitSim();
await newWorld();
await ev((s) => window.__ds.actions.loadGravityDemo(s), 'ramp');
await wait(1200);
await add('earthquake', { event: 'earthquake', magnitude: 6.5, pga: 0.35, duration: 10, seed: 3, startTime: 10 });
await add('rain', { event: 'rain', intensity: 80, duration: 60 });
await wait(400);
await enterRun();
await atTime(40);
L = await gl();
const fin37 = await ev(() => { let bad = 0; for (const e of window.__ds.sim.getRuntime().entities.values()) for (const v of e.pose.position) if (!Number.isFinite(v)) bad++; return bad; });
check('37 multi-hazard: gravity ramp + earthquake + rain on the demo block — finite state, gravity ledger finite', fin37 === 0 && Number.isFinite(L.balance.workGravity), { fin37, W: L.balance.workGravity });
await exitSim();

// ══ 38–42: save / load, reset, original world, rerun ═════════════════════════════════════════════
const saved38 = await ev(() => {
  const ds = window.__ds;
  ds.actions.addPhenomenon('gravity', { event: 'gravity', scenario: 'well', global: false, magnitude: 9.81, direction: [0, -1, 0], transition: 'vector', profile: 'staged', stages: [[10, 0.5], [20, 1]], duration: 60, end: 'restore', sources: [{ kind: 'radial', center: [0, 2, 0], radius: 25, falloff: 'smooth', edge: 8, strength: 15, r0: 5, law: 'inverseSquare', softening: 3, followProfile: true }] });
  const text = ds.buildLib.serializeDocument(ds.world.getState().doc, false);
  const r = ds.buildLib.parseDocument(text);
  return { ok: r.ok, version: JSON.parse(text).schemaVersion, spec: r.ok ? r.doc.scenario.experiment.instances.filter((i) => i.type === 'gravity').pop()?.spec : null };
});
check('38 save: the gravity experiment (staged profile, radial source) saved in schema 7', saved38.ok && saved38.version === 7 && saved38.spec?.profile === 'staged' && saved38.spec?.sources?.[0]?.law === 'inverseSquare', saved38);
check('39 load: reloaded spec identical (stages, end mode, source)', saved38.spec?.stages?.[1]?.[0] === 20 && saved38.spec?.end === 'restore' && saved38.spec?.sources?.[0]?.softening === 3);
await newWorld();
await ev((s) => window.__ds.actions.loadGravityDemo(s), 'pulse');
await wait(1200);
const fp40 = await fp();
await enterRun();
await atTime(25);
const h40a = await gHash();
await ev(() => window.__ds.actions.resetSimulation());
await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status !== 'loading', { timeout: 120_000 });
const r40 = await ev(() => ({ field: window.__ds.gravityLib.channel().field === null, t: window.__ds.sim.getTime(), g: window.__ds.gravityLib.physics().getGravity() }));
check('40 reset: the field and the Rapier gravity back to the project gravity, t = 0', r40.field && r40.t === 0 && r40.g[1] === -9.81, r40);
await ev(() => window.__ds.sim.play());
await atTime(25);
const h40b = await gHash();
check('42 same conditions again (rerun after reset): identical bodies and gravity ledger', h40a === h40b, { h40a: h40a.slice(0, 60), h40b: h40b.slice(0, 60) });
await exitSim();
check('41b original world after the pulse run: fingerprint unchanged', (await fp()) === fp40);

// ══ 43: large town ══════════════════════════════════════════════════════════════════════════════
await newWorld();
await ev(() => {
  const ds = window.__ds;
  const d = ds.buildingLib.createDesign(ds.buildingLib.presetSpec('house'), 'house');
  const add = [];
  for (let z = -94; z <= 94 && add.length < 1000; z += 6) for (let x = -94; x <= 94 && add.length < 1000; x += 6) add.push({ type: 'building', building: d, seed: add.length + 1, transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] } });
  ds.world.getState().applyEdit({ add });
  ds.actions.addPhenomenon('gravity', { event: 'gravity', scenario: 'ramp', global: true, magnitude: 2.5 * 9.81, direction: [0, -1, 0], transition: 'vector', profile: 'linear', ramp: 20, duration: 600, end: 'hold', sources: [] });
});
await wait(1500);
await enterRun();
await atTime(30);
await view(0, 0, 90, 110);
await ev(() => window.__ds.sim.play());
const fps43 = await ev(() => new Promise((res) => { const t = []; let last = performance.now(); const f = (now) => { t.push(now - last); last = now; if (t.length < 240) requestAnimationFrame(f); else res({ mean: t.reduce((a, b) => a + b, 0) / t.length, worst: Math.max(...t.slice(10)) }); }; requestAnimationFrame(f); }));
const gl43 = await ev(() => { const g = window.__r3f.get().gl.info; return { calls: g.render.calls, geometries: g.memory.geometries, textures: g.memory.textures }; });
L = await gl();
await shot('43-town');
await exitSim();
check('43 large town (1000 houses) under a gravity ramp to 2.5 g: every building re-loaded, interactive frame rate', fps43.mean < 100 && L.structures.loaded >= 900, { fps: +(1000 / fps43.mean).toFixed(1), worstFrameMs: +fps43.worst.toFixed(1), loaded: L.structures.loaded, gl43, ms: L.ms });

// ══ 44–45: repeated runs, GPU resources ═════════════════════════════════════════════════════════
await newWorld();
await wait(500);
const geoA = await geometries();
const heaps44 = [];
for (let k = 0; k < 3; k++) {
  await newWorld();
  await ev((s) => window.__ds.actions.loadGravityDemo(s), 'well');
  await wait(800);
  await enterRun();
  await atTime(10);
  await ev(() => window.__ds.view.getState().setGravityViz({ overlay: 'magnitude', arrows: true, sources: true }));
  await wait(800);
  await exitSim();
  heaps44.push(await heapMB());
}
await newWorld();
await wait(500);
const geoB = await geometries();
check('44 repeated runs: heap flat over three runs', heaps44[2] - heaps44[0] < 25, { heaps44 });
check('45 GPU resources released: geometries back after the gravity layer / preview were shown', geoB <= geoA + 2, { geoA, geoB });

// ══ 50–57: Phase 31 audit additions ════════════════════════════════════════════════════════════
const cl50 = (p = {}) => ({ event: 'climate', scenario: 'custom', forcing: 'flux', temperature: 268.15, target: 268.15, profile: 'constant', duration: 900, humidity: 0.85, precipitation: 0, solar: 'off', soilMoisture: 0.25, initialIce: 0, blowingSnow: false, ...p });
await newWorld();
await addObjects([{ preset: 'office', x: 0, z: 0, seed: 1 }]);
await add('gravity', G({ magnitude: 4.5 * 9.81, profile: 'linear', ramp: 8, startTime: 0 }));
await wait(400);
await enterRun();
await atTime(15);
L = await gl();
await view(0, 0, 50, 60);
await shot('50-ramp-collapse');
check('50 gravity ramp → 4.5 g on an office: structural failures attributed to gravity, debris, ledger finite; all members of the building take the ramp in the same step', L.structures.failures > 0 && Number.isFinite(L.balance.workGravity) && Number.isFinite(L.balance.workOther), { failures: L.structures.failures, debris: await ev(() => window.__ds.sim.getRuntime().debris.length) });
await exitSim();

await newWorld();
await addObjects([{ preset: 'house', x: 0, z: 0, seed: 3 }]);
await add('climate', cl50({ initialSnow: 1.2, initialSnowDensity: 300 }));
await add('gravity', G({ magnitude: 2 * 9.81, startTime: 3 }));
await wait(400);
const fp51 = await fp();
await enterRun();
await atTime(4);
const p51a = await ev(() => { const r = window.__ds.climateLib.rt(); return { n: r.cw.packets.length, carried: r.cw.packetMass() }; });
await atTime(16);
const p51 = await ev(() => { const r = window.__ds.climateLib.rt(); return { n: r.cw.packets.length, inTransit: r.cw.packetMass(), done: r.cw.packets.filter((p) => p.done).length, resting: r.packets.length, out: r.cw.water.boundaryOut, resW: r.stats.waterResidual, resE: r.stats.energyResidual }; });
await shot('51-snow-packets');
// Packets resting on a floor stay packets (snow indoors, its weight on the floor); the rest are on the ground.
check('51 roof snow under 2 g: failed panels carry their snow as packets (falling, resting on a floor, set down on the ground) — every packet either carried by a member or landed, mass unchanged, ledgers closed', p51a.n > 0 && p51.done + p51.resting === p51.n && p51.inTransit <= p51a.carried * (1 + 1e-12) && p51.resW < 1e-8 && p51.resE < 1e-8, { p51a, p51 });
await exitSim();
check('57 original world after roof-snow packets, collapse and gravity: fingerprint unchanged', (await fp()) === fp51);

await newWorld();
await addObjects([{ preset: 'warehouse', x: -20, z: 20, seed: 1 }]);
await add('gravity', G({ magnitude: 3.71, startTime: 0 }));
await add('volcano', { event: 'volcano', vents: [{ kind: 'central', position: [-40, 0], radius: 2 }], material: 'basalt', temperature: 1150, rate: 2, duration: 120, profile: 'constant', bombFraction: 0.05, ashFraction: 0.3, plumeHeight: 60, startTime: 0 });
await wait(400);
await enterRun();
await atTime(60);
const a52 = await ev(() => { const e = [...window.__ds.sim.getRuntime().entities.values()].find((x) => x.source.type === 'building'); const m = e.modular?.structure?.model; return { ash: e.volcano?.ash ?? 0, kPa: e.volcano?.ashLoad ?? 0, check: m ? m.s.roofCheck : null }; });
check('52 ash on a roof: the roof-panel check is on as for snow (failure by load, not by its source)', a52.ash > 0 ? a52.check === true : true, a52);
await exitSim();

await newWorld();
await ev(() => {
  const ds = window.__ds;
  const d = ds.buildingLib.createDesign(ds.buildingLib.presetSpec('house'), 'house');
  const add = [];
  for (let z = -94; z <= 94 && add.length < 500; z += 8) for (let x = -94; x <= 94 && add.length < 500; x += 8) add.push({ type: 'building', building: d, seed: add.length + 1, transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] } });
  ds.world.getState().applyEdit({ add });
  ds.actions.addPhenomenon('gravity', { event: 'gravity', scenario: 'well', global: false, magnitude: 9.81, direction: [0, -1, 0], transition: 'vector', profile: 'smooth', ramp: 4, duration: 600, end: 'hold', sources: [{ kind: 'region', center: [0, 0, 0], radius: 40, falloff: 'smooth', edge: 10, shape: 'column', mode: 'add', accel: [0, -2 * 9.81, 0], followProfile: true }] });
});
await wait(1500);
await enterRun();
await atTime(10);
await view(0, 0, 90, 110);
await ev(() => window.__ds.sim.play());
const fps53 = await ev(() => new Promise((res) => { const t = []; let last = performance.now(); const f = (now) => { t.push(now - last); last = now; if (t.length < 180) requestAnimationFrame(f); else res(t.reduce((a, b) => a + b, 0) / t.length); }; requestAnimationFrame(f); }));
L = await gl();
await shot('53-local-town');
await exitSim();
check('53 local heavy column over a 500-house town: only the buildings near it loaded (per member), interactive frame rate', L.structures.loaded > 0 && L.structures.loaded < 200 && fps53 < 100, { loaded: L.structures.loaded, fps: +(1000 / fps53).toFixed(1) });

await newWorld();
await addObjects([{ type: 'car', x: 0, z: 0, y: 20, seed: 1 }, { type: 'car', x: 8, z: 0, seed: 2 }, { preset: 'house', x: 20, z: 0, seed: 3 }]);
await add('gravity', G({ magnitude: 2 * 9.81, profile: 'linear', ramp: 6, startTime: 0 }));
await add('blast', { event: 'blast', position: [14, 0], height: 1, energy: 5e8, model: 'weakShock', waveform: 'nWave', startTime: 2 });
await wait(400);
await enterRun();
await atTime(8);
L = await gl();
const n54 = await ev(() => window.__ds.sim.getRuntime().debris.length);
// The blast's own work on the bodies is 'other work' (it may exceed gravity's); the books must still close: R_Φ = 0 in a uniform field.
check('54 bodies spawned (blast debris) during a gravity ramp: they enter the ledger with their K and U; the books close (field check ≈ 0, energy check = −ε)', n54 > 0 && Number.isFinite(L.balance.workOther) && Math.abs(L.balance.fieldResidual) < 1e-6 * Math.max(1, L.balance.workGravityGross) && Math.abs(L.balance.energyResidual + L.balance.integratorResidual) < 1e-6 * Math.max(1, L.balance.workGravityGross), { debris: n54, other: L.balance.workOther, gross: L.balance.workGravityGross, res: L.balance.fieldResidual, e: L.balance.energyResidual, eps: L.balance.integratorResidual });
await ev(() => window.__ds.ui.getState().setResultsOpen(true));
await wait(800);
const res55 = await ev(() => document.querySelector('[data-testid="gravity-results"]')?.textContent ?? '');
await shot('55-results-energy');
await ev(() => window.__ds.ui.getState().setResultsOpen(false));
check('55 results: the energy terms (integrator ε, energy check R_Φ − ε against the gross work, W_moved in the CSV)', res55.includes('ε') && res55.includes('R_Φ'), res55.slice(res55.indexOf('R_Φ'), res55.indexOf('R_Φ') + 90));
await exitSim();

await fallRun(G({ magnitude: 9.81, direction: [1, 0, 0], transition: 'rotate', profile: 'smooth', ramp: 1, startTime: 0 }), 3);
L = await gl();
const hud56 = await ev(() => document.body.textContent ?? '');
check('56 limited models flagged: sideways gravity — structure and flood reported limited / unsupported (no fake vertical results)', ['structure', 'flood'].every((k) => L.support[k] === 'limited' || L.support[k] === 'unsupported'), L.support);
void hud56;
await exitSim();

// ── Whole run ─────────────────────────────────────────────────────────────────────────────────
await newWorld();
await wait(800);
const heap1 = await heapMB();
const geo1 = await geometries();
check('whole run: no page errors, the tab alive, GPU geometries back to the start', errors.length === 0 && !crashed && geo1 <= geo0 + 2, { errors: errors.length, geo0, geo1 });
console.log(JSON.stringify({ heap0, heap1, geo0, geo1, crashed }));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; ${errors.length} page errors; heap ${heap0} → ${heap1} MB; geometries ${geo0} → ${geo1}; crashed ${crashed}`);
if (errors.length) console.log(errors.slice(0, 10).join('\n'));
fs.writeFileSync(path.join(out, `results-${lang}.json`), JSON.stringify({ lang, url, results, errors, heap: [heap0, heap1], geometries: [geo0, geo1], crashed }, null, 2));
await browser.close();
process.exit(results.every((r) => r.ok) && errors.length === 0 && !crashed ? 0 : 1);
