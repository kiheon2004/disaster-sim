// Browser verification of the reduced human physiology (Phase 34): scenarios in real Chrome through the UI and the dev
// hooks (settings: the physiology switch — it switches the extended human model on —, advanced options; a calm run with
// assumed / reference sources; boundary-condition zones for cold, heat, radiant heat, smoke + CO, hypoxia, low pressure,
// airway submersion, water deficit and fatigue; the capacity with its limiting cause and the physiological collapse; the
// overlay with its legend and GPU resources; the results block — cards, table, charts with gaps, the physiology CSV / JSON
// with schema version, units and provenance; presets; save → reload, reset, the original world, the language switch, a
// combined hazard, the legacy run) plus whole-run checks (raw i18n keys, NaN shown, page / console errors, GPU geometries).
//
//   npx vite build && npx vite preview --port 4199 --strictPort &
//   LANG_UI=ko node scripts/verify-physiology.mjs http://localhost:4199/ ./docs/verify/physiology
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:4199/', out = './docs/verify/physiology'] = process.argv.slice(2);
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
const t0 = Date.now();
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${typeof detail === 'string' ? detail : JSON.stringify(detail)} [${((Date.now() - t0) / 1000).toFixed(0)} s]`);
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clickText = (re, root = 'body') => ev(([src, root]) => {
  const r = new RegExp(src);
  for (const b of document.querySelector(root)?.querySelectorAll('button, [role="menuitem"]') ?? []) if (r.test(b.textContent ?? '') && !b.disabled) { b.click(); return true; }
  return false;
}, [re.source, root]);
const tr = (k, p) => ev(([k, p]) => (p ? window.__ds.tr(k).replace(/\{(\w+)\}/g, (_, n) => String(p[n])) : window.__ds.tr(k)), [k, p]);
const text = (sel) => ev((sel) => document.querySelector(sel)?.textContent ?? '', sel);
const glInfo = () => ev(() => { const g = window.__r3f.get().gl.info; return { geometries: g.memory.geometries, textures: g.memory.textures }; });
async function view(x, z, h = 6, back = 9) {
  await ev(([x, z, h, back]) => { const st = window.__r3f.get(); st.camera.position.set(x + back * 0.5, h, z + back); st.controls.target.set(x, 1, z); st.controls.update(); }, [x, z, h, back]);
  await wait(300);
}
const inst = () => ev(() => window.__ds.world.getState().doc.scenario.experiment?.instances ?? []);
const fp = () => ev(() => window.__ds.blueprintLib.worldFingerprint(window.__ds.world.getState().doc));
const settings = () => ev(() => { const s = window.__ds.world.getState().doc.settings.simulation; return { humans: s.humans ?? null, physiology: s.physiology ?? null }; });
const rows = () => ev(() => window.__ds.physioLib.people());
const agg = () => ev(() => window.__ds.physioLib.aggregate());
const snap = (id) => ev((id) => window.__ds.physioLib.snapshot(id), id);
const physEvents = () => ev(() => window.__ds.simStore.getState().damageEvents.filter((e) => e.physio).map((e) => ({ t: e.time, type: e.eventType, ...e.physio })));
async function newWorld() {
  await ev(() => { window.__ds.actions.newProject(); window.__ds.view.getState().setPhysioViz({ enabled: false, metric: 'core', airway: true }); window.__ds.view.getState().setHumanViz({ enabled: false }); });
  await wait(300);
}
const addObjects = (list) => ev((list) => {
  window.__ds.world.getState().applyEdit({ add: list.map((o) => ({ type: o.type, seed: o.seed ?? 1, params: o.params, transform: { position: [o.x, o.y ?? 0, o.z], rotation: [0, o.yaw ?? 0, 0], scale: [1, 1, 1] } })) });
}, list);
const add = (type, spec) => ev(([type, spec]) => window.__ds.actions.addPhenomenon(type, spec), [type, spec]);
const setPhysio = (p) => ev((p) => window.__ds.world.getState().updateSimulationSettings({ humans: { model: 'extended' }, physiology: p }), p);
const K = 273.15;
const zone = (o) => ({ id: 'z1', name: 'test', shape: 'box', center: [0, 1, 0], size: [40, 8, 40], ...o });
async function enterRun() {
  if ((await inst()).length) await clickText(/^\s*실험 실행|Run experiment/);
  else await ev(() => window.__ds.actions.enterSimulation());
  await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status !== 'loading', { timeout: 180_000 });
}
const atTime = async (T) => { const t = await ev((T) => { const s = window.__ds.sim; s.pause(); const r = T - s.getTime(); if (r > 0) s.advance(r); return s.getTime(); }, T); await wait(400); return t; };
const exitSim = async () => { await ev(() => window.__ds.actions.exitSimulation()); await wait(500); };
const select = async (k) => { await ev((k) => { const e = window.__ds.physioLib.people()[k] ?? null; window.__ds.editor.getState().select(e?.id ?? null); }, k); await wait(400); };
/** Scenario: a fresh world, people, physiology settings, run to T. */
async function scenario(physio, T, people = PEOPLE) {
  await newWorld();
  await addObjects(people);
  await setPhysio(physio);
  await wait(200);
  await enterRun();
  await atTime(T);
}
const openSub = async (labelKey, hostSel = '[data-testid="physio-object"]') => { const r = await ev(([label, hostSel]) => { const host = document.querySelector(hostSel)?.parentElement; for (const b of host?.querySelectorAll('button') ?? []) if ((b.textContent ?? '').includes(label)) { if (b.getAttribute('aria-expanded') !== 'true') b.click(); return true; } return false; }, [await tr(labelKey), hostSel]); await wait(300); return r; };
const overlaySwitch = (label) => ev((label) => {
  for (const l of document.querySelectorAll('label')) if ((l.textContent ?? '').trim() === label) { const s = l.querySelector('[role="switch"]'); if (s) { s.click(); return true; } }
  return false;
}, label);
const layer = () => ev(() => {
  let found = false; const counts = []; const colors = [];
  window.__r3f.get().scene.traverse((o) => { if (o.name === 'physiology-layer') { found = true; o.traverse((m) => { if (m.isInstancedMesh) { counts.push(m.count); colors.push(m.count ? [...m.instanceColor.array.slice(0, 3)].map((x) => +x.toFixed(3)).join(',') : ''); } }); } });
  return { found, markers: counts[0] ?? 0, rings: counts[1] ?? 0, color0: colors[0] ?? '' };
});
const setSelect = (sel, value) => ev(([sel, value]) => { const s = document.querySelector(sel); if (!s) return false; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, value); s.dispatchEvent(new Event('change', { bubbles: true })); return true; }, [sel, value]);
const rawKeys = () => ev(() => (document.body.innerText.match(/\b(physioUi|physioPresets|physiology)\.[a-zA-Z_]+(\.[a-zA-Z_]+)*/g) ?? []).slice(0, 8));
const rawSeen = [];
const scanRaw = async (where) => { const r = await rawKeys(); if (r.length) rawSeen.push({ where, r }); };
const nanSeen = [];
const scanNaN = async (where) => { const n = await ev(() => /\bNaN\b|\bInfinity\b|undefined/.test(document.body.innerText)); if (n) nanSeen.push(where); };
await ev(() => { window.__blobs = []; const o = URL.createObjectURL.bind(URL); URL.createObjectURL = (b) => { window.__blobs.push(b); return o(b); }; HTMLAnchorElement.prototype.click = function () {}; });
const lastBlob = () => ev(async () => (window.__blobs.length ? await window.__blobs[window.__blobs.length - 1].text() : ''));
const PEOPLE = [{ type: 'human', x: 0, z: 0, seed: 1 }, { type: 'human', x: 3, z: 0, seed: 2 }];
const nc = await tr('physioUi.notComputed');
const geo0 = (await glInfo()).geometries;

// ══ 1–8: settings (editor) ════════════════════════════════════════════════════════════════
await newWorld();
await clickText(new RegExp('^\\s*▸?\\s*' + esc(await tr('settings.title'))));
await wait(300);
const sw = '[data-testid="physio-settings"] [role="switch"]';
const s1 = await settings();
const has1 = await ev((s) => !!document.querySelector(s), sw);
await ev((s) => document.querySelector(s).click(), sw);
await wait(300);
const s1b = await settings();
await shot('01-settings');
check('1 settings: the physiology switch writes physiology = { model: reduced } AND switches the extended human model on', has1 && s1.humans === null && s1.physiology === null && s1b.physiology?.model === 'reduced' && s1b.humans?.model === 'extended', { s1, s1b });
const opened2 = await openSub('physioUi.settings.advanced', '[data-testid="physio-settings"]');
const adv = '[data-testid="physio-advanced-settings"]';
const nSel = await ev((a) => document.querySelectorAll(`${a} select`).length, adv);
await ev((a) => { const s = document.querySelectorAll(`${a} select`); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s[0], 'moderate'); s[0].dispatchEvent(new Event('change', { bubbles: true })); set.call(s[1], 'insulated'); s[1].dispatchEvent(new Event('change', { bubbles: true })); }, adv);
await wait(300);
const s2 = (await settings()).physiology;
check('2 advanced (collapsed by default): activity and clothing selects store activity = moderate, clothing = insulated', opened2 && nSel === 2 && s2?.activity === 'moderate' && s2?.clothing === 'insulated', s2);
const waterSel = `${adv} input`;
await page.click(waterSel, { clickCount: 3 });
await page.keyboard.press('Backspace');
await page.type(waterSel, '0.5');
await page.keyboard.press('Enter');
await wait(300);
const s3 = (await settings()).physiology;
check('3 explicit water intake field stores 0.5 L/h (no automatic drinking)', s3?.waterIntake === 0.5, s3?.waterIntake);
const modSwitches = await ev((a) => document.querySelectorAll(`${a} [role="switch"]`).length, adv);
await ev((a) => document.querySelectorAll(`${a} [role="switch"]`)[2].click(), adv);
await wait(300);
const s4 = (await settings()).physiology;
await ev((a) => document.querySelectorAll(`${a} [role="switch"]`)[2].click(), adv);
await wait(300);
check('4 six module toggles; switching "gas" off stores modules.gas = false (on again → true)', modSwitches === 6 && s4?.modules?.gas === false && (await settings()).physiology?.modules?.gas === true, { modSwitches, m: s4?.modules });
const refIn = await ev((a) => document.querySelectorAll(`${a} input`).length, adv);
await ev((a) => { const i = document.querySelectorAll(`${a} input`)[1]; i.id = '__hum'; }, adv);
await page.click('#__hum', { clickCount: 3 });
await page.keyboard.press('Backspace');
await page.type('#__hum', '70');
await page.keyboard.press('Enter');
await wait(300);
const s5 = (await settings()).physiology;
const assumedNote = await text(adv);
check('5 reference values (humidity / pressure / O₂ / CO₂ / water temperature) with the "assumed" note; humidity 70 % stored as 0.7', refIn >= 6 && Math.abs((s5?.reference?.humidity ?? 0) - 0.7) < 1e-9 && assumedNote.includes((await tr('physioUi.settings.assumedNote')).slice(0, 10)), { refIn, ref: s5?.reference });
await ev(() => document.querySelector('[data-testid="human-settings"] [role="switch"]').click());
await wait(300);
const s6 = await settings();
check('6 switching the extended human model off drops the physiology too (it needs the extended model)', s6.humans === null && s6.physiology === null, s6);
await ev((s) => document.querySelector(s).click(), sw);
await wait(300);
await ev((s) => document.querySelector(s).click(), sw);
await wait(300);
const s7 = await settings();
check('7 physiology off → the key is removed, the extended human model stays on', s7.physiology === null && s7.humans?.model === 'extended', s7);
await ev(() => window.__ds.world.getState().updateSimulationSettings({ seed: 4242 }));
await setPhysio({ model: 'reduced', activity: 'light' });
await ev(() => window.__ds.world.getState().updateSimulationSettings({ seed: 4343 }));
check('8 other settings edits keep the physiology setting', (await settings()).physiology?.activity === 'light');
await scanRaw('settings');

// ══ 9–16: calm run ════════════════════════════════════════════════════════════════════════
await addObjects(PEOPLE);
await setPhysio({ model: 'reduced' });
const fp9 = await fp();
await enterRun();
await atTime(60);
const r9 = await rows();
check('9 people placed: 2 people with physiology state in the run', r9.length === 2 && (await agg())?.people === 2, r9.length);
check('10 calm scene (60 s): core stays near 36.8 °C, capacity normal, no physiology events', r9.every((r) => Math.abs(r.core - 36.8) < 0.4 && r.combined === 'normal') && (await physEvents()).length === 0, r9.map((r) => r.core));
check('11 calm scene sources: air = scene ambient, humidity / pressure / gas = reference (assumed values)', r9[0].provenance.airT === 'scene.ambient' && r9[0].provenance.humidity === 'reference' && r9[0].provenance.pressure === 'reference' && r9[0].provenance.gas === 'reference', r9[0].provenance);
await select(0);
await view(0, 0);
const insp12 = await text('[data-testid="physio-object"]');
check('12 inspector: physiology section with core / skin / air temperature (source) / heat balance in-out W / ventilation L/min / O₂ supply index', insp12.includes('°C') && insp12.includes(' W') && insp12.includes('L/min') && insp12.includes(await tr('physioUi.src.scene_ambient')) && insp12.includes(await tr('physioUi.inspect.supply')), insp12.slice(0, 200));
await openSub('physioUi.inspect.sources');
const src13 = await text('[data-testid="physio-sources"]');
await shot('13-inspector-calm');
check('13 inspector value sources: translated labels, assumed ones marked "assumed" (reference value)', src13.includes(await tr('physioUi.src.reference')) && src13.includes(await tr('physioUi.assumed')) && src13.includes(await tr('physioUi.field.humidity')), src13.slice(0, 200));
const lim14 = (await text('[data-testid="physio-limitation"]')) + (await text('[data-testid="physio-levels"]'));
check('14 inspector: model level legend (A / B / C) and the limitation line (no diagnosis / time of death / survival probability)', lim14.includes(await tr('physioUi.limitation')) && lim14.includes(await tr('physioUi.levels')));
check('15 inspector: capacity (physiological and combined) and activity / clothing translated', insp12.includes(await tr('physioUi.cap.normal')) && insp12.includes(await tr('physioUi.act.resting')) && insp12.includes(await tr('physioUi.cloth.normal')));
const smokeTxt = await ev(() => document.querySelector('[data-testid="physio-object"]').textContent);
check('16 calm scene: no "NaN" / "undefined" in the physiology section; uncomputed shown as text, not 0', !/NaN|undefined/.test(smokeTxt), '');
await scanRaw('calm');
await scanNaN('calm');
// Reset + original world
await ev(() => window.__ds.actions.resetSimulation());
await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.sim.getTime() === 0, { timeout: 60_000 });
await wait(400);
const sn17 = await snap();
check('17 reset: back to t = 0 — physiology state re-created (time 0, no doses, no series)', sn17.length === 2 && sn17.every((p) => p.s.time === 0 && p.s.dose.co === 0 && p.series.n === 0), sn17.map((p) => p.s.time));
await exitSim();
check('18 original world: leaving the run shows the untouched world (fingerprint equal, physiology setting kept)', (await fp()) === fp9 && (await settings()).physiology?.model === 'reduced');

// ══ 19–22: cold ═══════════════════════════════════════════════════════════════════════════
await scenario({ model: 'reduced', clothing: 'light', zones: [zone({ airTemperature: 0 + K, wind: 8 })] }, 300);
const r19 = await rows();
const ev19 = await physEvents();
check('19 cold zone (0 °C, 8 m/s wind, light clothing, 300 s): skin falls well below 33 °C (core held by vasoconstriction, < 37 °C), provenance "zone"', r19[0].skin < 31 && r19[0].core < 37 && r19[0].provenance.airT === 'zone' && r19[0].provenance.wind === 'zone', { skin: r19[0].skin, core: r19[0].core });
check('20 cold stress: thermal state cold / severe cold and a THERMAL_STRESS event', ['coldStress', 'severeColdStress'].includes(r19[0].thermalState) && ev19.some((e) => e.type === 'THERMAL_STRESS'), { st: r19[0].thermalState, ev: ev19.map((e) => e.type) });
await select(0);
const insp21 = await text('[data-testid="physio-object"]');
check('21 inspector (cold): the translated thermal state and the zone as the air source', insp21.includes(await tr(`physioUi.thermal.${r19[0].thermalState}`)) && insp21.includes(await tr('physioUi.src.zone')), insp21.slice(0, 160));
check('22 cold: net heat loss (heat out > heat in, W) — the body is cooling', r19[0].heatOut > r19[0].heatIn, { in: r19[0].heatIn, out: r19[0].heatOut, shiver: r19[0].shiver });
await scanRaw('cold');
await exitSim();

// ══ 23–25: heat ═══════════════════════════════════════════════════════════════════════════
await scenario({ model: 'reduced', activity: 'strenuous', clothing: 'light', zones: [zone({ airTemperature: 45 + K, humidity: 0.85 })] }, 600);
const r23 = await rows();
check('23 hot humid zone (45 °C, 85 %, strenuous, 600 s): core rises above 37.5 °C', r23[0].core > 37.5, r23[0].core);
check('24 heat: sweating (sweat rate > 0 g/h), water lost (deficit > 0 %)', r23[0].sweat > 0 && r23[0].deficit > 0, { sweat: r23[0].sweat, deficit: r23[0].deficit });
const ev25 = await physEvents();
check('25 heat stress state and a THERMAL_STRESS event (once per change, not every step)', ['heatStress', 'severeHeatStress', 'thermoregulationFailure'].includes(r23[0].thermalState) && ev25.filter((e) => e.type === 'THERMAL_STRESS').length <= 8 && ev25.some((e) => e.type === 'THERMAL_STRESS'), { st: r23[0].thermalState, n: ev25.length });
await scanRaw('heat');
await exitSim();

// ══ 26–27: radiant heat ═══════════════════════════════════════════════════════════════════
await scenario({ model: 'reduced', zones: [zone({ radiantFlux: 6000 })] }, 120);
const r26 = await rows();
check('26 radiant flux zone (6 kW/m², 120 s): absorbed radiation → heat FED > 0, radiant source "zone", heat in > heat out direction', r26[0].fedHeat > 0 && r26[0].qFire > 5000 && /zone/.test(r26[0].provenance.radiant ?? ''), { fed: r26[0].fedHeat, q: r26[0].qFire, src: r26[0].provenance.radiant });
await select(0);
await openSub('physioUi.inspect.advanced');
const adv27 = await text('[data-testid="physio-advanced"]');
check('27 inspector details: radiant flux W/m², sweat g/h, strain index, immersed share', adv27.includes('W/m²') && adv27.includes('g/h') && adv27.includes('%'), adv27.slice(0, 160));
await exitSim();

// ══ 28–31: smoke + CO ═════════════════════════════════════════════════════════════════════
await scenario({ model: 'reduced', zones: [zone({ co: 0.003, smoke: 0.001 })] }, 120);
const r28 = await rows();
check('28 smoke + CO zone (3000 ppm, 1 g/m³, 120 s): CO dose ≈ 3000 ppm × 2 min, FED(CO) > 0', r28[0].coDose > 4000 && r28[0].coDose < 7000 && r28[0].fedCo > 0, { dose: r28[0].coDose, fed: r28[0].fedCo });
check('29 smoke dose (mg·min/m³) ≈ 1000 × 2 min and inhaled mass (mg) > 0 from the ventilation', r28[0].smokeDose > 1500 && r28[0].smokeDose < 2500 && r28[0].smokeInhaled > 0, { d: r28[0].smokeDose, m: r28[0].smokeInhaled });
check('30 GAS_EXPOSURE event once the asphyxiant FED passes 0.1', (await physEvents()).some((e) => e.type === 'GAS_EXPOSURE') === (r28[0].fedAsphyxiant >= 0.1), r28[0].fedAsphyxiant);
await select(0);
const insp31 = await text('[data-testid="physio-object"]');
check('31 inspector: FED line (CO / O₂ / CO₂), CO dose ppm·min, smoke dose and inhaled mg', insp31.includes('ppm·min') && insp31.includes('mg·min/m³') && insp31.includes(' mg'), '');
await exitSim();

// ══ 32–34: hypoxia / low pressure ═════════════════════════════════════════════════════════
await scenario({ model: 'reduced', zones: [zone({ o2: 0.1 })] }, 120);
const r32 = await rows();
check('32 hypoxic zone (10 % O₂): O₂ supply index < 0.5, respiratory strain event', r32[0].supply < 0.5 && (await physEvents()).some((e) => e.type === 'RESPIRATORY_STRESS'), r32[0].supply);
check('33 hypoxia: capacity limited with "respiratory" among the limiting causes', r32[0].limiting.includes('respiratory') && r32[0].capacity !== 'normal', { cap: r32[0].capacity, lim: r32[0].limiting });
await exitSim();
await scenario({ model: 'reduced', zones: [zone({ pressure: 50000 })] }, 60);
const r34 = await rows();
check('34 low pressure zone (50 kPa): supply index falls below 0.7, pressure source zone', r34[0].supply < 0.7 && r34[0].provenance.pressure === 'zone', r34[0].supply);
await exitSim();

// ══ 35–39: airway submersion + overlay ════════════════════════════════════════════════════
await scenario({ model: 'reduced', zones: [zone({ start: 5, end: 25, water: { level: 2.2, temperature: 20 + K } })] }, 15);
const r35 = await rows();
check('35 physiology-only water over the airway (t = 5–25 s): airway under water at 15 s, not breathing', r35[0].airway === 'submerged' && r35[0].breathing === false, { a: r35[0].airway });
await view(0, 0, 5, 8);
const ovLabel = await tr('physioUi.overlay');
const glA = await glInfo();
const on36 = await overlaySwitch(ovLabel);
await wait(500);
const L36 = await layer();
const leg36 = await text('[data-testid="physio-legend"]');
await shot('36-overlay-airway');
check('36 overlay on: one marker per person, an airway ring for each submerged person, the legend states the unit (°C) and the meaning', on36 && L36.found && L36.markers === 2 && L36.rings === 2 && leg36.includes('°C') && leg36.includes((await tr('physioUi.metric.core.meaning')).slice(0, 10)), { L36, leg36: leg36.slice(0, 120) });
await setSelect('[data-testid="physio-metric"]', 'airway');
await wait(400);
const L37 = await layer();
const leg37 = await text('[data-testid="physio-legend"]');
check('37 metric switch (airway time): marker colour changes, legend unit s and the "not computed" key', L37.color0 !== L36.color0 && leg37.includes((await tr('physioUi.overlay.notComputed')).slice(0, 6)), { c36: L36.color0, c37: L37.color0 });
const metricOpts = await ev(() => [...document.querySelectorAll('[data-testid="physio-metric"] option')].map((o) => o.textContent));
check('38 eight metrics offered with translated names (core, strain, O₂ supply, smoke, airway, water deficit, fatigue, capacity)', metricOpts.length === 8 && !metricOpts.some((o) => /physioUi/.test(o)), metricOpts);
await setSelect('[data-testid="physio-metric"]', 'core');
await overlaySwitch(ovLabel);
await wait(400);
const L39 = await layer();
for (let i = 0; i < 10; i++) { await overlaySwitch(ovLabel); await wait(150); }
await wait(500);
const glB = await glInfo();
check('39 overlay off unmounts the layer; 10× toggling: GPU geometries / textures do not grow', !L39.found && glB.geometries <= glA.geometries + 1 && glB.textures <= glA.textures, { L39, glA, glB });
await atTime(40);
const ev40 = await physEvents();
const r40 = await rows();
check('40 airway events: AIRWAY_SUBMERGED and AIRWAY_CLEARED once each per person; cumulative ≈ 20 s, first ≥ 5 s', ev40.filter((e) => e.type === 'AIRWAY_SUBMERGED').length === 2 && ev40.filter((e) => e.type === 'AIRWAY_CLEARED').length === 2 && Math.abs(r40[0].airwayCumulative - 20) < 1.5 && r40[0].airwayFirst >= 5, { cum: r40[0].airwayCumulative, first: r40[0].airwayFirst });
await select(0);
const insp41 = await text('[data-testid="physio-object"]');
check('41 inspector airway history: first / cumulative / longest in s and the number of submersions', insp41.includes(await tr('physioUi.airway.clear')) && /\d+(\.\d)? s \/ \d+(\.\d)? s \/ \d+(\.\d)? s/.test(insp41), insp41.slice(0, 200));
const L42 = await layer();
check('42 overlay after clearing: no airway rings (overlay switched off → layer unmounted, nothing drawn)', !L42.found || L42.rings === 0, L42);
await scanRaw('airway');
await exitSim();

// ══ 43–44: water deficit / fatigue ════════════════════════════════════════════════════════
await scenario({ model: 'reduced', activity: 'strenuous', clothing: 'light', zones: [zone({ airTemperature: 40 + K, humidity: 0.1, o2: 0.16 })] }, 600, [...PEOPLE, { type: 'human', x: -3, z: 0, seed: 3 }]);
const r43 = await rows();
check('43 hot dry zone, strenuous (600 s): water deficit grows (> 0.05 % body mass in 10 min)', r43[0].deficit > 0.05, r43[0].deficit);
check('44 fatigue index rises under strenuous activity in heat with reduced O₂ (16 %) (> 0.2)', r43[0].fatigue > 0.2, r43[0].fatigue);
await exitSim();

// ══ 45–49: capacity + physiological collapse + results ════════════════════════════════════
await scenario({ model: 'reduced', zones: [zone({ co: 0.05 })] }, 90);
const r45 = await rows();
const s45 = await snap(r45[0].id);
check('45 CO zone (5 %, 90 s): capacity unable to act, limiting cause "gas" recorded', r45[0].combined === 'unableToAct' && r45[0].combinedCauses.includes('gas'), { c: r45[0].combined, causes: r45[0].combinedCauses });
check('46 physiological collapse: the person is down (not standing), fall cause "physiological", no impact episode', s45.human.standing === false && s45.human.fallCause === 'physiological' && s45.human.impacts === 0, s45.human);
await select(0);
const insp47 = await text('[data-testid="physio-object"]');
await view(0, 0, 4, 7);
await shot('47-collapse');
check('47 inspector: combined capacity "unable to act" with the limiting cause translated (gas exposure)', insp47.includes(await tr('physioUi.cap.unableToAct')) && insp47.includes(await tr('physioUi.comp.gas')), '');
const hinsp = await text('[data-testid="human-object"]');
check('48 human inspector shows the physiological fall cause translated', hinsp.includes(await tr('humanUi.cause.physiological')), hinsp.slice(0, 160));
await ev(() => window.__ds.ui.getState().setResultsOpen(true));
await wait(900);
const res49 = await text('[data-testid="physio-results"]');
const cards49 = await ev(() => document.querySelectorAll('[data-testid="physio-results"] [class*="card"]').length);
const tab49 = await ev(() => document.querySelectorAll('[data-testid="physio-table"] tbody tr').length);
await shot('49-results');
check('49 results block: ≥ 10 aggregate cards (unable to act 2), capacity table, people table (2 rows), the limitation line', cards49 >= 10 && tab49 === 2 && res49.includes(await tr('physioUi.limitation')) && (await agg()).combined.unableToAct === 2, { cards49, tab49 });
const ch50 = await ev(() => ({ charts: document.querySelectorAll('[data-testid^="physio-chart-"]').length, lines: document.querySelectorAll('[data-testid^="physio-chart-"] polyline').length, axis: [...document.querySelectorAll('[data-testid="physio-chart-temperature"] div')].map((d) => d.textContent).join('|') }));
check('50 charts: 10 charts with lines, time axis in s, units on the value axis (°C)', ch50.charts >= 10 && ch50.lines >= 8 && /\d s/.test(ch50.axis) && ch50.axis.includes('°C'), ch50);
await ev(() => document.querySelector('[data-testid="physio-csv"]').click());
await wait(300);
const csv51 = (await lastBlob()).split('\n');
const hdr = csv51.find((l) => l.startsWith('time_s,person_id'))?.split(',') ?? [];
const row51 = csv51[csv51.indexOf(hdr.join(',')) + 1]?.split(',') ?? [];
check('51 physiology CSV: schema v1 line, model note "not a medical prediction", units line, columns incl. provenance / core / FED / doses / airway / capacity', csv51[0] === '# schema: disaster-sim.physiology v1' && csv51[1].includes('not a medical prediction') && csv51.some((l) => l.startsWith('# units:')) && ['src_airT', 'src_gas', 'core_C', 'skin_C', 'heat_in_W', 'o2_supply_index', 'fed_co', 'co_dose_ppm_min', 'smoke_dose_mg_min_m3', 'smoke_inhaled_mg', 'airway_state', 'water_deficit_pct', 'fatigue', 'capacity_combined', 'limiting', 'flags', 'model_version'].every((c) => hdr.includes(c)), csv51.slice(0, 2));
check('52 CSV row: full width, provenance "zone" for the gas, capacity unableToAct, events and series sections', row51.length === hdr.length && row51[hdr.indexOf('src_gas')] === 'zone' && row51[hdr.indexOf('capacity_combined')] === 'unableToAct' && csv51.some((l) => l.startsWith('# events')) && csv51.some((l) => l.startsWith('# series')), { n: row51.length, h: hdr.length });
await clickText(/^\s*JSON\s*$/, '[role="dialog"]');
await wait(300);
const j53 = JSON.parse((await lastBlob()) || '{}');
check('53 results JSON: a physiology block (schema 1, model reduced, units, levels A/B/C, parameters, people, events) next to the intact Phase 33 humans block', j53.physiology?.schemaVersion === 1 && j53.physiology.model === 'reduced' && j53.physiology.units?.coDose === 'ppm·min' && j53.physiology.levels?.A && j53.physiology.parameters?.specificHeat && j53.physiology.people?.length === 2 && j53.physiology.events?.length > 0 && j53.humans?.schemaVersion === 1 && j53.humans.model === 'extended', { p: !!j53.physiology, h: j53.humans?.model });
await clickText(/^\s*CSV\s*$/, '[role="dialog"]');
await wait(300);
const dcsv = (await lastBlob()).split('\n');
check('54 damage-events CSV keeps the human columns and adds the physiology columns (kind, from, to, value, causes)', ['human_segment', 'human_posture', 'physio_kind', 'physio_from', 'physio_to', 'physio_value', 'physio_causes'].every((c) => dcsv[0].includes(c)) && dcsv.some((l) => l.includes('CAPACITY_CHANGED')), dcsv[0]?.slice(-120));
await scanRaw('results');
await scanNaN('results');
await ev(() => window.__ds.ui.getState().setResultsOpen(false));
await exitSim();

// ══ 55: gaps (module off) ═════════════════════════════════════════════════════════════════
await scenario({ model: 'reduced', modules: { gas: false } }, 20);
const r55 = await rows();
await ev(() => window.__ds.ui.getState().setResultsOpen(true));
await wait(900);
const g55 = await ev(() => ({ empty: document.querySelector('[data-testid="physio-chart-smoke"]')?.getAttribute('data-empty'), txt: document.querySelector('[data-testid="physio-chart-smoke"]')?.textContent ?? '' }));
const j55 = await ev(() => window.__ds.physioLib.json());
check('55 not computed ≠ 0: gas module off → FED / doses null, the smoke chart is a gap ("not computed"), JSON series null', r55[0].fedCo === null && r55[0].smokeDose === null && g55.empty === 'true' && g55.txt.includes(nc) && j55.people[0].series.smoke.every((v) => v === null), { g55, fed: r55[0].fedCo });
await ev(() => window.__ds.ui.getState().setResultsOpen(false));
await select(0);
const insp56 = await text('[data-testid="physio-object"]');
check('56 inspector with the gas module off: FED / CO dose / smoke read "not computed", not 0', insp56.split(nc).length - 1 >= 3, '');
await exitSim();

// ══ 57–59: save → reload, language switch ═════════════════════════════════════════════════
await newWorld();
await addObjects(PEOPLE);
await setPhysio({ model: 'reduced', clothing: 'protective', waterIntake: 0.25, zones: [zone({ airTemperature: 5 + K })] });
await ev(() => window.__ds.actions.saveProject());
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
await ev(() => { window.__blobs = []; const o = URL.createObjectURL.bind(URL); URL.createObjectURL = (b) => { window.__blobs.push(b); return o(b); }; HTMLAnchorElement.prototype.click = function () {}; });
await ev(() => window.__ds.actions.loadProject());
await wait(600);
const s57 = await settings();
check('57 save → reload → load: physiology (clothing, water intake, zone) and the extended model survive', s57.physiology?.clothing === 'protective' && s57.physiology?.waterIntake === 0.25 && s57.physiology?.zones?.[0]?.airTemperature === 5 + K && s57.humans?.model === 'extended', s57.physiology);
const rt58 = await ev(() => { const ds = window.__ds; const r = ds.buildLib.parseDocument(ds.buildLib.serializeDocument(ds.world.getState().doc)); return r.ok ? r.doc.settings.simulation.physiology : 'fail'; });
check('58 serialization round trip of the physiology setting (schema validated)', rt58?.clothing === 'protective' && rt58?.zones?.length === 1, rt58);
await enterRun();
await atTime(20);
await select(0);
const before59 = await text('[data-testid="physio-object"]');
const other = lang === 'ko' ? 'en' : 'ko';
await ev((l) => window.__ds.locale.getState().setLocale(l), other);
await wait(400);
const after59 = await text('[data-testid="physio-object"]');
const raw59 = await rawKeys();
await ev((l) => window.__ds.locale.getState().setLocale(l), lang);
await wait(400);
const back59 = await text('[data-testid="physio-object"]');
check('59 language switch: the physiology inspector re-renders in the other language without raw keys, and back', before59 !== after59 && raw59.length === 0 && back59 === before59, { raw59, a: after59.slice(0, 80) });
await exitSim();

// ══ 60–62: presets ════════════════════════════════════════════════════════════════════════
const pre60 = await ev(() => window.__ds.physioLib.presets.map((p) => { const ok = window.__ds.physioLib.loadPreset(p.id); const s = window.__ds.world.getState().doc.settings.simulation; const name = window.__ds.tr(p.keys.name); return { id: p.id, ok: ok && s.physiology?.model === 'reduced' && s.humans?.model === 'extended' && Object.values(window.__ds.world.getState().doc.objects).some((o) => o.type === 'human'), name }; }));
check('60 presets: 24 physiology presets, each builds a world with the extended model, physiology and people', pre60.length === 24 && pre60.every((p) => p.ok), pre60.filter((p) => !p.ok).map((p) => p.id));
check('61 preset names translated (no raw physioPresets.* key)', pre60.every((p) => p.name && !/^physioPresets\./.test(p.name)), pre60.filter((p) => /^physioPresets\./.test(p.name)).map((p) => p.id).slice(0, 6));
await ev(() => window.__ds.physioLib.loadPreset('coldWaterFull'));
await wait(500);
await enterRun();
await atTime(120);
const r62 = await rows();
check('62 preset "cold water (full)" run 120 s: people immersed (> 90 % of the body), airway under water, skin falls toward the 10 °C water, water temperature source = reference (assumed)', r62.length === 2 && r62.every((r) => r.immersed > 0.9 && r.airway === 'submerged' && r.skin < 30 && r.provenance.waterT === 'reference'), r62.map((r) => [r.skin, r.core, r.thermalState, r.immersed, r.provenance]));
await exitSim();
await ev(() => window.__ds.physioLib.loadPreset('fireRadiant'));
await wait(500);
await enterRun();
await atTime(120);
const r63 = await rows();
check('63 preset "fire radiant" (120 s): directed radiation at the people (radiant flux > 0) and a heat FED > 0', r63.some((r) => r.qFire > 0 && r.fedHeat > 0), r63.map((r) => [r.qFire, r.fedHeat, r.provenance.radiant]));
await scanRaw('presets');
await exitSim();

// ══ 64: combined hazard ═══════════════════════════════════════════════════════════════════
await newWorld();
await addObjects([...PEOPLE, { type: 'human', x: 6, z: 4, seed: 9 }]);
await setPhysio({ model: 'reduced', zones: [zone({ airTemperature: 2 + K, co: 0.004, smoke: 0.0005, water: { level: 0.6, temperature: 8 + K } })] });
await add('wind', { event: 'wind', speed: 26, direction: 'S', duration: 30, gustStrength: 0.3, rampDuration: 2, startTime: 0 });
await add('earthquake', { event: 'earthquake', magnitude: 6.5, pga: 0.4, duration: 8, seed: 3, startTime: 1 });
await wait(300);
await enterRun();
await atTime(30);
const j64 = await ev(() => window.__ds.physioLib.json());
const fin64 = await ev(() => [...window.__ds.sim.getRuntime().entities.values()].every((e) => e.pose.position.every(Number.isFinite) && (!e.physio || (Number.isFinite(e.physio.s.Tc) && Number.isFinite(e.physio.s.Ts)))));
check('64 combined hazard (cold water + CO + smoke + wind + earthquake): everything finite, export valid with doses and immersion', fin64 && j64?.people?.length === 3 && j64.people.every((p) => p.coDose > 0 && p.immersed > 0), j64?.people?.map((p) => [p.coDose, p.immersed]));
await exitSim();

// ══ 65–66: legacy (no physiology) ═════════════════════════════════════════════════════════
await newWorld();
await addObjects(PEOPLE);
await ev(() => window.__ds.world.getState().updateSimulationSettings({ humans: { model: 'extended' } }));
await enterRun();
await atTime(5);
await ev(() => window.__ds.editor.getState().select([...window.__ds.sim.getRuntime().entities.values()].find((e) => e.human).id));
await wait(400);
const hasSec = await ev(() => !!document.querySelector('[data-testid="physio-object"]'));
const hasHuman = await ev(() => !!document.querySelector('[data-testid="human-object"]'));
const ov65 = await ev((l) => [...document.querySelectorAll('label')].some((x) => (x.textContent ?? '').trim() === l), ovLabel);
await ev(() => window.__ds.ui.getState().setResultsOpen(true));
await wait(700);
const res65 = await ev(() => !!document.querySelector('[data-testid="physio-results"]'));
await clickText(/^\s*JSON\s*$/, '[role="dialog"]');
await wait(300);
const j65 = JSON.parse((await lastBlob()) || '{}');
await ev(() => window.__ds.ui.getState().setResultsOpen(false));
check('65 extended model without physiology: no physiology section / overlay toggle / results block; the human section works', !hasSec && hasHuman && !ov65 && !res65, { hasSec, hasHuman, ov65, res65 });
check('66 export without physiology: no physiology block, the humans block unchanged; physioLib empty', j65.physiology === undefined && j65.humans?.model === 'extended' && (await ev(() => window.__ds.physioLib.json())) === null && (await ev(() => window.__ds.physioLib.snapshot())) === null, { p: j65.physiology, h: j65.humans?.model });
await exitSim();

// ══ Whole run ════════════════════════════════════════════════════════════════════════════
check('67 no raw i18n keys of the physiology visible anywhere checked', rawSeen.length === 0, rawSeen);
check('68 no "NaN" / "Infinity" / "undefined" text shown (calm, results)', nanSeen.length === 0, nanSeen);
await newWorld();
await wait(800);
const geo1 = (await glInfo()).geometries;
check('69 resources: GPU geometries back to the start after all runs', geo1 <= geo0 + 2, { geo0, geo1 });
const mem = await ev(() => { if (window.gc) window.gc(); return performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : -1; });
check('70 whole run: no page / console errors, the tab alive', errors.length === 0 && !crashed, { errors: errors.length, heapMB: mem });
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; ${errors.length} page errors; geometries ${geo0} → ${geo1}; heap ${mem} MB; crashed ${crashed}`);
if (errors.length) console.log(errors.slice(0, 10).join('\n'));
fs.writeFileSync(path.join(out, `results-${lang}.json`), JSON.stringify({ lang, url, results, errors, geometries: [geo0, geo1], heapMB: mem, crashed }, null, 2));
await browser.close();
process.exit(results.every((r) => r.ok) && errors.length === 0 && !crashed ? 0 : 1);
