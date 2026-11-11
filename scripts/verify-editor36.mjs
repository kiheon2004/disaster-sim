// Browser verification of Phase 36 (advanced world editor) in real Chrome, Korean / English, with the real
// mouse and keyboard (puppeteer input events — state is READ through window.__ds, never written to fake a
// user action unless a check says so). Scenario groups run in order; ONLY=<comma list of group ids> runs a subset.
//
//   npx vite build && npx vite preview --port 4196 --strictPort &
//   LANG_UI=ko node scripts/verify-editor36.mjs http://localhost:4196/ ./docs/verify/editor36
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:4196/', out = './docs/verify/editor36'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const lang = process.env.LANG_UI ?? 'ko';
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = Number(process.env.VW ?? 1600), H = Number(process.env.VH ?? 1000);
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', `--window-size=${W},${H}`, '--enable-precise-memory-info'],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 }, protocolTimeout: 1_800_000, timeout: 180_000,
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
const want = (g) => !ONLY || ONLY.has(g);

async function fresh(query = '') {
  await page.goto(url + '?devtools' + query, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__ds && window.__r3f);
  await ev(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__ds && window.__r3f);
  await ev((l) => window.__ds.locale.getState().setLocale(l), lang);
  await wait(1200);
}
/** Camera looking down at (x, z) from height h, `back` m south. */
async function view(x = 0, z = 0, h = 120, back = 60) {
  await ev(([x, z, h, back]) => { const st = window.__r3f.get(); st.camera.position.set(x, h, z + back); st.controls.target.set(x, 0, z); st.controls.update(); }, [x, z, h, back]);
  await wait(400);
}
/** Almost straight down at (x, z): the point is at the canvas centre, nothing in front of it. */
const above = (x, z, h = 60) => view(x, z, h, 0.5);
/** Screen point at a fraction of the CANVAS (not the window — side panels cover parts of it). */
const canvasAt = (fx, fy) => ev(([fx, fy]) => { const r = window.__r3f.get().gl.domElement.getBoundingClientRect(); return [r.left + r.width * fx, r.top + r.height * fy]; }, [fx, fy]);
const camPos = () => ev(() => window.__r3f.get().camera.position.toArray().map((v) => Math.round(v * 100) / 100));
/** Screen point of a world point (y = ground height + dy). */
const screen = (x, z, dy = 0) => ev(([x, z, dy]) => {
  const st = window.__r3f.get(); const r = st.gl.domElement.getBoundingClientRect();
  const s = window.__ds.buildLib.samplerFor(window.__ds.world.getState().doc.terrain);
  const v = st.camera.position.clone().set(x, s.sampleHeight(x, z) + dy, z).project(st.camera);
  return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
}, [x, z, dy]);
async function clickWorld(x, z, dy = 0, mods = []) {
  const [sx, sy] = await screen(x, z, dy);
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.move(sx - 12, sy - 8);
  await page.mouse.move(sx, sy, { steps: 3 });
  await wait(120);
  await page.mouse.click(sx, sy);
  for (const m of mods) await page.keyboard.up(m);
  await wait(200);
}
/** Press at a screen point, move by (dx, dy) in steps, optionally keep the button down. */
async function dragScreen([sx, sy], dx, dy, { release = true, steps = 12 } = {}) {
  await page.mouse.move(sx, sy);
  await wait(80);
  await page.mouse.down();
  await page.mouse.move(sx + dx, sy + dy, { steps });
  await wait(120);
  if (release) { await page.mouse.up(); await wait(200); }
}
const click = async (sel) => { await page.click(sel); await wait(180); };
const objects = () => ev(() => Object.values(window.__ds.world.getState().doc.objects).map((o) => ({ id: o.id, type: o.type, name: o.name, p: o.transform.position, r: o.transform.rotation, group: o.group ?? null })));
const sel = () => ev(() => window.__ds.editor.getState().selectedIds);
const inputState = () => ev(() => ({ locked: window.__ds.input.cameraLocked(), owners: window.__ds.input.cameraLockOwners(), gesture: window.__ds.input.activeGesture(), dragging: window.__ds.editor.getState().dragging, tool: window.__ds.editor.getState().tool }));
const undoDepth = () => ev(() => window.__ds.world.getState().past.length);
const insts = () => ev(() => window.__ds.world.getState().doc.scenario.experiment?.instances ?? []);
const glInfo = () => ev(() => { const g = window.__r3f.get().gl.info; return { geometries: g.memory.geometries, textures: g.memory.textures }; });
const near = (a, b, tol = 0.05) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);

// ── G1 (S18 + 36-A): input ownership — gizmo drag cancel, orbit, pin drag cancel, tool switch during placement ──
if (want('input')) {
  await fresh();
  const objs = await objects();
  const b = objs.filter((o) => o.type === 'building').sort((a, c) => Math.hypot(...[a.p[0], a.p[2]]) - Math.hypot(...[c.p[0], c.p[2]]))[0];
  // Select by clicking the building from above, then drag the gizmo's centre handle and press Esc mid-drag.
  await above(b.p[0], b.p[2], 60);
  await clickWorld(b.p[0], b.p[2], 4);
  let s = await sel();
  check('input-1 click selects the building', s.includes(b.id), { s, b: b.id });
  const steps0 = await undoDepth();
  const at = await screen(b.p[0], b.p[2], 0);
  await dragScreen(at, 60, 0, { release: false });
  const mid = await inputState();
  const moved = (await objects()).find((o) => o.id === b.id).p;
  await page.keyboard.press('Escape');
  await wait(250);
  await page.mouse.up();
  await wait(250);
  const after = (await objects()).find((o) => o.id === b.id).p;
  const st = await inputState();
  check('input-2 gizmo drag holds an owned camera lock while dragging', mid.locked && mid.gesture === 'gizmo:object', mid);
  check('input-3 Esc mid-drag restores the transform, adds no undo step, keeps the selection', near(after, b.p) && !near(moved, b.p, 0.2) && (await undoDepth()) === steps0 && (await sel()).includes(b.id), { before: b.p, moved, after });
  check('input-4 after the cancelled drag: camera free, not dragging', !st.locked && !st.dragging && st.gesture === null, st);

  // A real drag + release = exactly one undo step; Ctrl+Z restores.
  await dragScreen(at, 50, 0);
  const p2 = (await objects()).find((o) => o.id === b.id).p;
  check('input-5 a completed drag moves the object as ONE undo step', !near(p2, b.p, 0.2) && (await undoDepth()) === steps0 + 1, { p2, steps: await undoDepth() });
  await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
  await wait(300);
  check('input-6 Ctrl+Z restores it', near((await objects()).find((o) => o.id === b.id).p, b.p), {});

  // Orbit still works with the left button on empty ground (camera position changes).
  await page.keyboard.press('Escape');
  await wait(200);
  await view(0, 0, 90, 60); // an oblique view: an orbit visibly moves the camera
  const c0 = await camPos();
  await dragScreen(await canvasAt(0.25, 0.75), -120, 0);
  const c1 = await camPos();
  check('input-7 left-drag on empty ground orbits the camera', !near(c0, c1, 0.5), { c0, c1 });

  // A disaster pin drag cancelled with Esc: the instance keeps its place.
  await above(-40, 40, 70);
  await click('[data-tab="phenomena"]');
  await click('[data-testid="lib-blast"]');
  await clickWorld(-40, 40);
  await page.keyboard.press('Escape'); // leave placement
  await wait(250);
  let is = await insts();
  const pin = is[is.length - 1];
  const pinAt = [pin.spec.position[0], pin.spec.position[1]];
  await dragScreen(await screen(pinAt[0], pinAt[1], 0), 70, 30, { release: false });
  const pd = await ev(() => window.__ds.placementStore.getState().drag);
  await page.keyboard.press('Escape');
  await wait(200);
  await page.mouse.up();
  await wait(250);
  is = await insts();
  const pin2 = is.find((i) => i.id === pin.id);
  const pinAt2 = [pin2.spec.position[0], pin2.spec.position[1]];
  const st2 = await inputState();
  check('input-8 pin drag follows the mouse, Esc puts the pin back', pd && near(pinAt2, pinAt, 0.05) && !st2.locked, { pd, pinAt, pinAt2, st2 });

  // Arming a disaster while the road tool is active leaves the road tool; arming the road tool disarms the disaster.
  await ev(() => window.__ds.editor.getState().setRoadEdit(true));
  await wait(200);
  await click('[data-tab="phenomena"]');
  await click('[data-testid="lib-blast"]');
  const t1 = await inputState();
  await ev(() => window.__ds.editor.getState().setRoadEdit(true));
  await wait(200);
  const armed = await ev(() => window.__ds.placementStore.getState().type);
  check('input-9 disaster placement and editor tools disarm each other', t1.tool === 'select' && armed === null, { t1, armed });

  // Pin selected, then a building selected → Delete removes the building's selection target, not the disaster.
  await ev(() => window.__ds.editor.getState().setRoadEdit(false));
  await page.keyboard.press('Escape');
  await click('[data-tab="phenomena"]');
  await clickWorld(pinAt[0], pinAt[1], 0);
  const pinSel = await ev(() => window.__ds.placementStore.getState().selected);
  await above(b.p[0], b.p[2], 60);
  await clickWorld(b.p[0], b.p[2], 4);
  const n0 = (await insts()).length;
  const pinSel2 = await ev(() => window.__ds.placementStore.getState().selected);
  check('input-10 selecting an object drops the pin selection (Delete can no longer hit the disaster)', pinSel === pin.id && pinSel2 === null && (await insts()).length === n0, { pinSel, pinSel2 });
  await shot('g1-input');
}

const pass = results.filter((r) => r.ok).length;
const gl = await glInfo();
console.log(`${pass}/${results.length} passed; ${errors.length} page errors; geometries ${gl.geometries}; textures ${gl.textures}`);
for (const e of errors.slice(0, 20)) console.log('  ' + e);
fs.writeFileSync(path.join(out, `results-${lang}.json`), JSON.stringify({ lang, results, errors, gl }, null, 1));
await browser.close();
process.exit(pass === results.length && errors.length === 0 ? 0 : 1);
