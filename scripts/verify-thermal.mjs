// Browser verification of thermal physics (Phase 26): 26 scenarios in real Chrome through the UI
// (experiment tab: add a heat source, kind / position picked on the map / output / profile, preview,
// run; overlay options, member colors, inspector, HUD, timeline, results) with state checks after each
// step, plus whole-run checks: console / page errors, the tab staying alive, GPU geometries, heap.
//
//   npm run build && npx vite preview --port 4196 --strictPort &
//   LANG_UI=ko node scripts/verify-thermal.mjs http://localhost:4196/ ./docs/verify/thermal
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:4196/', out = './docs/verify/thermal'] = process.argv.slice(2);
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
const heap0 = await heapMB();
const geo0 = await geometries();
const C = (K) => K - 273.15;

// ══ 1–6: the editor ═════════════════════════════════════════════════════════════════════════════
await newWorld();
await place([['building', 0, 0, 'house'], ['car', -14, 4], ['tree', -24, -2], ['human', -10, -12], ['car', 14, 6]]);
await clickText(/^\s*현상 추가|Add phenomenon/);
await wait(250);
await shot('01-add-menu');
await clickText(new RegExp((await tr('phen.heatSource')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
await wait(300);
let I = await inst();
const id = I[0]?.id;
await expand(id);
await shot('01-editor');
check('1 heat-source phenomenon added from the Experiment tab (default: point source, 500 kW, constant 300 s)', I.length === 1 && I[0].type === 'heatSource' && I[0].spec.kind === 'point', I[0]?.spec);

await setSelect(id, 'kind', 'area');
await wait(200);
const fieldsArea = await ev((id) => [...document.querySelectorAll(`[data-instance="${id}"] [data-field]`)].map((e) => e.getAttribute('data-field')), id);
await setSelect(id, 'kind', 'point');
await wait(200);
const fieldsPoint = await ev((id) => [...document.querySelectorAll(`[data-instance="${id}"] [data-field]`)].map((e) => e.getAttribute('data-field')), id);
check('2 source type chosen; only the fields of that type are shown (radius for an area, radiative share for a point)', fieldsArea.includes('radius') && !fieldsArea.includes('radiativeFraction') && fieldsPoint.includes('radiativeFraction') && !fieldsPoint.includes('radius'), { fieldsArea, fieldsPoint });

await view(0, 0, 55, 60);
await page.click('[data-testid="thermal-pick"]');
await wait(200);
await clickWorld(-14, -6);
I = await inst();
check('3 position picked on the map with a click', Math.abs(I[0].spec.position[0] + 14) < 1 && Math.abs(I[0].spec.position[1] + 6) < 1, I[0].spec.position);

await setNumber(id, 'power', 1500);
I = await inst();
check('4 heat output entered (kW → W stored)', I[0].spec.power === 1.5e6, I[0].spec.power);

await setSelect(id, 'profile', 'ramp');
await wait(200);
const hasRamp = await ev((id) => !!document.querySelector(`[data-instance="${id}"] [data-field="rampTime"]`), id);
await setNumber(id, 'rampTime', 20);
await setSelect(id, 'profile', 'pulse');
await wait(200);
await setNumber(id, 'pulseWidth', 90);
const invalid5 = await ev(() => document.querySelector('[data-testid="exp-invalid"]')?.textContent ?? '');
const reason = await tr('thermal.invalid.pulseWidth');
await setSelect(id, 'profile', 'ramp');
I = await inst();
check('5 time profile set (ramp shows its ramp time; an impossible pulse is rejected with the reason)', hasRamp && I[0].spec.profile === 'ramp' && I[0].spec.rampTime === 20 && invalid5.includes(reason.slice(0, 12)), { invalid5 });

await page.click('[data-testid="thermal-preview"]');
await wait(900);
const sum6 = await ev(() => document.querySelector('[data-testid="thermal-summary"]')?.textContent ?? '');
const prev6 = await ev(() => { let n = 0; window.__r3f.get().scene.traverse((o) => { if (o.name === 'thermal-preview') n++; }); return n; });
const out6 = await ev(() => { const d = window.__ds.world.getState().doc; const o = window.__ds.thermalLib.outlook(d.scenario.experiment.instances[0].spec); return { n: o.receivers.length, reach: o.reach, inside: o.inside }; });
const lim6 = await ev(() => [...document.querySelectorAll('[data-instance] div')].some((d) => /CFD/.test(d.textContent ?? '')));
await shot('06-preview');
check('6 preview: source position, coverage (reach), expected flux map from the run\'s model, limitations listed', prev6 > 0 && out6.n > 0 && sum6.length > 20 && lim6, { out6, sum6: sum6.slice(0, 100) });

// ══ 7–13, 20–23: a run with ground, objects, people ════════════════════════════════════════════
const fpWorld = await fp();
await enterRun();
await atTime(60);
await wait(600);
let T = await th();
const rt7 = await ev(() => { const rt = window.__ds.thermalLib.rt(), w = rt.world, g = w.terrain; const c = g.index(-14 + 0.5, -6 + 0.5); return { T0: g.T(c, 0), T1: g.T(c, 1), Tref: w.Tref, air: w.air.T(w.air.index(-14, -6, 1)), tiles: g.tiles.length }; });
check('7 ground heated under the source; the change stays local (active tiles only)', rt7.T0 - rt7.Tref > 1 && rt7.tiles < 400, rt7);
const obj8 = await ev(() => { const rt = window.__ds.thermalLib.rt(), B = rt.world.bodies; const out = []; for (const e of window.__ds.sim.getRuntime().entities.values()) { const te = rt.entity(e.id); if (te && te.body >= 0) out.push({ type: e.source.type, x: e.pose.position[0], T: B.TS[te.body] - 273.15, src: B.Esrc[te.body] }); } return out; });
const car8 = obj8.find((o) => o.type === 'car' && o.x < 0), carBehind = obj8.find((o) => o.type === 'car' && o.x > 0), tree8 = obj8.find((o) => o.type === 'tree');
check('8 objects heated by the source radiation (car, tree; received energy recorded); the car behind the house is shaded', car8?.src > 0 && car8.T > 15.2 && tree8?.T > 15 && (carBehind?.src ?? 0) === 0, obj8);
check('9 conduction: heat moved down into the ground (second layer warmer than ambient)', rt7.T1 > rt7.Tref + 0.01 && T.transfers.conduction > 0, { T1: C(rt7.T1), cond: T.transfers.conduction });
check('10 convection: the air above warmed, convective transfer booked', rt7.air > rt7.Tref && T.transfers.convection > 0, { air: C(rt7.air) });
check('11 radiation: source radiation absorbed by surfaces, surface radiation to the surroundings booked', T.losses.radiationSky > 0 && car8?.src > 0, { sky: T.losses.radiationSky, car: car8?.src });
await ev(() => { const v = window.__ds.view.getState(); v.setThermalViz({ field: 'surface', isotherms: true, objects: true, vectors: true }); });
await view(-14, -6, 30, 35);
await wait(800);
const legend20 = await ev(() => document.querySelector('[data-testid="thermal-legend"]')?.textContent ?? '');
const grid20 = await ev(() => { let n = 0; window.__r3f.get().scene.traverse((o) => { if (o.name === 'thermal-layer') o.traverse((m) => { if (m.isMesh && m.geometry?.drawRange) n += m.geometry.drawRange.count === Infinity ? 0 : m.geometry.drawRange.count; }); }); return n; });
await shot('20-heatmap');
check('20 temperature heatmap drawn with a fixed, labelled °C legend', grid20 > 0 && /°C|K/.test(legend20), { grid20, legend20 });
await clickWorld(-14, -6);
await wait(400);
const probe21 = await ev(() => document.querySelector('[data-testid="thermal-probe"]')?.textContent ?? '');
const carId = await ev(() => [...window.__ds.sim.getRuntime().entities.values()].find((e) => e.source.type === 'car' && e.pose.position[0] < 0).id);
await ev((id) => window.__ds.editor.getState().select(id), carId);
await wait(500);
const obj21 = await ev(() => document.querySelector('[data-testid="thermal-object"]')?.textContent ?? '');
const hum = await ev(() => [...window.__ds.sim.getRuntime().entities.values()].find((e) => e.source.type === 'human').exposure?.thermal ?? null);
await shot('21-inspector');
check('21 inspector: ground column at the clicked point, the car\'s temperatures / capacity / flows / source share, a person\'s exposure', probe21.length > 20 && obj21.length > 20 && hum && hum.radiant > 0, { probe: probe21.slice(0, 60), obj: obj21.slice(0, 60), hum });
const ms22 = await ev(() => window.__ds.simStore.getState().milestones.map((m) => m.kind));
check('22 timeline: heat source activation and heat-flux milestones recorded (temperature milestones: scenario 18)', ms22.includes('heatSource') && ms22.includes('heatFlux'), ms22.filter((k) => !['start', 'end'].includes(k)));
const hud23 = await ev(() => document.querySelector('[data-testid="thermal-residual"]')?.textContent ?? '');
await ev(() => window.__ds.ui.getState().setResultsOpen(true));
await wait(600);
const res23 = await ev(() => document.querySelector('[data-testid="thermal-results"]')?.textContent ?? '');
await shot('23-results');
await ev(() => window.__ds.ui.getState().setResultsOpen(false));
await wait(300);
T = await th();
check('23 energy ledger: added = held + lost (+ round-off), shown in the HUD and the results', T.relativeResidual < 1e-9 && hud23.length > 0 && res23.length > 20 && Math.abs(T.added - T.internal - T.lost) / T.added < 1e-9, { rel: T.relativeResidual, added: T.added, held: T.internal, lost: T.lost });
await exitSim();
check('25a leaving the simulation leaves the original world untouched (fingerprint)', (await fp()) === fpWorld);

// ══ 12: wind ═════════════════════════════════════════════════════════════════════════════════
await newWorld();
await place([['car', 0, 0]]);
await ev(() => { const a = window.__ds.actions; a.addPhenomenon('wind', { event: 'wind', speed: 10, direction: 'W', duration: 120, gustStrength: 0, rampDuration: 1 }); a.addPhenomenon('heatSource', { event: 'heatSource', kind: 'point', position: [0, 0], height: 1.5, radius: 2, input: 'power', power: 1e6, profile: 'constant', duration: 120 }); });
await enterRun();
await atTime(40);
const w12 = await ev(() => { const w = window.__ds.thermalLib.rt().world; return { down: w.air.T(w.air.index(12, 0)), up: w.air.T(w.air.index(-12, 0)), adv: w.ledger.lost.airAdvection, Tref: w.Tref, dup: window.__ds.sim.duplicateForces() }; });
await exitSim();
check('12 wind carries warm air downstream (air advection booked; no forces from the thermal system)', w12.down > w12.up && w12.down > w12.Tref && w12.adv > 0 && w12.dup === 0, w12);

// ══ 13: water ═════════════════════════════════════════════════════════════════════════════════
await newWorld();
await ev(() => { const a = window.__ds.actions; a.addPhenomenon('waterSource', { event: 'waterSource', position: [0, 0], rate: 4, duration: 200, radius: 3 }); a.addPhenomenon('heatSource', { event: 'heatSource', kind: 'area', position: [0, 0], height: 0, radius: 6, input: 'power', power: 4e6, profile: 'constant', duration: 200 }); });
await enterRun();
await atTime(60);
await wait(500);
const w13 = await th();
await shot('13-water');
await exitSim();
check('13 water temperature rises (heat carried by the water, ledger closed)', w13.maxWaterT > w13.ambient + 0.05 && w13.relativeResidual < 1e-9, { water: C(w13.maxWaterT), rel: w13.relativeResidual });

// ══ 14–19: building members (RC apartment, hot sphere enclosing a ground column) ══════════════
await newWorld();
await place([['building', 0, 0, 'apartment'], ['car', 0, 16]]);
const pos14 = await ev(() => { const ds = window.__ds; const m = ds.buildingLib.createDesign(ds.buildingLib.presetSpec('apartment'), 'apartment').members.find((x) => x.type === 'column' && x.level === 0); return [m.position[0] + Math.sign(-m.position[0] || 1) * 1.8, m.position[2] + Math.sign(-m.position[2] || 1) * 1.8, m.id]; });
await ev((p) => window.__ds.actions.addPhenomenon('heatSource', { event: 'heatSource', kind: 'temperature', position: [p[0], p[1]], height: 4, radius: 3.2, input: 'power', temperature: 1373.15, profile: 'constant', duration: 3000 }), pos14);
await enterRun();
await atTime(600);
const mem = await ev((cid) => {
  const rt = window.__ds.thermalLib.rt(), bt = rt.buildings[0], B = rt.world.bodies, ids = bt.e.modular.design.members;
  let hot = -1, T = 0; for (let i = 0; i < bt.g.n; i++) if (bt.body[i] >= 0 && bt.g.structural[i] && B.TS[bt.body[i]] > T) { T = B.TS[bt.body[i]]; hot = i; }
  const i = ids.findIndex((m) => m.id === cid);
  return { hottest: ids[hot].id, type: ids[hot].type, T: T - 273.15, minF: bt.minFactor, strain: bt.strain[hot], rooms: Array.from(bt.comp).map((c) => rt.world.compT(c) - 273.15), col: i, colT: B.TS[bt.body[i]] - 273.15 };
}, pos14[2]);
check('14 building member temperatures tracked per member (a structural member above 400 °C, the room heated)', mem.T > 400 && mem.rooms[0] > 30, mem);
check('15 thermal expansion of the hot member (free strain > 0)', mem.strain > 0, mem.strain);
await ev(() => window.__ds.view.getState().setStructureViz({ color: 'temperature' }));
const memWorld = await ev((cid) => { const ds = window.__ds, e = [...ds.sim.getRuntime().entities.values()][0]; const i = e.modular.design.members.findIndex((m) => m.id === cid); return { id: e.id, i, p: ds.structureLib.memberWorld(e.id, i) }; }, mem.hottest);
await view(memWorld.p[0], memWorld.p[2], 14, 20);
await ev((id) => window.__ds.editor.getState().select(id), memWorld.id);
await ev((m) => window.__ds.view.getState().setSimMember({ owner: m.id, member: m.i }), memWorld);
await wait(700);
const memSec = await ev(() => document.querySelector('[data-testid="thermal-member"]')?.textContent ?? '');
await shot('14-members');
check('14b member colors by temperature; the picked member\'s thermal state (factors, expansion, restraint, force) shown', memSec.length > 40, memSec.slice(0, 120));
check('17 strength reduced with temperature (EN factors applied through the structural engine)', mem.minF < 0.95, mem.minF);
await atTime(960);
const st18 = await ev(() => { const e = [...window.__ds.sim.getRuntime().entities.values()][0], m = e.modular.structure?.model; return { level: m?.collapseLevel(), recs: (m?.records ?? []).slice(0, 4).map((r) => [r.cause, r.hazard, +r.time.toFixed(2)]), n: m?.records.length ?? 0, thermalRecs: (m?.records ?? []).filter((r) => r.hazard === 'thermal').length }; });
const ms18 = await ev(() => window.__ds.simStore.getState().milestones.map((m) => m.kind));
await shot('18-failure');
check('18 structural failure from load vs reduced capacity (first cause mechanical, hazard heat), partial collapse; failure and temperature milestones', st18.thermalRecs > 0 && ['bending', 'axial', 'shear'].includes(st18.recs[0]?.[0]) && ['partial', 'global'].includes(st18.level) && ms18.includes('thermalFailure') && ms18.includes('peakTemperature') && ms18.includes('strengthReduction'), st18);
const deb19 = await ev(() => { const rt = window.__ds.thermalLib.rt(), B = rt.world.bodies; let E = 0, n = 0; for (const b of rt.heapBody.values()) { E += B.ES[b]; n++; } return { heaps: n, E, rel: rt.world.ledger.relativeResidual() }; });
check('19 debris keeps its heat: rubble heaps hold the merged members\' energy (ledger closed)', deb19.heaps > 0 && deb19.E > 0 && deb19.rel < 1e-9, deb19);
await ev(() => window.__ds.view.getState().setStructureViz({ color: 'normal' }));
await exitSim();

// ══ 16: restrained expansion (warehouse, full restraint vs free) ═════════════════════════════
const wh = async (restraint) => {
  await newWorld();
  await ev((r) => window.__ds.world.getState().updateSimulationSettings({ thermal: { restraint: r } }), restraint);
  await place([['building', 0, 0, 'warehouse']]);
  const p = await ev(() => { const ds = window.__ds; const m = ds.buildingLib.createDesign(ds.buildingLib.presetSpec('warehouse'), 'w').members.find((x) => x.type === 'column' && x.level === 0); return [m.position[0] + Math.sign(-m.position[0] || 1) * 1.8, m.position[2] + Math.sign(-m.position[2] || 1) * 1.8]; });
  await ev((p) => window.__ds.actions.addPhenomenon('heatSource', { event: 'heatSource', kind: 'temperature', position: p, height: 4, radius: 2.6, input: 'power', temperature: 1173.15, profile: 'constant', duration: 900 }), p);
  await enterRun();
  await atTime(150);
  const r = await ev(() => { const rt = window.__ds.thermalLib.rt(), bt = rt.buildings[0]; let N = 0, u = 0; for (let i = 0; i < bt.g.n; i++) { N += Math.abs(bt.nApplied[i]); u = Math.max(u, bt.util[i]); } const m = bt.e.modular.structure?.model; return { N, u, fails: (m?.records ?? []).filter((x) => x.hazard === 'thermal').map((x) => x.cause) }; });
  await exitSim();
  return r;
};
const free16 = await wh('none');
const full16 = await wh('full');
await ev(() => window.__ds.world.getState().updateSimulationSettings({ thermal: { restraint: 'frame' } }));
check('16 restrained expansion produces thermal force (and earlier failure); free expansion produces none', free16.N === 0 && full16.N > 0 && full16.u > 0, { free16, full16 });

// ══ 24–26: save / load, restoration, re-run ═══════════════════════════════════════════════════
await newWorld();
await place([['building', 0, 0, 'house'], ['car', 10, 0]]);
await ev(() => { window.__ds.world.getState().updateSimulationSettings({ thermal: { ambient: 298.15 } }); window.__ds.actions.addPhenomenon('heatSource', { event: 'heatSource', kind: 'point', position: [5, 5], height: 2, radius: 2, input: 'energy', energy: 5e7, profile: 'pulse', pulseWidth: 2, period: 6, duration: 30 }); });
const saved24 = await ev(() => {
  const ds = window.__ds, d = ds.world.getState().doc;
  const text = ds.buildLib.serializeDocument(d, false);
  const r = ds.buildLib.parseDocument(text);
  return { ok: r.ok, version: JSON.parse(text).schemaVersion, thermal: r.ok ? r.doc.settings.simulation.thermal : null, spec: r.ok ? r.doc.scenario.experiment.instances[0]?.spec : null };
});
check('24 heat source and thermal settings saved and reloaded (schema 7)', saved24.ok && saved24.version === 7 && saved24.thermal?.ambient === 298.15 && saved24.spec?.energy === 5e7 && saved24.spec?.profile === 'pulse', saved24);
const fp25 = await fp();
await enterRun();
await atTime(20);
const h1 = await thHash();
await ev(() => window.__ds.actions.resetSimulation());
await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status !== 'loading', { timeout: 60_000 });
const r25 = await ev(() => ({ rt: window.__ds.thermalLib.rt() === null, t: window.__ds.sim.getTime() }));
check('25 reset clears every thermal state (no thermal runtime at t = 0) and the document is unchanged', r25.rt && r25.t === 0 && (await fp()) === fp25, r25);
await ev(() => window.__ds.sim.play());
await atTime(20);
const h2 = await thHash();
await shot('26-rerun');
await exitSim();
check('26 the same conditions reproduce the same thermal state at the same step', h1 !== null && h1 === h2, { h1, h2 });

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
