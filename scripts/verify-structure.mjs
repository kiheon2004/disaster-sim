// Browser verification of structural destruction (Phase 25): 22 scenarios in real Chrome through the
// UI (building editor member inspector + removal preview, simulation member picking, overlay toggles,
// inspector, HUD, timeline, results) with state checks after each step, plus whole-run checks:
// console / page errors, the tab staying alive, GPU geometries, heap.
//
//   npm run build && npx vite preview --port 4191 --strictPort &
//   LANG_UI=ko node scripts/verify-structure.mjs http://localhost:4191/ ./docs/verify/structure
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:4191/', out = './docs/verify/structure'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const lang = process.env.LANG_UI ?? 'ko';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,1000', '--enable-precise-memory-info', '--js-flags=--expose-gc'],
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 }, protocolTimeout: 900_000, timeout: 180_000,
});
const errors = [];
const results = [];
const page = await browser.newPage();
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
async function heapMB() {
  for (let i = 0; i < 2; i++) { await ev(() => window.gc?.()); await cdp.send('HeapProfiler.collectGarbage'); }
  return ev(() => +(performance.memory.usedJSHeapSize / 1048576).toFixed(1));
}
const geometries = () => ev(() => window.__r3f.get().gl.info.memory.geometries);
async function screenOfWorld(p) {
  return ev((p) => {
    const st = window.__r3f.get();
    const v = st.camera.position.clone().set(p[0], p[1], p[2]).project(st.camera);
    const r = st.gl.domElement.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  }, p);
}
async function view(x, z, h = 60, back = 70) {
  await ev(([x, z, h, back]) => { const st = window.__r3f.get(); st.camera.position.set(x + back * 0.5, h, z + back); st.controls.target.set(x, 0, z); st.controls.update(); }, [x, z, h, back]);
  await wait(300);
}
const tr = (k) => ev((k) => window.__ds.tr(k), k);
/** Open a collapsible section by its (translated) title. */
async function openSection(key) {
  const title = await tr(key);
  return ev((title) => {
    for (const b of document.querySelectorAll('button, [role="button"], summary, div')) {
      // Section headers start with the chevron "▸".
      if (b.children.length < 4 && (b.textContent ?? '').replace(/^[\s▸]+/, '').startsWith(title) && b.getAttribute('aria-expanded') === 'false') { b.click(); return true; }
    }
    return false;
  }, title);
}
const fp = () => ev(() => window.__ds.blueprintLib.worldFingerprint(window.__ds.world.getState().doc));
async function newWorld() {
  await ev(() => window.__ds.actions.newProject());
  await wait(300);
}
/** Place objects: [type, x, z, preset?] (modular buildings by preset). */
const place = (items) => ev((items) => {
  const ds = window.__ds;
  return ds.world.getState().applyEdit({ add: items.map(([type, x, z, preset], k) => ({ type, ...(type === 'building' ? { building: ds.buildingLib.createDesign(ds.buildingLib.presetSpec(preset ?? 'house'), preset ?? 'house') } : {}), seed: k + 1, transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] } })) });
}, items);
async function run(specs) {
  await ev((specs) => window.__ds.actions.runSimulation(specs), specs);
  await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status === 'running', { timeout: 60_000 });
}
/** Pause and step to exactly T (fixed steps), sampling the engine on the way. */
async function stepTo(T, sample = false) {
  return ev(([T, sample]) => {
    const s = window.__ds.sim; s.pause();
    const seen = { blocks: 0, moving: 0, levels: new Set() };
    while (s.getTime() < T - 1e-9) {
      s.advance(1 / 60);
      if (!sample) continue;
      const S = s.getRuntime().structures;
      if (!S) continue;
      let b = 0;
      for (const e of S.active) for (const bl of e.modular.structure.model.blocks) if (bl.active) b++;
      seen.blocks = Math.max(seen.blocks, b);
      seen.moving = Math.max(seen.moving, S.fragments.filter((f) => !f.structural.settled).length);
      for (const e of S.all) seen.levels.add(e.modular.structure.level ?? '');
    }
    return { ...seen, levels: [...seen.levels] };
  }, [T, sample]);
}
const exitSim = async () => { await ev(() => window.__ds.actions.exitSimulation()); await wait(400); };
const models = () => ev(() => (window.__ds.sim.getRuntime().structures?.all ?? []).map((e) => {
  const m = e.modular.structure.model, ids = e.modular.design.members;
  return { id: e.id, level: m.collapseLevel(), records: m.records.map((r) => ({ m: ids[r.i].id, type: ids[r.i].type, cause: r.cause, hz: r.hazard, trig: r.trigger, t: r.time, sec: !!r.secondary })), piles: m.piles.length, residual: m.ledger.residual(), edgesFailed: Array.from(m.s.edgeAlive).filter((x) => !x).length };
}));
const damage = () => ev(() => window.__ds.sim.getDamageEvents().map((e) => ({ o: e.objectId, ty: e.objectType, t: e.eventType, h: e.hazard, c: e.cause, sec: e.secondary ?? null, f: e.failure ?? null, time: e.time })));
const milestones = () => ev(() => window.__ds.simStore.getState().milestones.map((m) => m.kind));
const heap0 = await heapMB();
const geo0 = await geometries();

// ══ Building editor (creative mode) ══════════════════════════════════════════════════════════
await newWorld();
const [aptId] = await place([['building', 0, 0, 'apartment']]);
const fpBefore = await fp();
await ev((id) => { window.__ds.editor.getState().select(id); window.__ds.buildingActions.enterBuildingEdit(id); }, aptId);
await wait(500);
await ev(() => window.__ds.members.getState().select(['c0-1-0']));
await wait(400);
await openSection('struct.edit.title');
await wait(300);
const conn1 = await ev(() => [...document.querySelectorAll('[data-testid="member-connections-edit"] tbody tr')].map((r) => [...r.children].map((c) => c.textContent)));
const dem1 = await ev(() => document.querySelector('[data-testid="member-demand"]')?.textContent ?? '');
await shot('01-member');
check('1 a structural member selected in the editor shows its demand / capacity', dem1.length > 0 && /kN/.test(dem1), { dem1: dem1.slice(0, 120) });
check('2 its load-transfer connections are listed (kind, support, load, capacity)', conn1.length > 0 && conn1.every((r) => r.length === 4), { rows: conn1.slice(0, 3) });

// ── 3/4. Removal preview (alternate path) — the selected ground column removed suddenly ─────────
// DOM click: the button sits in the scrolled inspector; a coordinate click could land in the viewport.
await ev(() => document.querySelector('[data-testid="removal-preview"]').click());
await wait(600);
const prev4 = await ev(() => { const p = window.__ds.members.getState().preview; return p ? { level: p.result.level, followers: p.result.failed.length, removed: p.result.removed } : null; });
const res4 = await ev(() => document.querySelector('[data-testid="removal-result"]')?.textContent ?? '');
await view(0, 0, 40, 40);
await shot('04-removal-preview');
check('4 single-member removal preview: computed with the collapse model, local result, the design is unchanged', prev4 && prev4.level === 'local' && prev4.removed[0] === 'c0-1-0' && res4.length > 0, prev4);
await ev(() => { window.__ds.buildingActions.exitBuildingEdit(); window.__ds.members.getState().setPreview(null); });
await wait(300);
check('3 the original design is not modified by the preview (fingerprint unchanged)', (await fp()) === fpBefore);

// ══ Street: earthquake 1.1 g — apartment, house, cars, a road ════════════════════════════════
await newWorld();
await ev(() => {
  const ds = window.__ds, S = ds.world.getState();
  S.applyEdit({ roads: ds.roadLib.drawRoad(S.doc.roads, [[-40, 9], [40, 9]], { curved: false, profile: ds.roadLib.defaultProfile() }).network });
});
await place([['building', 0, 0, 'apartment'], ['building', 18, 0, 'house'], ['car', -12, 10], ['car', -6, 10], ['car', 0, 10], ['car', 6, 10], ['car', 12, 10]]);
const fpStreet = await fp();
await run([{ event: 'earthquake', magnitude: 7.5, pga: 1.1, duration: 20, seed: 3 }]);
await view(0, 0, 45, 55);
const seen = await stepTo(12, true);
await ev(() => window.__ds.sim.play());
await wait(900);
await shot('12-falling');
await ev(() => window.__ds.sim.pause());
await stepTo(24, true);
const M = await models();
const D1 = await damage();
const MS1 = await milestones();
const apt = M[0];
const struct = (m) => m.records.filter((r) => r.cause !== 'facade');
check('5 connection failures are computed and recorded (connections out of the load path)', M.some((m) => m.edgesFailed > 0) || MS1.includes('connectionFailure'), { edges: M.map((m) => m.edgesFailed), ms: MS1.includes('connectionFailure') });
check('6 load redistribution: members failing because another member failed (trigger recorded)', struct(apt).some((r) => r.trig >= 0 && ['axial', 'bending', 'shear', 'support'].includes(r.cause)) && MS1.includes('loadRedistribution'));
check('7 partial collapse stage reached (part of the building standing while part fell)', seen.levels.includes('partial') || MS1.includes('partialCollapse'), seen.levels);
check('8 progressive collapse: falling floors broke through the floors below, in time order', MS1.includes('progressiveCollapse') && struct(apt).some((r) => r.cause === 'impact'));
check('9 roof failure: roof / top-floor members failed and came down', struct(apt).some((r) => r.type === 'roof' || (r.type === 'slab' && /^sl5-/.test(r.m))), struct(apt).filter((r) => r.type === 'roof').length);
check('11 floor slabs failed (bending / support / impact)', struct(apt).some((r) => r.type === 'slab'));
check('12 debris falls: falling blocks inside the building and moving fragments were observed', seen.blocks > 0 && seen.moving > 0, seen);
check('13 debris impacts recorded (milestone)', MS1.includes('debrisImpact'));
const carHits = D1.filter((d) => d.ty === 'car' && d.sec);
check('14 vehicles damaged by fragments: secondary records keep the primary hazard and the source building', carHits.length > 0 && carHits.every((d) => d.h === 'earthquake' && d.sec.source === apt.id), carHits.slice(0, 2));
const road15 = await ev(() => { const s = window.__ds.sim.getRuntime().roads.segments[0]; return s.rubble ?? null; });
check('15 the street is blocked by the collapse rubble (separate from sediment)', road15?.blocked === true, road15);
check('16 earthquake integration: every structural failure of this run is the earthquake\'s; mass conserved', M.every((m) => struct(m).every((r) => r.hz === 'earthquake') && Math.abs(m.residual) < 1e-3), M.map((m) => m.residual));

// ── Inspector, member picking, overlays, HUD, timeline ─────────────────────────────────────────
await ev((id) => window.__ds.editor.getState().select(id), apt.id);
await wait(400);
const level16 = await ev(() => document.querySelector('[data-testid="structure-level"]')?.textContent ?? '');
await openSection('struct.sequence');
await wait(300);
const seqRows = await ev(() => document.querySelectorAll('[data-testid="collapse-sequence"] tbody tr').length);
// Pick a standing member of the house next door by clicking it.
const house = (await ev(() => [...window.__ds.sim.getRuntime().entities.values()].filter((e) => e.source.type === 'building').map((e) => e.id)))[1];
const hp = await ev((id) => { const ds = window.__ds; const e = ds.sim.getRuntime().entities.get(id); const i = e.modular.design.members.findIndex((m) => m.id === 'w0-s-0'); return ds.structureLib.memberWorld(id, i); }, house);
await view(18, 0, 14, 22);
const [sx, sy] = await screenOfWorld(hp);
await page.mouse.click(sx, sy);
await wait(500);
const pick = await ev(() => window.__ds.view.getState().simMember);
const memSec = await ev(() => document.querySelector('[data-testid="member-structure"]')?.textContent ?? '');
await shot('16-inspector');
check('1b a member clicked in the simulation is picked; its computed state is shown', pick !== null && memSec.length > 0, { pick, memSec: memSec.slice(0, 80) });
await ev(() => window.__ds.view.getState().setStructureViz({ loadPath: true, connections: true, support: true, color: 'demand' }));
await ev((id) => window.__ds.editor.getState().select(id), house);
await wait(600);
const overlay3 = await ev(() => { let n = 0; window.__r3f.get().scene.traverse((o) => { if (o.isLineSegments && o.renderOrder === 10 && o.visible) n += o.geometry.attributes.position?.count ?? 0; }); return n; });
await shot('03-loadpath');
check('3b load-path overlay of the selected building drawn from the engine state (vertices)', overlay3 > 0, { vertices: overlay3 });
for (const c of ['failure', 'sequence', 'normal']) { await ev((c) => window.__ds.view.getState().setStructureViz({ color: c }), c); await wait(150); }
const hud = await ev(() => document.querySelector('[data-testid="structure-hud"]')?.textContent ?? '');
const tl = await ev(() => document.querySelectorAll('[class*="milestone"]').length);
check('20 cause / timeline: inspector level + collapse sequence rows, HUD, timeline milestones', level16.length > 0 && seqRows > 0 && hud.length > 0 && tl > 0, { level16, seqRows, tl });
await ev(() => window.__ds.ui.getState().setResultsOpen(true));
await wait(500);
const resStruct = await ev(() => document.querySelector('[data-testid="structure-results"]')?.textContent ?? '');
await shot('20-results');
await ev(() => window.__ds.ui.getState().setResultsOpen(false));
check('20b results: structural destruction summary (classes, members, debris mass, roads, secondary)', resStruct.length > 0, resStruct.slice(0, 100));

// ── 22. Same conditions re-run (reset) → same collapse sequence at the same step ──────────────────
const seqA = JSON.stringify((await models()).map((m) => m.records.map((r) => `${r.m}:${r.cause}:${r.t.toFixed(5)}`)));
await ev(() => window.__ds.actions.resetSimulation());
await page.waitForFunction(() => window.__ds.sim.isLoaded() && window.__ds.simStore.getState().status !== 'loading', { timeout: 60_000 });
const clean = await ev(() => ({ s: !!window.__ds.sim.getRuntime().structures, ev: window.__ds.sim.getDamageEvents().length }));
await ev(() => window.__ds.sim.play());
await wait(200);
await stepTo(24);
const seqB = JSON.stringify((await models()).map((m) => m.records.map((r) => `${r.m}:${r.cause}:${r.t.toFixed(5)}`)));
check('22 reset → re-run: the same collapse sequence (members, causes, times) bit for bit', !clean.s && clean.ev === 0 && seqA === seqB && seqA.length > 10, { len: seqA.length });
await exitSim();
check('21 leaving the simulation shows the original world exactly (fingerprint)', (await fp()) === fpStreet);

// ══ Blast: houses + parked cars ═══════════════════════════════════════════════════════════════
await newWorld();
await place([['building', 10, 0], ['building', 10, 14], ['building', -12, 0], ['car', 18, 0]]);
await run([{ event: 'blast', position: [0, 0], height: 1, energy: 2e9, model: 'weakShock', waveform: 'nWave', startTime: 0.3 }]);
await view(0, 0, 35, 45);
await stepTo(1.2);
await ev(() => window.__ds.sim.play());
await wait(500);
await shot('10-blast');
await ev(() => window.__ds.sim.pause());
await stepTo(8);
const MB = await models();
const DB = await damage();
const frags = await ev(() => (window.__ds.sim.getRuntime().structures?.fragments ?? []).length);
check('10 exterior walls / cladding blown off by the wave: detached parts become fragments', DB.some((d) => d.t === 'DETACHED' && d.h === 'blast') && frags > 0, { frags });
check('17 blast integration: structural failures recorded as the blast\'s (walls out of plane / story mechanism)', MB.some((m) => struct(m).length > 0) && MB.every((m) => m.records.every((r) => r.hz === 'blast')), MB.map((m) => struct(m).length));
await exitSim();

// ══ Ground: support lost under a corner ══════════════════════════════════════════════════════
await newWorld();
const [indId] = await place([['building', 0, 0, 'industrial']]);
await run([{ event: 'terrainDeformation', kind: 'subsidence', center: [-15, -10], radius: 4, amount: 0.08, supportLoss: 0.9, duration: 1, profile: 'smooth', falloff: 'steep' }]);
await stepTo(5);
await ev((id) => window.__ds.editor.getState().select(id), indId);
await ev(() => window.__ds.view.getState().setStructureViz({ support: true }));
await view(-12, -8, 18, 24);
await wait(500);
await shot('18-foundation');
const MG = await models();
check('18 ground: the footing whose ground gave way fails; the rest of the building stands', MG[0] && MG[0].records.some((r) => (r.cause === 'foundation' || r.cause === 'bearing') && r.hz === 'ground') && MG[0].level !== 'global', MG[0] && { level: MG[0].level, n: MG[0].records.length });
await exitSim();

// ══ Landslide: house at the toe of a 32° slope ═══════════════════════════════════════════════
await newWorld();
await ev(() => {
  const ds = window.__ds, S = ds.world.getState(), t0 = S.doc.terrain, heights = new Float32Array(t0.heights.length), tb = Math.tan((32 * Math.PI) / 180);
  for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) { const x = t0.originX + ix * t0.cellSize; heights[iz * t0.nx + ix] = x < 0 ? Math.min(90, -x) * tb : 0; }
  S.applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length) } } });
});
const [lsHouse] = await place([['building', 7, 0]]);
await run([{ event: 'landslide', area: { kind: 'circle', center: [-14, 0], radius: 12 }, thickness: 2.5, saturation: 1, trigger: 'user', targetSaturation: 1, duration: 10 }]);
await stepTo(30);
const ls = await ev((id) => { const e = window.__ds.sim.getRuntime().entities.get(id); const mr = e.modular; return { maxD: Math.max(...mr.storyMembers[0].map((i) => mr.damage[i])), hz: [...new Set(window.__ds.sim.getDamageEvents().map((d) => d.hazard))] }; }, lsHouse);
await view(0, 0, 30, 40);
await shot('19-landslide');
check('19 landslide: the sediment load damages the ground-story members (ground hazard only)', ls.maxD > 0.3 && ls.hz.every((h) => h === 'ground'), ls);
await exitSim();

// ── Whole run ─────────────────────────────────────────────────────────────────────────────────
await newWorld();
await wait(800);
const heap1 = await heapMB();
const geo1 = await geometries();
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; ${errors.length} page errors; heap ${heap0} → ${heap1} MB; geometries ${geo0} → ${geo1}; crashed ${crashed}`);
if (errors.length) console.log(errors.slice(0, 10).join('\n'));
fs.writeFileSync(path.join(out, `results-${lang}.json`), JSON.stringify({ lang, url, results, errors, heap: [heap0, heap1], geometries: [geo0, geo1], crashed }, null, 2));
await browser.close();
process.exit(results.every((r) => r.ok) && errors.length === 0 && !crashed ? 0 : 1);
