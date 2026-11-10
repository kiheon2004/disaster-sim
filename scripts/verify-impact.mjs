// Browser verification of meteoroid / asteroid impacts (Phase 23): 22 scenarios through the real
// UI (Experiment tab, fields, world clicks, preview, HUD, overlays, inspector, results, save) with
// state checks after each step, plus whole-run checks: console errors, collider = render,
// plausible speeds, memory growth, the tab staying alive.
//
//   npm run build && npx vite preview --port 4191 --strictPort &
//   LANG_UI=ko node scripts/verify-impact.mjs http://localhost:4191/ ./docs/verify/impact
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:4191/', out = './docs/verify/impact'] = process.argv.slice(2);
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

// ── 1. Add the meteor phenomenon from the Experiment tab menu ─────────────────────────────────
await newWorld();
await ev(() => {
  const ds = window.__ds, d = ds.buildingLib.createDesign(ds.buildingLib.presetSpec('house'), 'house');
  ds.world.getState().applyEdit({ add: [
    { type: 'building', building: d, seed: 1, transform: { position: [16, 0, 4], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    { type: 'building', building: d, seed: 2, transform: { position: [55, 0, -30], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    { type: 'car', seed: 3, transform: { position: [-14, 0, 12], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    { type: 'human', seed: 4, transform: { position: [-20, 0, -10], rotation: [0, 0, 0], scale: [1, 1, 1] } },
  ] });
});
await clickText(/^\s*현상 추가|Add phenomenon/);
await wait(250);
await shot('01-add-menu');
const added = await clickText(lang === 'ko' ? /운석/ : /Meteor/);
await wait(300);
let I = await inst();
const id = I[0]?.id;
await expand(id);
const fields = await ev((id) => [...document.querySelectorAll(`[data-instance="${id}"] [data-field]`)].map((e) => e.getAttribute('data-field')), id);
check('1 meteor phenomenon added from the menu; its fields are shown', added && I[0]?.type === 'impact' && ['material', 'diameter', 'density', 'mass', 'speed', 'angle', 'azimuth', 'entry'].every((f) => fields.includes(f)), { fields });

// ── 2. Material selection; density "auto" shows the class value ──────────────────────────────
await page.select(`[data-instance="${id}"] select[data-field="material"]`, 'stony');
await wait(250);
const dens2 = await ev((id) => document.querySelector(`[data-instance="${id}"] [data-field="density"] input`)?.value, id);
await page.select(`[data-instance="${id}"] select[data-field="material"]`, 'iron');
await wait(250);
const dens2b = await ev((id) => document.querySelector(`[data-instance="${id}"] [data-field="density"] input`)?.value, id);
I = await inst();
check('2 material selected; the auto density is the material\'s representative value', I[0].spec.material === 'iron' && /3300|3,300/.test(dens2) && /7800|7,800/.test(dens2b), { dens2, dens2b });

// ── 3. Size / density / mass; an inconsistent mass is flagged ────────────────────────────────
await setNumber(id, 'diameter', 2);
await setImpact(id, { mass: 1000 });
await wait(300);
const invalid3 = await ev(() => !!document.querySelector('[data-testid="exp-invalid"]'));
const issue3 = await ev((id) => document.querySelector(`[data-instance="${id}"]`).textContent, id);
await setImpact(id, { mass: null });
await wait(200);
I = await inst();
check('3 diameter set; a mass inconsistent with diameter × density is rejected with the reason', I[0].spec.diameter === 2 && invalid3 && /π\/6|mass|질량/.test(issue3), { invalid3 });

// ── 4. Speed and angle ─────────────────────────────────────────────────────────────────────────
await setNumber(id, 'speed', 12);
await setNumber(id, 'angle', 60);
await setNumber(id, 'azimuth', 90);
I = await inst();
check('4 speed (km/s) and angle set in SI underneath; the spec is valid again', I[0].spec.speed === 12000 && I[0].spec.angle === 60 && I[0].spec.azimuth === 90 && I[0].spec.mass === undefined && !(await ev(() => !!document.querySelector('[data-testid="exp-invalid"]'))), I[0].spec);

// ── 5. Aim point picked with a world click ───────────────────────────────────────────────────
await view(0, 0, 70, 80);
await page.click('[data-testid="impact-pick"]');
await wait(200);
await clickWorld(-4, 2);
I = await inst();
const sel5 = await ev(() => window.__ds.editor.getState().selectedIds);
check('5 aim point set by a world click (no selection, no world edit)', Math.hypot(I[0].spec.target[0] + 4, I[0].spec.target[1] - 2) < 1.5 && sel5.length === 0, { target: I[0].spec.target });
await setImpact(id, { target: [0, 0] });

// ── 6. Trajectory / impact preview from the same plan ────────────────────────────────────────
await page.click('[data-testid="impact-preview"]');
await wait(800);
const prev6 = await ev(() => { let n = 0; window.__r3f.get().scene.traverse((o) => { if (o.name === 'impact-preview') n++; }); return n; });
await shot('06-preview');
const flat6 = await ev(() => window.__ds.world.getState().doc.terrain.heights.every((v) => v === 0));
check('6 trajectory, impact point, crater and ejecta preview drawn; the world is unchanged', prev6 === 1 && flat6, { prev6 });

// ── 7. Energy / momentum / crater numbers ────────────────────────────────────────────────────
const sum7 = await ev(() => document.querySelector('[data-testid="impact-summary"]')?.textContent ?? '');
const plan7 = await ev(() => { const ds = window.__ds; const i = ds.world.getState().doc.scenario.experiment.instances[0]; const p = ds.groundLib.impactPlan(i.spec); return { E: p.energy, m: p.mass, v: p.speed, D: 2 * (p.crater?.radius ?? 0) }; });
await page.click('[data-testid="impact-preview"]');
check('7 energy (J and TNT), momentum and crater shown — E = ½mv² of the plan', /TNT/.test(sum7) && Math.abs(plan7.E - 0.5 * plan7.m * plan7.v * plan7.v) / plan7.E < 1e-9 && plan7.D > 0, { sum7: sum7.slice(0, 160), plan7 });

// ── 8. Small impact (stony 0.6 m, no atmosphere) ─────────────────────────────────────────────
await setImpact(id, { material: 'stony', diameter: 0.6, speed: 6000, angle: 75, entry: 'direct' });
const fp8 = await fp();
await enterRun();
await waitSim(6);
const s8 = await impactNow();
const h8 = await ev(([x, z]) => window.__ds.sim.getEnvironment().terrain.sampleHeight(x, z), [s8.p[0], s8.p[2]]);
await view(0, 0, 30, 40);
await shot('08-small');
await exitSim();
check('8 small impact: crater cut on the runtime ground, document untouched', s8.formed && h8 < -0.4 * s8.d && (await fp()) === fp8, { R: s8.R, d: s8.d, h8 });

// ── 9. Medium impact (iron 2 m, atmospheric entry): countdown, then a larger crater ────────────
await setImpact(id, { material: 'iron', diameter: 2, speed: 12000, angle: 60, entry: 'atmosphere' });
await enterRun();
await waitSim(3);
const hud9 = await ev(() => document.querySelector('[data-testid="impact-countdown"]')?.textContent ?? '');
await view(0, 0, 70, 90);
await shot('09-entry');
const ti9 = (await impactReady()).ti;
await waitSim(ti9 + 0.5);
await shot('09-impact');
await waitSim(ti9 + 6);
const s9 = await impactNow();
check('9 medium impact: entry countdown in the HUD, crater larger than the small one', /T−\d/.test(hud9) && s9.formed && s9.R > s8.R, { hud9, R: s9.R, small: s8.R });

// ── 10. Collider = render on the crater; plausible ejecta speeds ──────────────────────────────
// Paused, two frames rendered: the mesh must equal the runtime heights exactly (no lag allowed then).
await ev(() => window.__ds.sim.pause());
await wait(250);
const mesh10 = await ev(() => { let r = null; window.__r3f.get().scene.traverse((o) => { if (o.name === 'ground' && o.geometry?.attributes?.position?.count > 4) { const p = o.geometry.attributes.position; const h = window.__ds.sim.getEnvironment().terrain.data.heights; let worst = 0; for (let i = 0; i < p.count; i++) worst = Math.max(worst, Math.abs(p.getY(i) - h[i])); r = worst; } }); return r; });
const ray10 = await ev(() => { const s = window.__ds.sim, t = s.getEnvironment().terrain; let worst = 0; for (let x = -10; x <= 10; x += 2.3) for (let z = -10; z <= 10; z += 2.9) { const h = s.colliderHeight(x, z); if (h !== null) worst = Math.max(worst, Math.abs(h - t.sampleHeight(x, z))); } return worst; });
const speeds10 = await ev(() => { const m = window.__ds.sim.getEnvironment().impact.models[0]; return { vmax: Math.max(...m.plan.parcels.map((p) => p.speed)), impact: m.plan.speed }; });
check('10 rendered terrain = runtime heights on the crater (paused); collider = render; ejecta launch speeds below the impact speed', mesh10 !== null && mesh10 < 1e-6 && speeds10.vmax < speeds10.impact && ray10 < 1e-3, { mesh10, ray10, ...speeds10 });
await ev(() => window.__ds.sim.play());

// ── 11. Crater formation: centre at about the transient depth; inspector probe ────────────────
const h11 = await ev(([x, z]) => window.__ds.sim.getEnvironment().terrain.sampleHeight(x, z), [s9.p[0], s9.p[2]]);
await view(s9.p[0], s9.p[2], 35, 45);
await clickWorld(s9.p[0] + s9.R * 0.3, s9.p[2]);
await wait(400);
const probe11 = await ev(() => document.querySelector('[data-testid="ground-inspector"]')?.textContent ?? '');
await ev(() => window.__ds.view.getState().setGroundViz({ mode: 'change' }));
await wait(300);
await shot('11-crater');
check('11 crater formed (centre lowered ~ transient depth); the probe names the impact and its shock', h11 < -0.4 * s9.d && /p1/.test(probe11) && /PGA/.test(probe11), { h11, d: s9.d, probe: probe11.slice(0, 160) });

// ── 12. Ejecta in flight are drawn from their computed paths ──────────────────────────────────
await exitSim();
await enterRun();
const ti12 = (await impactReady()).ti;
await waitSim(ti12 + 0.4);
await ev(() => window.__ds.sim.pause());
const rocks12 = await ev(() => { let n = 0; window.__r3f.get().scene.traverse((o) => { if (o.isInstancedMesh && o.parent?.name === 'impact-layer') n = o.count; }); return n; });
await view(0, 0, 25, 45);
await wait(300);
await shot('12-ejecta');
await ev(() => window.__ds.sim.play());
check('12 ejecta parcels in flight drawn at their computed positions', rocks12 > 10, { rocks12 });

// ── 13. Ejecta deposition: deposit outside the rim; budgets close ─────────────────────────────
await waitSim(ti12 + 8);
const b13 = await ev(() => { const f = window.__ds.sim.getEnvironment().groundFailure.field; const b = f.budget; let g = 0; for (let i = 0; i < f.n; i++) g += f.bed[i] + f.h[i]; return { res: b.residual, rel: b.released, air: b.airborne, dep: b.deposited, err: Math.abs(g * f.dx * f.dx - f.expectedTerrainChange()), exc: b.excavated, upl: b.uplifted, ej: b.ejectedInSitu }; });
await ev(() => window.__ds.view.getState().setGroundViz({ mode: 'deposit' }));
await wait(300);
await shot('13-deposit');
check('13 ejecta deposited on the ground; nothing left in the air; cut − uplift = ejected; terrain = ledgers', b13.dep > 0 && b13.air < 1e-6 * b13.rel && Math.abs(b13.exc - b13.upl - b13.ej) < 1e-6 * b13.exc && b13.err < 1e-6 * b13.exc && Math.abs(b13.res) < 1e-6 * b13.rel, b13);

// ── 14. Building damage attributed to the impact ──────────────────────────────────────────────
await waitSim(ti12 + 12);
const ev14 = await ev(() => window.__ds.sim.getDamageEvents().map((e) => [e.objectType, e.hazard, e.cause, e.source]));
const b14 = await ev(() => [...window.__ds.sim.getRuntime().entities.values()].find((e) => e.source.type === 'building' && e.initialPose.position[0] === 16)?.id);
await ev((id) => window.__ds.editor.getState().select(id), b14);
await wait(500);
const obj14 = await ev(() => document.querySelector('[data-testid="impact-object"]')?.textContent ?? '');
await shot('14-building');
await ev(() => window.__ds.editor.getState().select(null));
check('14 building damage recorded with hazard impact (no wind); the inspector shows the impact section', ev14.some((e) => e[0] === 'building' && e[1] === 'impact') && !ev14.some((e) => e[1] === 'wind') && obj14.length > 0, { n: ev14.length, hazards: [...new Set(ev14.map((e) => e[1]))] });
await exitSim();

// ── 15. Road across the impact: impassable, network unchanged ────────────────────────────────
await ev(() => { const ds = window.__ds, L = ds.roadLib; ds.world.getState().applyEdit({ roads: L.drawRoad(ds.world.getState().doc.roads, [[-90, -2], [90, -2]], { curved: false, profile: L.defaultProfile() }).network }); });
const roads15 = JSON.stringify((await doc()).roads);
await enterRun();
const ti15 = (await impactReady()).ti;
await waitSim(ti15 + 8);
await view(0, -2, 40, 50);
await wait(600);
const road15 = await ev(() => ({ blocked: window.__ds.sim.getRuntime().roads.segments.filter((s) => s.deform && !s.deform.passable).length, panel: document.querySelector('[data-testid="road-sim"]')?.parentElement?.textContent ?? '' }));
await shot('15-road');
await exitSim();
check('15 road across the crater cut / blocked (impassable), the network itself unchanged', road15.blocked >= 1 && JSON.stringify((await doc()).roads) === roads15, { blocked: road15.blocked });

// ── 16. Impact into a lake: water mass exact ──────────────────────────────────────────────────
await newWorld();
await ev(() => {
  const ds = window.__ds;
  ds.world.getState().setFeatures([{ id: 'f1', kind: 'lake', points: [[-30, -30], [30, -30], [30, 30], [-30, 30]], surface: -0.3, depth: 3, shoreWidth: 4, material: 7, filled: true }], 2);
  ds.world.getState().updateSimulationSettings({ water: { ...ds.world.getState().doc.settings.simulation.water, infiltration: false, drainageCapacity: 0 } });
  ds.actions.addPhenomenon('impact', { event: 'impact', target: [0, 0], material: 'stony', diameter: 1, speed: 8000, angle: 70, azimuth: 0, entry: 'direct', startTime: 1 });
});
await enterRun();
await waitSim(0.8);
const v16a = await ev(() => window.__ds.sim.getEnvironment().flood.field?.totalVolume() ?? null);
await waitSim(15);
const v16 = await ev(() => window.__ds.sim.getEnvironment().flood.field?.totalVolume() ?? null);
await view(0, 0, 40, 55);
await shot('16-lake');
await exitSim();
check('16 impact into a lake bed: the water follows the bed, water mass exact', v16a !== null && Math.abs(v16 - v16a) / v16a < 1e-6, { v16a, v16 });

// ── 17. Impact + rain: water collects in the crater ──────────────────────────────────────────
await newWorld();
await ev(() => {
  const a = window.__ds.actions;
  a.addPhenomenon('impact', { event: 'impact', target: [0, 0], material: 'iron', diameter: 2, speed: 12000, angle: 60, azimuth: 90, entry: 'atmosphere' });
  a.addPhenomenon('rain', { ...window.__ds.deformLib.phenomena.implemented('rain').defaults(), intensity: 200, duration: 60 });
});
await enterRun();
const ti17 = (await impactReady()).ti;
await waitSim(ti17 + 25);
const depth17 = await ev(([x, z]) => { const f = window.__ds.sim.getEnvironment().flood.field; return { c: f.sampleDepth(x, z), o: f.sampleDepth(70, 70) }; }, [0, 0]);
await ev(() => window.__ds.view.getState().setFloodViz({ mode: 'depth' }));
await view(0, 0, 40, 55);
await shot('17-flood');
await ev(() => window.__ds.view.getState().setFloodViz({ mode: 'normal' }));
await exitSim();
check('17 impact + rain: rain collects in the crater', depth17.c > 3 * depth17.o && depth17.c > 0.003, depth17);

// ── 18. Impact + landslide: a crater at the toe of a marginal slope triggers it ───────────────
await slopeWorld(34);
await ev(() => {
  const a = window.__ds.actions;
  a.addPhenomenon('landslide', { event: 'landslide', area: { kind: 'circle', center: [-12, 0], radius: 10 }, thickness: 1.5, saturation: 0.3, trigger: 'slope', duration: 1 });
  a.addPhenomenon('impact', { event: 'impact', target: [-4, 0], material: 'stony', diameter: 1.2, speed: 8000, angle: 75, azimuth: 90, entry: 'direct', startTime: 1 });
});
await enterRun();
await waitSim(20);
const g18 = await ev(() => ({ failed: window.__ds.sim.getEnvironment().groundFailure.landslides[0].failedCells, miss: window.__ds.sim.getEnvironment().impact.models[0].plan.arc.miss }));
await view(-8, 0, 40, 55);
await shot('18-landslide');
await exitSim();
check('18 impact on a slope: actual point from the terrain (miss reported), the crater triggers the landslide', g18.failed > 0, g18);

// ── 19. Timeline milestones and log in the current language ──────────────────────────────────
await newWorld();
await ev(() => window.__ds.actions.addPhenomenon('impact', { event: 'impact', target: [0, 0], material: 'iron', diameter: 2, speed: 12000, angle: 60, azimuth: 90, entry: 'atmosphere' }));
await enterRun();
const ti19 = (await impactReady()).ti;
await waitSim(ti19 + 6);
const ms19 = await ev(() => window.__ds.simStore.getState().milestones.map((m) => m.kind));
const log19 = await ev(() => window.__ds.simStore.getState().log.map((l) => window.__ds.tr(l.message.key)).join(' | '));
await shot('19-timeline');
await exitSim();
check('19 timeline: entry, impact, crater formed, ejecta landing; log translated', ['impactEntry', 'impact', 'craterFormed', 'ejectaLanding'].every((k) => ms19.includes(k)) && (lang === 'ko' ? /운석/ : /Meteoroid/).test(log19), { ms19 });

// ── 20. Save / load ─────────────────────────────────────────────────────────────────────────────
const saved20 = await ev(() => {
  const ds = window.__ds;
  const text = ds.buildLib.serializeDocument(ds.world.getState().doc);
  const r = ds.buildLib.parseDocument(text);
  return { version: JSON.parse(text).schemaVersion, ok: r.ok, inst: r.ok ? r.doc.scenario.experiment.instances.map((i) => [i.type, i.spec.material, i.spec.entry]) : null };
});
check('20 impact saved in the experiment and reloaded (schema 7)', saved20.ok && saved20.version === 7 && saved20.inst.some((i) => i[0] === 'impact' && i[1] === 'iron' && i[2] === 'atmosphere'), saved20);

// ── 21. Original world restored (city + river, run, exit, restore) ────────────────────────────
await newWorld();
await ev(() => { const ds = window.__ds; ds.world.getState().replaceDocument(ds.blueprintLib.buildTemplate('riverValley', 3)); });
await wait(500);
await ev(() => window.__ds.actions.addPhenomenon('impact', { event: 'impact', target: [10, 10], material: 'iron', diameter: 2, speed: 12000, angle: 60, azimuth: 45, entry: 'atmosphere' }));
const fp21 = await fp();
const land21 = JSON.stringify((await doc()).landscape);
await enterRun();
const ti21 = (await impactReady()).ti;
const T21 = Math.ceil(ti21 + 8);
await atTime(T21, ti21 + 0.2);
const h21 = await ev(() => ({ t: window.__ds.sim.getTime(), h: Array.from(window.__ds.sim.getEnvironment().terrain.data.heights) }));
await ev(() => window.__ds.actions.resetSimulation());
await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status !== 'loading', { timeout: 60_000 });
const restored21 = await ev(() => { const a = window.__ds.sim.getEnvironment().terrain.data.heights, b = window.__ds.world.getState().doc.terrain.heights; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; });
check('21 river-valley world: reset restores the original ground exactly; the document (terrain, river, buildings, roads, nature) unchanged', restored21 && (await fp()) === fp21 && JSON.stringify((await doc()).landscape) === land21, { restored21 });

// ── 22. Same conditions re-run → same result ────────────────────────────────────────────────────
await ev(() => window.__ds.sim.play());
await atTime(T21, ti21 + 0.2);
const h22 = await ev(() => ({ t: window.__ds.sim.getTime(), h: Array.from(window.__ds.sim.getEnvironment().terrain.data.heights) }));
await shot('22-rerun');
await exitSim();
let diff = 0;
for (let i = 0; i < h21.h.length; i++) if (h21.h[i] !== h22.h[i]) diff++;
check('22 the same conditions reproduce the same crater and deposits (bit-identical heights at the same step)', h21.t === h22.t && diff === 0 && h21.h.some((v, i) => v !== 0), { t: [h21.t, h22.t], diff });

// ── Whole run ─────────────────────────────────────────────────────────────────────────────────
await newWorld();
await wait(500);
const heap1 = await heapMB();
console.log(JSON.stringify({ heap0, heap1, crashed }));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; ${errors.length} page errors; heap ${heap0} → ${heap1} MB; crashed ${crashed}`);
if (errors.length) console.log(errors.slice(0, 10).join('\n'));
fs.writeFileSync(path.join(out, `results-${lang}.json`), JSON.stringify({ lang, url, results, errors, heap: [heap0, heap1], crashed }, null, 2));
await browser.close();
process.exit(results.every((r) => r.ok) && errors.length === 0 && !crashed ? 0 : 1);
