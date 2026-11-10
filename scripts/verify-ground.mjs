// Browser verification of sinkholes and landslides (Phase 22): 22 scenarios through the real UI
// (Experiment tab, world clicks / polygon drawing, previews, overlay modes, HUD, inspector,
// results, save) with state checks after each step.
//
//   npx vite --port 5199 &     (or a production preview)
//   node scripts/verify-ground.mjs http://localhost:5199/ ./docs/verify/ground     (LANG_UI=en)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:5199/', out = './docs/verify/ground'] = process.argv.slice(2);
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
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('ds.hazardTab', 'experiment'); localStorage.setItem('ds.bottomHeight', '380'); });
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
async function moveTo(x, z) { const [sx, sy] = await screenOf(x, z); await page.mouse.move(sx, sy, { steps: 3 }); await wait(150); }
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
const groundLive = () => ev(() => window.__ds.simStore.getState().ground);
const runtimeHeight = (x, z) => ev(([x, z]) => window.__ds.sim.getEnvironment().terrain.sampleHeight(x, z), [x, z]);
const sceneCount = (name) => ev((name) => { let n = 0; window.__r3f.get().scene.traverse((o) => { if (o.name === name) n++; }); return n; }, name);
const text = (sel) => ev((sel) => document.querySelector(sel)?.textContent ?? '', sel);
async function waitSim(t) {
  // Also resolves when the experiment ended earlier (its end time is the phenomena's own duration).
  await page.waitForFunction((t) => window.__ds.sim.getTime() >= t || window.__ds.simStore.getState().status === 'finished', { timeout: 180_000, polling: 100 }, t);
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
  await ev(() => {
    window.__ds.actions.newProject();
    const v = window.__ds.view.getState();
    v.setGroundPreview(null); v.setGroundPick(null); v.setGroundViz({ mode: 'change', arrows: true, sources: true, dust: true });
  });
  await wait(300);
}
/** Plane descending toward +x at `deg` from x = −90 to 0, flat beyond (Phase 22 test world). */
async function slopeWorld(deg, soil = 1) {
  await newWorld();
  await ev(([deg, soil]) => {
    const ds = window.__ds, S = ds.world.getState();
    const t0 = S.doc.terrain;
    const heights = new Float32Array(t0.heights.length);
    const tb = Math.tan((deg * Math.PI) / 180);
    for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) { const x = t0.originX + ix * t0.cellSize; heights[iz * t0.nx + ix] = x < 0 ? Math.min(90, -x) * tb : 0; }
    S.applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length).fill(soil === 2 ? 2 : 0) } } });
    if (soil !== 1) ds.world.getState().doc.terrain.soil.fill(soil);
  }, [deg, soil]);
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
async function expand(id) {
  const open = await ev((id) => document.querySelector(`[data-testid="exp-edit-${id}"]`)?.getAttribute('aria-expanded') === 'true', id);
  if (!open) await page.click(`[data-testid="exp-edit-${id}"]`);
  await wait(300);
}
const fieldsOf = (id) => ev((id) => [...document.querySelectorAll(`[data-instance="${id}"] [data-field]`)].map((e) => e.getAttribute('data-field')), id);
const addHouse = (x, z, seed = 1) => ev(([x, z, seed]) => {
  const ds = window.__ds;
  const d = ds.buildingLib.createDesign(ds.buildingLib.presetSpec('house'), 'house');
  ds.world.getState().applyEdit({ add: [{ type: 'building', building: d, seed, transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] } }] });
}, [x, z, seed]);
const sinkSpec = (x = {}) => ({ event: 'sinkhole', center: [0, 0], cavityRadius: 4, cavityHeight: 8, cover: 5, initiation: 'supportLoss', supportLoss: 0.9, duration: 1, ...x });
const slideSpec = (x = {}) => ({ event: 'landslide', area: { kind: 'circle', center: [-30, 0], radius: 12 }, thickness: 1.5, saturation: 0.2, trigger: 'saturation', targetSaturation: 1, duration: 6, ...x });

// ── 1. Add a sinkhole in the Experiment tab; only the parameters of its initiation are shown ──
await newWorld();
await addHouse(9, 0, 1);
await clickText(/^\s*현상 추가|Add phenomenon/);
await wait(250);
await shot('01-add-menu');
const added1 = await clickText(lang === 'ko' ? /싱크홀/ : /Sinkhole/);
await wait(300);
let I = await inst();
const sid = I[0]?.id;
await expand(sid);
const f1a = await fieldsOf(sid);
await page.select(`[data-instance="${sid}"] select[data-field="initiation"]`, 'supportLoss');
await wait(200);
const f1b = await fieldsOf(sid);
await shot('01-sinkhole-editor');
check('1 add sinkhole; parameters follow the initiation mode',
  added1 && I[0]?.type === 'sinkhole' && f1a.includes('growthRate') && !f1a.includes('supportLoss') && f1b.includes('supportLoss') && !f1b.includes('growthRate') && f1b.includes('cover') && f1b.includes('material'),
  { f1a, f1b });

// ── 2. Centre picked with a click on the ground (no selection, no world edit) ─────────────────
await view(0, 0, 60, 70);
const objs2 = Object.keys((await doc()).objects).length;
await page.click('[data-testid="ground-pick"]');
await wait(200);
await moveTo(6, 2);
await shot('02-pick');
await clickWorld(6, 2);
I = await inst();
const sel2 = await ev(() => window.__ds.editor.getState().selectedIds);
check('2 sinkhole centre picked by a world click', Math.hypot(I[0].spec.center[0] - 6, I[0].spec.center[1] - 2) < 1.5 && sel2.length === 0 && Object.keys((await doc()).objects).length === objs2 && !(await ev(() => window.__ds.view.getState().groundPick)), { center: I[0].spec.center });

// ── 3. Parameters typed; predicted roof FS / critical radius / drop shown ─────────────────────
await setNumber(sid, 'cavityRadius', 4);
await setNumber(sid, 'cavityHeight', 8);
await setNumber(sid, 'cover', 5);
await setNumber(sid, 'supportLoss', 90);
await setNumber(sid, 'duration', 1);
I = await inst();
const sum3 = await text('[data-testid="ground-summary"]');
const verdict3 = await ev(() => document.querySelector('[data-testid="ground-summary"]')?.dataset.verdict);
check('3 sinkhole parameters edited; predicted critical radius, FS and pit shown', I[0].spec.cavityRadius === 4 && I[0].spec.cover === 5 && Math.abs(I[0].spec.supportLoss - 0.9) < 1e-9 && /a_c/.test(sum3) && verdict3 === 'fail', { sum3, spec: I[0].spec });

// ── 4. Sinkhole preview rings; nothing in the world changes ───────────────────────────────────
await page.click('[data-testid="ground-preview"]');
await wait(400);
const prev4 = await sceneCount('sinkhole-preview');
await shot('04-sinkhole-preview');
await page.click('[data-testid="ground-preview"]');
const flat4 = await ev(() => window.__ds.world.getState().doc.terrain.heights.every((v) => v === 0));
check('4 sinkhole preview drawn (cavity / critical / pit); world unchanged', prev4 === 1 && flat4, { prev4 });

// ── 5. Run: plug failure, pit on the runtime ground, document untouched; HUD ──────────────────
await ev((id) => { const a = window.__ds.actions; const i = window.__ds.world.getState().doc.scenario.experiment.instances[0]; a.updatePhenomenon(id, { spec: { ...i.spec, center: [0, 0] } }); }, sid);
const fp5 = await fp();
await enterRun();
await waitSim(6);
await view(4, 0, 35, 45);
const g5 = await groundLive();
const h5 = await runtimeHeight(0, 0);
await shot('05-sinkhole-run');
const hud5 = await text('[data-testid="ground-hud"]');
check('5 sinkhole collapses on the runtime ground; document untouched; HUD shows its phase', g5 && g5.sinkholes[0].phase !== 'stable' && h5 < -0.5 && (await ev(() => window.__ds.world.getState().doc.terrain.heights.every((v) => v === 0))) && (await fp()) === fp5 && hud5.includes(sid), { phase: g5?.sinkholes[0].phase, h5 });

// ── 6. Rendered terrain mesh = runtime heights ────────────────────────────────────────────────
const mesh6 = await ev(() => { let r = null; window.__r3f.get().scene.traverse((o) => { if (o.name === 'ground' && o.geometry?.attributes?.position?.count > 4) { const p = o.geometry.attributes.position; const h = window.__ds.sim.getEnvironment().terrain.data.heights; let worst = 0; for (let i = 0; i < p.count; i++) worst = Math.max(worst, Math.abs(p.getY(i) - h[i])); r = { worst, n: p.count }; } }); return r; });
check('6 rendered terrain mesh matches the runtime heights', mesh6 && mesh6.worst < 1e-6, mesh6);

// ── 7. Overlay modes (FS / moving / deposit / height change); dust labelled visual only ─────
const modes7 = {};
for (const m of ['stability', 'sediment', 'deposit', 'change']) {
  await ev((m) => window.__ds.view.getState().setGroundViz({ mode: m }), m);
  await wait(350);
  await shot(`07-${m}`);
  modes7[m] = await ev(() => { let vis = false; window.__r3f.get().scene.traverse((o) => { if (o.parent?.name === 'ground-failure-overlay' && o.isMesh && !o.isInstancedMesh) vis = o.visible; }); return vis; });
}
const note7 = await text('[data-testid="ground-overlay"]');
check('7 ground overlay modes shown; dust labelled as a visual effect only', Object.values(modes7).every(Boolean) && (lang === 'ko' ? /시각 효과/ : /visual effect/i).test(note7), modes7);
await ev(() => window.__ds.view.getState().setGroundViz({ mode: 'change' }));

// ── 8. The house next to the pit: ground response / sediment section in the inspector ────────
const b8 = await ev(() => [...window.__ds.sim.getRuntime().entities.values()].find((e) => e.source.type === 'building').id);
await ev((id) => window.__ds.editor.getState().select(id), b8);
await wait(500);
const live8 = await ev(() => document.querySelector('[data-testid="ground-live"]')?.textContent ?? '');
await shot('08-building');
await ev(() => window.__ds.editor.getState().select(null));
check('8 building near the pit: ground response in the inspector', live8.length > 0, live8.slice(0, 160));

// ── 9. Ground probe: material, slope, FS, change, source ──────────────────────────────────────
await clickWorld(1, 0);
await wait(500);
const probe9 = await text('[data-testid="ground-inspector"]');
await shot('09-probe');
check('9 ground probe: material, slope, water, FS, height change, source', (lang === 'ko' ? /지반 재료.*경사.*안전율.*높이 변화/s : /Ground material.*Slope.*Factor of safety.*Height change/s).test(probe9) && probe9.includes(sid), probe9.slice(0, 220));

// ── 10. Timeline milestones and log in the current language ───────────────────────────────────
const ms10 = await ev(() => window.__ds.simStore.getState().milestones.map((m) => m.kind));
const log10 = await ev(() => window.__ds.simStore.getState().log.map((l) => window.__ds.tr(l.message.key)).join(' | '));
check('10 sinkhole milestones on the timeline; log translated', ms10.includes('sinkholeInit') && (lang === 'ko' ? /싱크홀/ : /Sinkhole/).test(log10), { ms10 });

// ── 11. Mid-run save: only the original world + plan; the user is told ───────────────────────
await page.click('[data-testid="save"]');
await wait(400);
const toast11 = await ev(() => document.body.textContent);
const saved11 = await ev(() => Object.keys(localStorage).some((k) => (localStorage.getItem(k) ?? '').includes('"schemaVersion"') && !(localStorage.getItem(k) ?? '').includes('releasedInSitu')));
const manifest11 = await ev(() => window.__ds.sim.runtimeState().map((c) => [c.id, c.kind, c.present]));
await shot('11-save-notice');
check('11 save during a run: original world saved, mid-run state explicitly not saved', (lang === 'ko' ? /실행 중간 저장은 지원하지 않습니다/ : /mid-run saving is not supported/).test(toast11) && !!saved11 && manifest11.some(([id, k, p]) => id === 'groundFailure' && k === 'state' && p), { manifest11 });

// ── 12. Reset restores the original ground; exit keeps the fingerprint ───────────────────────
await ev(() => window.__ds.actions.resetSimulation());
await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status !== 'loading', { timeout: 60_000 });
await wait(400);
const reset12 = await ev(() => ({ field: window.__ds.sim.getEnvironment().groundFailure.active, flat: window.__ds.sim.getEnvironment().terrain.data.heights.every((v) => v === 0) }));
await exitSim();
check('12 reset restores the original ground; fingerprint unchanged on exit', reset12.flat && (await fp()) === fp5, reset12);

// ── 13. Landslide: polygon source area drawn by world clicks ──────────────────────────────────
await slopeWorld(30);
await clickText(/^\s*현상 추가|Add phenomenon/);
await wait(250);
await clickText(lang === 'ko' ? /^\s*산사태/ : /^\s*Landslide/);
await wait(300);
I = await inst();
const lid = I[0]?.id;
await expand(lid);
await view(-30, 0, 70, 80);
await page.click('[data-testid="ground-draw"]');
await wait(200);
for (const [x, z] of [[-42, -12], [-18, -12], [-18, 12], [-42, 12]]) await clickWorld(x, z);
await moveTo(-40, 8);
await shot('13-draw');
await page.keyboard.press('Enter');
await wait(300);
I = await inst();
const area13 = I[0].spec.area;
check('13 landslide source area drawn as a polygon (4 corners, Enter)', I[0].type === 'landslide' && area13.kind === 'polygon' && area13.points.length === 4 && Math.abs(area13.points[0][0] + 42) < 1.5, area13);

await setNumber(lid, 'duration', 6);
// ── 14. FS preview of the area; predicted failure; circle conversion ─────────────────────────
await page.click('[data-testid="ground-preview"]');
await wait(500);
const prev14 = await sceneCount('landslide-preview');
const sum14 = await text('[data-testid="ground-summary"]');
await shot('14-fs-preview');
await page.click('[data-testid="ground-preview"]');
I = await inst();
check('14 FS map preview of the area with min FS and unstable share; ramp edited', I[0].spec.duration === 6 && prev14 === 1 && /FS|안전율/.test(sum14) && /\d+\/\d+/.test(sum14), sum14);

// ── 15. Run: saturation trigger fails the slope, sediment flows downhill, budget closes ──────
const fp15 = await fp();
await enterRun();
await waitSim(4);
await ev(() => window.__ds.view.getState().setGroundViz({ mode: 'sediment', arrows: true }));
await waitSim(9);
await view(-15, 0, 45, 60);
await wait(500);
const g15 = await groundLive();
const arrows15 = await ev(() => { let n = 0; window.__r3f.get().scene.traverse((o) => { if (o.isInstancedMesh && o.parent?.name === 'ground-failure-overlay') n = o.count; }); return n; });
await shot('15-landslide-flow');
check('15 slope fails when saturated; sediment moves (flow arrows), budget closes', g15 && g15.released > 0 && g15.landslides[0].failed > 0 && arrows15 > 0 && Math.abs(g15.residual) < 1e-6 * g15.released, { released: g15?.released, arrows15, residual: g15?.residual });

// ── 16. At rest: deposit at the toe, document untouched ─────────────────────────────────────
await waitSim(40);
const g16 = await groundLive();
await ev(() => window.__ds.view.getState().setGroundViz({ mode: 'deposit' }));
await wait(400);
await shot('16-deposit');
const toe16 = await ev(() => { const f = window.__ds.sim.getEnvironment().groundFailure.field; let d = 0; for (let i = 0; i < f.n; i++) { const x = f.originX + (i % f.nx) * f.dx; if (x > -5) d += f.loose[i]; } return d; });
await exitSim();
check('16 sediment comes to rest as a deposit at the toe; original world kept', g16.mobile < 0.1 * g16.released && toe16 > 1 && (await fp()) === fp15, { mobile: g16.mobile, released: g16.released, toe16 });

// ── 17. Road at the toe blocked by the deposit; network unchanged ─────────────────────────────
await ev(() => {
  const ds = window.__ds, L = ds.roadLib;
  ds.world.getState().applyEdit({ roads: L.drawRoad(ds.world.getState().doc.roads, [[3, -60], [3, 60]], { curved: false, profile: L.defaultProfile() }).network });
  const i = ds.world.getState().doc.scenario.experiment.instances[0];
  ds.actions.updatePhenomenon(i.id, { spec: { ...i.spec, trigger: 'user', saturation: 1, thickness: 2.5, area: { kind: 'circle', center: [-14, 0], radius: 12 } } });
});
const roads17 = JSON.stringify((await doc()).roads);
await enterRun();
await waitSim(30);
await view(3, 0, 40, 50);
await wait(600);
const g17 = await groundLive();
const panel17 = await ev(() => document.querySelector('[data-testid="road-sim"]')?.parentElement?.textContent ?? '');
await shot('17-road-blocked');
const hazards17 = await ev(() => [...new Set(window.__ds.sim.getDamageEvents().map((e) => e.hazard))]);
await exitSim();
check('17 road at the toe blocked by the deposit; network unchanged; no wind attribution', g17.blockedRoads >= 1 && (lang === 'ko' ? /통행 불가/ : /impassable/).test(panel17) && JSON.stringify((await doc()).roads) === roads17 && !hazards17.includes('wind'), { blocked: g17.blockedRoads, hazards17 });

// ── 18. Landslide into a lake: water mass exact, the deposit displaces water ─────────────────
await newWorld();
await ev(() => {
  const ds = window.__ds, S = ds.world.getState();
  const t0 = S.doc.terrain;
  const heights = new Float32Array(t0.heights.length);
  const tb = Math.tan((32 * Math.PI) / 180);
  for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) { const x = t0.originX + ix * t0.cellSize; heights[iz * t0.nx + ix] = x < 0 ? Math.min(90, -x) * tb : 0; }
  S.applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length) } } });
  ds.world.getState().setFeatures([{ id: 'f1', kind: 'lake', points: [[0, -40], [60, -40], [60, 40], [0, 40]], surface: -0.3, depth: 3, shoreWidth: 4, material: 7, filled: true }], 2);
  ds.world.getState().updateSimulationSettings({ water: { ...ds.world.getState().doc.settings.simulation.water, infiltration: false, drainageCapacity: 0 } });
  ds.actions.addPhenomenon('landslide', { event: 'landslide', area: { kind: 'circle', center: [-12, 0], radius: 10 }, thickness: 1.5, saturation: 1, trigger: 'user', duration: 0, startTime: 1 });
});
await enterRun();
await waitSim(1);
const v18a = await ev(() => window.__ds.sim.getEnvironment().flood.field?.totalVolume() ?? null);
await waitSim(30);
const st18 = await ev(() => ({ v: window.__ds.sim.getEnvironment().flood.field?.totalVolume() ?? null, err: window.__ds.simStore.getState().flood?.relativeError, sub: (() => { const f = window.__ds.sim.getEnvironment().groundFailure.field; let s = 0; for (let i = 0; i < f.n; i++) { const x = f.originX + (i % f.nx) * f.dx; if (x > 1) s += f.loose[i] + f.h[i]; } return s; })() }));
await view(5, 0, 45, 55);
await shot('18-lake');
await exitSim();
check('18 landslide into a lake: sediment enters the water, water mass exact', v18a !== null && st18.sub > 0 && Math.abs(st18.v - v18a) / v18a < 1e-6, { v18a, ...st18 });

// ── 19. Landslide + earthquake (Newmark); HUD shows the displacement ──────────────────────────
await slopeWorld(28);
await ev(() => {
  const a = window.__ds.actions;
  a.addPhenomenon('landslide', { event: 'landslide', area: { kind: 'circle', center: [-40, 0], radius: 15 }, thickness: 1.5, saturation: 0.62, trigger: 'earthquake', duration: 0, newmarkLimit: 0.05 });
  a.addPhenomenon('earthquake', { ...window.__ds.deformLib.phenomena.implemented('earthquake').defaults(), magnitude: 7, pga: 0.45, duration: 15, seed: 3 });
});
await enterRun();
await waitSim(16);
const g19 = await groundLive();
await view(-30, 0, 60, 70);
await shot('19-earthquake');
const hud19 = await text('[data-testid="ground-hud"]');
await exitSim();
check('19 earthquake: Newmark displacement accumulates on the slope (HUD)', g19.landslides[0].newmark > 0.001 && /D \d/.test(hud19), { newmark: g19.landslides[0].newmark, failed: g19.landslides[0].failed });

// ── 20. All hazards (rain + earthquake + sinkhole + landslide + wind 0): results by hazard ───
await slopeWorld(30, 2);
await addHouse(14, 20, 2);
await addHouse(-10, 30, 3);
await ev(() => {
  const ds = window.__ds, a = ds.actions;
  ds.world.getState().updateSimulationSettings({ water: { ...ds.world.getState().doc.settings.simulation.water, infiltrationScale: 5 } });
  a.addPhenomenon('rain', { ...ds.deformLib.phenomena.implemented('rain').defaults(), intensity: 150, duration: 60 });
  a.addPhenomenon('earthquake', { ...ds.deformLib.phenomena.implemented('earthquake').defaults(), magnitude: 6.5, pga: 0.3, duration: 10, seed: 4 });
  a.addPhenomenon('sinkhole', { event: 'sinkhole', center: [14, 20], cavityRadius: 5, cavityHeight: 8, cover: 5, initiation: 'supportLoss', supportLoss: 0.9, duration: 2 });
  a.addPhenomenon('landslide', { event: 'landslide', area: { kind: 'circle', center: [-25, -10], radius: 12 }, thickness: 1.5, saturation: 0.9, trigger: 'user', duration: 0 });
});
await enterRun();
await waitSim(20);
await ev(() => window.__ds.ui.getState().setResultsOpen(true));
await wait(800);
const res20 = await ev(() => ({ hazards: [...new Set(window.__ds.sim.getDamageEvents().map((e) => e.hazard))], text: document.body.textContent }));
await shot('20-results');
await ev(() => window.__ds.ui.getState().setResultsOpen(false));
await exitSim();
check('20 all hazards: ground damage reported separately; nothing attributed to wind (calm)', res20.hazards.includes('ground') && !res20.hazards.includes('wind') && (lang === 'ko' ? /지반/ : /Ground/).test(res20.text), { hazards: res20.hazards });

// ── 21. Save / load: sinkhole + polygon landslide round trip, schema 7 ───────────────────────
const saved21 = await ev(() => {
  const ds = window.__ds;
  const a = ds.actions;
  const i = ds.world.getState().doc.scenario.experiment.instances.find((x) => x.type === 'landslide');
  a.updatePhenomenon(i.id, { spec: { ...i.spec, area: { kind: 'polygon', points: [[-40, -20], [-15, -20], [-15, 0], [-40, 0]] } } });
  const t = ds.buildLib.serializeDocument(ds.world.getState().doc);
  const r = ds.buildLib.parseDocument(t);
  return { version: JSON.parse(t).schemaVersion, ok: r.ok, inst: r.ok ? r.doc.scenario.experiment.instances.map((x) => [x.type, x.spec.area?.kind ?? x.spec.initiation ?? null]) : null };
});
check('21 sinkholes and polygon landslides saved and reloaded (schema 7)', saved21.ok && saved21.version === 7 && saved21.inst.some((x) => x[0] === 'sinkhole' && x[1] === 'supportLoss') && saved21.inst.some((x) => x[0] === 'landslide' && x[1] === 'polygon'), saved21);

// ── 22. Disabled ground instances: no ground channel, no HUD ─────────────────────────────────
await ev(() => { const a = window.__ds.actions; for (const i of window.__ds.world.getState().doc.scenario.experiment.instances) a.updatePhenomenon(i.id, { enabled: i.type !== 'sinkhole' && i.type !== 'landslide' }); });
await enterRun();
await waitSim(3);
const off22 = await ev(() => ({ active: window.__ds.sim.getEnvironment().groundFailure.active, hud: !!document.querySelector('[data-testid="ground-hud"]') }));
await exitSim();
check('22 disabled sinkhole / landslide do nothing (no ground field, no HUD)', !off22.active && !off22.hud, off22);

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; ${errors.length} page errors`);
if (errors.length) console.log(errors.slice(0, 10).join('\n'));
fs.writeFileSync(path.join(out, `results-${lang}.json`), JSON.stringify({ lang, url, results, errors }, null, 2));
await browser.close();
process.exit(results.every((r) => r.ok) && errors.length === 0 ? 0 : 1);
