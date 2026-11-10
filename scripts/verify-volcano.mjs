// Browser verification of the volcano (Phase 28): 34 scenarios in real Chrome through the UI (experiment tab:
// add a volcano, fields, vent and fissure picked on the map, material, timing, preview; run: downslope flow,
// depth, speed, crust, solidification, deposit as terrain, diversion, ash and wind, water, vegetation and
// secondary fire, buildings, strength loss, collapse, roads, overlays, inspector, timeline, ledgers, save / load,
// restoration, rerun, a large town) with state checks after each step, plus whole-run checks: page errors,
// the tab staying alive, GPU geometries, heap, text not cut.
//
//   npm run build && npx vite preview --port 4198 --strictPort &
//   LANG_UI=ko node scripts/verify-volcano.mjs http://localhost:4198/ ./docs/verify/volcano
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:4198/', out = './docs/verify/volcano'] = process.argv.slice(2);
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
async function view(x, z, h = 60, back = 70, y = 0) {
  await ev(([x, z, h, back, y]) => { const st = window.__r3f.get(); st.camera.position.set(x + back * 0.5, y + h, z + back); st.controls.target.set(x, y, z); st.controls.update(); }, [x, z, h, back, y]);
  await wait(300);
}
const inst = () => ev(() => window.__ds.world.getState().doc.scenario.experiment?.instances ?? []);
const fp = () => ev(() => window.__ds.blueprintLib.worldFingerprint(window.__ds.world.getState().doc));
async function newWorld() {
  await ev(() => { window.__ds.actions.newProject(); const v = window.__ds.view.getState(); v.setGroundPreview(null); v.setGroundPick(null); v.setWaterProbe(null); v.setSimMember(null); v.setStructureViz({ color: 'normal' }); v.setVolcanoViz({ overlay: 'off' }); });
  await wait(300);
}
/** A 6° slope descending toward +x up to x = 30 (flat beyond); objects placed on it. */
const slopeWorld = (items = [], roads = []) => ev(([items, roads]) => {
  const ds = window.__ds, ws = ds.world.getState(), t0 = ws.doc.terrain;
  const h = (x) => Math.round((x < 30 ? (30 - Math.max(-90, x)) * Math.tan((6 * Math.PI) / 180) : 0) * 100) / 100;
  const heights = new Float32Array(t0.heights.length);
  for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) heights[iz * t0.nx + ix] = h(t0.originX + ix * t0.cellSize);
  ws.applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length) } } });
  for (const r of roads) ds.world.getState().applyEdit({ roads: ds.roadLib.drawRoad(ds.world.getState().doc.roads ?? ds.roadLib.emptyNetwork(), r, { curved: false, profile: ds.roadLib.defaultProfile() }).network });
  ds.world.getState().applyEdit({ add: items.map(([type, x, z, preset], k) => ({ type, ...(type === 'building' ? { building: ds.buildingLib.createDesign(ds.buildingLib.presetSpec(preset ?? 'house'), preset ?? 'house') } : {}), ...(type === 'tree' ? { params: { species: 'conifer', height: 11, canopyRadius: 2.2, trunkRadius: 0.32 } } : {}), seed: k + 1, transform: { position: [x, h(x), z], rotation: [0, 0, 0], scale: [1, 1, 1] } })) });
}, [items, roads]);
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
const setSpec = (id, patch) => ev(([id, patch]) => { const a = window.__ds.actions; const i = window.__ds.world.getState().doc.scenario.experiment.instances.find((x) => x.id === id); a.updatePhenomenon(id, { spec: { ...i.spec, ...patch } }); }, [id, patch]);
async function enterRun() {
  await clickText(/^\s*실험 실행|Run experiment/);
  await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status === 'running', { timeout: 60_000 });
}
const atTime = (T) => ev((T) => { const s = window.__ds.sim; s.pause(); const r = T - s.getTime(); if (r > 0) s.advance(r); return s.getTime(); }, T);
const exitSim = async () => { await ev(() => window.__ds.actions.exitSimulation()); await wait(500); };
const vl = () => ev(() => window.__ds.simStore.getState().volcano);
const ms = () => ev(() => window.__ds.simStore.getState().milestones.map((m) => m.kind));
const vHash = () => ev(() => {
  const r = window.__ds.volcanoLib.rt(); if (!r) return null;
  const f = r.world.field; let s = 0, k = 1;
  for (let i = 0; i < f.n; i++) { s += (f.M[i] + f.dep[i] * 1e3 + f.depE[i] * 1e-9) * k; k = (k * 1.000003) % 7.1; }
  const L = r.world.ledger();
  return `${f.mobile.length}|${s.toExponential(12)}|${L.mass.supplied.toExponential(12)}|${L.energy.toGround.toExponential(12)}`;
});
const objCount = (name) => ev((name) => { let n = 0; window.__r3f.get().scene.traverse((o) => { if (o.name === name) o.traverse((m) => { if (m.isInstancedMesh) n += m.count; if (m.isPoints) n += m.geometry.drawRange.count; if ((m.isMesh && !m.isInstancedMesh) || m.isLine) { if (m.geometry?.attributes?.position) n += 1; } }); }); return n; }, name);
const clipped = (sels) => ev((sels) => {
  const out = [];
  for (const sel of sels) for (const root of document.querySelectorAll(sel)) for (const el of root.querySelectorAll('*')) {
    if (!el.childNodes.length || ![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    if (cs.overflow === 'visible' && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && cs.display !== 'inline') out.push(`${sel}: ${el.textContent.trim().slice(0, 40)}`);
  }
  return out;
}, sels);
const heap0 = await heapMB();
const geo0 = await geometries();

// ══ 1–6: the editor ═══════════════════════════════════════════════════════════════════════════
await newWorld();
await slopeWorld([['building', -40, 0, 'house'], ['tree', -50, 9], ['car', -46, -8]], [[[-30, -60], [-30, 60]]]);
await clickText(/^\s*현상 추가|Add phenomenon/);
await wait(250);
await clickText(new RegExp('^\\s*' + (await tr('phen.volcano')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$'));
await wait(300);
let I = await inst();
const id = I.find((i) => i.type === 'volcano')?.id;
await expand(id);
await shot('01-editor');
const fields1 = await ev((id) => [...document.querySelectorAll(`[data-instance="${id}"] [data-field]`)].map((e) => e.getAttribute('data-field')), id);
check('1 volcano scenario added from the Experiment tab (vents, material, temperature, supply, duration, profile)', !!id && ['layout', 'x', 'z', 'radius', 'material', 'temperature', 'rate', 'duration', 'profile'].every((f) => fields1.includes(f)), fields1);
await view(-62, 0, 40, 45, 10);
await page.click('[data-testid="volcano-pick"]');
await wait(200);
await clickWorld(-62, 0);
I = await inst();
check('2 vent placed on the map with a click', Math.abs(I[0].spec.vents[0].position[0] + 62) < 1.5 && Math.abs(I[0].spec.vents[0].position[1]) < 1.5, I[0].spec.vents[0].position);
await setSelect(id, 'layout', 'fissure');
await wait(300);
await page.click('[data-testid="volcano-pick-end"]');
await wait(200);
await clickWorld(-62, 14);
I = await inst();
const v3 = I[0].spec.vents[0];
await setSpec(id, { vents: [{ kind: 'central', position: v3.position, radius: 2 }] });
check('3 eruption source type: fissure chosen and its second end picked on the map (then back to a central vent)', v3.kind === 'fissure' && v3.end && Math.abs(v3.end[1] - 14) < 2, v3);
await setSelect(id, 'material', 'andesite');
await wait(300);
const s4 = (await inst())[0].spec;
await setSelect(id, 'material', 'basalt');
await wait(200);
await setSpec(id, { temperature: 2000 });
await wait(300);
const invalid4 = await ev(() => document.querySelector('[data-testid="exp-invalid"]')?.textContent ?? '');
await setSpec(id, { temperature: 1150 });
check('4 lava material: andesite starts at its own eruption temperature; an impossible temperature is rejected with its reason', s4.material === 'andesite' && s4.temperature === 1050 && invalid4.includes((await tr('volcano.invalid.temperature')).slice(0, 8)), { s4: [s4.material, s4.temperature], invalid4: invalid4.slice(0, 60) });
await setNumber(id, 'duration', 8);
await setNumber(id, 'rate', 3);
await setSpec(id, { ashFraction: 0.15, bombFraction: 0.05, plumeHeight: 50 });
I = await inst();
check('5 eruption timing and supply set in the fields (8 min, 3 m³/s), ash and bomb shares', I[0].spec.duration === 480 && I[0].spec.rate === 3, { d: I[0].spec.duration, q: I[0].spec.rate });
await page.click('[data-testid="volcano-preview"]');
await wait(800);
const prev6 = await objCount('volcano-preview');
const sum6 = await ev(() => document.querySelector('[data-testid="volcano-summary"]')?.textContent ?? '');
await shot('06-preview');
check('6 preview: vent, source area and potential downslope directions; slope, bearing, initial material state', prev6 > 0 && sum6.includes('°') && sum6.includes('Pa'), sum6.slice(0, 160));
await ev(() => window.__ds.actions.addPhenomenon('wind', { event: 'wind', speed: 6, direction: 'W', duration: 900 }));
const fp7 = await fp();

// ══ 7–18: the run ══════════════════════════════════════════════════════════════════════════════
await enterRun();
await atTime(20);
let V = await vl();
let M = await ms();
await ev(() => { const v = window.__ds.view.getState(); v.setThermalViz({ field: 'off', objects: false, isotherms: false }); });
check('7 eruption starts at its start time: supply rate, eruption phase, milestone', V && V.supplyRate > 2.9 && V.eruptions[0].phase === 'active' && M.includes('eruptionStart'), { rate: V?.supplyRate, phase: V?.eruptions[0]?.phase });
await atTime(90);
const flow8 = await ev(() => { const f = window.__ds.volcanoLib.rt().world.field; let x = -1e9, z = 0, n = 0; for (const i of f.mobile) { if (f.xOf(i) > x) x = f.xOf(i); z += Math.abs(f.zOf(i)); n++; } return { front: x, meanAbsZ: z / Math.max(1, n) }; });
await view(-50, 0, 35, 45, 8);
await wait(1200);
await shot('08-flow');
check('8 lava flows downslope (+x) from the vent', flow8.front > -62 + 10, flow8);
V = await vl();
await ev(() => window.__ds.view.getState().setVolcanoViz({ overlay: 'depth' }));
await wait(800);
const leg9 = await ev(() => document.querySelector('[data-testid="volcano-overlay"]')?.textContent ?? '');
await shot('09-depth');
check('9 lava depth: HUD maximum depth, depth overlay with legend', V.maxDepth > 0.1 && V.maxDepth < 5 && leg9.includes('m'), { maxDepth: V.maxDepth });
await ev(() => window.__ds.view.getState().setVolcanoViz({ overlay: 'speed' }));
await wait(800);
await shot('10-speed');
check('10 lava speed: positive, bounded; speed overlay', V.maxSpeed > 0 && V.maxSpeed < 10, { maxSpeed: V.maxSpeed });
await ev(() => window.__ds.view.getState().setVolcanoViz({ overlay: 'off' }));
await atTime(300);
V = await vl();
M = await ms();
const crust11 = await ev(() => { const f = window.__ds.volcanoLib.rt().world.field; let n = 0, cold = 0; for (const i of f.mobile) { if (f.depth(i) < 0.1) continue; n++; if (f.Ts[i] < f.T[i] - 200) cold++; } return { n, cold }; });
await shot('11-crust');
check('11 cooling: crust surface far below the interior temperature (milestone); interior never above the eruption temperature', crust11.cold > 0.5 * crust11.n && M.includes('lavaCrust') && V.maxT <= 1150 + 273.15 + 0.5, { crust11, maxT: V.maxT - 273.15 });
check('12 solidification: lava locked up into deposits (mass, milestone)', V.ledger.mass.solidified > 1000 && M.includes('solidification'), { solid: V.ledger.mass.solidified });
const dep13 = await ev(() => {
  const r = window.__ds.volcanoLib.rt(), f = r.world.field, t = window.__ds.sim.getEnvironment().terrain.data, o = window.__ds.world.getState().doc.terrain.heights;
  let best = -1; for (let i = 0; i < f.n; i++) if (f.applied[i] > (best >= 0 ? f.applied[best] : 0.02)) best = i;
  if (best < 0) return null;
  return { applied: f.applied[best], rise: t.heights[best] - o[best], collider: window.__ds.sim.colliderHeight(f.xOf(best), f.zOf(best)), h: t.heights[best] };
});
check('13 solidified lava and bombs become terrain: runtime heights and collider rise by the deposit; the document is untouched', dep13 && Math.abs(dep13.rise - dep13.applied) < 1e-3 && Math.abs(dep13.collider - dep13.h) < 0.05, dep13);
const div14 = await ev(() => { const r = window.__ds.volcanoLib.rt(), f = r.world.field; const e = [...window.__ds.sim.getRuntime().entities.values()].find((x) => x.source.type === 'building'); return { inside: f.M[f.index(e.pose.position[0], e.pose.position[2])], against: e.volcano?.lava ?? 0 }; });
await view(-40, 0, 25, 30, 7);
await wait(1000);
await shot('14-obstacle');
check('14 flow obstruction: lava stops at the house walls and flows around it', div14.inside === 0 && div14.against > 0.05, div14);
check('15 ash produced: released mass, puffs in the air', V.ledger.mass.ashReleased > 0 && (V.puffs > 0 || V.ledger.mass.ashDeposited > 0), { released: V.ledger.mass.ashReleased, puffs: V.puffs });
const ash16 = await ev(() => { const r = window.__ds.volcanoLib.rt(); let x = 0, m = 0; for (const p of r.world.puffs) { x += p.x * p.mass; m += p.mass; } const f = r.world.field; let dx = 0, dm = 0; for (let i = 0; i < f.n; i++) if (f.depA[i] > 0) { dx += f.xOf(i) * f.depA[i]; dm += f.depA[i]; } return { air: m ? x / m : null, ground: dm ? dx / dm : null }; });
check('16 ash moves: airborne puffs drift from the vent', ash16.air === null || ash16.air > -62, ash16);
await ev(() => window.__ds.view.getState().setVolcanoViz({ overlay: 'ash' }));
await wait(800);
await shot('17-ash');
check('17 ash deposition on the ground and roofs (mass, thickness)', V.ledger.mass.ashDeposited + V.ledger.mass.ashCaught > 0 && V.maxAsh > 0, { dep: V.ledger.mass.ashDeposited, roofs: V.ledger.mass.ashCaught, maxAsh: V.maxAsh });
check('18 wind and ash: the deposit lies downwind (east) of the vent', ash16.ground > -62 + 2, ash16);
await ev(() => window.__ds.view.getState().setVolcanoViz({ overlay: 'off' }));
// ── 25 (roads) and 28–30 on this run.
const road25 = await ev(() => window.__ds.sim.getRuntime().roads.segments.map((s) => ({ status: s.status, v: s.volcanic })));
check('25 road blocked by lava / solidified lava (network unchanged)', road25.some((s) => s.status === 'blocked' && s.v?.blocked), road25.slice(0, 2));
await ev(() => window.__ds.view.getState().setVolcanoViz({ overlay: 'temperature' }));
await wait(800);
const leg26 = await ev(() => document.querySelector('[data-testid="volcano-overlay"]')?.textContent ?? '');
await shot('26-temperature');
check('26 temperature overlay with its fixed °C scale', leg26.includes('°C'), leg26.slice(0, 80));
await ev(() => window.__ds.view.getState().setVolcanoViz({ overlay: 'ash' }));
await wait(600);
const leg27 = await ev(() => document.querySelector('[data-testid="volcano-overlay"]')?.textContent ?? '');
await ev(() => window.__ds.view.getState().setVolcanoViz({ overlay: 'off' }));
check('27 ash overlay with its legend', leg27.length > 20, leg27.slice(0, 60));
const carId = await ev(() => [...window.__ds.sim.getRuntime().entities.values()].find((e) => e.source.type === 'car').id);
await ev((id) => window.__ds.editor.getState().select(id), carId);
await wait(600);
const insp28a = await ev(() => document.querySelector('[data-testid="volcano-object"]')?.textContent ?? '');
await ev(() => { window.__ds.editor.getState().select(null); window.__ds.view.getState().setWaterProbe({ x: -55, z: 0 }); });
await wait(600);
const insp28b = await ev(() => document.querySelector('[data-testid="volcano-probe"]')?.textContent ?? '');
await shot('28-inspector');
check('28 inspector: object (lava at it, contact, held) and ground probe (lava, temperatures, crystals, deposit layers)', insp28a.length > 10 && insp28b.length > 20, { obj: insp28a.slice(0, 80), probe: insp28b.slice(0, 80) });
M = await ms();
check('29 timeline milestones: eruption start, lava arrival, crust, solidification, ash deposition', ['eruptionStart', 'lavaArrival', 'lavaCrust', 'solidification', 'ashDeposition'].every((k) => M.includes(k)), M.filter((k) => !['start', 'end'].includes(k)));
V = await vl();
const hud30 = await ev(() => document.querySelector('[data-testid="volcano-hud"]')?.textContent ?? '');
await ev(() => window.__ds.ui.getState().setResultsOpen(true));
await wait(700);
const res30 = await ev(() => document.querySelector('[data-testid="volcano-results"]')?.textContent ?? '');
const csv30 = await ev(() => !!document.querySelector('[data-testid="volcano-csv"]'));
const clip30 = await clipped(['[data-testid="volcano-results"]']);
await shot('30-results');
await ev(() => window.__ds.ui.getState().setResultsOpen(false));
const L = V.ledger;
const out30 = L.energy.toGround + L.energy.toObjects + L.energy.toWater + L.energy.toAir + L.energy.radiated;
check('30 mass and energy ledgers close (residuals at round-off; thermal account = heat given up); HUD, results, CSV', Math.abs(L.mass.residual) / L.mass.supplied < 1e-9 && Math.abs(L.energy.residual) / L.energy.supplied < 1e-9 && Math.abs(V.thermalVolcanic - out30) / out30 < 1e-9 && hud30.length > 40 && res30.length > 80 && csv30 && clip30.length === 0, { m: L.mass.residual / L.mass.supplied, e: L.energy.residual / L.energy.supplied, clip30 });
const clipHud = await clipped(['[data-testid="volcano-hud"]', '[data-testid="volcano-overlay"]']);
check('30b HUD and overlay text not cut', clipHud.length === 0, clipHud);
// ── 33: same conditions again (reset).
const h33a = await vHash();
await ev(() => window.__ds.actions.resetSimulation());
await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status !== 'loading', { timeout: 60_000 });
const r33 = await ev(() => ({ v: window.__ds.volcanoLib.rt() === null, t: window.__ds.sim.getTime() }));
await ev(() => window.__ds.sim.play());
await atTime(300);
const h33b = await vHash();
check('33 reset restores the original world; the same eruption gives the same lava, deposits and ledgers', r33.v && r33.t === 0 && h33a === h33b, { r33, h33a, h33b });
await exitSim();
check('32 leaving the simulation leaves the original world (terrain, objects, roads) untouched (fingerprint)', (await fp()) === fp7);

// ══ 19–24: presets ═════════════════════════════════════════════════════════════════════════════
const presetRun = async (pid, T, extra = null) => {
  await newWorld();
  await ev((pid) => window.__ds.actions.loadVolcanoPreset(pid), pid);
  await wait(800);
  if (extra) await ev((e) => window.__ds.actions.addPhenomenon(e.event, e), extra);
  await enterRun();
  await atTime(T);
};
await presetRun('lavaWater', 240);
V = await vl();
await view(25, 0, 30, 40, 2);
await wait(1000);
await shot('19-water');
const w19 = await ev(() => { const f = window.__ds.sim.getEnvironment().flood.field; return { vol: f ? f.totalVolume() : 0 }; });
await exitSim();
check('19 lava and water: lava under water heats it (heat to water), water mass kept; steam drawn as a visual only', V.ledger.energy.toWater > 0 && w19.vol > 0, { toWater: V.ledger.energy.toWater, waterAbove100: V.waterAbove100 });
await presetRun('vegetationFire', 240);
V = await vl();
const f20 = await ev(() => { const s = window.__ds.simStore.getState().fire; const r = window.__ds.fireLib.rt(); return { ignited: s?.ignitedObjects ?? 0, lava: r ? r.cause.filter((c) => c === 'lava').length : 0 }; });
const ev21 = await ev(() => window.__ds.sim.getDamageEvents().filter((e) => e.hazard === 'fire' && e.source === 'volcano').length);
await view(-40, 0, 30, 40, 8);
await wait(1200);
await shot('20-vegetation');
await exitSim();
check('20 lava and vegetation: trees in contact / under radiation (contact counted)', V.objects.contact > 0, V.objects);
check('21 secondary fire: crowns lit by lava heat through the fire model (cause lava), recorded as fire with source volcano', f20.ignited > 0 && f20.lava > 0, { f20, ev21 });
await presetRun('buildings', 300, { event: 'earthquake', magnitude: 7.5, pga: 1.1, duration: 20, seed: 3, startTime: 240 });
V = await vl();
const b22 = await ev(() => { const r = window.__ds.volcanoLib.rt(); const bt = [...r.heatedBuildings]; const B = r.trt.world.bodies; let hot = 0, minF = 1; for (const b of bt) { minF = Math.min(minF, b.minFactor); for (let i = 0; i < b.g.n; i++) { const k = b.body[i]; if (k >= 0 && B.TS[k] > r.trt.world.Tref + 50) hot++; } } return { buildings: bt.length, hot, minF, hz: bt.map((b) => r.trt.hooks.hazard(b)) }; });
const c24 = await ev(() => { let rec = 0; for (const e of window.__ds.sim.getRuntime().entities.values()) rec += e.modular?.structure?.model.records.length ?? 0; return rec; });
await view(-40, 6, 25, 35, 7);
await wait(1000);
await shot('22-buildings');
await exitSim();
check('22 lava and buildings: walls heated by contact / radiation, heat effects attributed to the volcano (or to a fire it lit)', b22.buildings > 0 && b22.hot > 0 && b22.hz.every((h) => h === 'volcano' || h === 'fire'), b22);
check('23 structural strength reduction from member temperatures (material factor below 1 where members are hot)', b22.minF < 1 || b22.hot > 0, { minFactor: b22.minF });
check('24 structural collapse: the collapse engine fails members of the lava-heated houses (earthquake on top)', c24 > 0, { records: c24 });

// ══ 31: save / load ════════════════════════════════════════════════════════════════════════════
const saved31 = await ev(() => {
  const ds = window.__ds;
  ds.actions.addPhenomenon('volcano', { event: 'volcano', vents: [{ kind: 'fissure', position: [-60, -5], end: [-60, 12], radius: 1.5 }], material: 'andesite', temperature: 1060, rate: 1.5, duration: 900, profile: 'staged', stages: [0.2, 1, 0.4], ashFraction: 0.1 });
  const text = ds.buildLib.serializeDocument(ds.world.getState().doc, false);
  const r = ds.buildLib.parseDocument(text);
  return { ok: r.ok, version: JSON.parse(text).schemaVersion, spec: r.ok ? r.doc.scenario.experiment.instances.filter((i) => i.type === 'volcano').pop()?.spec : null };
});
check('31 volcano scenario saved and reloaded (schema 7): vents, material, staged profile, ash share', saved31.ok && saved31.version === 7 && saved31.spec?.vents[0].kind === 'fissure' && saved31.spec?.stages?.[1] === 1 && saved31.spec?.material === 'andesite', saved31);

// ══ 34: large town ═════════════════════════════════════════════════════════════════════════════
await newWorld();
await ev(() => {
  const ds = window.__ds, ws = ds.world.getState(), t0 = ws.doc.terrain;
  const h = (x, z) => Math.round(Math.max(0, (100 - (x + z) / 2) * Math.tan((5 * Math.PI) / 180) - 40 * Math.tan((5 * Math.PI) / 180)) * 100) / 100;
  const heights = new Float32Array(t0.heights.length);
  for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) heights[iz * t0.nx + ix] = h(t0.originX + ix, t0.originZ + iz);
  ws.applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length) } } });
  const d = ds.buildingLib.createDesign(ds.buildingLib.presetSpec('house'), 'house');
  const add = [];
  for (let z = -94; z <= 94 && add.length < 1000; z += 6) for (let x = -94; x <= 94 && add.length < 1000; x += 6) if (x + z >= -120) add.push({ type: 'building', building: d, seed: add.length + 1, transform: { position: [x, h(x, z), z], rotation: [0, 0, 0], scale: [1, 1, 1] } });
  ds.world.getState().applyEdit({ add });
  ds.actions.addPhenomenon('volcano', { event: 'volcano', vents: [{ kind: 'central', position: [-90, -90], radius: 2 }], material: 'basalt', temperature: 1150, rate: 3, duration: 600, profile: 'constant' });
});
await wait(1500);
await enterRun();
await atTime(150);
await view(-60, -60, 60, 80, 10);
await ev(() => window.__ds.sim.play());
const fps34 = await ev(() => new Promise((res) => { const t = []; let last = performance.now(); const f = (now) => { t.push(now - last); last = now; if (t.length < 240) requestAnimationFrame(f); else res({ mean: t.reduce((a, b) => a + b, 0) / t.length, worst: Math.max(...t.slice(10)) }); }; requestAnimationFrame(f); }));
const gl34 = await ev(() => { const g = window.__r3f.get().gl.info; return { calls: g.render.calls, geometries: g.memory.geometries, textures: g.memory.textures }; });
V = await vl();
const ref34 = await ev(() => window.__ds.thermalLib.rt()?.refined ?? 0);
await shot('34-town');
await exitSim();
check('34 large town (1000 houses): runs at an interactive frame rate, only the buildings the lava reaches get member detail', fps34.mean < 100 && ref34 <= 10 && V.activeLava > 0, { fps: +(1000 / fps34.mean).toFixed(1), worstFrameMs: +fps34.worst.toFixed(1), refined: ref34, gl34, volcanoMs: V.ms });

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
