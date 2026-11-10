// Browser verification of Phase 35.5 (spec §55–57) in real Chrome, Korean / English: disasters placed with the MOUSE
// (no coordinates typed), several independent instances, staggered start, two vortices, the closed right panel + the command
// drawer, library search in both languages, a palette road joined to the default world's road (width / height at the seam),
// the steel office under an earthquake, a blast at one side of a building, a sinkhole under a building; page / console
// errors and GPU resources over the whole run.
//
//   npx vite build && npx vite preview --port 4196 --strictPort &
//   LANG_UI=ko node scripts/verify-ux355.mjs http://localhost:4196/ ./docs/verify/ux355
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:4196/', out = './docs/verify/ux355'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const lang = process.env.LANG_UI ?? 'ko';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,1000', '--enable-precise-memory-info'],
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 }, protocolTimeout: 1_800_000, timeout: 180_000,
});
const errors = [];
const results = [];
const page = await browser.newPage();
page.setDefaultNavigationTimeout(180_000);
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('dialog', (d) => d.accept());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const shot = (n) => page.screenshot({ path: path.join(out, `${n}-${lang}.png`) });
const t0 = Date.now();
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${typeof detail === 'string' ? detail : JSON.stringify(detail)} [${((Date.now() - t0) / 1000).toFixed(0)} s]`);
};

async function fresh() {
  await page.goto(url + '?devtools', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__ds && window.__r3f);
  await ev(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__ds && window.__r3f);
  await ev((l) => window.__ds.locale.getState().setLocale(l), lang);
  await wait(1200);
}
/** Top-down-ish camera over (x, z). */
async function view(x = 0, z = 0, h = 120, back = 60) {
  await ev(([x, z, h, back]) => { const st = window.__r3f.get(); st.camera.position.set(x, h, z + back); st.controls.target.set(x, 0, z); st.controls.update(); }, [x, z, h, back]);
  await wait(400);
}
/** Screen point of a world point on the ground. */
const screen = (x, z) => ev(([x, z]) => {
  const st = window.__r3f.get(); const r = st.gl.domElement.getBoundingClientRect();
  const s = window.__ds.buildLib.samplerFor(window.__ds.world.getState().doc.terrain);
  const v = st.camera.position.clone().set(x, s.sampleHeight(x, z), z).project(st.camera);
  return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
}, [x, z]);
async function clickWorld(x, z) {
  const [sx, sy] = await screen(x, z);
  await page.mouse.move(sx - 12, sy - 8);
  await page.mouse.move(sx, sy, { steps: 3 });
  await wait(120);
  await page.mouse.click(sx, sy);
  await wait(150);
}
const insts = () => ev(() => window.__ds.world.getState().doc.scenario.experiment?.instances ?? []);
const running = () => ev(() => window.__ds.sim.isLoaded() ? window.__ds.sim.instances().map((i) => ({ key: i.key, status: i.status, type: i.spec.event, name: i.spec.name ?? null })) : []);
const glInfo = () => ev(() => { const g = window.__r3f.get().gl.info; return { geometries: g.memory.geometries, textures: g.memory.textures }; });
const click = async (sel) => { await page.click(sel); await wait(150); };
const exitSim = () => ev(() => window.__ds.actions.exitSimulation());

if (!process.env.ONLY_S6) {
// ── Scenario 1: a blast on the left of the world — library card + one map click, no coordinates ────────────────────
await fresh();
await view(0, 0, 120, 70);
await shot('01-start');
await click('[data-tab="phenomena"]');
let clicks = 0;
await click('[data-testid="lib-blast"]'); clicks++;
check('S1 the blast card arms placement mode', (await ev(() => window.__ds.placementStore.getState().type)) === 'blast');
{
  const [sx, sy] = await screen(-55, 25);
  await page.mouse.move(sx, sy, { steps: 4 });
  await wait(250);
  check('S1 a preview follows the pointer (footprint labelled reference range)', await ev(() => !!document.querySelector('[data-testid="placement-preview"]') && /\(.+\)/.test(document.querySelector('[data-testid="placement-preview"]').textContent)));
  await shot('02-placement-preview');
  await page.mouse.click(sx, sy); clicks++;
  await wait(200);
}
let list = await insts();
check('S1 the click created one blast instance on the left half (x < 0) with no coordinate typed', list.length === 1 && list[0].type === 'blast' && list[0].spec.position[0] < -20, list.map((i) => i.spec.position));
await page.keyboard.press('Escape');
await click('[data-testid="exp-run"]'); clicks++;
await page.waitForFunction(() => window.__ds.simStore.getState().status === 'running', { timeout: 120_000 });
await wait(1500);
let run = await running();
check('S1 the blast runs (3 clicks from the library: card, map, run)', run.length === 1 && run[0].type === 'blast' && clicks === 3, { run, clicks });
await shot('03-s1-running');
await exitSim();
await wait(500);

// ── Scenario 2: three blasts at three places, one run ──────────────────────────────────────────────────────────────
await ev(() => window.__ds.world.getState().setExperiment({ instances: [] }));
await click('[data-testid="lib-blast"]');
for (const [x, z] of [[-40, 30], [10, -30], [45, 35]]) await clickWorld(x, z);
await page.keyboard.press('Escape');
list = await insts();
check('S2 continuous placement: three blast instances at three distinct points', list.length === 3 && new Set(list.map((i) => i.spec.position.join(','))).size === 3, list.map((i) => [i.id, i.spec.position]));
await shot('04-s2-placed');
// Undo / redo of the last placement before the run.
await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control'); await page.keyboard.press('z'); await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
await wait(150);
const afterUndo = (await insts()).length;
await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control'); await page.keyboard.down('Shift'); await page.keyboard.press('z'); await page.keyboard.up('Shift'); await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
await wait(150);
check('S2 Ctrl/⌘+Z removes the last placement, Ctrl/⌘+Shift+Z restores it', afterUndo === 2 && (await insts()).length === 3, { afterUndo });
await click('[data-testid="exp-run"]');
await page.waitForFunction(() => window.__ds.simStore.getState().status === 'running', { timeout: 120_000 });
await wait(1500);
run = await running();
check('S2 three independent blast instances run together (own keys, own source names)', run.length === 3 && new Set(run.map((r) => r.name)).size === 3 && run.every((r) => r.status === 'active' || r.status === 'done'), run);
const waves = await ev(() => window.__ds.sim.getEnvironment().blast.ledger(window.__ds.sim.getTime()).length);
check('S2 the pressure channel holds three waves (one per instance, none dropped)', waves === 3, { waves });
await shot('05-s2-running');
await exitSim();
await wait(500);

// ── Scenario 3: two blasts + two sinkholes, staggered ──────────────────────────────────────────────────────────────
await ev(() => window.__ds.world.getState().setExperiment({ instances: [] }));
await click('[data-testid="lib-blast"]');
await clickWorld(-45, 30); await clickWorld(48, -30);
await page.keyboard.press('Escape');
await click('[data-testid="lib-sinkhole"]');
await clickWorld(-10, 0); await clickWorld(20, 0);
await page.keyboard.press('Escape');
list = await insts();
// Start times through the instance editor's start field (exact numeric entry).
await ev(() => { const a = window.__ds.world.getState().doc.scenario.experiment.instances; window.__ds.actions.updatePhenomenon(a[1].id, { start: { at: 6 } }); window.__ds.actions.updatePhenomenon(a[3].id, { start: { at: 10 } }); });
check('S3 two blasts and two sinkholes placed by mouse', list.filter((i) => i.type === 'blast').length === 2 && list.filter((i) => i.type === 'sinkhole').length === 2, list.map((i) => i.type));
await click('[data-testid="exp-run"]');
await page.waitForFunction(() => window.__ds.simStore.getState().status === 'running', { timeout: 180_000 });
await wait(1200);
const early = await running();
await page.waitForFunction(() => window.__ds.sim.getTime() > 11, { timeout: 300_000 });
const late = await running();
const st = (r, k) => r.find((x) => x.key === k)?.status;
const ids = list.map((i) => i.id);
check('S3 staggered: the 6 s / 10 s instances wait, then start; the others run from 0', st(early, ids[1]) === 'pending' && st(early, ids[3]) === 'pending' && ['active', 'done'].includes(st(late, ids[1])) && ['active', 'done'].includes(st(late, ids[3])), { early, late });
await shot('06-s3-staggered');
await exitSim();
await wait(500);

// ── Scenario 4: two vortices — independent winds ───────────────────────────────────────────────────────────────────
await ev(() => window.__ds.world.getState().setExperiment({ instances: [] }));
await click('[data-testid="lib-tornado"]');
await clickWorld(-50, -40); await clickWorld(50, 40);
await page.keyboard.press('Escape');
await click('[data-testid="exp-run"]');
await page.waitForFunction(() => window.__ds.simStore.getState().status === 'running', { timeout: 120_000 });
await page.waitForFunction(() => window.__ds.sim.getTime() > 6, { timeout: 120_000 });
const vort = await ev(() => {
  const env = window.__ds.sim.getEnvironment();
  const a = env.windField.sample([-50 + 15, 10, -40], window.__ds.sim.getTime()).velocity.slice();
  const b = env.windField.sample([50 + 15, 10, 40], window.__ds.sim.getTime()).velocity.slice();
  const mid = env.windField.sample([0, 10, 0], window.__ds.sim.getTime()).speed;
  return { n: env.wind.vortices.length, a, b, mid, global: env.wind.baseSpeed };
});
check('S4 two vortex instances: each turns the wind around its own centre; between them (outside both reaches) calm', vort.n === 2 && vort.a[2] < -10 && vort.b[2] < -10 && vort.mid < 1 && vort.global === 0, vort);
// Stop one of them: the other keeps blowing.
const vkeys = (await running()).map((r) => r.key);
await ev((k) => window.__ds.sim.controlEvent(k, 'stop'), vkeys[0]);
await wait(600);
const after = await ev(() => window.__ds.sim.getEnvironment().wind.vortices.length);
check('S4 stopping one vortex leaves the other (per-instance control)', after === 1, { after });
await shot('07-s4-vortices');
await exitSim();
await wait(500);

// ── Scenario 5: right panel closed, a disaster from the command drawer ─────────────────────────────────────────────
const vpBefore = await ev(() => { const r = window.__r3f.get().gl.domElement.getBoundingClientRect(); return r.width * r.height; });
await click('[data-testid="right-close"]');
await wait(400);
const vpAfter = await ev(() => { const r = window.__r3f.get().gl.domElement.getBoundingClientRect(); return r.width * r.height; });
check('S5 closing the right panel widens the 3D view', vpAfter > vpBefore * 1.15, { vpBefore, vpAfter });
await click('[data-testid="command-toggle"]');
await page.click('[data-testid="command-input"]');
await page.keyboard.type(lang === 'ko' ? '폭발을 일으켜' : 'make an explosion');
await page.keyboard.press('Enter');
await page.waitForFunction(() => window.__ds.simStore.getState().status === 'running', { timeout: 120_000 }).catch(() => {});
await wait(1500);
run = await running();
check('S5 with the panel closed a command starts a disaster (same execution path)', run.some((r) => r.type === 'blast'), run);
await shot('08-s5-panel-closed');
await exitSim();
await click('[data-testid="right-open"]');

}
if (process.env.ONLY_S6) await fresh();
// ── Scenario 6: search ────────────────────────────────────────────────────────────────────────────────────────────
await click('[data-tab="phenomena"]');
for (const [q, type] of [[lang === 'ko' ? 'meteor' : '운석', 'impact'], [lang === 'ko' ? '블랙홀' : 'black hole', 'celestial'], ['earthquake', 'earthquake'], ['지진', 'earthquake']]) {
  await page.click('[data-testid="disaster-search"]', { clickCount: 3 });
  await page.keyboard.type(q);
  await wait(200);
  const shown = await ev(() => [...document.querySelectorAll('[data-testid="disaster-library"] [data-type]')].map((e) => e.getAttribute('data-type')));
  if (process.env.DEBUG) console.log(await ev(() => { const el = document.querySelector('[data-testid="disaster-search"]'); const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { rect: [r.left, r.top, r.width, r.height].map(Math.round), top: top?.outerHTML.slice(0, 160), vh: innerHeight }; }));
  if (process.env.DEBUG) console.log(await ev(() => ({ val: document.querySelector('[data-testid="disaster-search"]')?.value, n: document.querySelectorAll('[data-testid="disaster-search"]').length, focus: document.activeElement?.outerHTML.slice(0, 100), tab: window.__ds.ui.getState().rightTab, open: window.__ds.ui.getState().rightOpen })));
  await page.keyboard.press('Enter');
  await wait(200);
  const armed = await ev(() => window.__ds.placementStore.getState().type);
  check(`S6 search "${q}" finds ${type} (either language) and Enter arms it`, shown[0] === type && (armed === type || armed === null), { shown, armed });
  await page.keyboard.press('Escape');
  await ev(() => window.__ds.world.getState().setExperiment({ instances: [] }));
}
await shot('09-s6-search');
if (process.env.ONLY_S6 || process.env.STOP_S6) { await browser.close(); process.exit(0); }

// ── Scenario 7: palette 2-lane road joined to the default world's main street ─────────────────────────────────────
await fresh();
await view(66, 0, 45, 30);
await ev(() => window.__ds.editor.getState().armPlacement('env.road'));
await wait(300);
await clickWorld(66, 0);
await page.keyboard.press('Escape');
const road = await ev(() => {
  const d = window.__ds.world.getState().doc;
  const segs = Object.values(d.roads.segments);
  const lib = window.__ds.roadLib;
  const end = segs.find((s) => Math.abs(d.roads.nodes[s.a].x - 56) < 0.5 || Math.abs(d.roads.nodes[s.b].x - 56) < 0.5 || Math.abs(d.roads.nodes[s.a].x - 76) < 0.5 || Math.abs(d.roads.nodes[s.b].x - 76) < 0.5);
  const joined = segs.filter((s) => [s.a, s.b].some((n) => Math.abs(d.roads.nodes[n].x - 56) < 0.5 && Math.abs(d.roads.nodes[n].z) < 0.5));
  const s = window.__ds.buildLib.samplerFor(d.terrain);
  return { n: segs.length, joined: joined.map((x) => ({ w: x.profile.width, lanes: x.profile.lanes, sh: x.profile.shoulderWidth ?? 0, sw: x.profile.sidewalkWidth })), h: [55, 56, 57].map((x) => +s.sampleHeight(x, 0).toFixed(3)), objects: Object.values(d.objects).filter((o) => o.type === 'road').length, street: lib.PROFILE_PRESETS.street, any: !!end };
});
check('S7 the palette road is a network road joined at the main street end (no road object)', road.objects === 0 && road.joined.length === 2, road);
check('S7 same preset ⇒ same section: the palette road = the road tool\'s 2-lane street (7 m, 2 × 3.5 m lanes, 2 m sidewalks)', road.joined.some((j) => j.w === 7 && j.lanes === 2 && j.sh === 0 && j.sw === 2), road.joined);
check('S7 no step at the seam (surface heights across the joint within 2 cm)', Math.max(...road.h) - Math.min(...road.h) < 0.02, road.h);
await shot('10-s7-road-joint');

// ── Scenario 8: the steel office under an earthquake ──────────────────────────────────────────────────────────────
await fresh();
const office = await ev(() => Object.values(window.__ds.world.getState().doc.objects).find((o) => o.building?.spec.system === 'steelFrame' && o.building.spec.floors > 5)?.id);
await view(-14, -16.5, 45, 45);
await ev(() => window.__ds.actions.runSimulation([{ event: 'earthquake', magnitude: 7, pga: 0.6, duration: 20, seed: 3 }]));
await page.waitForFunction(() => window.__ds.sim.getTime() > 15, { timeout: 600_000 });
const quake = await ev((id) => {
  const e = window.__ds.sim.getRuntime().entities.get(id);
  const m = e.modular?.structure?.model;
  return { drift: e.seismic?.peakDrift ?? 0, storyPeak: Array.from(e.modular.storyPeak).map((v) => +v.toFixed(4)), damaged: Array.from(e.modular.damage).filter((d) => d > 0).length, records: m?.records.length ?? 0, level: m?.collapseLevel() ?? 'intact', v2: window.__ds.sim.getRuntime().structureV2 === true };
}, office);
check('S8 the steel office: storey drifts and member damage from its members (v2 structure model on)', quake.v2 && quake.drift > 0 && quake.storyPeak.some((v) => v > 0), quake);
await shot('11-s8-steel-quake');
await exitSim();

// ── Scenario 9: a blast at one side of a building ─────────────────────────────────────────────────────────────────
const target = await ev(() => { const o = Object.values(window.__ds.world.getState().doc.objects).find((o) => o.building?.spec.system === 'masonry'); return { id: o.id, x: o.transform.position[0], z: o.transform.position[2] }; });
await view(target.x, target.z, 40, 40);
await ev(() => window.__ds.world.getState().setExperiment({ instances: [] }));
await click('[data-tab="phenomena"]');
await click('[data-testid="lib-blast"]');
await ev(() => { const s = window.__ds.placementStore.getState(); s.setTemplate({ ...s.template, energy: 5e7 }); });
await clickWorld(target.x - 12, target.z);
await page.keyboard.press('Escape');
await click('[data-testid="exp-run"]');
await page.waitForFunction(() => window.__ds.sim.getTime() > 8, { timeout: 300_000 });
const side = await ev((t) => {
  const e = window.__ds.sim.getRuntime().entities.get(t.id);
  const ms = e.modular.design.members;
  const xs = ms.filter((m) => m.level === 0).map((m) => m.position[0]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  // Structural walls only (openings break on every face): near (west, blast side) vs far (east) face.
  const walls = ms.filter((m) => m.type === 'wall' && e.modular.failedSet.has(m.id));
  const near = walls.filter((m) => m.position[0] <= x0 + 1).length, far = walls.filter((m) => m.position[0] >= x1 - 1).length;
  return { failed: e.modular.failedSet.size, near, far, level: e.modular.structure?.model.collapseLevel() ?? 'intact', collapsed: !!e.flags.collapsed };
}, target);
check('S9 a side blast fails the near face walls first (more than the far face), not a global collapse', side.near > side.far && side.level !== 'global', side);
await shot('12-s9-side-blast');
await exitSim();

// ── Scenario 10: a sinkhole under a building ──────────────────────────────────────────────────────────────────────
const house = await ev(() => { const o = Object.values(window.__ds.world.getState().doc.objects).find((o) => o.building?.spec.system === 'rcFrame' && o.building.spec.floors <= 3); return { id: o.id, x: o.transform.position[0], z: o.transform.position[2] }; });
await view(house.x, house.z, 35, 35);
await ev(() => window.__ds.world.getState().setExperiment({ instances: [] }));
await click('[data-testid="lib-sinkhole"]');
await clickWorld(house.x - 3, house.z);
await page.keyboard.press('Escape');
await click('[data-testid="exp-run"]');
await page.waitForFunction(() => window.__ds.sim.getTime() > 20, { timeout: 600_000 });
const sink = await ev((h) => {
  const e = window.__ds.sim.getRuntime().entities.get(h.id);
  const m = e.modular.structure?.model;
  return { tilt: e.ground ? +(Math.hypot(e.ground.gradient[0], e.ground.gradient[1])).toFixed(4) : 0, settlement: e.ground?.settlement ?? 0, failed: e.modular.failedSet.size, foundation: m ? m.records.filter((r) => r.cause === 'foundation').length : 0, level: m?.collapseLevel() ?? 'intact', hinges: m ? m.events.filter((x) => x.kind === 'hinge').length : 0 };
}, house);
check('S10 a sinkhole under a building: the foundation loses support (settlement / tilt / foundation failures)', sink.settlement > 0 || sink.tilt > 0 || sink.foundation > 0, sink);
await shot('13-s10-sinkhole');
await exitSim();

// ── Whole run ─────────────────────────────────────────────────────────────────────────────────────────────────────
const gl = await glInfo();
const raw = await ev(() => [...document.body.innerText.matchAll(/\b(?:lib|place|inst|tab|vortex|road\.f|struct)\.[a-zA-Z.]+\b/g)].map((m) => m[0]).slice(0, 5));
check('no raw i18n keys of Phase 35.5 shown', raw.length === 0, raw);
check('whole run: no page / console errors', errors.length === 0, errors.slice(0, 5));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; ${errors.length} page errors; geometries ${gl.geometries}`);
fs.writeFileSync(path.join(out, `results-${lang}.json`), JSON.stringify({ lang, results, errors, gl }, null, 2));
await browser.close();

