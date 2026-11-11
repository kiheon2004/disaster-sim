// Phase 37 (view) — the command preview in the 3D view, looked at in a real browser: screenshots for a person, the
// numbers `window.__ds.command.preview()` reports for each kind of plan, "no leftover ghosts" after every way a plan
// goes away, draw calls / FPS with 100 and 1000 ghosts, and a plan / cancel leak lap.
// Plans are driven through `__ds.command` (canonical text) — this script checks the VIEWPORT side, not the bar's keys.
//
//   npx vite --port 4312 --strictPort &            (dev server; or vite build && vite preview)
//   node scripts/look-preview37.mjs http://localhost:4312/ <out-dir>        ONLY=cursor,kinds,gone,perf,leak   LAPS=100
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const [url = 'http://localhost:4312/', out = './docs/verify/command37/look-preview'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const lang = process.env.LANG_UI ?? 'ko';
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const LAPS = Number(process.env.LAPS ?? 100);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = Number(process.env.VW ?? 1600), H = Number(process.env.VH ?? 1000);
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', `--window-size=${W},${H}`, '--enable-precise-memory-info'],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 }, protocolTimeout: 1_800_000, timeout: 180_000,
});
const errors = [];
const results = [];
const log = { url, lang, started: new Date().toISOString(), load: os.loadavg(), freeMemMB: Math.round(os.freemem() / 1e6), commit: '', checks: results, numbers: {} };
try { log.commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
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
const want = (g) => !ONLY || ONLY.has(g);

async function fresh() {
  await page.goto(url + '?devtools', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__ds && window.__r3f);
  await ev(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__ds && window.__r3f);
  await ev((l) => window.__ds.locale.getState().setLocale(l), lang);
  await wait(1200);
}
async function view(x = 0, z = 0, h = 120, back = 60) {
  await ev(([x, z, h, back]) => { const st = window.__r3f.get(); st.camera.position.set(x, h, z + back); st.controls.target.set(x, 0, z); st.controls.update(); }, [x, z, h, back]);
  await wait(400);
}
const screen = (x, z, dy = 0) => ev(([x, z, dy]) => {
  const st = window.__r3f.get(); const r = st.gl.domElement.getBoundingClientRect();
  const s = window.__ds.buildLib.samplerFor(window.__ds.world.getState().doc.terrain);
  const v = st.camera.position.clone().set(x, s.sampleHeight(x, z) + dy, z).project(st.camera);
  return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
}, [x, z, dy]);

const preview = () => ev(() => window.__ds.command.preview());
/** Aim the camera at what the plan adds / moves / removes (the middle of those objects). */
async function aimAtPlan(h = 30, back = 34) {
  const c = await ev(() => {
    const d = window.__ds.command.session.getState().plan?.preview.diff;
    if (!d) return null;
    const ps = [...d.added, ...d.removed, ...d.moved.map((m) => m.after), ...d.changed.map((m) => m.after)].map((o) => o.transform.position);
    if (!ps.length) return null;
    return [ps.reduce((a, p) => a + p[0], 0) / ps.length, ps.reduce((a, p) => a + p[2], 0) / ps.length];
  });
  if (c) await view(c[0], c[1], h, back);
  return c;
}
const session = () => ev(() => { const s = window.__ds.command.session.getState(); return { plan: s.plan ? { armed: s.plan.armed, hash: s.plan.preview.result.hash } : null, feedback: s.feedback.k, cursor: s.cursor }; });
/** Type a command (a draft plan follows, as while typing). */
const draft = async (text) => { await ev((t) => { window.__ds.command.session.getState().setText(t); window.__ds.command.actions.draftCommand(); }, text); await wait(500); };
/** Enter. */
const enter = async (text) => {
  const r = await ev(async (t) => { if (t !== null) window.__ds.command.session.getState().setText(t); return window.__ds.command.actions.submitCommand(); }, text ?? null);
  await wait(600);
  return r;
};
const esc = async () => { await ev(() => window.__ds.command.actions.cancelCommand()); await wait(300); };
const hashes = () => ev(() => `${window.__ds.hash.raw()} ${window.__ds.hash.terrain()}`);
const sceneCount = () => ev(() => { let n = 0; window.__r3f.get().scene.traverse(() => n++); return n; });
const sprites = () => ev(() => { let n = 0; window.__r3f.get().scene.traverse((o) => { if (o.isSprite) n++; }); return n; });
const gl = () => ev(() => { const g = window.__r3f.get().gl.info; return { geometries: g.memory.geometries, textures: g.memory.textures, programs: g.programs?.length ?? 0, calls: g.render.calls, triangles: g.render.triangles }; });
/** Frames per second and draw calls over `ms` of real rendering. */
const measure = (ms = 3000) => ev((ms) => new Promise((resolve) => {
  const g = window.__r3f.get().gl.info;
  let frames = 0, calls = 0, tris = 0, worst = 0, last = performance.now();
  const start = last;
  const tick = (now) => {
    frames++; calls += g.render.calls; tris += g.render.triangles; worst = Math.max(worst, now - last); last = now;
    if (now - start < ms) requestAnimationFrame(tick);
    else resolve({ fps: +(frames / ((now - start) / 1000)).toFixed(1), drawCalls: Math.round(calls / frames), triangles: Math.round(tris / frames), worstFrameMs: +worst.toFixed(1), frames });
  };
  requestAnimationFrame(tick);
}), ms);
const emptyNow = async (name) => {
  const p = await preview();
  check(name, p.sceneObjects === 0 && p.ghosts === 0 && p.pins === 0 && p.removed === 0 && p.terrain === null && p.key === null, { sceneObjects: p.sceneObjects, key: p.key, ghosts: p.ghosts });
};

await fresh();
await view(0, 10, 70, 70);

// ── Cursor ground point and view point ───────────────────────────────────────────────
if (want('cursor')) {
  const c0 = (await session()).cursor;
  const [sx, sy] = await screen(20, 30);
  await page.mouse.move(sx - 40, sy - 20);
  await page.mouse.move(sx, sy, { steps: 5 });
  await wait(300);
  const c1 = (await session()).cursor;
  check('cursor-1 the ground point under the pointer is in the session, 0.1 m steps', c0 === null && c1 && Math.abs(c1[0] - 20) < 0.3 && Math.abs(c1[1] - 30) < 0.3 && c1.every((v) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-9), { before: c0, at: c1 });
  // Count the store writes of 40 small pointer moves over one ground point and of a sweep.
  const writes = await ev(async ([sx, sy]) => {
    let n = 0;
    const un = window.__ds.command.session.subscribe((s, p) => { if (s.cursor !== p.cursor) n++; });
    const el = window.__r3f.get().gl.domElement;
    const move = (x, y) => el.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true, buttons: 0 }));
    for (let k = 0; k < 40; k++) move(sx + (k % 2) * 0.01, sy);
    await new Promise((r) => setTimeout(r, 200));
    const still = n;
    n = 0;
    const f0 = performance.now();
    let frames = 0;
    await new Promise((res) => { const tick = () => { frames++; for (let k = 0; k < 5; k++) move(sx + frames * 2 + k * 0.3, sy); if (performance.now() - f0 < 500) requestAnimationFrame(tick); else res(); }; requestAnimationFrame(tick); });
    await new Promise((r) => setTimeout(r, 100));
    un();
    return { still, sweep: n, frames, events: frames * 5 };
  }, [sx, sy]);
  check('cursor-2 no store write for moves that stay on the same 0.1 m point; at most one write per frame in a sweep', writes.still === 0 && writes.sweep > 0 && writes.sweep <= writes.frames + 1, writes);
  await page.mouse.move(sx, sy, { steps: 2 });
  await wait(200);
  const inside = (await session()).cursor;
  // Leave the canvas for the command bar (below the canvas) in one jump — the last point stays, also while the pointer
  // moves about outside.
  const below = await ev(() => { const r = window.__r3f.get().gl.domElement.getBoundingClientRect(); return [r.left + r.width / 2, Math.min(window.innerHeight - 4, r.bottom + 12)]; });
  await page.mouse.move(below[0], below[1]);
  await wait(200);
  await page.mouse.move(below[0] + 60, below[1] + 4, { steps: 3 });
  await wait(300);
  const left = (await session()).cursor;
  check('cursor-3 the last point is kept when the pointer leaves the canvas', inside && left && inside[0] === left[0] && inside[1] === left[1], { inside, left, below });
  // Wheel zoom under a still pointer: the point under it is looked up again.
  await page.mouse.move(sx + 120, sy - 60, { steps: 3 });
  await wait(250);
  const beforeZoom = (await session()).cursor;
  await page.mouse.wheel({ deltaY: -600 });
  await wait(900);
  const afterZoom = (await session()).cursor;
  check('cursor-4 zooming under a still pointer updates the point', beforeZoom && afterZoom && (beforeZoom[0] !== afterZoom[0] || beforeZoom[1] !== afterZoom[1]), { beforeZoom, afterZoom });
  await view(0, 10, 70, 70);
  const ctx = await ev(() => { const c = window.__ds.command.context(); return { view: c.view, cursor: c.cursor }; });
  check('view-1 the view point is where the screen centre meets the ground (the orbit target here)', ctx.view && Math.abs(ctx.view[0]) < 0.2 && Math.abs(ctx.view[1] - 10) < 0.2, ctx);
  await ev(() => { const st = window.__r3f.get(); st.camera.position.set(40, 28, 40); st.controls.target.set(10, 8, 10); st.controls.update(); });
  await wait(300);
  const ctx2 = await ev(() => window.__ds.command.context().view);
  check('view-2 a target above the ground: the view point is the ground behind it, not the target', ctx2 && Math.abs(ctx2[0] + 2) < 0.5 && Math.abs(ctx2[1] + 2) < 0.5, ctx2);
  log.numbers.cursor = { writes };
  await view(0, 10, 70, 70);
}

// ── Each kind of preview ─────────────────────────────────────────────────────────────
if (want('kinds')) {
  const before = await hashes();
  // S4: three houses north of the main road.
  await draft('place building:house count=3 along=road:main side=north gap=2');
  log.numbers.housesAt = await aimAtPlan(26, 30);
  await wait(400);
  const d = await preview(), ds = await session();
  await shot('01-houses-draft');
  check('kinds-1 draft: 3 ghosts and 3 snap markers while typing (not armed)', ds.plan && ds.plan.armed === false && d.ghosts === 3 && d.snaps === 3 && d.armed === false && d.sceneObjects > 0, d);
  const builds0 = d.builds;
  await draft('place building:house count=3 along=road:main side=north gap=2 ');
  const d2 = await preview();
  check('kinds-2 typing on to the same plan rebuilds nothing', d2.builds === builds0 && d2.key === d.key, { builds: [builds0, d2.builds] });
  await draft('place building:house count=3 along=road:main side=north gap=2');
  const r = await enter(null);
  const a = await preview();
  await shot('02-houses-open');
  check('kinds-3 Enter: the same plan is now the open plan — same key, no rebuild, drawn stronger', r === 'planned' && a.armed === true && a.key === d.key && a.builds === builds0 && a.ghosts === 3, { r, key: [d.key, a.key], builds: [builds0, a.builds] });
  check('kinds-4 the document is untouched by the preview', (await hashes()) === before);
  await esc();
  await emptyNow('kinds-5 Esc: nothing of the preview is left in the scene');

  // Rejected + warned.
  const crate = await ev(() => { const ids = window.__ds.world.getState().applyEdit({ add: [{ type: 'crate', transform: { position: [30, 0, 30], rotation: [0, 0, 0], scale: [1, 1, 1] } }] }); return ids[0]; });
  await view(95, 30, 12, 16);
  await enter('place crate count=4 at=97,30 gap=2');
  const rj = await preview();
  await shot('03-rejected');
  check('kinds-6 items outside the world: rejected markers, no ghost for them', rj.rejected > 0 && rj.ghosts === 4 - rj.rejected, rj);
  await esc();
  await view(30, 30, 14, 16);
  await enter('place crate at=30,30');
  const wn = await preview();
  await shot('04-warned');
  check('kinds-7 a ghost on an existing object is a warned (orange) ghost', wn.ghosts === 1 && wn.warned === 1, wn);
  await esc();

  // Removed / changed / moved.
  const trees = await ev(() => Object.values(window.__ds.world.getState().doc.objects).filter((o) => o.type === 'tree').length);
  await view(0, 10, 80, 80);
  await enter('delete type:tree');
  await aimAtPlan(60, 60);
  const rm = await preview();
  await shot('05-removed');
  check('kinds-8 delete: every tree marked as removed, nothing else', trees > 0 && rm.removed === trees && rm.ghosts === 0 && rm.changed === 0, { trees, removed: rm.removed });
  await esc();
  await enter('hide type:tree');
  const ch = await preview();
  await shot('06-changed');
  check('kinds-9 hide: every tree marked as changed (another shape than removed)', ch.changed === trees && ch.removed === 0 && ch.ghosts === 0, { trees, changed: ch.changed });
  await esc();
  await ev((id) => window.__ds.editor.getState().setSelection([id], id), crate);
  await view(33, 30, 14, 16);
  await enter('move selection by=6,0,2');
  const mv = await preview();
  await shot('07-moved');
  check('kinds-10 move: a ghost at the new place and a link from the old one', mv.moved === 1 && mv.ghosts === 1, mv);
  await esc();
  await ev(() => window.__ds.editor.getState().select(null));

  // Terrain heat map, paint.
  await view(-60, 65, 40, 40);
  await enter('terrain raise circle -60,65 r=10 by=3');
  const tr = await preview();
  await shot('08-terrain-raise');
  check('kinds-11 terrain raise: the heat map (up 3 m, area of the circle)', tr.terrain && Math.abs(tr.terrain.up - 3) < 0.05 && tr.terrain.down === 0 && tr.terrain.area > 250, tr.terrain);
  await esc();
  await enter('terrain lower circle -60,65 r=10 by=2');
  const lo = await preview();
  await shot('09-terrain-lower');
  check('kinds-12 terrain lower: down 2 m', lo.terrain && Math.abs(lo.terrain.down - 2) < 0.05, lo.terrain);
  await esc();
  await enter('paint circle -60,65 r=8 ground=sand');
  const pa = await preview();
  await shot('10-paint');
  check('kinds-13 paint: a painted area and no height change', pa.terrain && pa.terrain.up === 0 && pa.terrain.down === 0 && pa.terrain.area > 100, pa.terrain);
  await esc();

  // Roads.
  await view(-50, 55, 60, 50);
  await enter('road -70,40 -> -30,75 preset=street');
  const ro = await preview();
  await shot('11-road');
  check('kinds-14 road: the new segment drawn on the ground', ro.roads >= 1, ro);
  await esc();

  // Disasters: ghost pin → confirm → the real pin is drawn (no tab switch, nothing selected) → undo → gone.
  await ev(() => window.__ds.ui.getState().setRightTab('selection'));
  await view(-60, 60, 40, 60);
  const sp0 = await sprites();
  await enter('disaster blast at=-60,60 energy=1.8e9 start=5');
  const pin = await preview();
  await shot('12-disaster-ghost');
  check('kinds-15 disaster: one ghost pin (and its ground point highlighted)', pin.pins === 1 && pin.highlight >= 1 && (await sprites()) === sp0 + 1, { pins: pin.pins, highlight: pin.highlight, sprites: [sp0, await sprites()] });
  const selBefore = await ev(() => window.__ds.editor.getState().selectedIds.length);
  const r2 = await enter(null);
  const placed = await ev(() => ({ instances: (window.__ds.world.getState().doc.scenario.experiment?.instances ?? []).length, pinSelected: window.__ds.placementStore.getState().selected, tab: window.__ds.ui.getState().rightTab, sel: window.__ds.editor.getState().selectedIds.length }));
  await shot('13-disaster-placed');
  const after = await preview();
  check('kinds-16 confirmed: the preview is gone and the REAL pin is drawn — on another tab, with no pin selected and the selection untouched', r2 === 'applied' && placed.instances === 1 && after.sceneObjects === 0 && (await sprites()) === sp0 + 1 && placed.pinSelected === null && placed.tab === 'selection' && placed.sel === selBefore, { r2, placed, sprites: await sprites() });
  // Moving and deleting the placed disaster by command: a ghost pin with an arrow from the real one; the real pin marked.
  const pid = await ev(() => window.__ds.world.getState().doc.scenario.experiment.instances[0].id);
  await enter(`disaster ${pid} move to=-40,45`);
  const mvp = await preview();
  await shot('13b-disaster-move');
  check('kinds-16b moving a placed disaster: one ghost pin at the new place, the real pin still drawn at the old one', mvp.pins === 1 && (await sprites()) === sp0 + 2 && mvp.sceneObjects > 0, { pins: mvp.pins, sprites: await sprites(), sceneObjects: mvp.sceneObjects });
  await esc();
  await enter(`disaster ${pid} delete`);
  const dlp = await preview();
  await shot('13c-disaster-delete');
  check('kinds-16c deleting a placed disaster: its real pin is the marking (no ghost pin); nothing changed yet', dlp.pins === 1 && (await sprites()) === sp0 + 1 && (await ev(() => window.__ds.world.getState().doc.scenario.experiment.instances.length)) === 1, { pins: dlp.pins, sprites: await sprites() });
  await esc();
  // A question's option pointing at the instance (hover): its pin is shown although no plan is open and no result names it.
  await ev(() => window.__ds.command.session.getState().setFeedback({ k: 'none' }));
  await wait(300);
  const hidden = await sprites();
  await ev((id) => window.__ds.command.session.getState().setHover({ instances: [id] }), pid);
  await wait(400);
  const shown = await sprites();
  const hp = await preview();
  await shot('13d-instance-hover');
  await ev(() => window.__ds.command.session.getState().setHover(null));
  await wait(300);
  check('kinds-16d the result gone: the pin is hidden again (not the disasters tab); hovering an option that names the instance shows it', hidden === sp0 && shown === sp0 + 1 && hp.highlight === 1 && (await sprites()) === sp0, { hidden, shown, highlight: hp.highlight, after: await sprites() });
  await ev(() => window.__ds.world.getState().undo());
  await wait(400);
  check('kinds-17 undo: the instance and its pin are gone', (await sprites()) === sp0 && (await ev(() => (window.__ds.world.getState().doc.scenario.experiment?.instances ?? []).length)) === 0, { sprites: await sprites() });

  // Highlight of the option under the pointer (what the bar sets on hover).
  await view(30, 30, 30, 40);
  await ev((id) => window.__ds.command.session.getState().setHover({ ids: [id], points: [[40, 30]], segments: Object.keys(window.__ds.world.getState().doc.roads.segments).slice(0, 1), nodes: Object.keys(window.__ds.world.getState().doc.roads.nodes).slice(0, 1) }), crate);
  await wait(400);
  const hv = await preview();
  await shot('14-highlight');
  check('kinds-18 hover highlight without a plan: box, road line, node ring, point ring', hv.highlight === 4 && hv.sceneObjects > 0, hv);
  await ev(() => window.__ds.command.session.getState().setHover(null));
  await wait(300);
  await emptyNow('kinds-19 hover cleared: nothing left');
  // Take the helper crate out again (one undo step) — the world is as it was loaded.
  await ev(() => window.__ds.world.getState().undo());
  await wait(200);
  check('kinds-20 the document is as before all the previews', (await hashes()) === before, '');
}

// ── Every way a plan goes away leaves nothing (S21) ──────────────────────────────────
if (want('gone')) {
  const text = 'place building:house count=3 along=road:main side=north gap=2';
  const open = async () => { const r = await enter(text); const p = await preview(); return r === 'planned' && p.ghosts === 3 && p.sceneObjects > 0; };
  check('gone-1 plan open', await open());
  await ev(() => window.__ds.editor.getState().setTerrainTool('raise'));
  await wait(400);
  await emptyNow('gone-2 arming an edit tool: plan cancelled, no leftover ghosts');
  await ev(() => window.__ds.editor.getState().setTerrainTool(null));
  await wait(200);
  check('gone-3 plan open', await open());
  await ev(() => window.__ds.placement.armPlacement('blast'));
  await wait(400);
  await emptyNow('gone-4 arming a disaster placement: no leftover ghosts');
  await ev(() => window.__ds.placement.disarmPlacement());
  await wait(200);
  check('gone-5 plan open', await open());
  await ev(() => window.__ds.world.getState().replaceDocument(window.__ds.world.getState().doc));
  await wait(500);
  await emptyNow('gone-6 document replaced: no leftover ghosts');
  check('gone-7 plan open', await open());
  await ev(() => window.__ds.actions.enterSimulation());
  await page.waitForFunction(() => window.__ds.editor.getState().mode === 'simulation', { timeout: 120000 });
  await wait(1500);
  const sim = await preview();
  check('gone-8 mode switch to the simulation: plan cancelled, no leftover ghosts (the simulation scene has its own layer)', sim.sceneObjects === 0 && sim.ghosts === 0 && sim.key === null && sim.layers === 1, sim);
  // In the simulation: a disaster plan draws its ghost pin (the pins scope).
  const r = await enter('disaster fire at=20,30');
  const sp = await preview();
  await view(20, 30, 30, 50);
  await shot('15-sim-ghost-pin');
  check('gone-9 a disaster plan in the simulation scene draws its ghost pin', r === 'planned' && sp.pins === 1 && sp.sceneObjects > 0 && sp.ghosts === 0, { r, pins: sp.pins, sceneObjects: sp.sceneObjects });
  await ev(() => window.__ds.actions.exitSimulation());
  await page.waitForFunction(() => window.__ds.editor.getState().mode === 'editor', { timeout: 120000 });
  await wait(1200);
  await emptyNow('gone-10 back in the editor: the plan made in the simulation is gone too');
}

// ── Draw calls and FPS with 100 / 1000 ghosts ────────────────────────────────────────
if (want('perf')) {
  await fresh();
  await view(0, 0, 150, 120);
  await wait(800);
  const rows = (kind, perRow, n, gap) => Array.from({ length: n }, (_, k) => `place ${kind} count=${perRow} at=0,${(-90 + (180 * k) / Math.max(1, n - 1)).toFixed(1)} gap=${gap}`).join('\n');
  const cases = [
    ['trees-100', rows('tree', 10, 10, 12)],
    ['trees-1000', rows('tree', 25, 40, 2.5)],
    ['houses-100', rows('building:house', 10, 10, 6)],
    ['houses-1000', rows('building:house', 20, 50, 1)],
  ];
  const base = await measure(3000);
  const perf = { baseline: base, cases: {} };
  for (const [name, script] of cases) {
    // Plan (text → plan on a fork → difference), then the time until the ghost batches are in the scene and drawn once.
    const t = await ev(async (s) => {
      const a = performance.now();
      window.__ds.command.session.getState().setText(s);
      const r = await window.__ds.command.actions.submitCommand();
      const b = performance.now();
      await new Promise((res) => { const tick = () => { const p = window.__ds.command.preview(); if (p.ghosts > 0 && p.sceneObjects > 3) requestAnimationFrame(() => res()); else requestAnimationFrame(tick); }; tick(); });
      return { r, planMs: +(b - a).toFixed(0), ghostsInSceneMs: +(performance.now() - b).toFixed(0) };
    }, script);
    await wait(1500);
    const p = await preview();
    const m = await measure(4000);
    await shot(`20-perf-${name}`);
    perf.cases[name] = { ...t, ghosts: p.ghosts, warned: p.warned, rejected: p.rejected, sceneObjects: p.sceneObjects, ...m, addedDrawCalls: m.drawCalls - base.drawCalls };
    console.log(name, JSON.stringify(perf.cases[name]));
    await esc();
    await wait(600);
    await emptyNow(`perf-${name} cancelled: nothing left`);
  }
  perf.after = await measure(2000);
  log.numbers.perf = perf;
  console.log('baseline', JSON.stringify(base), 'after', JSON.stringify(perf.after));
}

// ── Plan / cancel ×LAPS: geometries, textures, programs, scene objects, heap ──────────
if (want('leak')) {
  await fresh();
  await view(0, 10, 70, 70);
  const HOUSES = 'place building:house count=3 along=road:main side=north gap=2';
  const variants = {
    // Everything at once: ghosts, heat map, road, pin, removed boxes.
    all: [HOUSES, 'terrain raise circle -60,65 r=8 by=2', 'road -70,40 -> -30,75 preset=street', 'disaster blast at=40,-30 energy=1.8e9', 'delete type:tree'].join('\n'),
    // Only the batched ghost renderer (PlanPreview — the editor's own, also used by the brush / line / area tools).
    ghosts: HOUSES,
    // Only this layer's own markings and the pin / heat map (no ghost objects).
    marks: ['terrain raise circle -60,65 r=8 by=2', 'disaster blast at=40,-30 energy=1.8e9', 'delete type:tree', 'hide type:car'].join('\n'),
  };
  // Heap after a forced collection (CDP) — without it the number is mostly garbage not yet collected.
  const cdp = await page.createCDPSession();
  await cdp.send('HeapProfiler.enable');
  const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); await wait(150); await cdp.send('HeapProfiler.collectGarbage'); return ev(() => (performance.memory ? +(performance.memory.usedJSHeapSize / 1e6).toFixed(2) : null)); };
  const snap = async () => ({ ...(await gl()), scene: await sceneCount(), preview: (await preview()).sceneObjects, heapMB: await heap() });
  const marks = [1, 10, Math.round(LAPS / 2), LAPS];
  const perLapKB = (x, from, to) => +(((x[to]?.heapMB ?? x[to]) - (x[from]?.heapMB ?? x[from])) * 1000 / (to - from)).toFixed(1);
  const leak = {};
  for (const [name, script] of Object.entries(variants)) {
    if (process.env.LEAK && !process.env.LEAK.split(',').includes(name)) continue;
    // Control first: the same plans made by the pure pipeline alone (no session, nothing drawn) — what planning itself keeps.
    const control = {};
    control[0] = await heap();
    for (let k = 1; k <= LAPS; k++) {
      await ev((s) => {
        const lib = window.__ds.command.lib;
        const intents = s.split('\n').map((l) => lib.parseCanonical(l).intent);
        lib.previewIntents(window.__ds.world.getState().doc, intents, window.__ds.command.context());
      }, script);
      if (marks.includes(k)) control[k] = await heap();
    }
    const laps = {};
    laps[0] = await snap();
    for (let k = 1; k <= LAPS; k++) {
      await ev(async (s) => { window.__ds.command.session.getState().setText(s); await window.__ds.command.actions.submitCommand(); }, script);
      await wait(180);
      await ev(() => window.__ds.command.actions.cancelCommand());
      await wait(120);
      if (marks.includes(k)) { await wait(500); laps[k] = await snap(); }
    }
    const a = laps[10] ?? laps[1], b = laps[LAPS];
    check(`leak-${name} plan / cancel ×${LAPS}: geometries, textures, programs and scene objects are flat after the first 10 laps`, a.geometries === b.geometries && a.textures === b.textures && a.programs === b.programs && a.scene === b.scene && b.preview === 0, { lap10: a, [`lap${LAPS}`]: b });
    leak[name] = { laps, control, heapPerLapKB: { withLayer: perLapKB(laps, 10, LAPS), planningOnly: perLapKB(control, 10, LAPS) } };
    console.log(`leak ${name}: heap per lap after lap 10 (KB, after forced GC)`, JSON.stringify(leak[name].heapPerLapKB), 'control', JSON.stringify(control));
  }
  log.numbers.leak = leak;
}

log.errors = errors;
log.finished = new Date().toISOString();
log.loadEnd = os.loadavg();
fs.writeFileSync(path.join(out, `look-preview37-${lang}.json`), JSON.stringify(log, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();
process.exit(failed.length || errors.length ? 1 : 0);
