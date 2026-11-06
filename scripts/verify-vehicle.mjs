// Browser verification of the vehicle dynamics (Phase 35, spec §60–66, §79, §83): scenarios in real Chrome through the UI and the
// dev hooks.
// - Settings: the vehicle-dynamics switch, tyre model, ABS, sub-steps, and the vehicle state they create.
// - A parked car: inspector values (mass, COM, Σ F_z = m g, compression, gear, damage, rollover / LTR, occupants, driver,
//   energy ledger), the seated occupant hidden with a seat marker, the rigid Level 1 car.
// - Live control: UI slider, throttle / brake / steer / parking brake / reverse, keyboard keydown / keyup / blur, the paused-input
//   policy, the autopilot.
// - The wheel layer (spin, steer, compression drawn from the state); the debug overlay with its legend and GPU resources.
// - Scenarios: a crash into a wall (collision event, damage), the results block (cards, table, charts with gaps, vehicle CSV /
//   JSON with schema and units, damage-events CSV columns), a flood stall, a rollover under lateral gravity, the passive objects.
// - Presets (or a devtools scene fallback), reset / restart / scene switch cleanup, the language switch, a legacy world.
// - Whole-run checks: raw i18n keys, NaN shown, page / console errors, GPU geometries.
//
//   npx vite build && npx vite preview --port 4199 --strictPort &
//   LANG_UI=ko node scripts/verify-vehicle.mjs http://localhost:4199/ ./docs/verify/vehicle
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:4199/', out = './docs/verify/vehicle'] = process.argv.slice(2);
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
const has = (sel) => ev((sel) => !!document.querySelector(sel), sel);
const glInfo = () => ev(() => { const g = window.__r3f.get().gl.info; return { geometries: g.memory.geometries, textures: g.memory.textures }; });
async function view(x, z, h = 6, back = 9) {
  await ev(([x, z, h, back]) => { const st = window.__r3f.get(); st.camera.position.set(x + back * 0.5, h, z + back); st.controls.target.set(x, 1, z); st.controls.update(); }, [x, z, h, back]);
  await wait(300);
}
const inst = () => ev(() => window.__ds.world.getState().doc.scenario.experiment?.instances ?? []);
const vset = () => ev(() => window.__ds.world.getState().doc.settings.simulation.vehicles ?? null);
const row = (id) => ev((id) => window.__ds.vehicleLib.row(id), id);
const raw = (id) => ev((id) => window.__ds.vehicleLib.inspect(id), id);
const setLive = (id, input) => ev(([id, input]) => window.__ds.vehicleLib.setLive(id, input), [id, input]);
const vehEvents = (type) => ev((type) => window.__ds.simStore.getState().damageEvents.filter((e) => e.vehicle && (!type || e.eventType === type)).map((e) => ({ t: e.time, id: e.objectId, type: e.eventType, ...e.vehicle })), type);
async function newWorld() {
  await ev(() => { window.__ds.actions.newProject(); window.__ds.view.getState().setVehicleViz({ enabled: false, contacts: true, normals: true, tyre: true, suspension: true, com: true, velocity: true, slip: true, ltr: true, impulse: true }); });
  await wait(300);
}
const addObjects = (list) => ev((list) => {
  window.__ds.world.getState().applyEdit({ add: list.map((o) => ({ type: o.type, seed: o.seed ?? 1, params: o.params, transform: { position: [o.x, o.y ?? 0, o.z], rotation: [0, o.yaw ?? 0, 0], scale: [1, 1, 1] } })) });
}, list);
/** Object of the scene builder (vehicleLib.loadScene): type at (x, z), yaw. */
const O = (type, x, z, seed = 1, yaw = 0) => ({ type, seed, transform: { position: [x, 0, z], rotation: [0, yaw, 0], scale: [1, 1, 1] } });
const scene = (sc) => ev((sc) => window.__ds.vehicleLib.loadScene(sc), sc);
async function enterRun() {
  if ((await inst()).length) await clickText(/^\s*실험 실행|Run experiment/);
  else await ev(() => window.__ds.actions.enterSimulation());
  await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status !== 'loading', { timeout: 180_000 });
}
const atTime = async (T) => { const t = await ev((T) => { const s = window.__ds.sim; s.pause(); const r = T - s.getTime(); if (r > 0) s.advance(r); return s.getTime(); }, T); await wait(400); return t; };
const step = async (dt) => { await ev((dt) => { const s = window.__ds.sim; s.pause(); s.advance(dt); }, dt); await wait(250); };
const exitSim = async () => { await ev(() => window.__ds.actions.exitSimulation()); await wait(500); };
const select = async (id) => { await ev((id) => window.__ds.editor.getState().select(id), id); await wait(400); };
const openSub = async (labelKey, hostSel = '[data-testid="vehicle-object"]') => { const r = await ev(([label, hostSel]) => { const host = document.querySelector(hostSel)?.parentElement; for (const b of host?.querySelectorAll('button') ?? []) if ((b.textContent ?? '').includes(label)) { if (b.getAttribute('aria-expanded') !== 'true') b.click(); return true; } return false; }, [await tr(labelKey), hostSel]); await wait(300); return r; };
const overlaySwitch = (label) => ev((label) => {
  for (const l of document.querySelectorAll('label')) if ((l.textContent ?? '').trim() === label) { const s = l.querySelector('[role="switch"]'); if (s) { s.click(); return true; } }
  return false;
}, label);
/** The vehicle layer: instance counts of the wheel group (tyres, spokes, seat markers) and of the debug group (markers, line vertices). */
const layer = () => ev(() => {
  const sc = window.__r3f.get().scene;
  const w = sc.getObjectByName('vehicle-wheels'), d = sc.getObjectByName('vehicle-debug');
  return {
    found: !!sc.getObjectByName('vehicle-layer'),
    tyres: w?.children[0]?.count ?? 0, spokes: w?.children[1]?.count ?? 0, seats: w?.children[2]?.count ?? 0,
    debug: !!d, marks: d?.children[0]?.count ?? 0, lines: d?.children[1]?.geometry?.drawRange.count ?? 0,
  };
});
const tyres = () => ev(() => window.__ds.vehicleLib.tyres());
const unit = (m, c) => { const v = [m[4 * c], m[4 * c + 1], m[4 * c + 2]]; const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
const setRange = (sel, value) => ev(([sel, value]) => { const s = document.querySelector(sel); if (!s) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(s, String(value)); s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); return true; }, [sel, value]);
const setSelect = (sel, value) => ev(([sel, value]) => { const s = document.querySelector(sel); if (!s) return false; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, value); s.dispatchEvent(new Event('change', { bubbles: true })); return true; }, [sel, value]);
const blurAll = () => ev(() => { document.activeElement?.blur?.(); });
const rawKeys = () => ev(() => (document.body.innerText.match(/\b(vehicleUi|vehiclePresets|vehicle|evt\.VEHICLE|evt\.OCCUPANT)[._][a-zA-Z_]+(\.[a-zA-Z_]+)*/g) ?? []).filter((k) => !/^vehicle[._](csv|json)$/.test(k)).slice(0, 8));
const rawSeen = [];
const scanRaw = async (where) => { const r = await rawKeys(); if (r.length) rawSeen.push({ where, r }); };
const nanSeen = [];
const scanNaN = async (where) => { const n = await ev(() => /\bNaN\b|\bInfinity\b|undefined/.test(document.body.innerText)); if (n) nanSeen.push(where); };
await ev(() => { window.__blobs = []; const o = URL.createObjectURL.bind(URL); URL.createObjectURL = (b) => { window.__blobs.push(b); return o(b); }; HTMLAnchorElement.prototype.click = function () {}; });
const lastBlob = () => ev(async () => (window.__blobs.length ? await window.__blobs[window.__blobs.length - 1].text() : ''));
const G = 9.80665;
const nc = await tr('vehicleUi.notComputed');
const geo0 = (await glInfo()).geometries;
const lateralGravity = (th, startTime) => ({ event: 'gravity', scenario: 'custom', global: true, magnitude: G, direction: [0, -Math.cos(th), Math.sin(th)], transition: 'vector', profile: 'constant', duration: 600, end: 'hold', sources: [], startTime });

// ══ 1–8: settings (editor), placing / selecting a car ══════════════════════════════════════
await newWorld();
await addObjects([{ type: 'car', x: 0, z: 0, seed: 1 }]);
const carId1 = await ev(() => Object.values(window.__ds.world.getState().doc.objects).find((o) => o.type === 'car')?.id ?? null);
await select(carId1);
const sel1 = await ev(() => window.__ds.editor.getState().selectedId);
check('1 a car is placed in the editor and selected (document object, editor selection)', !!carId1 && sel1 === carId1, { carId1, sel1 });
await select(null);
await clickText(new RegExp('^\\s*▸?\\s*' + esc(await tr('settings.title'))));
await wait(300);
const sw = '[data-testid="vehicle-settings"] [role="switch"]';
const v2a = await vset();
const has2 = await has(sw);
await ev((s) => document.querySelector(s).click(), sw);
await wait(300);
const v2b = await vset();
await shot('02-settings');
check('2 settings: the vehicle-dynamics switch writes vehicles = { model: dynamics } (absent before)', has2 && v2a === null && v2b?.model === 'dynamics', { v2a, v2b });
const nSel3 = await ev(() => document.querySelectorAll('[data-testid="vehicle-settings"] select').length);
await setSelect('[data-testid="vehicle-settings"] select', 'linear');
await wait(300);
check('3 tyre model select stores tire = linear', nSel3 === 1 && (await vset())?.tire === 'linear', await vset());
await ev(() => document.querySelectorAll('[data-testid="vehicle-settings"] [role="switch"]')[1].click());
await wait(300);
check('4 ABS default toggle stores abs = false', (await vset())?.abs === false, await vset());
await ev(() => { const i = document.querySelector('[data-testid="vehicle-settings"] input'); i.id = '__sub'; });
await page.click('#__sub', { clickCount: 3 });
await page.keyboard.press('Backspace');
await page.type('#__sub', '12');
await page.keyboard.press('Enter');
await wait(300);
check('5 sub-steps field stores substeps = 12 (integer, 1–32)', (await vset())?.substeps === 12, await vset());
const rt6 = await ev(() => { const ds = window.__ds; const r = ds.buildLib.parseDocument(ds.buildLib.serializeDocument(ds.world.getState().doc)); return r.ok ? r.doc.settings.simulation.vehicles : 'fail'; });
check('6 serialization round trip of the vehicle settings (schema validated)', rt6?.model === 'dynamics' && rt6.tire === 'linear' && rt6.abs === false && rt6.substeps === 12, rt6);
await enterRun();
await atTime(1);
const c7 = await ev(() => ({ rt: !!window.__ds.sim.getRuntime().vehicles, cars: window.__ds.vehicleLib.cars().map((r) => ({ level: r.level, tire: r.tire, abs: r.abs })) }));
check('7 the switch creates the vehicle state: runtime.vehicles, the car a wheeled vehicle with the chosen tyre model and ABS', c7.rt && c7.cars.length === 1 && c7.cars[0].level === 'vehicle' && c7.cars[0].tire === 'linear' && c7.cars[0].abs === false, c7);
await exitSim();
await clickText(new RegExp('^\\s*▸?\\s*' + esc(await tr('settings.title'))));
await wait(200);
if (!(await has(sw))) { await clickText(new RegExp('^\\s*▸?\\s*' + esc(await tr('settings.title')))); await wait(200); }
await ev((s) => document.querySelector(s)?.click(), sw);
await wait(300);
const v8 = await vset();
await enterRun();
await atTime(1);
const c8 = await ev(() => ({ rt: window.__ds.sim.getRuntime().vehicles ?? null, veh: [...window.__ds.sim.getRuntime().entities.values()].filter((e) => e.vehicle).length }));
check('8 switching it off removes the setting; the run has no vehicle state (legacy rigid car)', v8 === null && c8.rt === null && c8.veh === 0, { v8, c8 });
await exitSim();

// ══ 9–22: parked car, inspector, occupants, rigid car ═════════════════════════════════════
// Objects: 0 wheeled car (driver = person 2, restrained), 1 rigid car, 2 person.
const ids9 = await scene({ objects: [O('car', 0, 0, 1), O('car', 0, 12, 2), O('human', 5, 5, 3)], vehicles: { model: 'dynamics', cars: { 0: { occupants: [{ human: 2, seat: 'driver', restrained: true }] }, 1: { level: 'rigid' } } } });
const [carA, carR, person] = ids9;
await enterRun();
await atTime(5);
await select(carA);
await view(0, 0, 4, 8);
const r9 = await row(carA);
const insp9 = await text('[data-testid="vehicle-object"]');
await shot('09-parked');
check('9 inspector section of the selected car (title, model: wheeled vehicle · sedan)', insp9.includes(await tr('vehicleUi.level.vehicle')) && insp9.includes(await tr('vehicleUi.variant.sedan')), insp9.slice(0, 120));
check('10 inspector mass = the car mass (kg), COM line in m', r9.mass > 500 && insp9.includes(`${r9.mass.toFixed(0)} kg`) && insp9.includes(`x ${r9.com[0].toFixed(2)}`), { mass: r9.mass, com: r9.com });
const fz = r9.wheels.reduce((a, w) => a + w.Fz, 0);
check('11 parked on flat ground: Σ F_z = m g within 2 %', Math.abs(fz - r9.mass * G) / (r9.mass * G) < 0.02, { fz, mg: r9.mass * G });
const s12 = await ev((id) => { const v = window.__ds.sim.getRuntime().entities.get(id).vehicle; return v.geo.staticCompression; }, carA);
check('12 every wheel in contact and compressed near its static compression (±35 %); wheels table has 4 rows', r9.wheels.every((w, i) => w.contact && Math.abs(w.compression - s12[i]) < 0.35 * s12[i]) && (await ev(() => document.querySelectorAll('[data-testid="vehicle-wheels"] tbody tr').length)) === 4, r9.wheels.map((w, i) => [w.compression, s12[i]]));
check('13 parked: gear P from the settings, parking brake on, input source "parked" translated', r9.gearSelector === 'P' && r9.handbrake && insp9.includes(await tr('vehicleUi.src.parked')), { g: r9.gearSelector, src: r9.controlSource });
check('14 damage "intact" (index 0), rollover "upright", LTR < 0.1', r9.damageLevel === 'intact' && r9.damageIndex === 0 && r9.rollover === 'upright' && r9.ltr < 0.1 && insp9.includes(await tr('vehicleUi.damage.intact')) && insp9.includes(await tr('vehicleUi.roll.upright')), { d: r9.damageLevel, ltr: r9.ltr });
const occ15 = await text('[data-testid="vehicle-occupants"]');
const he15 = await ev((id) => window.__ds.sim.getRuntime().entities.get(id).occupant ?? null, person);
check('15 occupant: the person sits in the driver seat (seated, belted) — inspector and runtime', r9.occupantsSeated === 1 && he15?.vehicle === carA && occ15.includes(await tr('vehicleUi.seat.driver')) && occ15.includes(await tr('vehicleUi.occ.seated')), { occ15: occ15.slice(0, 80), he15 });
check('16 driver availability 100 % with no limiting cause (healthy seated driver)', r9.availDriver === 1 && r9.driverCause === null && insp9.includes(await tr('vehicleUi.inspect.driver')), { a: r9.availDriver, c: r9.driverCause });
const L17 = await layer();
const drawn17 = await ev((id) => window.__ds.vehicleLib.drawnScales(id), person);
check('17 the seated person is not drawn standing (all instances scale 0); one seat marker in the vehicle layer', Array.isArray(drawn17) && drawn17.length > 0 && drawn17.every((s) => s < 1e-6) && L17.seats === 1, { drawn17, L17 });
check('18 wheel layer: 4 tyres + 8 spoke bars for the one wheeled car (the rigid car draws none)', L17.found && L17.tyres === 4 && L17.spokes === 8, L17);
await openSub('vehicleUi.inspect.energy');
const en19 = await text('[data-testid="vehicle-energy"]');
check('19 energy ledger: E, E0, ledger entries and residual computed (kJ shown), residual small when parked (< 5 % of |E0| + 2 kJ)', r9.E !== null && r9.E0 !== null && r9.residual !== null && Math.abs(r9.residual) < 0.05 * Math.abs(r9.E0) + 2000 && en19.includes('kJ') && en19.includes(await tr('vehicleUi.energy.residual')), { E: r9.E, E0: r9.E0, res: r9.residual });
check('20 limitation and model-level lines in the inspector', (await text('[data-testid="vehicle-limitation"]')) === (await tr('vehicleUi.limitation')) && (await has('[data-testid="vehicle-levels"]')), '');
await select(carR);
const insp21 = await text('[data-testid="vehicle-object"]');
const r21 = await row(carR);
check('21 rigid car: "rigid vehicle" model, no wheels table, wheels / gear / LTR not computed (null)', insp21.includes(await tr('vehicleUi.level.rigid')) && insp21.includes(await tr('vehicleUi.inspect.rigidNote')) && !(await has('[data-testid="vehicle-wheels"]')) && r21.wheels === null && r21.gear === null && r21.ltr === null, { w: r21.wheels, g: r21.gear });
check('22 the rigid car has no live control section (only wheeled cars are drivable)', !(await has('[data-testid="vehicle-control"]')), '');
await scanRaw('parked');
await scanNaN('parked');
await exitSim();

// ══ 23–41: live control, wheel layer, keyboard ════════════════════════════════════════════
const [car1] = await scene({ objects: [O('car', 0, 0, 1)], vehicles: { model: 'dynamics' }, extended: false });
await enterRun();
await atTime(2);
await select(car1);
await view(0, 0, 5, 10);
const ctl = '[data-testid="vehicle-control"]';
await ev((c) => document.querySelector(`${c} [role="switch"]`).click(), ctl);
await wait(300);
const l23 = (await raw(car1)).live;
check('23 live control switch: live input created (pedals neutral), the parked car put in D with the parking brake off', l23 && l23.throttle === 0 && l23.brake === 0 && l23.gear === 'D' && l23.handbrake === false, l23);
await setRange(`${ctl} input[type="range"]`, 0.8);
await wait(200);
check('24 throttle slider (UI) writes live.throttle = 0.8', Math.abs(((await raw(car1)).live?.throttle ?? -1) - 0.8) < 1e-9, (await raw(car1)).live);
await atTime(7);
const r25 = await row(car1);
check('25 throttle → the car accelerates forward (> 3 m/s after 5 s), engine speed and gear computed', r25.speed > 3 && r25.engineRpm > 0 && r25.gear >= 1 && r25.controlSource === 'live', { v: r25.speed, rpm: r25.engineRpm, g: r25.gear });
const insp26 = await text('[data-testid="vehicle-object"]');
check('26 inspector follows the motion: speed in m/s and km/h, drive torque > 0', insp26.includes('km/h') && r25.driveTorque > 0, insp26.slice(0, 80));
const ty1 = await tyres();
await step(0.37);
const ty2 = await tyres();
const spinA = ty1.length && ty2.length ? angle(unit(ty1[0], 0), unit(ty2[0], 0)) : 0;
check('27 wheel layer: the drawn wheel turns as the car rolls (spin angle changes between frames)', ty1.length === 4 && spinA > 0.05, { spinA, n: ty1.length });
const pos28 = await ev((id) => {
  const e = window.__ds.sim.getRuntime().entities.get(id), v = e.vehicle, g = v.geo, q = e.pose.quaternion, p = e.pose.position, W = v.dyn.wheels[0];
  const rot = (a) => { const [x, y, z, w] = q; const tx = 2 * (y * a[2] - z * a[1]), ty = 2 * (z * a[0] - x * a[2]), tz = 2 * (x * a[1] - y * a[0]); return [a[0] + w * tx + (y * tz - z * ty), a[1] + w * ty + (z * tx - x * tz), a[2] + w * tz + (x * ty - y * tx)]; };
  const loc = [g.mounts[0][0], g.mounts[0][1] - (g.freeLength[0] - Math.min(W.compression, g.freeLength[0])), g.mounts[0][2]];
  const r = rot(loc);
  return { expected: [p[0] + r[0], p[1] + r[1], p[2] + r[2]], compression: W.compression };
}, car1);
const ty28 = await tyres();
const d28 = ty28.length ? Math.hypot(ty28[0][12] - pos28.expected[0], ty28[0][13] - pos28.expected[1], ty28[0][14] - pos28.expected[2]) : 99;
check('28 wheel centre drawn at mount − (free length − compression) along body up (≤ 2 cm)', d28 < 0.02 && pos28.compression > 0, { d28, c: pos28.compression });
await setLive(car1, { throttle: 0.4, steer: 1 });
await step(3);
const r29 = await row(car1);
const ty29 = await tyres();
const steerDrawn = ty29.length ? angle(unit(ty29[0], 2), unit(ty29[2], 2)) : 0;
check('29 steer +1 (left) → positive yaw rate (turns left, about +Y)', r29.yawRate > 0.05, r29.yawRate);
check('30 steer angle drawn: front-left vs rear-left axle angle ≈ |road-wheel angle| (± 0.05 rad)', Math.abs(steerDrawn - Math.abs(r29.wheels[0].steer)) < 0.05 && Math.abs(r29.wheels[0].steer) > 0.05, { steerDrawn, steer: r29.wheels[0].steer });
await setLive(car1, { steer: -1 });
await step(3);
const r31 = await row(car1);
check('31 steer −1 (right) → negative yaw rate', r31.yawRate < -0.05, r31.yawRate);
await setLive(car1, { steer: 0, throttle: 0, brake: 1 });
await step(6);
const r32 = await row(car1);
check('32 brake 1 → the car stops (|v| < 0.3 m/s within 6 s), brake torque applied', Math.abs(r32.speed) < 0.3 && r32.brakeTorque > 0, { v: r32.speed, b: r32.brakeTorque });
await setLive(car1, { brake: 0, gear: 'R', throttle: 0.5 });
await step(4);
const r33 = await row(car1);
check('33 gear R + throttle → the car moves backwards (v < −0.5 m/s)', r33.speed < -0.5 && r33.gearSelector === 'R', { v: r33.speed, g: r33.gearSelector });
await setLive(car1, { gear: 'D', throttle: 0.6 });
await step(5);
const v34a = (await row(car1)).speed;
await setLive(car1, { throttle: 0, handbrake: true });
await step(1);
const r34 = await row(car1);
check('34 parking brake while moving: rear wheels held (locked or stopped), the car slows', r34.handbrake && r34.wheels.slice(2).every((w) => w.locked || Math.abs(w.omega) < 0.5) && r34.speed < v34a, { v0: v34a, v: r34.speed, w: r34.wheels.slice(2).map((w) => [w.locked, w.omega]) });
await setLive(car1, { handbrake: false, brake: 1 });
await step(4);
await setLive(car1, { brake: 0, throttle: 0, steer: 0 });
await blurAll();
await page.keyboard.down('KeyW');
await wait(150);
const k35 = await raw(car1);
await step(0.1);
const k35b = await raw(car1);
check('35 keyboard W while paused: live.throttle = 1 stored, effective throttle unchanged until the next step, then 1 (paused-input policy)', k35.live.throttle === 1 && k35.controls.throttle === 0 && k35b.controls.throttle === 1, { live: k35.live.throttle, eff: k35.controls.throttle, after: k35b.controls.throttle });
await page.keyboard.up('KeyW');
await wait(150);
check('36 keyup W releases the throttle (live.throttle = 0)', (await raw(car1)).live.throttle === 0, (await raw(car1)).live);
await page.keyboard.down('KeyA');
await wait(100);
const k37a = (await raw(car1)).live.steer;
await page.keyboard.down('ArrowRight');
await wait(100);
const k37b = (await raw(car1)).live.steer;
await page.keyboard.up('KeyA');
await page.keyboard.up('ArrowRight');
await wait(100);
check('37 A → steer +1, A + → together → 0 (cancel), both released → 0', k37a === 1 && k37b === 0 && (await raw(car1)).live.steer === 0, { k37a, k37b });
await page.keyboard.down('KeyS');
await wait(100);
const k38a = (await raw(car1)).live.brake;
await ev(() => window.dispatchEvent(new Event('blur')));
await wait(150);
const k38b = (await raw(car1)).live.brake;
await page.keyboard.up('KeyS');
check('38 window blur releases a held key (brake 1 → 0) — no stuck keys', k38a === 1 && k38b === 0, { k38a, k38b });
await page.keyboard.down('KeyX');
await wait(100);
const k39a = (await raw(car1)).live.handbrake;
await page.keyboard.up('KeyX');
await wait(100);
await page.keyboard.press('Digit2');
await wait(100);
const k39g = (await raw(car1)).live.gear;
await page.keyboard.press('Digit4');
await wait(100);
check('39 X holds the parking brake (released on keyup); 2 → gear R, 4 → gear D', k39a === true && (await raw(car1)).live.handbrake === false && k39g === 'R' && (await raw(car1)).live.gear === 'D', { k39a, k39g });
await ev(() => document.querySelector('[data-testid="vehicle-neutral"]')?.click());
await wait(200);
const l40 = (await raw(car1)).live;
check('40 neutral button: throttle / brake / steer 0', l40.throttle === 0 && l40.brake === 0 && l40.steer === 0, l40);
await ev((c) => document.querySelector(`${c} [role="switch"]`).click(), ctl);
await wait(200);
await blurAll();
await page.keyboard.down('KeyW');
await wait(100);
const l41 = (await raw(car1)).live;
await page.keyboard.up('KeyW');
const st41a = await ev(() => window.__ds.simStore.getState().status);
await page.keyboard.press('Space');
await wait(300);
const st41b = await ev(() => window.__ds.simStore.getState().status);
await ev(() => window.__ds.sim.pause());
check('41 live control off: keys do nothing (live stays null); Space still toggles play / pause', l41 === null && st41a === 'paused' && st41b === 'running', { l41, st41a, st41b });
await scanRaw('controls');

// ══ 42–46: autopilot ═════════════════════════════════════════════════════════════════════
const p42 = await ev((id) => [...window.__ds.sim.getRuntime().entities.get(id).pose.position], car1);
const tgt = { x: p42[0] + 30, z: p42[2], speed: 6 };
const ok42 = await ev(([id, t]) => window.__ds.vehicleLib.startAutopilot(id, t), [car1, tgt]);
await wait(200);
const r42 = await row(car1);
check('42 autopilot to a typed point starts (inputs only): source "autopilot", 2 path points, inspector line', ok42 && r42.controlSource === 'autopilot' && r42.autopilot?.points === 2 && (await text('[data-testid="vehicle-object"]')).includes(await tr('vehicleUi.inspect.autopilot')), r42.autopilot);
await step(40);
const r43 = await row(car1);
const d43 = Math.hypot(r43.position[0] - tgt.x, r43.position[2] - tgt.z);
check('43 the autopilot drives to the point and stops there (≤ 6 m, |v| < 1 m/s, done)', d43 < 6 && Math.abs(r43.speed) < 1 && r43.autopilot?.done === true, { d43, v: r43.speed, ap: r43.autopilot });
check('44 stop autopilot removes it (source no longer autopilot)', (await ev((id) => window.__ds.vehicleLib.stopAutopilot(id), car1)) && (await row(car1)).autopilot === null, '');
await ev(([id, t]) => window.__ds.vehicleLib.startAutopilot(id, t), [car1, { x: p42[0], z: p42[2], speed: 5 }]);
await ev((id) => window.__ds.vehicleLib.enableLive(id), car1);
await wait(200);
const r45 = await row(car1);
check('45 live control suspends the autopilot (source live, autopilot kept for later)', r45.controlSource === 'live' && r45.autopilot !== null, { src: r45.controlSource });
await ev((id) => { window.__ds.vehicleLib.clearLive(id); window.__ds.vehicleLib.stopAutopilot(id); }, car1);
await wait(300);
await openSub('vehicleUi.ap.title', ctl);
const go46 = await has('[data-testid="vehicle-ap-go"]');
await ev(() => document.querySelector('[data-testid="vehicle-ap-go"]')?.click());
await wait(300);
check('46 autopilot UI: "drive to this point" button starts an autopilot from the target fields', go46 && (await row(car1)).autopilot?.points === 2, '');
await ev((id) => { window.__ds.vehicleLib.stopAutopilot(id); window.__ds.vehicleLib.enableLive(id); window.__ds.vehicleLib.setLive(id, { throttle: 0.4, steer: 0.3 }); }, car1);
await step(2);
const pos47 = (await row(car1)).position;

// ══ 47–52: debug overlay ═════════════════════════════════════════════════════════════════
await view(p42[0] + 15, p42[2], 5, 10);
const ovLabel = await tr('vehicleUi.overlay');
const geo47 = (await glInfo()).geometries;
const ok47 = await overlaySwitch(ovLabel);
await wait(700);
const L48 = await layer();
await shot('48-overlay');
check('47 overlay toggle present in the view options and switches the debug overlay on', ok47 && L48.debug, L48);
check('48 debug overlay (car under throttle): contact points + COM (≥ 5 markers) and normal / suspension / tyre / velocity lines (≥ 13)', L48.marks >= 5 && L48.lines >= 2 * 13, L48);
const leg49 = await text('[data-testid="vehicle-legend"]');
check('49 legend with units: kN for forces, m/s for velocity, kN·s for the impulse, slip colours, LTR scale', ['kN', 'm/s', 'kN·s', await tr('vehicleUi.legend.sliding'), await tr('vehicleUi.legend.grip')].every((s) => leg49.includes(s)), leg49.slice(0, 160));
await overlaySwitch(await tr('vehicleUi.overlay.tyre'));
await wait(400);
const L50 = await layer();
check('50 sub-toggle "tyre forces" off → fewer lines drawn', L50.lines < L48.lines, { before: L48.lines, after: L50.lines });
await overlaySwitch(ovLabel);
await wait(800);
const L51 = await layer();
const geo51 = (await glInfo()).geometries;
check('51 overlay off → debug group unmounted, its GPU geometries released (count back to before)', !L51.debug && geo51 <= geo47, { geo47, geo51 });
check('52 render-only: toggling the overlay while paused changes no simulation state (same position)', JSON.stringify((await row(car1)).position) === JSON.stringify(pos47), { pos47 });
await scanRaw('overlay');
await exitSim();

// ══ 53–57: crash into a wall ═════════════════════════════════════════════════════════════
// Objects: 0 car driving (throttle 1) toward 1 wall at x = 26, 2 rigid parked car (results gaps), 3 belted driver.
const ids53 = await scene({ objects: [O('car', 0, 0, 1), O('wall', 26, 0, 4, Math.PI / 2), O('car', 0, 20, 2), O('human', 5, 10, 3)], vehicles: { model: 'dynamics', cars: { 0: { controls: { gear: 'D', throttle: 1 }, occupants: [{ human: 3, seat: 'driver', restrained: true }] }, 2: { level: 'rigid' } } } });
const [crashCar, , rigid2] = ids53;
await enterRun();
await atTime(9);
const e53 = (await vehEvents('VEHICLE_COLLISION')).filter((e) => e.id === crashCar);
check('53 crash: a VEHICLE_COLLISION event for the car (partner, Δv, impulse)', e53.length >= 1 && e53.some((e) => e.dv > 3 && e.impulse > 0), e53.slice(0, 2));
const r54 = await row(crashCar);
check('54 damage level raised (not intact), peak Δv > 3 m/s, collisions ≥ 1', r54.damageLevel !== 'intact' && r54.peakDv > 3 && r54.collisions >= 1, { d: r54.damageLevel, dv: r54.peakDv });
await select(crashCar);
await view(24, 0, 5, 10);
await shot('55-crash');
const insp55 = await text('[data-testid="vehicle-object"]');
check('55 inspector shows the damage level translated and the collision count', insp55.includes(await tr(`vehicleUi.damage.${r54.damageLevel}`)) && insp55.includes(await tr('vehicleUi.inspect.collisions')), r54.damageLevel);
const occ56 = await ev((id) => window.__ds.vehicleLib.inspect(id).occupants, crashCar);
check('56 belted occupant: still seated, Level A seat Δv recorded (> 0)', occ56.length === 1 && occ56[0].state === 'seated' && occ56[0].peakDv > 0, occ56);
check('57 the crash is attributed to the vehicle (hazard "vehicle")', e53.some((e) => e.kind === 'collision') && (await ev((id) => window.__ds.simStore.getState().damageEvents.some((e) => e.objectId === id && e.hazard === 'vehicle'), crashCar)), '');

// ══ 58–66: results block, CSV / JSON ═════════════════════════════════════════════════════
await select(rigid2);
await ev(() => window.__ds.ui.getState().setResultsOpen(true));
await wait(900);
const res58 = await text('[data-testid="vehicle-results"]');
const cards58 = await ev(() => document.querySelectorAll('[data-testid="vehicle-results"] [class*="card"]').length);
const tab58 = await ev(() => document.querySelectorAll('[data-testid="vehicle-table"] tbody tr').length);
await shot('58-results');
check('58 results block: ≥ 8 cards, table with both cars, limitation line', cards58 >= 8 && tab58 === 2 && res58.includes(await tr('vehicleUi.limitation')), { cards58, tab58 });
await setSelect('[data-testid="vehicle-chart-car"]', crashCar);
await wait(400);
const ch59 = await ev(() => ({ charts: document.querySelectorAll('[data-testid^="vehicle-chart-"]:not(select)').length, lines: document.querySelectorAll('[data-testid^="vehicle-chart-"] polyline').length, axis: [...document.querySelectorAll('[data-testid="vehicle-chart-speed"] div')].map((d) => d.textContent).join('|') }));
check('59 charts of the crash car: 9 charts with lines, time axis in s, unit m/s on the speed chart', ch59.charts >= 9 && ch59.lines >= 8 && /\d s/.test(ch59.axis) && ch59.axis.includes('m/s'), ch59);
await setSelect('[data-testid="vehicle-chart-car"]', rigid2);
await wait(400);
const g60 = await ev(() => ({ empty: document.querySelector('[data-testid="vehicle-chart-slip"]')?.getAttribute('data-empty'), txt: document.querySelector('[data-testid="vehicle-chart-slip"]')?.textContent ?? '', speedLines: document.querySelectorAll('[data-testid="vehicle-chart-speed"] polyline').length }));
check('60 not computed ≠ 0: the rigid car\'s slip chart is a gap ("not computed"), its speed chart is drawn', g60.empty === 'true' && g60.txt.includes(nc) && g60.speedLines >= 1, g60);
await ev(() => document.querySelector('[data-testid="vehicle-csv"]').click());
await wait(300);
const csv61 = (await lastBlob()).split('\n');
const hdr = csv61.find((l) => l.startsWith('time_s,vehicle_id'))?.split(',') ?? [];
const rowsCsv = csv61.slice(csv61.indexOf(hdr.join(',')) + 1, csv61.indexOf(hdr.join(',')) + 3).map((l) => l.split(','));
const rigidCsv = rowsCsv.find((r) => r[hdr.indexOf('vehicle_id')] === rigid2) ?? [];
check('61 vehicle CSV: schema v1, model vehicle-dynamics-1, units / notes / limits lines, columns incl. speed / wheels / damage / energy', csv61[0] === '# schema: disaster-sim.vehicles v1' && csv61[1].includes('vehicle-dynamics-1') && csv61.some((l) => l.startsWith('# units:')) && csv61.some((l) => l.startsWith('# limits:')) && ['speed_ms', 'accel_long_ms2', 'yaw_rate_rads', 'gear', 'engine_rpm', 'damage_level', 'rollover', 'ltr', 'residual_J', 'model_version'].every((c) => hdr.includes(c)), csv61.slice(0, 2));
check('62 CSV rows full width; the rigid car\'s gear / LTR / drive-work cells are empty (not computed), not 0', rowsCsv.length === 2 && rowsCsv.every((r) => r.length === hdr.length) && rigidCsv[hdr.indexOf('gear')] === '' && rigidCsv[hdr.indexOf('ltr')] === '' && rigidCsv[hdr.indexOf('drive_work_J')] === '', { n: rowsCsv.map((r) => r.length), h: hdr.length });
check('63 CSV sections: wheels, collision episodes, occupants, events, series', ['# wheels', '# collision episodes', '# occupants', '# events', '# series'].every((s) => csv61.some((l) => l.startsWith(s))), '');
await clickText(/^\s*JSON\s*$/, '[role="dialog"]');
await wait(300);
const j64 = JSON.parse((await lastBlob()) || '{}');
const jr = j64.vehicles?.vehicles?.find((v) => v.id === rigid2);
check('64 results JSON: vehicles block (schema 1, model version, units N / m/s, parameters, variants, limits); rigid car wheels null and slip series null', j64.vehicles?.schemaVersion === 1 && j64.vehicles.modelVersion === 'vehicle-dynamics-1' && j64.vehicles.units?.force === 'N' && j64.vehicles.parameters?.ckPerLoad && j64.vehicles.variants?.sedan && j64.vehicles.limits?.length > 3 && jr?.wheels === null && jr.series.slip.every((x) => x === null), { v: !!j64.vehicles, jr: jr?.wheels });
await clickText(/^\s*CSV\s*$/, '[role="dialog"]');
await wait(300);
const dcsv = (await lastBlob()).split('\n');
const dh = dcsv[0]?.split(',') ?? [];
const drow = dcsv.find((l) => l.includes('VEHICLE_COLLISION'))?.split(',') ?? [];
check('65 damage-events CSV keeps the human / physiology columns and appends the vehicle columns; the collision row has Δv', ['human_segment', 'physio_causes', 'vehicle_kind', 'vehicle_partner', 'vehicle_dv_ms', 'vehicle_impulse_Ns', 'vehicle_level'].every((c) => dh.includes(c)) && dh.indexOf('vehicle_kind') > dh.indexOf('physio_causes') && Number(drow[dh.indexOf('vehicle_dv_ms')]) > 0, dh.slice(-8));
await scanRaw('results');
await scanNaN('results');
await ev(() => window.__ds.ui.getState().setResultsOpen(false));
check('66 vehicleLib.csv / json equal the exported content (schema line, block)', (await ev(() => window.__ds.vehicleLib.csv().split('\n')[0])) === csv61[0] && (await ev(() => window.__ds.vehicleLib.json().schemaVersion)) === 1, '');
await exitSim();

// ══ 67–68: flood → engine stall ══════════════════════════════════════════════════════════
const [floodCar] = await scene({ objects: [O('car', 0, 95, 1)], shore: { z0: 85, k: 0.1, max: 4 }, vehicles: { model: 'dynamics', cars: { 0: { program: [{ t: 0, gear: 'D', throttle: 0 }] } } }, events: [{ event: 'risingWater', boundary: 'S', level: 2.0, riseRate: 30, duration: 600, startTime: 0 }], extended: false });
await enterRun();
await atTime(60);
const r67 = await row(floodCar);
const e67 = await vehEvents('VEHICLE_STALLED');
check('67 flood: water above the intake stalls the engine (stalled, VEHICLE_STALLED event, drive availability 0)', r67.stalled && e67.length >= 1 && r67.availDrive === 0, { stalled: r67.stalled, ev: e67.length, touching: r67.touching });
await select(floodCar);
await view(0, 95, 6, 12);
await shot('68-flood');
check('68 inspector shows "engine stalled (water)"', (await text('[data-testid="vehicle-object"]')).includes(await tr('vehicleUi.inspect.stalled')), '');
await exitSim();

// ══ 69–70: rollover under lateral gravity ════════════════════════════════════════════════
const [rollCar] = await scene({ objects: [O('car', 0, 0, 1)], vehicles: { model: 'dynamics', tire: 'linear', cars: { 0: { controls: { gear: 'P', handbrake: true, brake: 1 } } } }, extended: false });
await enterRun();
await atTime(1);
const th = await ev((id) => { const g = window.__ds.sim.getRuntime().entities.get(id).vehicle.geo; return Math.atan(g.track / (2 * g.hcg)); }, rollCar);
await ev((spec) => window.__ds.sim.addEvent(spec), lateralGravity(1.05 * th, 1.5));
await atTime(10);
const r69 = await row(rollCar);
const e69 = await vehEvents('VEHICLE_ROLLOVER');
check('69 lateral gravity beyond the static rollover angle atan(t / 2h): the car rolls over (on side / roof), VEHICLE_ROLLOVER event', ['onSide', 'onRoof'].includes(r69.rollover) && e69.length >= 1, { th, state: r69.rollover, ev: e69.length });
await select(rollCar);
await view(0, 0, 4, 9);
await shot('70-rollover');
check('70 inspector rollover state translated; peak LTR reached 1 (a side unloaded)', (await text('[data-testid="vehicle-object"]')).includes(await tr(`vehicleUi.roll.${r69.rollover}`)) && r69.peakLtr > 0.95, { peak: r69.peakLtr });
await exitSim();

// ══ 71–73: passive objects (Level 1) ═════════════════════════════════════════════════════
const ids71 = await scene({ objects: [O('crate', -4, 60, 1), O('barrel', 0, 60, 2), O('ball', 4, 60, 3)], shore: { z0: 85, k: 0.1, max: 4 }, extended: false });
const pass71 = await ev(() => Object.values(window.__ds.world.getState().doc.objects).map((o) => o.type));
check('71 crate, barrel and ball are placeable objects of the world', ['crate', 'barrel', 'ball'].every((t) => pass71.includes(t)), pass71);
await enterRun();
const p72 = await ev((ids) => ids.map((id) => [...window.__ds.sim.getRuntime().entities.get(id).pose.position]), ids71);
const dyn72 = await ev((ids) => ids.map((id) => { const e = window.__ds.sim.getRuntime().entities.get(id); return e.body !== null && e.dynamic; }), ids71);
await atTime(6);
const q72 = await ev((ids) => ids.map((id) => [...window.__ds.sim.getRuntime().entities.get(id).pose.position]), ids71);
const ballMoved = Math.hypot(q72[2][0] - p72[2][0], q72[2][2] - p72[2][2]);
check('72 the passive objects are dynamic rigid bodies with finite poses', dyn72.every(Boolean) && q72.flat().every(Number.isFinite), dyn72);
await view(4, 66, 5, 10);
await shot('73-passive');
check('73 the ball rolls down the 5.7° slope (> 1 m in 6 s, toward +z)', ballMoved > 1 && q72[2][2] > p72[2][2], { ballMoved });
await exitSim();

// ══ 74–75: presets (or the devtools scene fallback) ══════════════════════════════════════
const presets = await ev(() => (Array.isArray(window.__ds.vehicleLib.presets) && typeof window.__ds.vehicleLib.loadPreset === 'function' ? window.__ds.vehicleLib.presets.map((p) => ({ id: p.id, keys: p.keys ?? null })) : null));
if (presets && presets.length) {
  const pre74 = await ev(() => window.__ds.vehicleLib.presets.map((p) => { const ok = window.__ds.vehicleLib.loadPreset(p.id); const s = window.__ds.world.getState().doc.settings.simulation; const name = p.keys?.name ? window.__ds.tr(p.keys.name) : p.id; return { id: p.id, ok: ok !== false && s.vehicles?.model === 'dynamics' && Object.values(window.__ds.world.getState().doc.objects).some((o) => o.type === 'car'), name }; }));
  check('74 presets: ≥ 30 vehicle presets, each builds a world with vehicle dynamics and a car; names translated', pre74.length >= 30 && pre74.every((p) => p.ok && !/^vehiclePresets\./.test(p.name)), pre74.filter((p) => !p.ok || /^vehiclePresets\./.test(p.name)).map((p) => p.id));
  await ev((id) => window.__ds.vehicleLib.loadPreset(id), presets[0].id);
} else {
  // Fallback (no presets yet): the scene builder with a constant-throttle car — the same path the presets will take.
  const ids74 = await scene({ objects: [O('car', 0, 0, 1)], vehicles: { model: 'dynamics', cars: { 0: { controls: { gear: 'D', throttle: 0.3 } } } }, extended: false });
  check('74 presets not provided yet → devtools scene fallback builds a vehicle world (settings + car)', ids74.length === 1 && (await vset())?.model === 'dynamics', ids74);
}
await wait(400);
await enterRun();
await atTime(5);
const r75 = await ev(() => window.__ds.vehicleLib.cars());
check('75 preset / fallback run 5 s: vehicle rows finite (speed, energy), no NaN in the export', r75.length >= 1 && r75.every((r) => r.speed === null || Number.isFinite(r.speed)) && !JSON.stringify(await ev(() => window.__ds.vehicleLib.json())).includes('NaN'), r75.map((r) => r.speed));
await exitSim();

// ══ 76–79: reset / restart / scene switch cleanup ════════════════════════════════════════
const geo76 = (await glInfo()).geometries;
const [rc] = await scene({ objects: [O('car', 0, 0, 1), O('human', 4, 0, 2)], vehicles: { model: 'dynamics', cars: { 0: { occupants: [{ human: 1, seat: 'driver', restrained: false }] } } } });
await enterRun();
await ev((id) => { window.__ds.vehicleLib.enableLive(id); window.__ds.vehicleLib.setLive(id, { throttle: 1 }); }, rc);
await atTime(5);
const moved76 = (await row(rc)).position[0];
await ev(() => window.__ds.actions.resetSimulation());
await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status !== 'loading', { timeout: 120_000 });
await atTime(0.5);
const r76 = await row(rc);
const raw76 = await raw(rc);
check('76 reset: the vehicle state is rebuilt (live input cleared, back at the start, parked, occupant seated again)', moved76 > 3 && raw76.live === null && Math.abs(r76.position[0]) < 0.2 && r76.controlSource === 'parked' && r76.occupantsSeated === 1, { moved76, x: r76.position[0], live: raw76.live });
await exitSim();
await enterRun();
await atTime(1);
const L77 = await layer();
check('77 restart (exit → run): one vehicle layer, 4 tyres, one seat marker (nothing duplicated)', L77.tyres === 4 && L77.seats === 1, L77);
await exitSim();
await scene({ objects: [O('car', 0, 0, 1), O('car', 8, 0, 2)], vehicles: { model: 'dynamics' }, extended: false });
await enterRun();
await atTime(1);
const L78 = await layer();
check('78 scene switch: the layer follows the new run (2 cars → 8 tyres, no seat marker)', L78.tyres === 8 && L78.seats === 0, L78);
await exitSim();
await newWorld();
await wait(800);
const geo79 = (await glInfo()).geometries;
check('79 cleanup: GPU geometries back after reset / restart / scene switch (no leaked vehicle buffers)', geo79 <= geo76 + 2, { geo76, geo79 });

// ══ 80: language switch mid-run ══════════════════════════════════════════════════════════
const [lc] = await scene({ objects: [O('car', 0, 0, 1)], vehicles: { model: 'dynamics' }, extended: false });
await enterRun();
await atTime(2);
await select(lc);
const before80 = await text('[data-testid="vehicle-object"]');
const other = lang === 'ko' ? 'en' : 'ko';
await ev((l) => window.__ds.locale.getState().setLocale(l), other);
await wait(400);
const after80 = await text('[data-testid="vehicle-object"]');
const raw80 = await rawKeys();
await ev((l) => window.__ds.locale.getState().setLocale(l), lang);
await wait(400);
const back80 = await text('[data-testid="vehicle-object"]');
check('80 language switch mid-run: the vehicle inspector re-renders in the other language without raw keys, and back', before80 !== after80 && raw80.length === 0 && back80 === before80, { raw80, a: after80.slice(0, 80) });
await exitSim();

// ══ 81–82: legacy world (no vehicle settings) ═══════════════════════════════════════════
const [lg] = await scene({ objects: [O('car', 0, 0, 1)], vehicles: null, extended: false });
await enterRun();
await atTime(3);
await select(lg);
const leg81 = await ev((id) => { const e = window.__ds.sim.getRuntime().entities.get(id); return { veh: e.vehicle ?? null, rt: window.__ds.sim.getRuntime().vehicles ?? null }; }, lg);
const sec81 = await has('[data-testid="vehicle-object"]');
const ov81 = await ev((l) => [...document.querySelectorAll('label')].some((x) => (x.textContent ?? '').trim() === l), ovLabel);
const L81 = await layer();
const drawn81 = await ev((id) => window.__ds.vehicleLib.drawnScales(id), lg);
check('81 legacy world: the car has no vehicle state, no vehicle section / overlay toggle / vehicle layer; the legacy car body is drawn', leg81.veh === null && leg81.rt === null && !sec81 && !ov81 && !L81.found && Array.isArray(drawn81) && drawn81.some((s) => s > 0), { leg81, sec81, ov81, L81: L81.found });
await ev(() => window.__ds.ui.getState().setResultsOpen(true));
await wait(700);
const res82 = await has('[data-testid="vehicle-results"]');
await clickText(/^\s*JSON\s*$/, '[role="dialog"]');
await wait(300);
const j82 = JSON.parse((await lastBlob()) || '{}');
await ev(() => window.__ds.ui.getState().setResultsOpen(false));
check('82 legacy export: no vehicle results block, JSON without a vehicles block; vehicleLib empty', !res82 && j82.vehicles === undefined && (await ev(() => window.__ds.vehicleLib.json())) === null && (await ev(() => window.__ds.vehicleLib.cars().length)) === 0, { res82, v: j82.vehicles });
await exitSim();

// ══ Whole run ════════════════════════════════════════════════════════════════════════════
check('83 no raw i18n keys of the vehicle model visible anywhere checked', rawSeen.length === 0, rawSeen);
check('84 no "NaN" / "Infinity" / "undefined" text shown (parked, results)', nanSeen.length === 0, nanSeen);
await newWorld();
await wait(800);
const geo1 = (await glInfo()).geometries;
check('85 resources: GPU geometries back to the start after all runs', geo1 <= geo0 + 2, { geo0, geo1 });
const mem = await ev(() => { if (window.gc) window.gc(); return performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : -1; });
check('86 whole run: no page / console errors, the tab alive', errors.length === 0 && !crashed, { errors: errors.length, heapMB: mem });
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; ${errors.length} page errors; geometries ${geo0} → ${geo1}; heap ${mem} MB; crashed ${crashed}`);
if (errors.length) console.log(errors.slice(0, 10).join('\n'));
fs.writeFileSync(path.join(out, `results-${lang}.json`), JSON.stringify({ lang, url, results, errors, geometries: [geo0, geo1], heapMB: mem, crashed }, null, 2));
await browser.close();
process.exit(results.every((r) => r.ok) && errors.length === 0 && !crashed ? 0 : 1);
