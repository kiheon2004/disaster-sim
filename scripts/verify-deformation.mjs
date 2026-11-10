// Browser verification of the Dynamic Terrain Deformation Engine (Phase 21): 21 scenarios
// through the real UI (Experiment tab, world clicks, overlay toggles, inspector, results) with
// state checks after each step, plus the Phase 20 residual (English left-panel tabs).
//
//   npx vite --port 5199 &     (or a production preview)
//   node scripts/verify-deformation.mjs http://localhost:5199/ ./docs/verify/deformation     (LANG_UI=en)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:5199/', out = './docs/verify/deformation'] = process.argv.slice(2);
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
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('dialog', (d) => d.accept());
await page.goto(url + '?devtools', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('ds.hazardTab', 'experiment'); localStorage.setItem('ds.bottomHeight', '360'); });
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
await page.evaluate((l) => window.__ds.locale.getState().setLocale(l), lang);
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
const deformLive = () => ev(() => window.__ds.simStore.getState().deform);
const runtimeHeight = (x, z) => ev(([x, z]) => window.__ds.sim.getEnvironment().terrain.sampleHeight(x, z), [x, z]);
async function waitSim(t) {
  await page.waitForFunction((t) => window.__ds.sim.getTime() >= t, { timeout: 120_000, polling: 100 }, t);
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
  await ev(() => { window.__ds.actions.newProject(); window.__ds.view.getState().setDeformPreview(null); window.__ds.view.getState().setDeformViz({ mode: 'displacement', foundations: true, exaggeration: 1 }); });
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

const house = () => ev(() => window.__ds.buildingLib.createDesign(window.__ds.buildingLib.presetSpec('house'), 'house'));

// ── 1. Add a terrain deformation in the Experiment tab; only the parameters that apply ──────
await newWorld();
await ev(() => {
  const ds = window.__ds;
  const d = ds.buildingLib.createDesign(ds.buildingLib.presetSpec('house'), 'house');
  ds.world.getState().applyEdit({ add: [
    { type: 'building', building: d, seed: 1, transform: { position: [-12, 0, 6], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    { type: 'car', seed: 2, transform: { position: [-20, 0, 14], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    { type: 'tree', seed: 3, transform: { position: [-28, 0, 18], rotation: [0, 0, 0], scale: [1, 1, 1] } },
  ] });
});
await clickText(/^\s*현상 추가|Add phenomenon/);
await wait(250);
await shot('01-add-menu');
const added = await clickText(lang === 'ko' ? /지형 변형/ : /Terrain deformation/);
await wait(300);
let I = await inst();
const id = I[0]?.id;
await page.click(`[data-testid="exp-edit-${id}"]`);
await wait(300);
const fieldsOf = () => ev((id) => [...document.querySelectorAll(`[data-instance="${id}"] [data-field]`)].map((e) => e.getAttribute('data-field')), id);
const f0 = await fieldsOf();
await page.select(`[data-instance="${id}"] select[data-field="profile"]`, 'staged');
await wait(200);
const f1 = await fieldsOf();
await page.select(`[data-instance="${id}"] select[data-field="kind"]`, 'ridge');
await wait(200);
const f2 = await fieldsOf();
await page.select(`[data-instance="${id}"] select[data-field="kind"]`, 'subsidence');
await page.select(`[data-instance="${id}"] select[data-field="profile"]`, 'smooth');
await wait(200);
await shot('01-editor');
check('1 add deformation; only applicable parameters shown',
  added && I.length === 1 && I[0].type === 'terrainDeformation'
  && !f0.includes('stages') && !f0.includes('length') && f0.includes('falloff')
  && f1.includes('stages') && f2.includes('length') && f2.includes('bearing') && !f2.includes('falloff'),
  { f0, f1, f2 });

// ── 2. Centre picked with a click on the ground (no selection, no edit of the world) ───────
await view(-15, 10, 70, 80);
const objsBefore = Object.keys((await doc()).objects).length;
await page.click('[data-testid="deform-pick"]');
await wait(200);
await moveTo(-15, 10);
async function moveTo(x, z) { const [sx, sy] = await screenOf(x, z); await page.mouse.move(sx, sy, { steps: 3 }); await wait(150); }
await shot('02-pick');
await clickWorld(-15, 10);
I = await inst();
const sel2 = await ev(() => window.__ds.editor.getState().selectedIds);
check('2 centre picked by a world click', Math.hypot(I[0].spec.center[0] + 15, I[0].spec.center[1] - 10) < 1.5 && sel2.length === 0 && Object.keys((await doc()).objects).length === objsBefore && !(await ev(() => window.__ds.view.getState().deformPick)), { center: I[0].spec.center, sel2 });

// ── 3. Radius / max displacement / duration typed into the editor ───────────────────────────
await setNumber(id, 'radius', 22);
await setNumber(id, 'amount', 1.6);
await setNumber(id, 'duration', 4);
I = await inst();
const summary3 = await ev(() => document.querySelector('[data-testid="deform-summary"]')?.textContent);
check('3 parameters edited in the GUI; predicted numbers shown', I[0].spec.radius === 22 && I[0].spec.amount === 1.6 && I[0].spec.duration === 4 && /1\.60/.test(summary3 ?? ''), { spec: I[0].spec, summary3 });

// ── 4. Preview of the predicted final displacement before running ───────────────────────────
await page.click('[data-testid="deform-preview"]');
await wait(400);
const preview = await ev(() => { let n = 0; window.__r3f.get().scene.traverse((o) => { if (o.name === 'deformation-preview') n++; }); return n; });
const heightsUnchanged4 = await ev(() => window.__ds.world.getState().doc.terrain.heights.every((v) => v === 0));
await shot('04-preview');
await page.click('[data-testid="deform-preview"]');
check('4 preview drawn; nothing in the world changed', preview === 1 && heightsUnchanged4, { preview });

// ── 5. Validation: warnings listed with reasons; an invalid spec is shown and not run ──────
await ev((id) => { const a = window.__ds.actions; const i = window.__ds.world.getState().doc.scenario.experiment.instances[0]; a.updatePhenomenon(id, { spec: { ...i.spec, kind: 'depression', amount: 20, radius: 6 } }); }, id);
await wait(300);
const warn5 = await ev((id) => document.querySelector(`[data-instance="${id}"]`).textContent, id);
await shot('05-warning');
await ev((id) => { const a = window.__ds.actions; const i = window.__ds.world.getState().doc.scenario.experiment.instances[0]; a.updatePhenomenon(id, { spec: { ...i.spec, radius: 1 } }); }, id);
await wait(300);
const invalid5 = await ev(() => !!document.querySelector('[data-testid="exp-invalid"]'));
await shot('05-invalid');
await ev((id) => { const a = window.__ds.actions; const i = window.__ds.world.getState().doc.scenario.experiment.instances[0]; a.updatePhenomenon(id, { spec: { ...i.spec, kind: 'subsidence', amount: 1.6, radius: 22 } }); }, id);
await wait(200);
check('5 validation: steep-slope warning with its reason; invalid radius flagged', (lang === 'ko' ? /경사|급/ : /steep/i).test(warn5) && invalid5, { invalid5 });

// ── 6. Run: the runtime ground moves, the document does not ──────────────────────────────────
const fp0 = await fp();
await enterRun();
await waitSim(5);
await view(-15, 10, 40, 60);
const d6 = await deformLive();
const h6 = await runtimeHeight(-15, 10);
const docFlat6 = await ev(() => window.__ds.world.getState().doc.terrain.heights.every((v) => v === 0));
await shot('06-running');
check('6 run: runtime ground lowered by the prescribed amount, document untouched', d6 && Math.abs(d6.maxAbs - 1.6) < 0.01 && Math.abs(h6 + 1.6) < 0.05 && docFlat6 && (await fp()) === fp0, { maxAbs: d6?.maxAbs, h6 });

// ── 7. Rendered terrain = runtime terrain (mesh vertices) ─────────────────────────────────────
const mesh7 = await ev(() => { let r = null; window.__r3f.get().scene.traverse((o) => { if (o.name === 'ground' && o.geometry?.attributes?.position?.count > 4) { const p = o.geometry.attributes.position; const h = window.__ds.sim.getEnvironment().terrain.data.heights; let worst = 0; for (let i = 0; i < p.count; i++) worst = Math.max(worst, Math.abs(p.getY(i) - h[i])); r = { worst, n: p.count }; } }); return r; });
check('7 rendered terrain mesh matches the runtime heights', mesh7 && mesh7.worst < 1e-6, mesh7);

// ── 8. Overlay modes: displacement legend, original ground, exaggerated vectors (labelled) ──
await ev(() => window.__ds.view.getState().setDeformViz({ mode: 'displacement' }));
await wait(300);
await shot('08-displacement');
const legend8 = await ev(() => document.querySelector('[data-testid="deform-overlay"]')?.textContent ?? '');
await ev(() => window.__ds.view.getState().setDeformViz({ mode: 'original' }));
await wait(300);
await shot('08-original');
await ev(() => window.__ds.view.getState().setDeformViz({ mode: 'vectors', exaggeration: 3 }));
await wait(300);
await shot('08-vectors');
const arrows8 = await ev(() => { let n = 0; window.__r3f.get().scene.traverse((o) => { if (o.isInstancedMesh && o.parent?.name === 'deformation-overlay' && o.geometry.type === 'CylinderGeometry') n = o.count; }); return n; });
const note8 = await ev(() => document.querySelector('[data-testid="deform-overlay"]')?.textContent ?? '');
await ev(() => window.__ds.view.getState().setDeformViz({ mode: 'displacement', exaggeration: 1 }));
check('8 overlay modes; exaggeration applies to arrows only and is labelled', /1\.?\d* ?m|m/.test(legend8) && arrows8 > 20 && (lang === 'ko' ? /화살표 길이에만/ : /arrow length only/).test(note8), { arrows8 });

// ── 9. A car on the subsiding ground rests on the new surface ─────────────────────────────────
const car9 = await ev(() => { const e = [...window.__ds.sim.getRuntime().entities.values()].find((e) => e.source.type === 'car'); const g = window.__ds.sim.getEnvironment().terrain.sampleHeight(e.pose.position[0], e.pose.position[2]); return { y: e.pose.position[1], g, y0: e.initialPose.position[1] }; });
check('9 car followed the ground down by contact', car9.y < car9.y0 - 0.3 && Math.abs(car9.y - car9.g) < 1.2, car9);

// ── 10. Building: differential settlement in the inspector ────────────────────────────────────
const bId = await ev(() => [...window.__ds.sim.getRuntime().entities.values()].find((e) => e.source.type === 'building').id);
await ev((id) => window.__ds.editor.getState().select(id), bId);
await wait(500);
const live10 = await ev(() => document.querySelector('[data-testid="ground-live"]')?.textContent ?? '');
await shot('10-building-inspector');
check('10 building ground response in the inspector (settlement, tilt, β, contact, class)', (lang === 'ko' ? /각변위/ : /Angular distortion/).test(live10) && /1\/\d+/.test(live10) && /%/.test(live10), live10.slice(0, 160));

// ── 11. Foundation contact rings ──────────────────────────────────────────────────────────────
const rings11 = await ev(() => { let n = 0; window.__r3f.get().scene.traverse((o) => { if (o.isInstancedMesh && o.parent?.name === 'deformation-overlay' && o.geometry.type === 'RingGeometry') n = o.count; }); return n; });
check('11 foundation contact rings drawn for buildings on moving ground', rings11 >= 1, { rings11 });
await ev(() => window.__ds.editor.getState().select(null));

// ── 12. Ground probe: original / current elevation, displacement, source, support ────────────
await clickWorld(-15, 10);
await wait(400);
const probe12 = await ev(() => document.querySelector('[data-testid="deform-inspector"]')?.textContent ?? '');
await shot('12-probe');
check('12 ground probe shows original / current elevation, displacement and its source', (lang === 'ko' ? /원래 고도.*현재 고도.*변위/s : /Original elevation.*Current elevation.*Displacement/s).test(probe12) && /p1/.test(probe12), probe12.slice(0, 200));

// ── 13. Timeline milestones and log in the current language ───────────────────────────────────
const ms13 = await ev(() => window.__ds.simStore.getState().milestones.map((m) => m.kind));
const log13 = await ev(() => window.__ds.simStore.getState().log.map((l) => window.__ds.tr(l.message.key)).join(' | '));
check('13 deformation milestones on the timeline; log entries translated', ms13.includes('deformPeak') && (lang === 'ko' ? /지형 변형 시작/ : /Terrain deformation started|deformation started/i).test(log13), { ms13 });

// ── 14. Reset restores the original ground exactly; leaving shows the original world ──────────
await ev(() => window.__ds.actions.resetSimulation());
await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status !== 'loading', { timeout: 60_000 });
await wait(400);
const reset14 = await ev(() => ({ engine: !!window.__ds.sim.getEnvironment().deformation.engine, flat: window.__ds.sim.getEnvironment().terrain.data.heights.every((v) => v === 0), mesh: window.__ds.deformLib.currentDeformation() === null }));
await shot('14-reset');
await exitSim();
check('14 reset restores the original ground exactly; fingerprint unchanged on exit', !reset14.engine && reset14.flat && reset14.mesh && (await fp()) === fp0, reset14);

// ── 15. Wide uplift + ridge, staged / cyclic profiles ─────────────────────────────────────────
await ev((id) => { const a = window.__ds.actions; a.updatePhenomenon(id, { spec: { event: 'terrainDeformation', kind: 'uplift', center: [0, 0], radius: 90, amount: 1, duration: 4, profile: 'staged', stages: 4, falloff: 'smooth' } }); a.addPhenomenon('terrainDeformation', { event: 'terrainDeformation', kind: 'ridge', center: [30, -30], radius: 6, length: 60, bearing: 45, amount: 1.2, duration: 6, profile: 'cyclic', period: 3 }); }, id);
await enterRun();
// Record (sim time, height at the centre) every frame, then read the samples (robust to load).
await ev(() => { window.__h15 = []; const f = () => { const s = window.__ds.sim; if (!s.isLoaded()) return; window.__h15.push([s.getTime(), s.getEnvironment().terrain.sampleHeight(0, 0)]); if (s.getTime() < 5) requestAnimationFrame(f); }; requestAnimationFrame(f); });
await waitSim(5);
const steps15 = await ev(() => [0.6, 1.6, 2.6, 4.2].map((t) => { const s = window.__h15.filter((p) => Math.abs(p[0] - t) < 0.3); return s.length ? +s[Math.floor(s.length / 2)][1].toFixed(3) : null; }));
await view(10, -10, 120, 160);
await shot('15-uplift-ridge');
await exitSim();
// Staged: f = ⌊n·τ/D⌋ / n → 0 until D/4, then 0.25, 0.5 … 1 at D.
check('15 staged uplift steps (0.25 m increments) and a cyclic ridge', Math.abs(steps15[0]) < 0.01 && Math.abs(steps15[1] - 0.25) < 0.01 && Math.abs(steps15[2] - 0.5) < 0.01 && steps15[3] > 0.99, { steps15 });

// ── 16. Roads: a road across an instant depression is cut; the network is never edited ──────
await newWorld();
await ev(() => {
  const ds = window.__ds, L = ds.roadLib;
  const net = L.drawRoad(ds.world.getState().doc.roads, [[-80, 0], [80, 0]], { curved: false, profile: L.defaultProfile() }).network;
  ds.world.getState().applyEdit({ roads: net });
  ds.actions.addPhenomenon('terrainDeformation', { event: 'terrainDeformation', kind: 'depression', center: [10, 0], radius: 9, amount: 1.4, duration: 0, profile: 'instant' });
});
const roads16 = JSON.stringify((await doc()).roads);
await enterRun();
await waitSim(1.5);
await view(10, 0, 30, 40);
await wait(800);
const road16 = await ev(() => ({ cut: window.__ds.sim.getRuntime().roads.summary().cut, rows: document.querySelector('[data-testid="road-sim"]')?.parentElement?.textContent ?? '' }));
await shot('16-road-cut');
await exitSim();
check('16 road cut by a step (impassable), shown in the road panel; network unchanged', road16.cut >= 1 && (lang === 'ko' ? /통행 불가/ : /impassable/).test(road16.rows) && JSON.stringify((await doc()).roads) === roads16, { cut: road16.cut });

// ── 17. Lake / river nature: bed and water move together, mass conserved, designs kept ──────
await newWorld();
await ev(() => { const ds = window.__ds; ds.world.getState().replaceDocument(ds.blueprintLib.buildTemplate('riverValley', 3)); });
await wait(500);
const land17 = JSON.stringify((await doc()).landscape);
const lake17 = await ev(() => { const f = window.__ds.world.getState().doc.landscape.features.find((f) => f.kind === 'lake') ?? window.__ds.world.getState().doc.landscape.features[0]; const xs = f.points.map((p) => p[0]), zs = f.points.map((p) => p[1]); return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2]; });
await ev((c) => window.__ds.actions.addPhenomenon('terrainDeformation', { event: 'terrainDeformation', kind: 'subsidence', center: c, radius: 25, amount: 1, duration: 3, profile: 'smooth', falloff: 'smooth' }), lake17);
await enterRun();
await waitSim(1);
const vol17a = await ev(() => window.__ds.sim.getEnvironment().flood.field?.totalVolume() ?? null);
await waitSim(8);
const st17 = await ev(() => ({ v: window.__ds.sim.getEnvironment().flood.field?.totalVolume() ?? null, live: window.__ds.simStore.getState().deform, flood: window.__ds.simStore.getState().flood }));
await view(lake17[0], lake17[1], 60, 80);
await shot('17-lake');
const hud17 = await ev(() => document.querySelector('[data-testid="deform-hud"]')?.textContent ?? '');
await exitSim();
check('17 lake over subsiding ground: water moves with the bed, mass budget closes, designs unchanged', vol17a !== null && st17.live.bedVolume > 0 && st17.flood.relativeError < 1e-6 && JSON.stringify((await doc()).landscape) === land17 && hud17.length > 0, { bed: st17.live.bedVolume, err: st17.flood.relativeError });

// ── 18. Flood + deformation: rain pools in the new bowl ───────────────────────────────────────
await newWorld();
await ev(() => {
  const a = window.__ds.actions;
  a.addPhenomenon('rain', { ...window.__ds.deformLib.phenomena.implemented('rain').defaults(), intensity: 200, duration: 30 });
  a.addPhenomenon('terrainDeformation', { event: 'terrainDeformation', kind: 'subsidence', center: [0, 0], radius: 25, amount: 1.2, duration: 5, profile: 'linear', falloff: 'smooth' });
});
await enterRun();
await waitSim(25);
const depth18 = await ev(() => { const f = window.__ds.sim.getEnvironment().flood.field; return { c: f.sampleDepth(0, 0), o: f.sampleDepth(60, 60) }; });
await ev(() => window.__ds.view.getState().setFloodViz({ mode: 'depth' }));
await view(0, 0, 50, 70);
await shot('18-flood-bowl');
await ev(() => window.__ds.view.getState().setFloodViz({ mode: 'normal' }));
await exitSim();
check('18 flood + deformation: rain collects in the subsided bowl', depth18.c > 3 * depth18.o && depth18.c > 0.003, depth18);

// ── 19. Multi-hazard: earthquake + subsidence; results report ground separately ──────────────
await newWorld();
await ev(() => {
  const ds = window.__ds, a = ds.actions;
  const d = ds.buildingLib.createDesign(ds.buildingLib.presetSpec('house'), 'house');
  const add = [];
  for (let k = 0; k < 6; k++) add.push({ type: 'building', building: d, seed: k + 1, transform: { position: [-25 + k * 10, 0, 8], rotation: [0, 0, 0], scale: [1, 1, 1] } });
  ds.world.getState().applyEdit({ add });
  a.addPhenomenon('earthquake', { ...ds.deformLib.phenomena.implemented('earthquake').defaults(), magnitude: 6.2, duration: 10 });
  a.addPhenomenon('terrainDeformation', { event: 'terrainDeformation', kind: 'subsidence', center: [0, 8], radius: 20, amount: 1.2, duration: 3, profile: 'smooth', falloff: 'smooth' });
});
await enterRun();
await waitSim(12);
await ev(() => window.__ds.ui.getState().setResultsOpen(true));
await wait(800);
const res19 = await ev(() => ({ hazards: [...new Set(window.__ds.sim.getDamageEvents().map((e) => e.hazard))], text: document.body.textContent }));
await shot('19-results');
await ev(() => window.__ds.ui.getState().setResultsOpen(false));
await exitSim();
check('19 multi-hazard: ground damage reported separately from the earthquake', res19.hazards.includes('ground') && (lang === 'ko' ? /지반/ : /Ground/).test(res19.text), { hazards: res19.hazards });

// ── 20. Save / load: the deformation is part of the experiment; water over deformed ground is refused ─
const saved20 = await ev(() => {
  const ds = window.__ds;
  const text = ds.buildLib.serializeDocument(ds.world.getState().doc);
  const r = ds.buildLib.parseDocument(text);
  return { version: JSON.parse(text).schemaVersion, ok: r.ok, inst: r.ok ? r.doc.scenario.experiment.instances.map((i) => [i.type, i.spec.kind ?? null]) : null };
});
await enterRun();
await waitSim(4);
await ev(() => window.__ds.actions.saveWaterState());
await wait(300);
const toast20 = await ev(() => document.body.textContent);
await shot('20-water-refused');
await exitSim();
check('20 experiment saved and reloaded (schema unchanged); mid-run water over deformed ground refused with a reason', saved20.ok && saved20.version === 7 && saved20.inst.some((i) => i[0] === 'terrainDeformation' && i[1] === 'subsidence') && (lang === 'ko' ? /저장할 수 없습니다/ : /cannot be saved/).test(toast20), saved20);

// ── 21. Disabled instance: no deformation at all ──────────────────────────────────────────────
await ev(() => { const a = window.__ds.actions; for (const i of window.__ds.world.getState().doc.scenario.experiment.instances) a.updatePhenomenon(i.id, { enabled: i.type !== 'terrainDeformation' }); });
await enterRun();
await waitSim(4);
const off21 = await ev(() => ({ engine: !!window.__ds.sim.getEnvironment().deformation.engine, hud: !!document.querySelector('[data-testid="deform-hud"]') }));
await exitSim();
check('21 a disabled deformation does nothing (no engine, no HUD)', !off21.engine && !off21.hud, off21);

// ── Phase 20 residual: English / Korean left-panel tabs fit (no clipped labels) ──────────────
await newWorld();
const tabs = await ev(() => [...document.querySelectorAll('[role="tablist"] [role="tab"], [data-testid^="tab-"]')].filter((b) => b.closest('aside, nav, [class*="palette" i]') || b.dataset.testid?.startsWith('tab-')).map((b) => ({ text: b.textContent.trim(), clipped: b.scrollWidth > b.clientWidth + 1 })));
await page.screenshot({ path: path.join(out, `00-left-tabs-${lang}.png`), clip: { x: 0, y: 46, width: 236, height: 160 } });
check('residual B: left-panel tabs fully visible', tabs.length >= 6 && tabs.every((t) => !t.clipped), tabs);

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; ${errors.length} page errors`);
if (errors.length) console.log(errors.slice(0, 10).join('\n'));
fs.writeFileSync(path.join(out, `results-${lang}.json`), JSON.stringify({ lang, url, results, errors }, null, 2));
await browser.close();
process.exit(results.every((r) => r.ok) && errors.length === 0 ? 0 : 1);
