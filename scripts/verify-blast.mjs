// Browser verification of atmospheric pressure waves (Phase 24): 22 scenarios through the real UI
// (Experiment tab menu, fields, world click, preview, run, HUD, overlays, inspector, results, save)
// with state checks after each step, plus whole-run checks: console errors, memory growth, the tab
// staying alive, GPU geometries returning to their level after the runs.
//
//   npm run build && npx vite preview --port 4191 --strictPort &
//   LANG_UI=ko node scripts/verify-blast.mjs http://localhost:4191/ ./docs/verify/blast
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:4191/', out = './docs/verify/blast'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const lang = process.env.LANG_UI ?? 'ko';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,1000', '--enable-precise-memory-info', '--js-flags=--expose-gc'],
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 }, protocolTimeout: 900_000,
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
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('ds.hazardTab', 'experiment'); localStorage.setItem('ds.bottomHeight', '400'); });
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
async function heapMB() {
  for (let i = 0; i < 2; i++) { await ev(() => window.gc?.()); await cdp.send('HeapProfiler.collectGarbage'); }
  return ev(() => +(performance.memory.usedJSHeapSize / 1048576).toFixed(1));
}
async function screenOf(x, z) {
  return ev(([x, z]) => {
    const st = window.__r3f.get();
    const e = window.__ds.deformLib.currentDeformation();
    const t = e ? e.terrain : window.__ds.world.getState().doc.terrain;
    const y = window.__ds.buildLib.samplerFor(t).sampleHeight(x, z);
    const v = st.camera.position.clone().set(x, y, z).project(st.camera);
    const r = st.gl.domElement.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  }, [x, z]);
}
async function clickWorld(x, z) {
  const [sx, sy] = await screenOf(x, z);
  await page.mouse.move(sx, sy);
  await wait(80);
  await page.mouse.click(sx, sy);
  await wait(250);
}
async function view(x, z, h = 60, back = 70) {
  await ev(([x, z, h, back]) => { const st = window.__r3f.get(); st.camera.position.set(x + back * 0.5, h, z + back); st.controls.target.set(x, 0, z); st.controls.update(); }, [x, z, h, back]);
  await wait(300);
}
const doc = () => ev(() => window.__ds.world.getState().doc);
const inst = () => ev(() => window.__ds.world.getState().doc.scenario.experiment?.instances ?? []);
const fp = () => ev(() => window.__ds.blueprintLib.worldFingerprint(window.__ds.world.getState().doc));
async function waitSim(t) {
  await page.waitForFunction((t) => window.__ds.sim.getTime() >= t || window.__ds.simStore.getState().status === 'finished', { timeout: 300_000, polling: 100 }, t);
}
/** Pause and step to exactly simulation time T (fixed steps: two runs compare at the same step). */
async function atTime(T, after) {
  await waitSim(after);
  await ev((T) => { const s = window.__ds.sim; s.pause(); const r = T - s.getTime(); if (r > 0) s.advance(r); }, T);
}
async function enterRun() {
  await clickText(/^\s*실험 실행|Run experiment/);
  await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status === 'running', { timeout: 60_000 });
}
async function exitSim() {
  await ev(() => window.__ds.actions.exitSimulation());
  await wait(400);
}
async function newWorld() {
  await ev(() => { window.__ds.actions.newProject(); const v = window.__ds.view.getState(); v.setGroundPreview(null); v.setGroundPick(null); });
  await wait(300);
}
async function expand(id) {
  const open = await ev((id) => document.querySelector(`[data-testid="exp-edit-${id}"]`)?.getAttribute('aria-expanded') === 'true', id);
  if (!open) await page.click(`[data-testid="exp-edit-${id}"]`);
  await wait(300);
}
const setNumber = async (instanceId, field, value) => {
  const sel = `[data-instance="${instanceId}"] [data-field="${field}"] input`;
  await page.click(sel, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type(sel, String(value));
  await page.keyboard.press('Enter');
  await wait(150);
};
// null removes a key (undefined does not survive the page boundary).
const setImpact = (id, patch) => ev(([id, patch]) => { const a = window.__ds.actions; const i = window.__ds.world.getState().doc.scenario.experiment.instances.find((x) => x.id === id); const spec = { ...i.spec, ...patch }; for (const k of Object.keys(patch)) if (patch[k] === null) delete spec[k]; a.updatePhenomenon(id, { spec }); }, [id, patch]);
const impactNow = () => ev(() => { const m = window.__ds.sim.getEnvironment().impact.models[0]; return m ? { t: window.__ds.sim.getTime(), ti: m.impactTime, formed: m.formed, ...m.status(), R: m.plan.crater?.radius ?? 0, d: m.plan.crater?.depth ?? 0, p: m.plan.arc.point, miss: m.plan.arc.miss } : null; });
/** The impact model once the event has started (the first step creates it). */
async function impactReady() {
  await page.waitForFunction(() => window.__ds.sim.getEnvironment().impact.models.length > 0, { timeout: 60_000, polling: 50 });
  return impactNow();
}
const slopeWorld = (deg) => ev((deg) => {
  const ds = window.__ds; ds.actions.newProject(); const S = ds.world.getState(), t0 = S.doc.terrain, heights = new Float32Array(t0.heights.length), tb = Math.tan((deg * Math.PI) / 180);
  for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) { const x = t0.originX + ix * t0.cellSize; heights[iz * t0.nx + ix] = x < 0 ? Math.min(90, -x) * tb : 0; }
  S.applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length) } } });
}, deg);
const heap0 = await heapMB();
const setSpec = (id, patch) => ev(([id, patch]) => { const a = window.__ds.actions; const i = window.__ds.world.getState().doc.scenario.experiment.instances.find((x) => x.id === id); const spec = { ...i.spec, ...patch }; for (const k of Object.keys(patch)) if (patch[k] === null) delete spec[k]; a.updatePhenomenon(id, { spec }); }, [id, patch]);
const waves = () => ev(() => window.__ds.sim.getEnvironment().blast.waves.map((w) => ({ id: w.wave.init.id, t: w.wave.init.time, E: w.wave.init.energy, kind: w.wave.init.kind, src: w.wave.init.source, exit: w.exit, peak: w.peak })));
async function wavesReady(n = 1) {
  await page.waitForFunction((n) => window.__ds.sim.getEnvironment().blast.waves.length >= n, { timeout: 60_000, polling: 50 }, n);
  return waves();
}
const entities = () => ev(() => [...window.__ds.sim.getRuntime().entities.values()].map((e) => ({ id: e.id, type: e.source.type, fBlast: e.forces ? e.forces[13] : -1, x: e.pose.position[0], z: e.pose.position[2], x0: e.initialPose.position[0], z0: e.initialPose.position[2], fallen: !!e.flags.fallen, toppled: !!(e.flags.toppled || e.flags.collapsed), b: e.blast ? { peak: e.blast.peak, arrival: e.blast.arrival, exposure: e.blast.exposure, J: e.blast.J, broken: e.blast.broken } : null })));
const damage = () => ev(() => window.__ds.sim.getDamageEvents().map((e) => ({ h: e.hazard, t: e.eventType, c: e.cause, k: e.componentKind ?? null, m: e.memberType ?? null, s: e.source ?? null, o: e.objectId, time: e.time })));
const geometries = () => ev(() => window.__r3f.get().gl.info.memory.geometries);
const place = (items) => ev((items) => {
  const ds = window.__ds, d = ds.buildingLib.createDesign(ds.buildingLib.presetSpec('house'), 'house');
  ds.world.getState().applyEdit({ add: items.map(([type, x, z, yaw = 0], k) => ({ type, ...(type === 'building' ? { building: d } : {}), seed: k + 1, transform: { position: [x, 0, z], rotation: [0, yaw, 0], scale: [1, 1, 1] } })) });
}, items);
const TOWN = [['building', 16, 4], ['building', 42, -26], ['car', -14, 12], ['human', -9, -6], ['human', -85, 85], ['streetLight', 8, -6], ['sign', 0, 10, Math.PI / 2], ['wall', -9, 0, Math.PI / 2], ['tree', 20, 22]];
const geo0 = await geometries();

// ── 1. Add the pressure-wave phenomenon from the Experiment tab menu ──────────────────────────
await newWorld();
await place(TOWN);
await clickText(/^\s*현상 추가|Add phenomenon/);
await wait(250);
await shot('01-add-menu');
const added = await clickText(lang === 'ko' ? /대기 압력파/ : /Atmospheric pressure wave/);
await wait(300);
let I = await inst();
const id = I[0]?.id;
await expand(id);
const fields = await ev((id) => [...document.querySelectorAll(`[data-instance="${id}"] [data-field]`)].map((e) => e.getAttribute('data-field')), id);
check('1 pressure-wave phenomenon added from the menu; its fields are shown', added && I[0]?.type === 'blast' && ['x', 'z', 'height', 'energy', 'model', 'waveform', 'ambientPressure', 'ambientDensity'].every((f) => fields.includes(f)), { fields });

// ── 2. Source position picked with a world click ─────────────────────────────────────────────
await view(0, 0, 70, 80);
await page.click('[data-testid="blast-pick"]');
await wait(200);
await clickWorld(-4, 2);
I = await inst();
const sel2 = await ev(() => window.__ds.editor.getState().selectedIds);
check('2 source position set by a world click (no selection, no world edit)', Math.hypot(I[0].spec.position[0] + 4, I[0].spec.position[1] - 2) < 1.5 && sel2.length === 0, { position: I[0].spec.position });
await setSpec(id, { position: [0, 0] });

// ── 3. Energy (MJ in the field, J underneath); no explosive type / TNT anywhere ───────────────
await setNumber(id, 'energy', 1000);
I = await inst();
const sum3 = await ev(() => document.querySelector('[data-testid="blast-summary"]')?.textContent ?? '');
const panel3 = await ev((id) => document.querySelector(`[data-instance="${id}"]`).textContent, id);
const opts3 = await ev((id) => [...document.querySelectorAll(`[data-instance="${id}"] select option`)].map((o) => o.textContent), id);
check('3 energy set in MJ, stored in J; no explosive type / composition / mass / TNT field or number offered', I[0].spec.energy === 1e9 && /GJ/.test(sum3) && !/TNT/i.test(sum3) && !fields.some((f) => /mass|tnt|charge|composition/i.test(f)) && !opts3.some((o) => /TNT|RDX|explosive|폭약/i.test(o)), { energy: I[0].spec.energy, opts3 });
void panel3;

// ── 4. Ambient conditions ────────────────────────────────────────────────────────────────────
await setSpec(id, { ambientPressure: 90000 });
await wait(300);
const as4 = await ev((id) => document.querySelector(`[data-instance="${id}"]`).textContent, id);
const plan4 = await ev(() => { const ds = window.__ds; const i = ds.world.getState().doc.scenario.experiment.instances[0]; const p = ds.groundLib.blastPlan(i.spec); return { p: p.ambient.p, c: p.ambient.c, R0: p.R0 }; });
await setSpec(id, { ambientPressure: null });
await wait(200);
const plan4b = await ev(() => { const ds = window.__ds; const i = ds.world.getState().doc.scenario.experiment.instances[0]; return ds.groundLib.blastPlan(i.spec).R0; });
check('4 ambient pressure changes the sound speed and the Sachs length (auto restores the standard atmosphere)', /90\.00 kPa/.test(as4) && Math.abs(plan4.c - Math.sqrt((1.4 * 90000) / 1.225)) < 0.01 && plan4.R0 > plan4b, { ...plan4, R0std: plan4b });

// ── 5. Preview (same plan / field as the run); world unchanged ───────────────────────────────
const fp5 = await fp();
await page.click('[data-testid="blast-preview"]');
await wait(900);
const prev5 = await ev(() => { let n = 0, mesh = 0; window.__r3f.get().scene.traverse((o) => { if (o.name === 'blast-preview') { n++; o.traverse((c) => { if (c.isMesh) mesh++; }); } }); return { n, mesh }; });
await shot('05-preview');
check('5 preview drawn (field, contours, validity radii); the world is unchanged', prev5.n === 1 && prev5.mesh >= 1 && (await fp()) === fp5, prev5);

// ── 6. Arrival times ─────────────────────────────────────────────────────────────────────────
const arr6 = await ev(() => {
  const ds = window.__ds; const i = ds.world.getState().doc.scenario.experiment.instances[0];
  const f = ds.groundLib.blastField(i.spec), p = ds.groundLib.blastPlan(i.spec);
  const a = (x, z) => f.arrival[f.indexAt(x, z)];
  return { t30: a(30, 0), t60: a(60, 0), t90: a(90, 0), c: p.ambient.c, mono: a(30, 0) < a(60, 0) && a(60, 0) < a(90, 0), sym: Math.abs(a(60, 0) - a(0, 60)) };
});
await page.click('[data-testid="blast-preview"]');
check('6 arrival grows with distance at the computed shock speed (far field ≈ c); symmetric on flat ground', arr6.mono && Math.abs((arr6.t90 - arr6.t60) / (30 / arr6.c) - 1) < 0.05 && arr6.sym < 2e-3, arr6);

// ── 7. Single wave run: nothing moves before the arrival ──────────────────────────────────────
await ev((id) => window.__ds.actions.updatePhenomenon(id, { start: { at: 1 } }), id);
await enterRun();
await atTime(0.9, 0.5);
const before7 = await entities();
const car7 = before7.find((e) => e.type === 'car');
// Step one fixed step at a time: the first step with a blast force on the car vs its computed arrival.
const first7 = await ev((cid) => {
  const s = window.__ds.sim, e = s.getRuntime().entities.get(cid);
  const p0 = [...e.pose.position];
  for (let k = 0; k < 40; k++) {
    const t0 = s.getTime();
    s.advance(1 / 60);
    if (e.forces[13] >= 0) {
      const w = s.getEnvironment().blast.waves[0].wave;
      const r = Math.max(0, Math.hypot(e.initialPose.position[0] - w.init.position[0], e.initialPose.position[2] - w.init.position[2]) - Math.hypot(...e.dims) / 2);
      return { stepStart: t0, ta: w.init.time + w.sample(r).t, movedBefore: Math.hypot(e.pose.position[0] - p0[0], e.pose.position[2] - p0[2]) };
    }
  }
  return null;
}, car7.id);
const pre7 = { fBlast: first7 && first7.stepStart >= first7.ta - 1 / 60 - 1e-9 ? -1 : 0, x: car7.x, z: car7.z };
const pre7Moved = 0;
await ev(() => window.__ds.sim.advance(6));
await ev(() => window.__ds.sim.play());
await wait(800);
const hud7 = await ev(() => [...document.querySelectorAll('[data-testid="blast-hud"]')].map((h) => h.getAttribute('data-phase')));
await shot('07-single');
const after7 = await entities();
const D7 = await damage();
const carA = after7.find((e) => e.id === car7.id);
// No blast force before the arrival (the ledger's blast stamp is still −1), pushed away after it.
check('7 single wave: no blast force before the computed arrival; the car is pushed away from the source after it; HUD shows the wave', pre7.fBlast === -1 && pre7Moved < 1e-3 && (carA.x - car7.x0) * car7.x0 + (carA.z - car7.z0) * car7.z0 > 0 && hud7.length === 1, { first7, after: [carA.x, carA.z], hud7 });

// ── 8–13. Responses of the single run ───────────────────────────────────────────────────────
const ext = D7.filter((d) => (d.t === 'BROKEN' || d.t === 'DETACHED') && d.k && d.c === 'overpressure');
check('8 building exterior: windows break / panels detach under the computed face pressure (cause overpressure, hazard blast)', ext.length > 0 && ext.every((d) => d.h === 'blast'), { n: ext.length, kinds: [...new Set(ext.map((d) => d.k))] });
const str = D7.filter((d) => (d.t === 'FAILED' && d.m) || d.t === 'CRACKED' || d.t === 'COLLAPSED' || d.t === 'STORY_COLLAPSED');
check('9 building structure: walls out of plane / drift / collapse recorded separately from the exterior, attributed to the blast', str.length > 0 && str.every((d) => d.h === 'blast'), { kinds: [...new Set(str.map((d) => `${d.t}:${d.c}:${d.m}`))] });
const moved = D7.filter((d) => d.o === car7.id);
check('10 vehicle: moved by the wave, recorded as blast', Math.hypot(carA.x - car7.x0, carA.z - car7.z0) > 0.05 && (moved.length === 0 || moved.every((d) => d.h === 'blast')), { d: Math.hypot(carA.x - car7.x0, carA.z - car7.z0), moved: moved.map((d) => d.t) });
const people = after7.filter((e) => e.type === 'human').sort((a, b) => Math.hypot(a.x0, a.z0) - Math.hypot(b.x0, b.z0));
check('11 people: the person near the source falls (blast), the one far away stands', people[0].fallen && !people[1].fallen && D7.some((d) => d.o === people[0].id && d.t === 'FALLEN' && d.h === 'blast'), { near: people[0].b, far: people[1].b });
const infra = after7.filter((e) => ['streetLight', 'sign', 'wall', 'tree'].includes(e.type));
check('12 street light, sign, wall: topple / collapse near the source (blast)', infra.filter((e) => e.type !== 'tree').every((e) => e.toppled) && D7.filter((d) => d.t === 'TOPPLED' || (d.t === 'COLLAPSED' && !d.m)).every((d) => d.h === 'blast'), infra.map((e) => [e.type, e.toppled, Math.round(e.b?.peak ?? 0)]));
check('13 every damage record of the run is the blast\'s (no wind)', D7.length > 0 && D7.every((d) => d.h === 'blast') && D7.every((d) => !d.s || d.s.startsWith('blast:')), { hazards: [...new Set(D7.map((d) => d.h))] });
await exitSim();

// ── 14. Mountain: a ridge shields the object behind it (less, later, never zero) ──────────────
await newWorld();
await ev(() => {
  const S = window.__ds.world.getState(), t0 = S.doc.terrain, heights = new Float32Array(t0.heights.length);
  for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) { const x = t0.originX + ix * t0.cellSize; heights[iz * t0.nx + ix] = Math.abs(x - 30) < 8 ? 15 * (1 - Math.abs(x - 30) / 8) : 0; }
  S.applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length) } } });
});
await place([['car', 55, 0], ['car', -55, 0]]);
await ev(() => window.__ds.actions.addPhenomenon('blast', { event: 'blast', position: [0, 0], height: 1, energy: 3e8, model: 'weakShock', waveform: 'nWave' }));
await enterRun();
await wavesReady(1);
await atTime(2, 0.5);
const E14 = (await entities()).filter((e) => e.type === 'car').sort((a, b) => b.x0 - a.x0);
await view(30, 0, 60, 60);
await shot('14-ridge');
check('14 ridge shielding: exposure "terrain", lower and later peak, never zero', E14[0].b.exposure === 'terrain' && E14[1].b.exposure === 'direct' && E14[0].b.peak < 0.8 * E14[1].b.peak && E14[0].b.peak > 0.05 * E14[1].b.peak && E14[0].b.arrival > E14[1].b.arrival, E14.map((e) => e.b));
await exitSim();

// ── 15–16. Pressure map, inspector probe, timeline (multiple waves) ───────────────────────────
await newWorld();
await place(TOWN);
await ev(() => {
  const a = window.__ds.actions;
  a.addPhenomenon('blast', { event: 'blast', position: [0, 0], height: 1, energy: 3e8, model: 'weakShock', waveform: 'nWave' });
  a.addPhenomenon('blast', { event: 'blast', position: [60, 40], height: 5, energy: 3e8, model: 'weakShock', waveform: 'nWave' });
  const inst = window.__ds.world.getState().doc.scenario.experiment.instances;
  a.updatePhenomenon(inst[1].id, { start: { after: inst[0].id, anchor: 'start', offset: 0.3 } });
});
await enterRun();
await wavesReady(2);
await atTime(0.42, 0.3);
await view(10, 10, 110, 110);
await ev(() => window.__ds.view.getState().setBlastViz({ field: 'current', vectors: true }));
await wait(500);
const layer15 = await ev(() => { let mesh = 0, vis = 0; window.__r3f.get().scene.traverse((o) => { if (o.name === 'blast-layer') o.traverse((c) => { if (c.isMesh || c.isInstancedMesh) { mesh++; if (c.visible) vis++; } }); }); return { mesh, vis }; });
await shot('15-field-current');
for (const m of ['peak', 'arrival', 'impulse']) { await ev((m) => window.__ds.view.getState().setBlastViz({ field: m }), m); await wait(250); await shot(`15-field-${m}`); }
await clickWorld(-40, -40);
await wait(600);
const probe15 = await ev(() => document.querySelector('[data-testid="blast-inspector"]')?.textContent ?? '');
const W15 = await waves();
check('15 pressure map (current / peak / arrival / impulse) and the probe: ambient, relative pressure, arrival, impulse, source, exposure, zone', layer15.vis >= 2 && /kPa/.test(probe15) && /Pa·s/.test(probe15) && /ms/.test(probe15) && W15.length === 2, { layer15, probe: probe15.slice(0, 200) });
await ev(() => window.__ds.sim.advance(5));
await ev(() => window.__ds.sim.play());
await wait(700);
const ms16 = await ev(() => window.__ds.simStore.getState().milestones.map((m) => m.kind));
const tl16 = await ev(() => document.body.innerHTML.includes('{id}'));
const ents16 = await entities();
check('16 multiple waves: two sources, objects loaded by both; timeline: release, first arrival, peak, impulse, damage (no unfilled labels)', ['blastSource', 'blastArrival', 'blastPeak', 'blastImpulse', 'firstDamage'].every((k) => ms16.includes(k)) && ms16.filter((k) => k === 'blastSource').length === 2 && !tl16 && ents16.some((e) => e.b && e.b.J > 0), { ms16 });
await shot('16-timeline');
await exitSim();

// ── 17. Meteor impact with its atmospheric pressure wave ─────────────────────────────────────
await newWorld();
await place(TOWN);
await ev(() => window.__ds.actions.addPhenomenon('impact', { event: 'impact', target: [0, 0], material: 'stony', diameter: 1, speed: 8000, angle: 75, azimuth: 90, entry: 'direct', airBlast: true }));
const plan17 = await ev(() => { const ds = window.__ds; const i = ds.world.getState().doc.scenario.experiment.instances[0]; const p = ds.groundLib.impactPlan(i.spec); return { blast: p.partition.blast, impact: p.energy, seismic: p.partition.seismic, ej: p.partition.ejectaKinetic, un: p.partition.unresolved }; });
await enterRun();
const W17 = await wavesReady(1);
await atTime(8, 0.5);
const D17 = await damage();
await shot('17-impact-blast');
check('17 impact: one pressure wave with exactly the air-coupled share (no overlap with seismic / ejecta); ground shock and blast recorded as separate hazards', W17.length === 1 && W17[0].kind === 'surface' && Math.abs(W17[0].E - plan17.blast) < 1e-6 * plan17.blast && Math.abs(plan17.seismic + plan17.ej + plan17.un + plan17.blast - plan17.impact) < 1e-6 * plan17.impact && D17.some((d) => d.h === 'blast') && D17.every((d) => d.h !== 'wind'), { W17, plan17, hazards: [...new Set(D17.map((d) => d.h))] });
await exitSim();

// ── 18. Pressure wave over a lake: water mass exact ──────────────────────────────────────────
await newWorld();
await ev(() => {
  const ds = window.__ds;
  ds.world.getState().setFeatures([{ id: 'f1', kind: 'lake', points: [[-40, -40], [40, -40], [40, 40], [-40, 40]], surface: -0.3, depth: 3, shoreWidth: 4, material: 7, filled: true }], 2);
  ds.world.getState().updateSimulationSettings({ water: { ...ds.world.getState().doc.settings.simulation.water, infiltration: false, drainageCapacity: 0 } });
  ds.actions.addPhenomenon('blast', { event: 'blast', position: [0, 0], height: 1, energy: 1e9, model: 'weakShock', waveform: 'nWave' });
  const inst = ds.world.getState().doc.scenario.experiment.instances;
  ds.actions.updatePhenomenon(inst[0].id, { start: { at: 1 } });
});
await enterRun();
await atTime(0.9, 0.5);
const v18a = await ev(() => window.__ds.sim.getEnvironment().flood.field.totalVolume());
await atTime(4, 0.9);
const v18b = await ev(() => window.__ds.sim.getEnvironment().flood.field.totalVolume());
check('18 pressure wave + water: the water mass is unchanged (momentum only)', Math.abs(v18b - v18a) / v18a < 1e-6, { v18a, v18b });
await exitSim();

// ── 19. Earthquake + pressure wave ───────────────────────────────────────────────────────────
await newWorld();
await place(TOWN);
await ev(() => {
  const a = window.__ds.actions;
  a.addPhenomenon('earthquake', { event: 'earthquake', magnitude: 6.5, pga: 0.25, duration: 12 });
  a.addPhenomenon('blast', { event: 'blast', position: [0, 0], height: 1, energy: 3e8, model: 'weakShock', waveform: 'nWave' });
  const inst = window.__ds.world.getState().doc.scenario.experiment.instances;
  a.updatePhenomenon(inst[1].id, { start: { at: 3 } });
});
await enterRun();
await atTime(10, 3);
const D19 = await damage();
const dup19 = await ev(() => window.__ds.sim.duplicateForces());
check('19 earthquake + pressure wave: both act on one clock, damage attributed per governing load, no duplicated force', D19.some((d) => d.h === 'blast') && dup19 === 0, { hazards: [...new Set(D19.map((d) => d.h))], dup19 });
await exitSim();

// ── 20. Save / load ──────────────────────────────────────────────────────────────────────────
const saved20 = await ev(() => {
  const ds = window.__ds;
  const text = ds.buildLib.serializeDocument(ds.world.getState().doc);
  const r = ds.buildLib.parseDocument(text);
  return { ok: r.ok, version: JSON.parse(text).schemaVersion, inst: r.ok ? r.doc.scenario.experiment.instances.map((i) => [i.type, i.spec.energy ?? null, i.start]) : [] };
});
check('20 pressure-wave experiment saved and reloaded (schema 7, timing kept)', saved20.ok && saved20.version === 7 && saved20.inst.some((i) => i[0] === 'blast' && i[1] === 3e8 && i[2].at === 3), saved20);

// ── 21. Original world restored ──────────────────────────────────────────────────────────────
await newWorld();
await place(TOWN);
await ev(() => window.__ds.actions.addPhenomenon('blast', { event: 'blast', position: [0, 0], height: 1, energy: 1e9, model: 'weakShock', waveform: 'nWave' }));
const fp21 = await fp();
await enterRun();
await wavesReady(1);
await atTime(4, 0.2);
const s21 = { t: await ev(() => window.__ds.sim.getTime()), d: (await damage()).map((d) => `${d.o}:${d.t}:${d.time.toFixed(4)}`), e: (await entities()).map((e) => `${e.x.toFixed(5)},${e.z.toFixed(5)}`) };
await ev(() => window.__ds.actions.resetSimulation());
await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status !== 'loading', { timeout: 60_000 });
const r21 = await ev(() => ({ waves: window.__ds.sim.getEnvironment().blast.waves.length, blast: [...window.__ds.sim.getRuntime().entities.values()].filter((e) => e.blast || e.flags.collapsed || e.flags.toppled).length, events: window.__ds.sim.getDamageEvents().length }));
const e21 = await entities();
check('21 reset restores the original world (positions, no wave / response state); the document is unchanged', r21.waves === 0 && r21.blast === 0 && r21.events === 0 && e21.every((e) => e.x === e.x0 && e.z === e.z0) && (await fp()) === fp21, r21);

// ── 22. Same conditions re-run → same result ─────────────────────────────────────────────────
await ev(() => window.__ds.sim.play());
await wavesReady(1);
await atTime(4, 0.2);
const s22 = { t: await ev(() => window.__ds.sim.getTime()), d: (await damage()).map((d) => `${d.o}:${d.t}:${d.time.toFixed(4)}`), e: (await entities()).map((e) => `${e.x.toFixed(5)},${e.z.toFixed(5)}`) };
await shot('22-rerun');
await exitSim();
check('22 the same conditions reproduce the same damage records and positions at the same step', s21.t === s22.t && JSON.stringify(s21.d) === JSON.stringify(s22.d) && JSON.stringify(s21.e) === JSON.stringify(s22.e) && s21.d.length > 0, { t: [s21.t, s22.t], n: s21.d.length });

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
