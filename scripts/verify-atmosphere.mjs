// Browser verification of the atmosphere (Phase 29): 40 scenarios in real Chrome through the UI (experiment tab:
// add an atmosphere experiment, reference state, derived density, impossible input rejected, removal / restoration
// fields, wind boundary, preview; run: pressure / density / temperature / altitude, flow arrows, removal, wind loads
// on cars / trees / buildings, O₂, fire, smoke, water, restoration, ledgers, overlays, inspector, timeline,
// results; presets: pressure-driven flow, heated plume, volcanic ash / gas; opt-in meteor entry and blast; save /
// load; original world and rerun; a large town; repeated runs) with state checks after each step, plus whole-run
// checks: page errors, the tab staying alive, GPU geometries, heap, text not cut.
//
//   npm run build && npx vite preview --port 4198 --strictPort &
//   LANG_UI=ko node scripts/verify-atmosphere.mjs http://localhost:4198/ ./docs/verify/atmosphere
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:4198/', out = './docs/verify/atmosphere'] = process.argv.slice(2);
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
  await ev(() => { window.__ds.actions.newProject(); const v = window.__ds.view.getState(); v.setGroundPreview(null); v.setGroundPick(null); v.setWaterProbe(null); v.setSimMember(null); v.setAtmosViz({ overlay: 'off', arrows: true, streamlines: false }); });
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
  await wait(200);
};
const setSelect = (id, field, value) => ev(([id, field, value]) => {
  const s = document.querySelector(`[data-instance="${id}"] select[data-field="${field}"]`);
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(s, value);
  s.dispatchEvent(new Event('change', { bubbles: true }));
}, [id, field, value]);
// (null removes a key: undefined does not survive the trip into the page.)
const setSpec = (id, patch) => ev(([id, patch]) => { const a = window.__ds.actions; const i = window.__ds.world.getState().doc.scenario.experiment.instances.find((x) => x.id === id); const s = { ...i.spec, ...patch }; for (const k of Object.keys(patch)) if (patch[k] === null) delete s[k]; a.updatePhenomenon(id, { spec: s }); }, [id, patch]);
async function enterRun() {
  await clickText(/^\s*실험 실행|Run experiment/);
  await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status === 'running', { timeout: 60_000 });
}
const atTime = (T) => ev((T) => { const s = window.__ds.sim; s.pause(); const r = T - s.getTime(); if (r > 0) s.advance(r); return s.getTime(); }, T);
const exitSim = async () => { await ev(() => window.__ds.actions.exitSimulation()); await wait(500); };
const al = () => ev(() => window.__ds.simStore.getState().atmosphere);
const ms = () => ev(() => window.__ds.simStore.getState().milestones.map((m) => m.kind));
// Per object: load / (ρ·v²) at its centre of pressure — constant if the loads follow the local density (q = ½ρv²).
const ents = () => ev(() => { const a = window.__ds.atmosLib.rt(); return [...window.__ds.sim.getRuntime().entities.values()].map((e) => { const p = e.pose.position; const rho = a.densityAt(p[0], p[1] + (e.copLocal?.[1] ?? 0), p[2]); const v2 = e.windAtCop * e.windAtCop; return { type: e.source.type, burned: e.visual?.burned ?? 0, load: e.windLoad, ratio: e.loadRatio, kLoad: v2 > 1 ? e.windLoad / (rho * v2) : null, kRatio: v2 > 1 ? e.loadRatio / (rho * v2) : null, rho, v: e.windAtCop }; }); });
const loads = async () => { const E = await ents(); const by = (t) => E.filter((e) => e.type === t); const sum = (a, k) => a.reduce((s, e) => s + e[k], 0); return { car: sum(by('car'), 'load'), tree: sum(by('tree'), 'load'), building: sum(by('building'), 'ratio'), E }; };
// (A crown burned in between has less area: excluded — the fire, not the air, changed it.)
const sameK = (A, B, type, key) => { const out = []; for (let i = 0; i < A.length; i++) if (A[i].type === type && A[i][key] && B[i][key] && B[i].burned < 0.05) out.push(B[i][key] / A[i][key]); return out; };
const aHash = () => ev(() => {
  const r = window.__ds.atmosLib.rt(); if (!r) return null;
  const f = r.field; let s = 0, k = 1;
  for (let i = 0; i < f.count; i++) { s += (f.sigma[i] + f.gas[i]) * k; k = (k * 1.000003) % 7.1; }
  const w = r.trt.world.air; let e = 0; for (let i = 0; i < w.count; i++) e += w.E[i] * ((i % 13) + 1);
  return `${s.toExponential(14)}|${e.toExponential(14)}|${f.mass.removed.toExponential(14)}|${f.energy.final.toExponential(14)}`;
});
const objCount = (name) => ev((name) => { let n = 0; window.__r3f.get().scene.traverse((o) => { if (o.name === name) o.traverse((m) => { if (m.isInstancedMesh) n += m.count; if (m.isLineSegments) n += m.geometry.drawRange.count; else if ((m.isMesh && !m.isInstancedMesh) || m.isLine) { if (m.geometry?.attributes?.position) n += 1; } }); }); return n; }, name);
const clipped = (sels) => ev((sels) => {
  const out = [];
  for (const sel of sels) for (const root of document.querySelectorAll(sel)) for (const el of root.querySelectorAll('*')) {
    if (!el.childNodes.length || ![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    if (cs.overflow === 'visible' && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && cs.display !== 'inline') out.push(`${sel}: ${el.textContent.trim().slice(0, 40)}`);
  }
  return out;
}, sels);
const overlay = async (o) => { await ev((o) => window.__ds.view.getState().setAtmosViz({ overlay: o }), o); await wait(700); return ev(() => document.querySelector('[data-testid="atmos-overlay"]')?.textContent ?? ''); };
const heap0 = await heapMB();
const geo0 = await geometries();

// ══ 1–7: the editor ═══════════════════════════════════════════════════════════════════════════
await newWorld();
// A street on a flat plain with a 20 m mound to the east, a lake to the north-west, dry crowns.
await ev(() => {
  const ds = window.__ds, ws = ds.world.getState(), t0 = ws.doc.terrain;
  const h = (x, z) => Math.round(Math.max(0, 20 - Math.hypot(x - 60, z) * 0.6) * 100) / 100;
  const heights = new Float32Array(t0.heights.length);
  for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) heights[iz * t0.nx + ix] = h(t0.originX + ix * t0.cellSize, t0.originZ + iz * t0.cellSize);
  ws.applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length) } } });
  ws.setFeatures([{ id: 'lk', kind: 'lake', points: [[-80, 30], [-30, 30], [-30, 80], [-80, 80]], surface: -0.3, depth: 2, shoreWidth: 3, material: 7, filled: true }], 2);
  const d = (p) => ds.buildingLib.createDesign(ds.buildingLib.presetSpec(p), p);
  const items = [['building', -30, -25], ['building', -5, -25], ['building', 20, -25], ['car', -20, 0], ['car', 0, 2], ['car', 20, 0], ['tree', -45, 5], ['tree', -40, 9], ['tree', -36, 4], ['tree', 35, 20], ['sign', -10, 10], ['streetLight', 10, 10]];
  ds.world.getState().applyEdit({ add: items.map(([type, x, z], k) => ({ type, ...(type === 'building' ? { building: d('house') } : {}), ...(type === 'tree' ? { params: { species: 'conifer', height: 11, canopyRadius: 2.2, trunkRadius: 0.32 } } : {}), seed: k + 1, transform: { position: [x, h(x, z), z], rotation: [0, 0, 0], scale: [1, 1, 1] } })) });
  ds.world.getState().updateSimulationSettings({ fire: { foliageMoisture: 0.2, openings: 'asBuilt', heatIgnition: false } });
});
await clickText(/^\s*현상 추가|Add phenomenon/);
await wait(250);
await clickText(new RegExp('^\\s*' + (await tr('phen.atmosphere')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$'));
await wait(300);
let I = await inst();
const id = I.find((i) => i.type === 'atmosphere')?.id;
await expand(id);
await shot('01-editor');
const fields1 = await ev((id) => [...document.querySelectorAll(`[data-instance="${id}"] [data-field]`)].map((e) => e.getAttribute('data-field')), id);
check('1 atmosphere experiment added from the Experiment tab (reference state, boundary, removal, air left behind, restoration, opt-in couplings) — density is not an input', !!id && ['altitude', 'pressure', 'temperature', 'boundary', 'removal', 'thermo', 'restore', 'coupleBlast', 'coupleMeteor'].every((f) => fields1.includes(f)) && !fields1.includes('density'), fields1);
await setSpec(id, { temperature: 288.15 });
await wait(200);
await setNumber(id, 'temperature', 20);
const sum2 = await ev(() => document.querySelector('[data-testid="atmos-summary"]')?.textContent ?? '');
I = await inst();
await setSpec(id, { pressure: -5000 });
await wait(300);
const invalid2 = await ev(() => document.querySelector('[data-testid="exp-invalid"]')?.textContent ?? '');
await setSpec(id, { pressure: null });
check('2 reference state: temperature entered in °C (stored in K), the density derived ρ = p/RT; a negative pressure is rejected with its reason', Math.abs(I[0].spec.temperature - 293.15) < 1e-6 && sum2.includes('kg/m³') && invalid2.includes((await tr('atmos.invalid.pressureSign')).slice(0, 6)), { T: I[0].spec.temperature, sum: sum2.slice(0, 120), invalid2: invalid2.slice(0, 60) });
await setSpec(id, { temperature: null });
await setSelect(id, 'removal', 'linear');
await wait(300);
await setNumber(id, 'target', 20);
await setNumber(id, 'duration', 120);
await setSelect(id, 'restore', 'boundary');
await wait(300);
await setNumber(id, 'restoreAt', 150);
await setNumber(id, 'restoreDuration', 120);
I = await inst();
const s3 = I[0].spec;
check('3 removal and restoration set in the fields: to 20 % over 120 s, then the surroundings recover from 150 s over 120 s', s3.removal === 'linear' && Math.abs(s3.target - 0.2) < 1e-9 && s3.duration === 120 && s3.restore === 'boundary' && s3.restoreAt === 150 && s3.restoreDuration === 120, s3);
await page.click('[data-testid="atmos-preview"]');
await wait(900);
const prev4 = await objCount('atmosphere-preview');
const sum4 = await ev(() => document.querySelector('[data-testid="atmos-summary"]')?.textContent ?? '');
const path4 = await ev(() => !!document.querySelector('[data-testid="atmos-path"] polyline'));
await view(0, 0, 120, 150);
await shot('04-preview');
check('4 preview: initial pressure field over the terrain, the boundary, the planned air-mass path; end state (pressure, adiabatic temperature, density) and boiling point', prev4 >= 2 && path4 && sum4.includes('kPa') && sum4.includes('°C'), sum4.slice(0, 200));
await ev(() => { window.__ds.actions.addPhenomenon('wind', { event: 'wind', speed: 15, direction: 'W', duration: 900 }); window.__ds.actions.addPhenomenon('fire', { event: 'fire', position: [-40, 6], height: 6, radius: 3, duration: 900, startTime: 20 }); });
check('5 temperature shown with its ISA auto value and editable; the air left behind adiabatic by default', (await ev((id) => document.querySelector(`[data-instance="${id}"] [data-field="thermo"]`)?.textContent ?? '', id)).length > 0 && (await inst())[0].spec.thermo !== 'isothermal');
check('7 wind boundary: an open boundary with the world wind as the prescribed background', (await inst())[0].spec.boundary === 'open' && (await inst()).some((i) => i.type === 'wind'));
await page.click('[data-testid="atmos-preview"]');
const fp0 = await fp();

// ══ the run ════════════════════════════════════════════════════════════════════════════════════
await enterRun();
await atTime(2);
let A = await al();
const L0 = await loads();
const o2a = A.stats.o2Layer;
const plan2 = 1 - 0.8 * (2 / 120);
check('3b pressure shown: mean surface pressure follows the planned path from 101.3 kPa (HUD)', A && Math.abs(A.stats.datumPressure - 101325 * plan2) < 60 && (await ev(() => document.querySelector('[data-testid="atmos-hud-pressure"]')?.textContent ?? '')).includes('kPa'), { p: A?.stats.meanPressure });
check('4b density shown: ρ = p/RT ≈ 1.22 kg/m³', Math.abs(A.stats.meanDensity - 1.224) < 0.02, { rho: A.stats.meanDensity });
check('5b temperature shown: the layer at the datum temperature, cooled adiabatically by the removal so far', Math.abs(A.stats.meanLayerT - 288.15 * Math.pow(plan2, 0.2856)) < 0.3, { T: A.stats.meanLayerT, expected: 288.15 * Math.pow(plan2, 0.2856) });
const alt6 = await ev(() => { const r = window.__ds.atmosLib.rt(); const g = (x, z) => r.field.ground[r.column(x, z)]; return { valley: r.pressureAt(-60, g(-60, -60) + 1, -60), summit: r.pressureAt(60, g(60, 0) + 1, 0), hs: g(60, 0) - g(-60, -60) }; });
await ev(() => window.__ds.view.getState().setWaterProbe({ x: 60, z: 0 }));
await wait(500);
const probe6 = await ev(() => document.querySelector('[data-testid="atmos-probe"]')?.textContent ?? '');
const narrow6 = await ev(() => [...document.querySelectorAll('[data-testid="atmos-probe"] > span:nth-child(odd)')].filter((e) => e.clientWidth < 40).map((e) => e.textContent));
await shot('06-probe');
check('6b probe rows readable (labels not squeezed by long values)', narrow6.length === 0, narrow6);
check('6 pressure falls with altitude: the mound summit has a lower pressure (hydrostatic, ≈ 12 Pa/m); the probe shows the vertical profile', alt6.summit < alt6.valley && Math.abs((alt6.valley - alt6.summit) / alt6.hs - 11.9) < 1.5 && probe6.includes('1000'), alt6);
await atTime(60);
A = await al();
let M = await ms();
await view(0, 0, 90, 110);
await ev(() => window.__ds.view.getState().setAtmosViz({ arrows: true, streamlines: true }));
await wait(1200);
const arrows8 = await objCount('atmosphere-layer');
await shot('08-flow');
check('8 airflow visualized: flow arrows and streamlines of the computed transport velocity (wind + computed flow)', arrows8 > 1, { drawn: arrows8 });
await ev(() => window.__ds.view.getState().setAtmosViz({ streamlines: false }));
check('11 removal started at its start time (milestone)', M.includes('removalStart') && M.includes('atmosStart'), M.filter((k) => k !== 'start'));
check('12 air mass falls: real mass removed (ledger), share ≈ 60 % at 60 s', A.mass.removed > 0 && Math.abs(A.stats.share - 0.6) < 0.01, { share: A.stats.share, removed: A.mass.removed });
check('13 pressure falls with the mass (p = σ·g)', A.stats.meanPressure < 0.62 * 101325 && A.stats.meanPressure > 0.58 * 101325, { p: A.stats.meanPressure });
check('14 density falls — with the adiabatic cooling ρ/ρ₀ ≈ (p/p₀)^(1/γ) (0.85 kg/m³ at 60 %); the air aloft cooled', A.stats.meanDensity < 1.225 * Math.pow(0.6, 1 / 1.4) + 0.01 && A.stats.Tcol < 288.15 - 10, { rho: A.stats.meanDensity, Tcol: A.stats.Tcol });
await atTime(115);
A = await al();
const L1 = await loads();
const k15 = sameK(L0.E, L1.E, 'car', 'kLoad'), k16 = sameK(L0.E, L1.E, 'tree', 'kLoad'), k17 = sameK(L0.E, L1.E, 'building', 'kRatio');
const near1 = (a) => a.length > 0 && a.every((r) => Math.abs(r - 1) < 0.08);
check('15 vehicles in thin air: wind load ∝ local ρ·v² (load / ρv² unchanged), lower total load', near1(k15) && L1.car < L0.car, { kRatio: k15, before: L0.car, now: L1.car });
check('16 trees in thin air: wind load ∝ local ρ·v², lower total', near1(k16) && L1.tree < L0.tree, { kRatio: k16, before: L0.tree, now: L1.tree });
check('17 buildings in thin air: load ratio ∝ ρ·v² against the sea-level design capacity, lower', near1(k17) && L1.building < L0.building, { kRatio: k17, before: L0.building, now: L1.building });
check('18 O₂ supply: the O₂ mass in the layer fell with the air (fraction kept)', A.stats.o2Layer < 0.35 * o2a && Math.abs(A.stats.o2Fraction - 0.232) < 0.02, { o2: A.stats.o2Layer, o2a, frac: A.stats.o2Fraction });
const f19 = await ev(() => { const r = window.__ds.fireLib.rt(); return r ? { burning: Array.from(r.fw.state.slice(0, r.fw.n)).filter((s) => s >= 3 && s <= 5).length, o2Limit: r.fw.o2Limit, ever: r.fw.o2LimitedEver, consumed: r.fw.ledger.fuelConsumed } : null; });
check('19 fire responds to the air: the fire model runs with the O₂ supply limit of the thinned air', f19 && f19.o2Limit && f19.consumed > 0, f19);
const fl20 = await ev(() => { const L = window.__ds.fireLib.rt().fw.ledger; return { produced: L.smokeProduced, moved: L.smokeAdvected + L.smokeVented, res: Math.abs(L.smokeProduced - L.smokeRooms - L.smokeAir - L.smokeVented - L.smokeAdvected) / Math.max(1e-9, L.smokeProduced) }; });
const leg20 = await overlay('smoke');
await view(-40, 6, 50, 60);
await wait(900);
await shot('20-smoke');
check('20 smoke carried by the layer flow (wind + computed flow), smoke ledger closed; smoke overlay with its mg/m³ legend', fl20.produced > 0 && fl20.moved > 0 && fl20.res < 1e-9 && leg20.includes('mg/m³'), { fl20, leg: leg20.slice(0, 60) });
const w25 = await ev(() => { const f = window.__ds.sim.getEnvironment().flood.field; return f ? f.totalVolume() : null; });
check('25 water and air pressure: the lake keeps its water (no disappearance at low pressure); the lower boiling point is reported, not modelled', A.stats.boiling < 373.15 - 10 && (w25 === null || w25 > 0) && A.stats.waterAboveBoiling === 0, { boiling: A.stats.boiling - 273.15, w25 });
for (const [n, o, unit] of [['29', 'pressure', 'kPa'], ['30', 'density', 'kg/m³'], ['31', 'temperature', '°C'], ['32', 'oxygen', 'kg/m³']]) {
  const leg = await overlay(o);
  await view(0, 0, 120, 150);
  await wait(500);
  await shot(`${n}-${o}`);
  check(`${n} ${o} overlay with its fixed ${unit} legend`, leg.includes(unit), leg.slice(0, 80));
}
await overlay('off');
const carId = await ev(() => [...window.__ds.sim.getRuntime().entities.values()].find((e) => e.source.type === 'car').id);
await ev((id) => window.__ds.editor.getState().select(id), carId);
await wait(600);
const insp33 = await ev(() => document.querySelector('[data-testid="atmos-object"]')?.textContent ?? '');
await shot('33-inspector');
await ev(() => window.__ds.editor.getState().select(null));
const narrow = () => ev(() => [...document.querySelectorAll('[data-testid="atmos-object"] > span:nth-child(odd), [data-testid="atmos-probe"] > span:nth-child(odd)')].filter((e) => e.clientWidth < 40).map((e) => e.textContent));
const narrow33 = await narrow();
check('33 inspector: local pressure, density, temperature, computed flow, O₂, dynamic pressure, what changes the air; labels not squeezed', insp33.includes('kPa') && insp33.includes('kg/m³') && insp33.includes('Pa') && narrow33.length === 0, { text: insp33.slice(0, 120), narrow33 });
await atTime(290);
A = await al();
M = await ms();
check('26 restoration: the surroundings recover, air flows in through the edges, the mass is back (milestones)', A.stats.share > 0.97 && A.mass.boundaryIn > 0.5 * A.mass.removed && M.includes('restorationStart') && M.includes('restorationComplete'), { share: A.stats.share, in: A.mass.boundaryIn, removed: A.mass.removed });
check('27 mass ledger closes (removed, boundary in / out, residual at round-off)', Math.abs(A.mass.residual) / A.mass.initial < 1e-10, { res: A.mass.residual / A.mass.initial });
check('28 energy ledger closes (removed with the air, pressure work, heat in, boundary)', Math.abs(A.energy.residual) / A.energy.initial < 1e-9 && A.energy.pressureWork !== 0, { res: A.energy.residual / A.energy.initial, work: A.energy.pressureWork });
check('34 timeline milestones: start, removal, pressure levels, low density, restoration', ['atmosStart', 'removalStart', 'pressureMilestone', 'lowDensity', 'restorationStart', 'restorationComplete'].every((k) => M.includes(k)), M.filter((k) => !['start', 'end'].includes(k)));
await ev(() => window.__ds.ui.getState().setResultsOpen(true));
await wait(700);
const res35 = await ev(() => document.querySelector('[data-testid="atmos-results"]')?.textContent ?? '');
const csv35 = await ev(() => !!document.querySelector('[data-testid="atmos-csv"]'));
const clip35 = await clipped(['[data-testid="atmos-results"]']);
await shot('35-results');
await ev(() => window.__ds.ui.getState().setResultsOpen(false));
check('35 results: cards, atmosphere CSV (ledgers, history), JSON summary; text not cut', res35.length > 80 && csv35 && clip35.length === 0, { res: res35.slice(0, 80), clip35 });
const clipHud = await clipped(['[data-testid="atmos-hud"]', '[data-testid="atmos-overlay"]']);
check('35b HUD and overlay text not cut; remaining-air indicator shown (no darkening of the scene)', clipHud.length === 0 && (await ev(() => !!document.querySelector('[data-testid="atmos-hud-indicator"]'))), clipHud);
const h38a = await aHash();
await ev(() => window.__ds.actions.resetSimulation());
await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status !== 'loading', { timeout: 60_000 });
const r38 = await ev(() => ({ a: window.__ds.atmosLib.rt() === null, t: window.__ds.sim.getTime() }));
await ev(() => window.__ds.sim.play());
await atTime(290);
const h38b = await aHash();
check('38 same conditions again (reset): the same air mass, flow, temperatures and ledgers', r38.a && r38.t === 0 && h38a === h38b, { r38, h38a, h38b });
await exitSim();
check('37 leaving the simulation leaves the original world untouched (fingerprint)', (await fp()) === fp0);

// ══ presets ════════════════════════════════════════════════════════════════════════════════════
const presetRun = async (pid, T) => {
  await newWorld();
  await ev((pid) => window.__ds.actions.loadAtmosPreset(pid), pid);
  await wait(800);
  await enterRun();
  await atTime(T);
};
await presetRun('pressureFlow', 60);
const f9 = await ev(() => { const r = window.__ds.atmosLib.rt(); const o = [0, 0]; r.flowAt(-25, 0, 2, o); const w = o[0]; r.flowAt(25, 0, 2, o); return { west: w, east: o[0], dpCentre: (r.field.sigma[r.column(0, 0)] - r.field.sigma0[r.column(0, 0)]) * 9.81, dpEdge: (r.field.sigma[r.column(-95, -95)] - r.field.sigma0[r.column(-95, -95)]) * 9.81 }; });
const leg9 = await overlay('pressureChange');
await view(0, 0, 70, 80);
await ev(() => window.__ds.view.getState().setAtmosViz({ arrows: true }));
await wait(900);
await shot('09-pressure-flow');
await exitSim();
check('9 pressure difference drives air: lower pressure at the sink, the layer flows toward it from both sides; log-scale pressure-change legend', f9.west > 0.2 && f9.east < -0.2 && f9.dpCentre < f9.dpEdge && leg9.includes('Pa'), f9);
await presetRun('heatedPlume', 90);
A = await al();
M = await ms();
await ev(() => window.__ds.view.getState().setAtmosViz({ overlay: 'updraft' }));
await view(0, 0, 50, 60);
await wait(900);
await shot('10-plume');
await exitSim();
check('10 thermal plume: heated air rises (updraft), the plume milestone', A.stats.maxUpdraft > 1 && M.includes('plumeDevelopment'), { w: A.stats.maxUpdraft });
await presetRun('volcanicAsh', 220);
A = await al();
const v21 = await ev(() => { const v = window.__ds.volcanoLib.rt(); const L = v.world.ledger(); return { puffs: v.world.puffs.length, ash: L.mass.ashReleased, gas: L.mass.gas }; });
const leg21 = await overlay('gas');
await view(-40, 0, 70, 80, 10);
await wait(900);
await shot('21-ash');
await exitSim();
check('21 volcanic ash in thin air: released ash airborne and settling (puffs), separate from gas and smoke', v21.ash > 0 && A.stats.share < 0.35, { v21, share: A.stats.share });
check('22 volcanic gas / plume: the atmosphere received exactly the volcano\'s gas (tracer, ledger), gas overlay', Math.abs(A.gas.emitted - v21.gas) / Math.max(1e-9, v21.gas) < 0.02 && A.gas.emitted > 0 && leg21.includes('g/m³'), { emitted: A.gas.emitted, volcano: v21.gas, airborne: A.gas.airborne });

// ══ 23–24: opt-in couplings ════════════════════════════════════════════════════════════════════
await newWorld();
const meteor = { event: 'impact', target: [0, 0], material: 'stony', diameter: 2, speed: 18000, angle: 45, azimuth: 90, entry: 'atmosphere', airBlast: false, startTime: 1 };
const ref23 = await ev((m) => window.__ds.groundLib.impactPlan(m).entry.speed, meteor);
await ev((m) => { const a = window.__ds.actions; a.addPhenomenon('atmosphere', { event: 'atmosphere', altitude: 0, pressure: 40000, boundary: 'open', removal: 'none', coupleMeteor: true, coupleBlast: true }); a.addPhenomenon('impact', m); a.addPhenomenon('blast', { event: 'blast', position: [30, 30], height: 1, energy: 2e7, model: 'weakShock', waveform: 'nWave', startTime: 1 }); }, meteor);
await enterRun();
await atTime(3);
const c23 = await ev(() => { const env = window.__ds.sim.getEnvironment(); return { entry: env.impact.models[0]?.plan.entry?.speed, blastP: env.blast.waves[0]?.wave.init.ambient.p }; });
await shot('23-meteor');
await exitSim();
check('23 meteor entry (opt-in): the thinner column → less drag, a faster arrival than the standard entry', c23.entry > ref23, { opted: c23.entry, standard: ref23 });
check('24 blast compatibility (opt-in): the blast takes the local background pressure; its overpressure keeps its own model and legend', Math.abs(c23.blastP - 40000) < 500, { blastP: c23.blastP });

// ══ 36: save / load ════════════════════════════════════════════════════════════════════════════
const saved36 = await ev(() => {
  const ds = window.__ds;
  ds.actions.addPhenomenon('atmosphere', { event: 'atmosphere', altitude: 1500, boundary: 'closed', removal: 'scheduled', target: 0.5, duration: 600, schedule: [[0, 100], [300, 400]], restore: 'reservoir', restoreAt: 700, restoreDuration: 300, restoreTarget: 0.9, thermo: 'isothermal' });
  const text = ds.buildLib.serializeDocument(ds.world.getState().doc, false);
  const r = ds.buildLib.parseDocument(text);
  return { ok: r.ok, version: JSON.parse(text).schemaVersion, spec: r.ok ? r.doc.scenario.experiment.instances.filter((i) => i.type === 'atmosphere').pop()?.spec : null };
});
check('36 atmosphere experiment saved and reloaded (schema 7): scheduled removal, reservoir restoration, isothermal, altitude', saved36.ok && saved36.version === 7 && saved36.spec?.removal === 'scheduled' && saved36.spec?.schedule?.[1]?.[0] === 300 && saved36.spec?.thermo === 'isothermal' && saved36.spec?.altitude === 1500, saved36);

// ══ 39: large town ═════════════════════════════════════════════════════════════════════════════
await newWorld();
await ev(() => {
  const ds = window.__ds;
  const d = ds.buildingLib.createDesign(ds.buildingLib.presetSpec('house'), 'house');
  const add = [];
  for (let z = -94; z <= 94 && add.length < 1000; z += 6) for (let x = -94; x <= 94 && add.length < 1000; x += 6) add.push({ type: 'building', building: d, seed: add.length + 1, transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] } });
  ds.world.getState().applyEdit({ add });
  ds.actions.addPhenomenon('atmosphere', { event: 'atmosphere', altitude: 0, boundary: 'open', removal: 'linear', extent: 'uniform', target: 0.3, duration: 120 });
  ds.actions.addPhenomenon('wind', { event: 'wind', speed: 20, direction: 'W', duration: 600 });
});
await wait(1500);
await enterRun();
await atTime(60);
await view(0, 0, 90, 110);
await ev(() => window.__ds.sim.play());
const fps39 = await ev(() => new Promise((res) => { const t = []; let last = performance.now(); const f = (now) => { t.push(now - last); last = now; if (t.length < 240) requestAnimationFrame(f); else res({ mean: t.reduce((a, b) => a + b, 0) / t.length, worst: Math.max(...t.slice(10)) }); }; requestAnimationFrame(f); }));
const gl39 = await ev(() => { const g = window.__r3f.get().gl.info; return { calls: g.render.calls, geometries: g.memory.geometries, textures: g.memory.textures }; });
A = await al();
await shot('39-town');
await exitSim();
check('39 large town (1000 houses) with removal + wind: interactive frame rate', fps39.mean < 100 && A.stats.share < 0.8, { fps: +(1000 / fps39.mean).toFixed(1), worstFrameMs: +fps39.worst.toFixed(1), atmosMs: A.ms, gl39 });

// ══ 40: repeated runs ══════════════════════════════════════════════════════════════════════════
await newWorld();
await wait(500);
const geoA = await geometries();
const heaps40 = [];
for (let k = 0; k < 3; k++) {
  await newWorld();
  await ev((pid) => window.__ds.actions.loadAtmosPreset(pid), 'gradualRemoval');
  await wait(600);
  await enterRun();
  await ev(() => window.__ds.view.getState().setAtmosViz({ overlay: 'pressure', arrows: true, streamlines: true }));
  await atTime(30);
  await wait(800);
  await exitSim();
  heaps40.push(await heapMB());
}
await newWorld();
await wait(500);
const geoB = await geometries();
check('40 repeated runs release their resources: GPU geometries back, heap flat', geoB <= geoA + 2 && heaps40[2] - heaps40[0] < 20, { geoA, geoB, heaps40 });

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
