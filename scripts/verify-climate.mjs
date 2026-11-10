// Browser verification of the climate (Phase 30): 45 scenarios in real Chrome through the UI (experiment tab: add a
// climate experiment, heatwave / cold wave scenarios, temperature path, humidity input and rejection, RH / dew point;
// runs from the presets: snowfall, particles, ground / roof / crown snow, compaction, snow overlays, snow ledger, road
// icing and vehicle friction, lake ice, frozen ground, thaw, snowmelt and its flood, solar heating, surface
// temperature, heatwave drying and fire, roof snow load and the structure, volcano on snow, atmospheric removal with
// evaporation, evaporation / condensation, overlays, inspector, HUD, timeline, results CSV / JSON, save / load,
// original world, rerun, a 1000-house town, repeated runs) with state checks, plus whole-run checks (page errors,
// the tab alive, GPU geometries, heap, text not cut).
//
//   npm run build && npx vite preview --port 4199 --strictPort &
//   LANG_UI=ko node scripts/verify-climate.mjs http://localhost:4199/ ./docs/verify/climate
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:4199/', out = './docs/verify/climate'] = process.argv.slice(2);
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
async function view(x, z, h = 60, back = 70, y = 0) {
  await ev(([x, z, h, back, y]) => { const st = window.__r3f.get(); st.camera.position.set(x + back * 0.5, y + h, z + back); st.controls.target.set(x, y, z); st.controls.update(); }, [x, z, h, back, y]);
  await wait(300);
}
const inst = () => ev(() => window.__ds.world.getState().doc.scenario.experiment?.instances ?? []);
const fp = () => ev(() => window.__ds.blueprintLib.worldFingerprint(window.__ds.world.getState().doc));
async function newWorld() {
  await ev(() => { window.__ds.actions.newProject(); const v = window.__ds.view.getState(); v.setGroundPreview(null); v.setGroundPick(null); v.setWaterProbe(null); v.setSimMember(null); v.setClimateViz({ overlay: 'off', snow: true, ice: true, particles: true, shimmer: true }); });
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
const cl = () => ev(() => window.__ds.simStore.getState().climate);
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
const overlay = async (o) => { await ev((o) => window.__ds.view.getState().setClimateViz({ overlay: o }), o); await wait(900); return ev(() => document.querySelector('[data-testid="climate-overlay"]')?.textContent ?? ''); };
const cHash = () => ev(() => {
  const r = window.__ds.climateLib.rt(); if (!r) return null;
  const c = r.cw; let s = 0, k = 1;
  for (let i = 0; i < c.n; i++) { s += (c.cM[i] + c.cU[i] * 1e-6) * k; k = (k * 1.000003) % 7.1; }
  let v = 0; for (let a = 0; a < c.na; a++) v += c.vap[a] * ((a % 13) + 1);
  const w = r.trt.world.air; let e = 0; for (let a = 0; a < w.count; a++) e += w.E[a] * ((a % 11) + 1);
  return `${s.toExponential(14)}|${v.toExponential(14)}|${e.toExponential(14)}|${c.water.precipitation.toExponential(14)}`;
});
const presetRun = async (pid, T) => {
  await newWorld();
  await ev((pid) => window.__ds.actions.loadClimatePreset(pid), pid);
  await wait(900);
  const f = await fp();
  await enterRun();
  await atTime(T);
  return f;
};
const layerCount = () => ev(() => { let pts = 0, slabs = 0, caps = 0; window.__r3f.get().scene.traverse((o) => { if (o.name === 'climate-layer') o.traverse((m) => { if (m.isPoints) pts += m.geometry.drawRange.count; if (m.isInstancedMesh) { if (m.geometry.type === 'BoxGeometry') slabs += m.count; else caps += m.count; } }); }); return { pts, slabs, caps }; });
const heap0 = await heapMB();
const geo0 = await geometries();

// ══ 1–6: the editor ══════════════════════════════════════════════════════════════════════════
await newWorld();
await clickText(/^\s*현상 추가|Add phenomenon/);
await wait(250);
await clickText(new RegExp('^\\s*' + (await tr('phen.climate')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$'));
await wait(400);
let I = await inst();
let C;
const id = I.find((i) => i.type === 'climate')?.id;
await expand(id);
const fields1 = await ev((id) => [...document.querySelectorAll(`[data-instance="${id}"] [data-field]`)].map((e) => e.getAttribute('data-field')), id);
await shot('01-add');
check('1 climate experiment added from the Experiment tab (scenario, forcing, temperature path, humidity, precipitation, sun, initial snow / ice / frost, soil moisture)', !!id && ['scenario', 'forcing', 'temperature', 'target', 'profile', 'humidity', 'precipitation', 'solar', 'initialSnow', 'initialIce', 'soilMoisture'].every((f) => fields1.includes(f)), fields1);
await setSelect(id, 'scenario', 'heatwave');
await wait(300);
I = await inst();
const s2 = I[0].spec;
check('2 heatwave scenario: a warming path (start < target), drying air, clear sun', s2.scenario === 'heatwave' && s2.target > s2.temperature + 5 && (s2.humidityTarget ?? s2.humidity) < s2.humidity && s2.solar === 'clearSky', { T0: s2.temperature - 273.15, T1: s2.target - 273.15 });
await setSelect(id, 'scenario', 'coldWave');
await wait(300);
I = await inst();
const s3 = I[0].spec;
check('3 cold-wave scenario: a cooling path below 0 °C', s3.scenario === 'coldWave' && s3.target < 273.15 && s3.target < s3.temperature, { T0: s3.temperature - 273.15, T1: s3.target - 273.15 });
await setSelect(id, 'profile', 'cyclic');
await wait(300);
const per4 = await ev((id) => !!document.querySelector(`[data-instance="${id}"] [data-field="period"]`), id);
const chart4 = await ev(() => !!document.querySelector('[data-testid="climate-path"]'));
await shot('04-profile');
check('4 temperature path: a cyclic (day-like) profile shows its period field; the forcing path chart', per4 && chart4 && (await inst())[0].spec.profile === 'cyclic');
await setNumber(id, 'humidity', 120);
const invalid5 = await ev((id) => document.querySelector(`[data-instance="${id}"]`)?.textContent ?? '', id);
await setNumber(id, 'humidity', 70);
I = await inst();
check('5 humidity input: 70 % stored as 0.7; above 100 % (dew point above the air) rejected with its reason', Math.abs(I[0].spec.humidity - 0.7) < 1e-9 && invalid5.includes((await tr('climate.invalid.supersaturated')).slice(0, 8)), { RH: I[0].spec.humidity, msg: invalid5.slice(0, 80) });
const sum6 = await ev(() => document.querySelector('[data-testid="climate-summary"]')?.textContent ?? '');
check('6 relative humidity shown with its derived dew point and wet bulb (vapour mass is the state)', sum6.includes('%') && sum6.includes('°C'), sum6.slice(0, 160));

// ══ 7–8: evaporation / condensation (lake) ═══════════════════════════════════════════════════
const lakeRun = async (spec, T) => {
  await newWorld();
  await ev((spec) => {
    const ds = window.__ds;
    ds.world.getState().setFeatures([{ id: 'lk', kind: 'lake', points: [[-70, -40], [10, -40], [10, 40], [-70, 40]], surface: -0.3, depth: 0.8, shoreWidth: 3, material: 7, filled: true }], 2);
    ds.actions.addPhenomenon('climate', { event: 'climate', scenario: 'custom', forcing: 'flux', profile: 'linear', duration: 900, solar: 'off', soilMoisture: 0.3, mixTime: 300, ...spec });
  }, spec);
  await wait(500);
  await enterRun();
  await atTime(T);
  return cl();
};
C = await lakeRun({ scenario: 'drying', temperature: 303.15, target: 306.15, ramp: 300, humidity: 0.3 }, 300);
await view(-30, 0, 60, 70);
await shot('07-evaporation');
check('7 evaporation: water leaves the lake as vapour (mass to the air, latent heat out of the water)', C.totals.evaporated > 0 && C.stats.vapour > 0 && C.thermal.latent < 0, { evap: C.totals.evaporated, vapour: C.stats.vapour });
await exitSim();
// Warm, nearly saturated air arriving over a lake and ground still at 15 °C: dew point above the surfaces → condensation.
C = await lakeRun({ scenario: 'humid', temperature: 288.15, target: 298.15, ramp: 120, humidity: 0.95 }, 300);
await shot('08-condensation');
check('8 condensation: warm humid air over colder water / ground condenses on them (dew), latent heat released into the surfaces', C.water.transfers.condensation + C.water.transfers.airCondensation > 0 && C.totals.condensed > 0, { surface: C.water.transfers.condensation, air: C.water.transfers.airCondensation });
await exitSim();

// ══ 9–16, 33–40: heavy snowfall on a street ═════════════════════════════════════════════════════
const fp0 = await presetRun('heavySnowfall', 600);
C = await cl();
let M = await ms();
await view(0, 0, 50, 60);
await ev(() => window.__ds.sim.play());
await wait(1500);
await ev(() => window.__ds.sim.pause());
const lc10 = await layerCount();
await shot('09-snowfall');
check('9 snowfall started: external precipitation split by the wet bulb into snow, first snow milestone', C.totals.snowfall > 0 && M.includes('firstSnow') && M.includes('climateStart'), { snowfall: C.totals.snowfall });
check('10 falling snow particles drawn while it snows (visual only, density from the computed rate)', lc10.pts > 0, lc10);
check('11 ground snow: the computed cover (mass, depth) on the ground', C.stats.snowMass > 0 && C.stats.maxSnowDepth > 0.003, { kg: C.stats.snowMass, d: C.stats.maxSnowDepth });
const st12 = await ev(() => { const r = window.__ds.climateLib.rt(); const cw = r.cw; const o = { roof: 0, crown: 0 }; for (const s of r.stores) { const k = cw.stores[s.k].kind; if (k === 0) o.roof += cw.sM[s.k]; if (k === 1) o.crown += cw.sM[s.k]; } return o; });
check('12 roof snow: snow on the roofs (stores), drawn as roof slabs', st12.roof > 0 && lc10.slabs > 0, { st12, lc10 });
check('13 snow on trees: crown interception (Hedstrom–Pomeroy), drawn as caps', st12.crown > 0 && lc10.caps > 0, { st12, lc10 });
await atTime(1200);
const leg15 = await overlay('snowDepth');
await view(0, 0, 90, 110);
await shot('15-snow-depth');
check('15 snow-depth overlay with its fixed m legend (35: snow overlay)', leg15.includes(' m'), leg15.slice(0, 80));
C = await cl();
check('16 snow mass ledger closes (precipitation in, stores, vapour, residual at round-off)', C.stats.waterResidual < 1e-8 && C.water.precipitation > 0, { res: C.stats.waterResidual });
const leg33 = await overlay('airT');
await shot('33-air-temperature');
check('33 air-temperature overlay with its °C legend', leg33.includes('°C'), leg33.slice(0, 60));
const leg34 = await overlay('rh');
await shot('34-humidity');
check('34 humidity overlay with its % legend', leg34.includes('%'), leg34.slice(0, 60));
await overlay('off');
const carId = await ev(() => [...window.__ds.sim.getRuntime().entities.values()].find((e) => e.source.type === 'building').id);
await ev((id) => window.__ds.editor.getState().select(id), carId);
await wait(700);
const insp37 = await ev(() => document.querySelector('[data-testid="climate-object"]')?.textContent ?? '');
await shot('37-inspector');
await ev(() => window.__ds.editor.getState().select(null));
await ev(() => window.__ds.view.getState().setWaterProbe({ x: -60, z: 60 }));
await wait(600);
const probe37 = await ev(() => document.querySelector('[data-testid="climate-probe"]')?.textContent ?? '');
await ev(() => window.__ds.view.getState().setWaterProbe(null));
const narrow37 = await ev(() => [...document.querySelectorAll('[data-testid="climate-object"] > span:nth-child(odd), [data-testid="climate-probe"] > span:nth-child(odd)')].filter((e) => e.clientWidth < 40).map((e) => e.textContent));
check('37 inspector: snow on the roof (kg, kPa), air, humidity, dew point, surface state, snow depth / SWE, friction; ground probe; labels not squeezed', insp37.includes('kPa') && insp37.includes('°C') && probe37.includes('kg/m²') && narrow37.length === 0, { insp: insp37.slice(0, 120), probe: probe37.slice(0, 80), narrow37 });
const hud38 = await ev(() => document.querySelector('[data-testid="climate-hud"]')?.textContent ?? '');
const clip38 = await clipped(['[data-testid="climate-hud"]', '[data-testid="climate-overlay"]']);
check('38 HUD: mean / min / max temperature, snow and ice mass, meltwater, evaporation, water and energy ledgers; text not cut', hud38.includes('°C') && hud38.includes('kg') && clip38.length === 0, { hud: hud38.slice(0, 120), clip38 });
await ev(() => window.__ds.ui.getState().setResultsOpen(true));
await wait(800);
const res40 = await ev(() => document.querySelector('[data-testid="climate-results"]')?.textContent ?? '');
const csv40 = await ev(() => !!document.querySelector('[data-testid="climate-csv"]'));
const clip40 = await clipped(['[data-testid="climate-results"]']);
await shot('40-results');
await ev(() => window.__ds.ui.getState().setResultsOpen(false));
check('40 results: cards, climate CSV (ledgers, stores, roads, history), JSON summary; text not cut', res40.length > 80 && csv40 && clip40.length === 0, { res: res40.slice(0, 80), clip40 });
const h43a = await cHash();
// The peak of the 'peak' snowfall profile is at mid-duration (1200 s); its milestone is set once the rate has halved.
await atTime(2000);
M = await ms();
check('39 timeline: climate start, first snow, peak snowfall', ['climateStart', 'firstSnow', 'peakSnowfall'].every((k) => M.includes(k)), M.filter((k) => !['start', 'end'].includes(k)));
await ev(() => window.__ds.actions.resetSimulation());
await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status !== 'loading', { timeout: 120_000 });
const r43 = await ev(() => ({ c: window.__ds.climateLib.rt() === null, t: window.__ds.sim.getTime() }));
await ev(() => window.__ds.sim.play());
await atTime(1200);
const h43b = await cHash();
check('43 same conditions again (reset): the same snow, vapour, air and ledgers', r43.c && r43.t === 0 && h43a === h43b, { r43, h43a, h43b });
await exitSim();
check('42 leaving the simulation leaves the original world untouched (fingerprint)', (await fp()) === fp0, { fp0 });

// ══ 14: compaction of an existing pack (no new snow: fresh snow would lower the mean density) ══════
await newWorld();
await ev(() => window.__ds.actions.addPhenomenon('climate', { event: 'climate', scenario: 'custom', forcing: 'flux', profile: 'constant', temperature: 268.15, target: 268.15, duration: 1800, humidity: 0.85, precipitation: 0, solar: 'off', soilMoisture: 0.3, mixTime: 300, initialSnow: 0.4, initialSnowDensity: 90 }));
await wait(500);
await enterRun();
const snap14 = () => ev(() => { const r = window.__ds.climateLib.rt(); const c = r.trt.world.terrain.index(-40, 40); return { rho: r.cw.cRho[c], kg: r.cw.cM[c], d: r.cw.snowDepth(c) }; });
await atTime(60);
const s14a = await snap14();
await atTime(1200);
const s14b = await snap14();
check('14 snow compaction: the density rises with time (mass kept, depth falls)', s14b.rho > s14a.rho && s14b.d < s14a.d && Math.abs(s14b.kg - s14a.kg) < 0.01 * s14a.kg, { s14a, s14b });
await exitSim();

// ══ 17–18: road icing ══════════════════════════════════════════════════════════════════════════
await presetRun('roadIcing', 1500);
const r17 = await ev(() => {
  const r = window.__ds.climateLib.rt(), g = r.trt.world.terrain;
  let ice = 0; for (let x = -90; x <= 90; x += 3) ice = Math.max(ice, r.cw.iceThickness(g.index(x, 0)));
  const cars = [...window.__ds.sim.getRuntime().entities.values()].filter((e) => e.source.type === 'car').map((e) => e.groundFriction);
  return { ice, cars, grip: r.frictionAt(-60, 0, 0.7 / 0.55, 0), probe: r.probe(-60, 0) };
});
await ev(() => window.__ds.view.getState().setClimateViz({ overlay: 'ice' }));
await view(0, 0, 40, 50);
await wait(900);
await shot('17-road-icing');
check('17 road icing: rain on the asphalt froze when the surface fell below 0 °C (computed ice thickness)', r17.ice > 0.0001, r17);
check('18 vehicle friction changed: the contact friction factor fell on the icy road (no tyre model)', r17.grip < 0.7 / 0.55 && r17.cars.some((f) => f < 1.27), r17);
await exitSim();

// ══ 19–20, 36: lake freezing ════════════════════════════════════════════════════════════════════
await presetRun('lakeFreezing', 1800);
C = await cl();
M = await ms();
const leg20 = await overlay('ice');
await view(-10, 0, 70, 80);
await shot('19-lake-ice');
check('19 lake freezing: the lake water froze from its own mass (frozen budget), floating ice in the flood model', C.stats.iceMass > 0 && (await ev(() => window.__ds.sim.getEnvironment().flood.field.budget.frozen)) > 0 && (await ev(() => !!window.__ds.sim.getEnvironment().flood.field.iceLoad)), { ice: C.stats.iceMass });
check('20 ice thickness computed and shown (36: ice overlay with its m legend); lake-ice milestone', C.stats.maxIce > 0.001 && leg20.includes(' m') && M.includes('lakeIce'), { maxIce: C.stats.maxIce });
await exitSim();

// ══ 21, 3b: frozen ground in extreme cold ═════════════════════════════════════════════════════
await presetRun('extremeCold', 3300);
C = await cl();
check('21 frozen ground: soil water froze in the thermal ground columns (frozen depth reported)', C.stats.frozenSoilCells > 0 && C.stats.frostDepth > 0, { cells: C.stats.frozenSoilCells, d: C.stats.frostDepth });
check('3b cold wave in the run: the air cooled toward the target, the surfaces below 0 °C', C.stats.meanAirT < 273.15 - 5 && C.stats.minSurfaceT < 273.15, { air: C.stats.meanAirT - 273.15, s: C.stats.minSurfaceT - 273.15 });
await exitSim();

// ══ 22–24: snowmelt flood ═══════════════════════════════════════════════════════════════════════
await presetRun('snowmeltFlood', 2400);
C = await cl();
M = await ms();
const fl24 = await ev(() => { const f = window.__ds.sim.getEnvironment().flood.field; return f ? { vol: f.totalVolume(), flooded: f.stats.floodedCells, melt: f.budget.melt } : null; });
// Covers that hold liquid are at the melting point (enthalpy node): the largest deviation over all wet covers.
const t22 = await ev(() => { const cw = window.__ds.climateLib.rt().cw; let n = 0, dev = 0; for (let c = 0; c < cw.n; c++) if (cw.cM[c] > 0.5 && cw.cLiq[c] > 0) { n++; dev = Math.max(dev, Math.abs(cw.coverT(c) - 273.15)); } return { wet: n, dev }; });
await ev(() => window.__ds.view.getState().setClimateViz({ overlay: 'water' }));
await view(30, 0, 80, 100, 5);
await wait(900);
await shot('24-snowmelt-flood');
check('22 thaw: melting started (thaw milestone), snow at 0 °C while melting', M.includes('thawStart') && C.totals.melt > 0 && t22.wet > 0 && t22.dev < 1e-6, { melt: C.totals.melt, t22 });
check('23 snowmelt: meltwater entered the flood model (melt budget = climate meltwater)', fl24 && C.totals.meltToFlood > 0 && Math.abs(fl24.melt * 1000 - C.totals.meltToFlood) < 1e-3 * C.totals.meltToFlood, { fl24, meltToFlood: C.totals.meltToFlood });
check('24 snowmelt flooding: flooded cells in the valley (Phase 14 runoff)', fl24 && fl24.flooded > 0, fl24);
await exitSim();

// ══ 25–26: solar heating ════════════════════════════════════════════════════════════════════════
await presetRun('solarHeating', 900);
C = await cl();
const s26 = await ev(() => { const r = window.__ds.climateLib.rt(); return { asphalt: r.probe(-60, -60).surfaceT, grass: r.probe(60, -70).surfaceT, solar: r.probe(-60, -60).solar }; });
const leg26 = await overlay('surfaceT');
await view(0, 0, 90, 110);
await shot('26-surface-temperature');
check('25 solar radiation: clear-sky noon irradiance absorbed by the ground (albedo, incidence, shadows)', C.stats.solar > 600 && s26.solar > 500, { G: C.stats.solar, absorbed: s26.solar });
check('26 surface temperature: dark asphalt warmer than grass in the sun; surface-temperature overlay °C', s26.asphalt > s26.grass + 2 && leg26.includes('°C'), s26);
await exitSim();

// ══ 27–28: heatwave, vegetation drying, fire ═══════════════════════════════════════════════════
await newWorld();
await ev((pid) => window.__ds.actions.loadClimatePreset(pid), 'heatwaveDrying');
await wait(800);
await ev(() => window.__ds.actions.addPhenomenon('fire', { event: 'fire', position: [-30, -10], height: 6, radius: 2.5, duration: 600, startTime: 900 }));
await wait(300);
await enterRun();
await atTime(880);
const u27 = await ev(() => window.__ds.climateLib.rt().crowns.map((c) => c.u));
const lit880 = await ev(() => { const fr = window.__ds.sim.getEnvironment().fire.rt; if (!fr) return 0; let lit = 0; for (let i = 0; i < fr.fw.n; i++) if (fr.fw.kind[i] === 1 && fr.fw.state[i] >= 3) lit++; return lit; });
await atTime(960);
const f28 = await ev(() => { const fr = window.__ds.sim.getEnvironment().fire.rt; const r = window.__ds.climateLib.rt(); if (!fr) return null; let n = 0, lit = 0; for (let i = 0; i < fr.fw.n; i++) if (fr.fw.kind[i] === 1) { n++; if (fr.fw.state[i] >= 3) lit++; } return { foliage: n, lit, u: r.crowns.map((c) => c.u) }; });
await view(-20, 0, 40, 50);
await shot('28-heatwave-fire');
check('27 heatwave dries vegetation: crown moisture fell below its start (soil too dry to supply), never below the live floor', u27.every((u) => u < 1.2 && u >= 0.6 - 1e-9), u27);
check('28 heatwave and fire: the fire model starts from the dried crowns (same water array); ignition needed a source — nothing ignited before it', !!f28 && f28.foliage > 0 && lit880 === 0, { ...f28, lit880 });
await exitSim();

// ══ 29–30: snow-loaded building ═════════════════════════════════════════════════════════════════
await presetRun('snowLoadedBuilding', 900);
C = await cl();
const b29 = await ev(() => { const e = [...window.__ds.sim.getRuntime().entities.values()].find((x) => x.source.type === 'building' && x.dims[0] > 20) ?? [...window.__ds.sim.getRuntime().entities.values()].find((x) => x.source.type === 'building'); const m = e.modular?.structure?.model; return { kPa: e.climate?.loadKPa, applied: e.climate?.applied, failed: m ? m.records.length : 0, hazards: m ? [...new Set(m.records.map((r) => r.hazard))] : [], collapsed: Number.isFinite(e.modular?.collapsedFrom) }; });
await ev(() => window.__ds.view.getState().setClimateViz({ overlay: 'roofLoad' }));
await view(0, 0, 40, 50);
await wait(900);
await shot('29-roof-load');
check('29 roof snow load: snow mass × g on the roof members of the structural model (≥ 0.4 kPa applied)', b29.kPa > 0.4 && b29.applied, b29);
check('30 structural response through the existing engine: failures (if any) recorded with hazard climate, the roof snow kept (water ledger closed)', (b29.failed === 0 || b29.hazards.includes('climate')) && C.stats.waterResidual < 1e-8, { b29, res: C.stats.waterResidual });
await exitSim();

// ══ 31: volcano meets snow ══════════════════════════════════════════════════════════════════════
await presetRun('volcanoSnow', 400);
C = await cl();
await view(-50, 0, 50, 60, 10);
await shot('31-volcano-snow');
// Ash on snow: where ash lies the snow is darker than clean snow of the same run (only judged when ash has fallen).
const a31 = await ev(() => { const cw = window.__ds.climateLib.rt().cw; let na = 0, sa = 0, nc = 0, sc = 0; for (let c = 0; c < cw.n; c++) { if (!(cw.swe(c) > 1)) continue; const ash = cw.ashAt ? cw.ashAt(c) : 0; const al = cw.albedo(c); if (ash > 0.05) { na++; sa += al; } else if (ash === 0) { nc++; sc += al; } } return { ashy: na, clean: nc, aAshy: na ? sa / na : null, aClean: nc ? sc / nc : null }; });
check('31 volcano and snow: lava heat on covered cells melted snow (meltwater); ash darkens the snow it lies on', C.totals.melt > 0 && (a31.ashy === 0 || a31.aAshy < a31.aClean), { melt: C.totals.melt, meltToFlood: C.totals.meltToFlood, a31 });
await exitSim();

// ══ 32: atmospheric removal + evaporation ═══════════════════════════════════════════════════════
await newWorld();
await ev(() => {
  const ds = window.__ds;
  ds.world.getState().setFeatures([{ id: 'lk', kind: 'lake', points: [[-50, -30], [30, -30], [30, 30], [-50, 30]], surface: -0.3, depth: 0.6, shoreWidth: 3, material: 7, filled: true }], 2);
  ds.actions.addPhenomenon('atmosphere', { event: 'atmosphere', altitude: 0, boundary: 'closed', removal: 'linear', extent: 'uniform', target: 0.2, duration: 120 });
  ds.actions.addPhenomenon('climate', { event: 'climate', scenario: 'custom', forcing: 'flux', temperature: 288.15, target: 288.15, profile: 'constant', duration: 900, humidity: 0.6, solar: 'off', soilMoisture: 0.25 });
});
await wait(500);
await enterRun();
await atTime(180);
C = await cl();
await shot('32-removal-evaporation');
check('32 atmospheric removal and evaporation: vapour leaves with the air (same share), evaporation continues at low pressure, ledgers close', C.water.removed > 0 && C.totals.evaporated > 0 && C.stats.waterResidual < 1e-8, { removed: C.water.removed, evap: C.totals.evaporated });
await exitSim();

// ══ 41: save / load ═════════════════════════════════════════════════════════════════════════════
const saved41 = await ev(() => {
  const ds = window.__ds;
  ds.actions.addPhenomenon('climate', { event: 'climate', scenario: 'snowmelt', forcing: 'prescribed', temperature: 274.15, target: 285.15, profile: 'staged', stages: [[300, 278.15], [600, 285.15]], duration: 1200, humidity: 0.8, solar: 'clearSky', latitude: 45, dayOfYear: 90, hour: 10, initialSnow: 0.4, initialSnowDensity: 300, soilMoisture: 0.2 });
  const text = ds.buildLib.serializeDocument(ds.world.getState().doc, false);
  const r = ds.buildLib.parseDocument(text);
  return { ok: r.ok, version: JSON.parse(text).schemaVersion, spec: r.ok ? r.doc.scenario.experiment.instances.filter((i) => i.type === 'climate').pop()?.spec : null };
});
check('41 climate experiment saved and reloaded (schema 7): staged path, prescribed forcing, sun, initial snow', saved41.ok && saved41.version === 7 && saved41.spec?.profile === 'staged' && saved41.spec?.stages?.[1]?.[0] === 600 && saved41.spec?.forcing === 'prescribed' && saved41.spec?.initialSnow === 0.4, saved41);

// ══ 44: large town ══════════════════════════════════════════════════════════════════════════════
await newWorld();
await ev(() => {
  const ds = window.__ds;
  const d = ds.buildingLib.createDesign(ds.buildingLib.presetSpec('house'), 'house');
  const add = [];
  for (let z = -94; z <= 94 && add.length < 1000; z += 6) for (let x = -94; x <= 94 && add.length < 1000; x += 6) add.push({ type: 'building', building: d, seed: add.length + 1, transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] } });
  ds.world.getState().applyEdit({ add });
  ds.actions.addPhenomenon('climate', { event: 'climate', scenario: 'snowfall', forcing: 'flux', temperature: 270.15, target: 270.15, profile: 'constant', duration: 1800, humidity: 0.9, precipitation: 10, precipPhase: 'snow', solar: 'off', soilMoisture: 0.25, initialSnow: 0.2 });
});
await wait(1500);
await enterRun();
await atTime(60);
await view(0, 0, 90, 110);
await ev(() => window.__ds.sim.play());
const fps44 = await ev(() => new Promise((res) => { const t = []; let last = performance.now(); const f = (now) => { t.push(now - last); last = now; if (t.length < 240) requestAnimationFrame(f); else res({ mean: t.reduce((a, b) => a + b, 0) / t.length, worst: Math.max(...t.slice(10)) }); }; requestAnimationFrame(f); }));
const gl44 = await ev(() => { const g = window.__r3f.get().gl.info; return { calls: g.render.calls, geometries: g.memory.geometries, textures: g.memory.textures }; });
C = await cl();
await shot('44-town');
await exitSim();
check('44 large town (1000 houses) under snowfall: interactive frame rate, roofs loaded', fps44.mean < 100 && C.stats.roofsLoaded > 0, { fps: +(1000 / fps44.mean).toFixed(1), worstFrameMs: +fps44.worst.toFixed(1), climateMs: C.ms, gl44 });

// ══ 45: repeated runs ═══════════════════════════════════════════════════════════════════════════
await newWorld();
await wait(500);
const geoA = await geometries();
const heaps45 = [];
for (let k = 0; k < 3; k++) {
  await presetRun('snowAccumulation', 60);
  await ev(() => window.__ds.view.getState().setClimateViz({ overlay: 'swe' }));
  await wait(800);
  await exitSim();
  heaps45.push(await heapMB());
}
await newWorld();
await wait(500);
const geoB = await geometries();
check('45 repeated runs release their GPU resources: geometries back, heap flat', geoB <= geoA + 2 && heaps45[2] - heaps45[0] < 25, { geoA, geoB, heaps45 });

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
