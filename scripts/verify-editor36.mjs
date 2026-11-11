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


const keyCombo = async (mods, code) => { for (const m of mods) await page.keyboard.down(m); await page.keyboard.press(code); for (const m of [...mods].reverse()) await page.keyboard.up(m); await wait(250); };
const objCount = () => ev(() => Object.keys(window.__ds.world.getState().doc.objects).length);
/** Arm a palette item by clicking its card in the Objects tab. */
async function armItem(id) {
  await click('[data-testid="tab-objects"]');
  await page.waitForSelector(`[data-item="${id}"]`, { timeout: 15000 });
  await click(`[data-item="${id}"]`);
}
/** Set a numeric field by its accessible label (Vec3 axis inputs are found by order inside the field row). */
async function typeInto(handle, value) {
  await handle.click({ clickCount: 3 });
  await page.keyboard.type(String(value));
  await page.keyboard.press('Enter');
  await wait(250);
}

// ── G2 (S1, S2, S3, S4, S5, S15, S16, S17): build a small world from an empty one ─────────────────────────────────────────
if (want('build')) {
  await fresh();
  // S1: an empty world (⋯ → New), a road drawn with the road tool, buildings placed from the palette.
  await click('[aria-haspopup="menu"]');
  await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')][0].click());
  await wait(800);
  check('S1-1 new empty world', (await objCount()) === 0 && (await ev(() => Object.keys(window.__ds.world.getState().doc.roads.segments).length)) === 0);
  await above(0, 0, 150);
  await click('[data-testid="tab-roads"]');
  await click('[data-road-mode="draw"]');
  await wait(600); // the road tool mounts on the next render
  // (The viewport tool strip covers the canvas's left edge — the road starts inside the free area.)
  await clickWorld(-55, 0); await clickWorld(0, 0); await clickWorld(55, 0);
  await page.keyboard.press('Enter');
  await wait(600);
  const r1 = await ev(() => { const n = window.__ds.world.getState().doc.roads; return { segs: Object.keys(n.segments).length, xs: Object.values(n.nodes).map((v) => Math.round(v.x)).sort((a, b) => a - b) }; });
  check('S1-2 road drawn by clicks + Enter (from −55 to 55)', r1.segs >= 1 && r1.xs[0] <= -54 && r1.xs[r1.xs.length - 1] >= 54, r1);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await wait(300);
  await above(-30, -20, 90);
  await armItem('building.m.house');
  // S3 (road): clicked about 1 m off the frontage line, the house snaps to it (facing the road, 1 m behind the sidewalk);
  // the second, clicked 0.5 m from touching the first, snaps flush against it (neighbour edge).
  const hDepth = await ev(() => window.__ds.buildingLib.presetSpec('house').depth);
  const width = await ev(() => window.__ds.buildingLib.presetSpec('house').width);
  // The frontage line from the drawn road's own section: carriageway half width + sidewalk + 1 m setback + half depth.
  const outer = await ev(() => { const s = Object.values(window.__ds.world.getState().doc.roads.segments)[0]; const p = s.profile; return p.width / 2 + (p.sidewalk === 'both' || p.sidewalk === 'left' ? p.sidewalkWidth : 0); });
  const frontZ = -(outer + 1 + hDepth / 2);
  const engine = await ev((z) => {
    const ds = window.__ds; const d = ds.world.getState().doc;
    const params = ds.buildingLib.deriveFields(ds.buildingLib.createDesign(ds.buildingLib.presetSpec('house'), 'house'), 1).params;
    return { t: ds.snapLib.snapPoint({ x: -30, z, yaw: 0, half: ds.snapLib.footprintHalves('building', params), type: 'building' }, { objects: Object.values(d.objects), roads: d.roads, grid: 1 }),
      nodes: Object.values(d.roads.nodes).map((n) => [n.x, n.z]), tool: ds.editor.getState().tool, item: ds.editor.getState().placeItemId, snap: ds.editor.getState().snap };
  }, frontZ - 1);
  await clickWorld(-30, frontZ - 1);
  const hint = await ev(() => document.querySelector('[data-testid="snap-hint"]')?.dataset.kind ?? null);
  await clickWorld(-30 + width + 0.5, frontZ - 0.3);
  await page.keyboard.press('Escape');
  await wait(300);
  let objs = await objects();
  const houses = objs.filter((o) => o.type === 'building').sort((a, b) => a.p[0] - b.p[0]);
  check('S1-3 two buildings placed with the mouse', houses.length === 2, { n: houses.length });
  // The real footprint (member extents) — not the nominal plan size — is what snaps.
  const realHalf = await ev(() => { const ds = window.__ds; return ds.snapLib.footprintHalves('building', ds.buildingLib.deriveFields(ds.buildingLib.createDesign(ds.buildingLib.presetSpec('house'), 'house'), 1).params); });
  const roadZ = await ev(() => Object.values(window.__ds.world.getState().doc.roads.nodes)[0].z); // the drawn centreline (click precision)
  const realFront = roadZ - (outer + 1 + realHalf[1]);
  check('S3-1 the house snapped to the road frontage (1 m behind the sidewalk), facing the road', houses[0] && Math.abs(houses[0].p[2] - realFront) < 1e-6 && hint === 'roadFront' && Math.abs(houses[0].r[1]) < 1e-9, { z: houses[0]?.p[2], realFront, hint, yaw: houses[0]?.r });
  check('S3-2 the second house snapped flush against the first along the street (no gap, no overlap)', houses[1] && Math.abs(houses[1].p[0] - houses[0].p[0] - 2 * realHalf[0]) < 1e-6 && Math.abs(houses[1].p[2] - realFront) < 1e-6, { x0: houses[0]?.p[0], x1: houses[1]?.p[0], w: 2 * realHalf[0] });

  // S2: exact position / heading typed in the inspector.
  await above(houses[0].p[0], houses[0].p[2], 60);
  await clickWorld(houses[0].p[0], houses[0].p[2], 3);
  await click('[data-tab="selection"]');
  const axisInputs = await page.$$('[data-testid="right-panel"] input[aria-label]');
  void axisInputs;
  const posInputs = await page.$$eval('[data-testid="right-panel"] input', (els) => els.map((e, i) => ({ i, label: e.getAttribute('aria-label') ?? '', v: e.value })));
  const posLabel = await ev(() => window.__ds.tr('ed36.pos'));
  const xi = posInputs.findIndex((x) => x.label === `${posLabel} X`);
  const inputs = await page.$$('[data-testid="right-panel"] input');
  if (xi >= 0) await typeInto(inputs[xi], -45.5);
  const after2 = (await objects()).find((o) => o.id === houses[0].id);
  check('S2-1 X typed in the inspector moves the building exactly', xi >= 0 && Math.abs(after2.p[0] + 45.5) < 1e-6, { xi, p: after2?.p, labels: posInputs.slice(0, 8).map((x) => x.label) });

  // S4: multi-select (Shift+click) and move together with the gizmo.
  await above(-35, -15, 90);
  objs = await objects();
  const [h1, h2] = objs.filter((o) => o.type === 'building');
  await clickWorld(h1.p[0], h1.p[2], 3);
  await clickWorld(h2.p[0], h2.p[2], 3, ['Shift']);
  const s4 = await sel();
  check('S4-1 Shift+click adds to the selection', s4.length === 2, { s4 });
  const piv = [(h1.p[0] + h2.p[0]) / 2, (h1.p[2] + h2.p[2]) / 2];
  await dragScreen(await screen(piv[0], piv[1], 0), 0, 50);
  const m1 = (await objects()).find((o) => o.id === h1.id), m2 = (await objects()).find((o) => o.id === h2.id);
  const d1 = [m1.p[0] - h1.p[0], m1.p[2] - h1.p[2]], d2 = [m2.p[0] - h2.p[0], m2.p[2] - h2.p[2]];
  check('S4-2 the group drag moves both by the same delta (one undo step)', Math.hypot(...d1) > 0.5 && near(d1, d2, 1e-6), { d1, d2 });

  // S5: group, rename in the outliner, duplicate the group.
  await keyCombo(['Control'], 'KeyG');
  const g = await ev(() => Object.values(window.__ds.world.getState().doc.objects).filter((o) => o.group).map((o) => o.group));
  check('S5-1 Ctrl+G groups the two buildings', g.length === 2 && g[0] === g[1], { g });
  await click('[data-testid="tab-scene"]');
  await click('[data-testid="outliner-rename-group"]');
  await page.keyboard.type('Block A');
  await page.keyboard.press('Enter');
  await wait(300);
  const gname = await ev(() => Object.values(window.__ds.world.getState().doc.groups ?? {}).map((x) => x.name));
  check('S5-2 group renamed in the outliner', gname.includes('Block A'), { gname });
  const n5 = await objCount();
  await keyCombo(['Control'], 'KeyD');
  const groups5 = await ev(() => new Set(Object.values(window.__ds.world.getState().doc.objects).map((o) => o.group).filter(Boolean)).size);
  check('S5-3 Ctrl+D duplicates the group as a new group', (await objCount()) === n5 + 2 && groups5 === 2, { n: await objCount(), groups5 });

  // S15: several undo / redo steps.
  const depth = await undoDepth();
  const snap0 = JSON.stringify(await objects());
  await keyCombo(['Control'], 'KeyZ'); await keyCombo(['Control'], 'KeyZ'); await keyCombo(['Control'], 'KeyZ');
  const back = await undoDepth();
  await keyCombo(['Control', 'Shift'], 'KeyZ'); await keyCombo(['Control', 'Shift'], 'KeyZ'); await keyCombo(['Control', 'Shift'], 'KeyZ');
  check('S15-1 three undos and three redos return to the same world', back === depth - 3 && JSON.stringify(await objects()) === snap0, { depth, back });

  // S16: the world survives a reload (autosave) — objects, roads and the group name.
  await wait(1200);
  const before16 = { n: await objCount(), names: await ev(() => window.__ds.world.getState().doc.groups) };
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__ds && window.__r3f);
  await wait(1200);
  const after16 = { n: await objCount(), names: await ev(() => window.__ds.world.getState().doc.groups) };
  check('S16-1 reload restores the world (autosave), group names included', after16.n === before16.n && JSON.stringify(after16.names) === JSON.stringify(before16.names), { before16, after16 });

  // S17: run a blast next to the block, then back to the editor: the original world (transforms identical).
  const doc0 = JSON.stringify(await objects());
  await click('[data-tab="phenomena"]');
  await click('[data-testid="lib-blast"]');
  await above(-20, -40, 80);
  await clickWorld(-20, -40);
  await page.keyboard.press('Escape');
  await ev(() => window.__ds.actions.runSimulation ? null : null);
  await ev(async () => { await window.__ds.actions.enterSimulation(); window.__ds.sim.advance?.(2); });
  await wait(1500);
  const inSim = await ev(() => window.__ds.editor.getState().mode);
  await ev(() => window.__ds.actions.exitSimulation());
  await wait(800);
  check('S17-1 after a simulation the editor world is the original one', inSim === 'simulation' && JSON.stringify(await objects()) === doc0, { inSim });
  await shot('g2-build');
}

// ── G3 (S6, S7, S8): terrain under roads and buildings; two road widths; T and cross junctions ────────────────────────────
if (want('terrain')) {
  await fresh();
  const roads = await ev(() => window.__ds.world.getState().doc.roads);
  // S7: a palette 2-lane road at the end of the default world's 10 m main street → a taper, no stair in the ground.
  await above(66, 0, 80);
  await armItem('env.road');
  await clickWorld(66, 0);
  await page.keyboard.press('Escape');
  await wait(500);
  const step = await ev(() => {
    const s = window.__ds.buildLib.samplerFor(window.__ds.world.getState().doc.terrain);
    let worst = 0;
    for (const z of [3.6, 4, 4.5, 5]) worst = Math.max(worst, Math.abs(s.sampleHeight(55.5, z) - s.sampleHeight(56.5, z)), Math.abs(s.sampleHeight(56.5, -z) - s.sampleHeight(55.5, -z)));
    const net = window.__ds.world.getState().doc.roads;
    return { worst, segs: Object.keys(net.segments).length };
  });
  check('S7-1 a 7 m road joined to the 10 m street: no height step across the joint (≤ 3 cm per metre)', step.segs > Object.keys(roads.segments).length && step.worst < 0.03, step);
  // S8: T and cross junctions with the road tool.
  await above(10, 0, 150);
  await click('[data-testid="tab-roads"]');
  await click('[data-road-mode="draw"]');
  await wait(600);
  await clickWorld(10, 45); await clickWorld(10, -45);
  await page.keyboard.press('Enter');
  await wait(600);
  const ints = await ev(() => [...window.__ds.roadLib.intersectionsOf(window.__ds.world.getState().doc.roads).values()].filter((i) => i.junction).map((i) => i.roads.length).sort());
  check('S8-1 drawing across the main street makes a cross junction (and the T stays)', ints.includes(4) && ints.includes(3), { ints });
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  // S6: raise the ground under a building with the terrain brush (mouse drag): the building re-seats, the road re-bakes.
  const b = (await objects()).filter((o) => o.type === 'building').sort((a, c) => Math.abs(a.p[0] - 2) - Math.abs(c.p[0] - 2))[0];
  await above(b.p[0], b.p[2], 70);
  await click('[data-testid="tab-terrain"]');
  await page.evaluate(() => window.__ds.editor.getState().setTerrainTool('raise'));
  await wait(300);
  const preview = await ev(() => window.__ds.editor.getState().brushPreview ?? null);
  const [bx, by] = await screen(b.p[0] + 8, b.p[2] + 3);
  await page.mouse.move(bx, by); await wait(300);
  const preview2 = await ev(() => window.__ds.editor.getState().brushPreview ?? null);
  await page.mouse.down();
  await page.mouse.move(bx - 120, by, { steps: 30 });
  await wait(600);
  await page.mouse.up();
  await wait(800);
  const b2 = (await objects()).find((o) => o.id === b.id);
  const g2 = await ev(([x, z]) => window.__ds.buildLib.samplerFor(window.__ds.world.getState().doc.terrain).sampleHeight(x, z), [b.p[0], b.p[2]]);
  check('S6-1 brush preview shown before the stroke', !!preview2, { before: !!preview, after: !!preview2 });
  check('S6-2 a stroke under a building raises the ground and the building stays seated on it', b2.p[1] > b.p[1] + 0.3, { y0: b.p[1], y1: b2.p[1], ground: g2 });
  await page.keyboard.press('Escape');
  await shot('g3-terrain');
}

// ── G4 (S9, S10, S11): structural type, member edits, partial collapse colliders, per-storey drift ─────────────────────────
if (want('structure')) {
  await fresh();
  // S9: the structure lab preset; the building panel's structural type picker shows the real types.
  await click('[aria-haspopup="menu"]');
  await click('[data-testid="preset-structureLab"]');
  await wait(1500);
  const lab = await ev(() => Object.values(window.__ds.world.getState().doc.objects).filter((o) => o.type === 'building').map((o) => ({ id: o.id, mat: o.building.spec.structureMaterial, p: o.transform.position })));
  check('S9-1 structure lab: one building per structural type', new Set(lab.map((x) => x.mat)).size === 4, { lab: lab.map((x) => x.mat) });
  const steel = lab.find((x) => x.mat === 'structuralSteel');
  await above(steel.p[0], steel.p[2], 60);
  await clickWorld(steel.p[0], steel.p[2], 5);
  await click('[data-testid="tab-building"]');
  const typeOptions = await page.$$eval('[data-testid="building-panel"] select', (els) => els.map((e) => [...e.options].map((o) => o.value)).find((v) => v.includes('steel') && v.includes('rc')) ?? null);
  check('S9-2 structural type picker lists steel / rc / masonry / timber (no "light")', typeOptions && typeOptions.length === 4 && !typeOptions.includes('light'), { typeOptions });
  // Member edit: Building Edit Mode, a window becomes a door (validated, one undo step).
  await ev((id) => window.__ds.buildingActions.enterBuildingEdit(id), steel.id);
  await wait(500);
  const win = await ev((id) => window.__ds.world.getState().doc.objects[id].building.members.find((m) => m.type === 'window')?.id, steel.id);
  await ev((m) => window.__ds.members.getState().select([m]), win);
  await wait(300);
  await ev(() => window.__ds.buildingActions.setSelectedType('door'));
  const mt = await ev(([id, m]) => window.__ds.world.getState().doc.objects[id].building.members.find((x) => x.id === m)?.type, [steel.id, win]);
  check('S9-3 member type change window → door (validated)', mt === 'door', { mt });
  // S9-4: a brace drawn joint → joint with the mouse ("+ Brace", foot of one façade column, top of the next one).
  const joints = await ev((id) => {
    const o = window.__ds.world.getState().doc.objects[id]; const d = o.building;
    const cols = d.members.filter((m) => m.type === 'column' && m.level === 0);
    const zf = Math.max(...cols.map((m) => m.position[2]));
    const front = cols.filter((m) => Math.abs(m.position[2] - zf) < 0.01).sort((a, b) => a.position[0] - b.position[0]);
    const [c1, c2] = front;
    const p = o.transform.position;
    return { A: [p[0] + c1.position[0], p[1] + c1.position[1] - c1.size[1] / 2, p[2] + c1.position[2]], B: [p[0] + c2.position[0], p[1] + c2.position[1] + c2.size[1] / 2, p[2] + c2.position[2]] };
  }, steel.id);
  await view((joints.A[0] + joints.B[0]) / 2, joints.A[2] + 4, 9, 22);
  const braces0 = await ev((id) => window.__ds.world.getState().doc.objects[id].building.members.filter((m) => m.type === 'brace').length, steel.id);
  await click('[data-member="brace"]');
  await clickWorld(joints.A[0], joints.A[2], joints.A[1]);
  await clickWorld(joints.B[0], joints.B[2], joints.B[1]);
  const brace = await ev((id) => { const d = window.__ds.world.getState().doc.objects[id].building; return { n: d.members.filter((m) => m.type === 'brace').length, last: d.members.filter((m) => m.type === 'brace').pop() ?? null, warn: window.__ds.buildingLib.analyzeBuilding ? null : null }; }, steel.id);
  check('S9-4 a brace drawn joint → joint with two clicks (one undo step)', brace.n === braces0 + 1 && brace.last && brace.last.size[0] > 3, { braces0, n: brace.n, size: brace.last?.size });
  await shot('g4-brace');
  await click('[data-member="brace"]'); // leave the brace tool
  await ev(() => window.__ds.buildingActions.exitBuildingEdit());
  // S10: partial collapse. In Building Edit Mode the RC building's corner bay (members of its first bay in x and z, all
  // storeys) is set to 95 % initial damage (member inspector slider, here through the same action); a moderate quake then
  // brings that bay down while the rest stands → the collider is rebuilt from the cells that still stand (v2).
  const rc = lab.find((x) => x.mat === 'reinforcedConcrete');
  await ev((id) => window.__ds.buildingActions.enterBuildingEdit(id), rc.id);
  await wait(400);
  const bay = await ev((id) => {
    const d = window.__ds.world.getState().doc.objects[id].building; const s = d.spec;
    const nx = Math.round(s.width / s.bay), nz = Math.round(s.depth / s.bay), bx = s.width / nx, bz = s.depth / nz;
    const ids = d.members.filter((m) => m.level >= 0 && m.position[0] <= -s.width / 2 + bx + 0.01 && m.position[2] <= -s.depth / 2 + bz + 0.01).map((m) => m.id);
    window.__ds.members.getState().select(ids);
    return ids.length;
  }, rc.id);
  await ev(() => window.__ds.buildingActions.setSelectedInitialDamage(0.95));
  await ev(() => window.__ds.buildingActions.exitBuildingEdit());
  await wait(300);
  const E10 = Number(process.env.S10_E ?? 1.8e9);
  const rcObj = await ev((id) => window.__ds.world.getState().doc.objects[id], rc.id);
  const corner = [rc.p[0] - rcObj.building.spec.width / 2 + 1, rc.p[2] - rcObj.building.spec.depth / 2 + 1];
  await ev(async ([c, E]) => {
    const def = window.__ds.deformLib.phenomena.get('blast');
    await window.__ds.actions.runSimulation([{ ...def.defaults(), position: [c[0], c[1]], energy: E, startTime: 0 }]);
  }, [corner, E10]);
  for (let i = 0; i < 16; i++) await ev(() => window.__ds.sim.advance(1));
  const cells = await ev((id) => {
    const rt = window.__ds.sim.getRuntime(); const e = rt.entities.get(id); const S = rt.structures;
    const m = e?.modular?.structure?.model; const design = e?.modular?.design; const byType = {};
    if (m && design) design.members.forEach((mm, i) => { if (m.state[i] > 3) byType[mm.type] = (byType[mm.type] ?? 0) + 1; });
    const st = S?.all?.find?.((x) => x.e?.id === id) ?? null;
    return { rebuilds: S?.cellRebuilds ?? 0, boxes: S?.cellBoxes ?? 0, collapsed: !!e?.flags?.collapsed, failedByType: byType, t: window.__ds.sim.getTime(), bodyShapes: null, st: !!st };
  }, rc.id);
  // (A weaker blast — 1.2e9 J — leaves fallen members resting inside the corner cells: by the cell rule those cells stay
  // solid until the debris settles into a rubble pile with its own collider; documented in ADVANCED_WORLD_EDITOR.md.)
  check('S10-1 the corner gives way: the collider is rebuilt from the cells that still stand (v2) before the building goes', cells.rebuilds > 0 && cells.boxes > 1, { bay, ...cells });
  await shot('g4-collapse');
  await ev(() => window.__ds.actions.exitSimulation());
  await wait(600);
  // S11: an earthquake — the drawn sway differs per storey (render-only, from the storey model).
  await ev(async () => {
    const def = window.__ds.deformLib.phenomena.get('earthquake');
    await window.__ds.actions.runSimulation([{ ...def.defaults(), pga: 0.6, startTime: 0 }]);
  });
  for (let i = 0; i < 8; i++) await ev(() => window.__ds.sim.advance(1));
  // Sample the drawn storey tops over 3 s; a uniform shear would keep every storey's displacement ∝ its height.
  let best = null;
  for (let i = 0; i < 12; i++) {
    await ev(() => window.__ds.sim.advance(0.25));
    const tops = await ev((id) => window.__ds.structureLib.storeyTops(id), steel.id);
    if (!tops || tops.length < 2) continue;
    const mag = tops.map(([x, z]) => Math.hypot(x, z));
    const ratio = mag[0] > 1e-6 ? mag[mag.length - 1] / mag[0] : 0;
    if (!best || mag[mag.length - 1] > best.top) best = { top: mag[mag.length - 1], mag, ratio };
  }
  // Uniform shear: top / first = n (storey count) exactly; the storey model gives its own profile.
  check('S11-1 the drawn sway comes per storey from the storey model (not one uniform shear)', best && best.top > 1e-4 && Math.abs(best.ratio - best.mag.length) > 0.05, best);
  await ev(() => window.__ds.actions.exitSimulation());
}

// ── G5 (S12, S13, S14): blueprint of a building group placed elsewhere; three blasts; quake + blast + fire together ─────────
if (want('disaster')) {
  await fresh();
  // S12: capture two buildings (the current selection) as a blueprint, save it to the library, place it elsewhere with
  // the mouse (click pins the ghost, Enter confirms — one undo step).
  const bs = (await objects()).filter((o) => o.type === 'building').slice(0, 2);
  await ev((ids) => window.__ds.editor.getState().setSelection(ids), bs.map((o) => o.id));
  const n0 = await objCount();
  const entry = await ev(async () => {
    const bp = window.__ds.blueprintActions;
    bp.startCapture('selection');
    bp.recomputeCapture(0);
    await new Promise((r) => setTimeout(r, 400));
    const e = await bp.saveCapture();
    if (!e) return null;
    await bp.startPlacement(e.id);
    return e.id;
  });
  const target = [40, 55];
  await above(target[0], target[1], 90);
  await wait(400);
  await clickWorld(target[0], target[1]);
  await page.keyboard.press('Enter');
  await wait(800);
  const added = (await objects()).filter((o) => !bs.some((b) => b.id === o.id) && o.type === 'building' && Math.hypot(o.p[0] - target[0], o.p[2] - target[1]) < 30);
  check('S12-1 a captured block (blueprint) placed at another spot with the mouse', !!entry && (await objCount()) === n0 + 2 && added.length === 2, { entry: !!entry, n0, n: await objCount(), near: added.length });
  await ev(() => window.__ds.blueprintActions.backToLibrary());
  // S13: three blasts at three places with the library and the mouse.
  await above(0, 40, 140);
  await click('[data-tab="phenomena"]');
  await click('[data-testid="lib-blast"]');
  for (const [x, z] of [[-50, 40], [0, 50], [50, 40]]) await clickWorld(x, z);
  await page.keyboard.press('Escape');
  const ii = await insts();
  check('S13-1 three blasts placed by clicking (three independent instances)', ii.filter((i) => i.type === 'blast').length === 3, { n: ii.length });
  // S14: add a quake and a fire, run all together: every instance becomes active.
  await click('[data-testid="lib-earthquake"]').catch(() => null);
  await clickWorld(0, 0).catch(() => null);
  await page.keyboard.press('Escape');
  await click('[data-testid="lib-fire"]').catch(() => null);
  await clickWorld(-20, 20).catch(() => null);
  await page.keyboard.press('Escape');
  const all = await insts();
  await ev(async () => window.__ds.actions.runExperiment?.());
  for (let i = 0; i < 5; i++) await ev(() => window.__ds.sim.isLoaded() && window.__ds.sim.advance(1));
  const st14 = await ev(() => window.__ds.sim.isLoaded() ? window.__ds.sim.instances().map((i) => i.status) : []);
  check('S14-1 quake + blasts + fire run together', all.length >= 5 && st14.length >= 5 && st14.every((s) => s !== 'pending'), { types: all.map((i) => i.type), st14 });
  await shot('g5-disasters');
  await ev(() => window.__ds.actions.exitSimulation());
}

// ── G6 (S19, layout): small screens — panels, viewport share, clipped labels ────────────────────────────────────────────────
if (want('layout')) {
  for (const [w, h] of [[1920, 1080], [1440, 900], [1366, 768], [1280, 720]]) {
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await fresh();
    await wait(600);
    const lay = await ev(() => {
      const r = (el) => el?.getBoundingClientRect();
      const canvas = r(window.__r3f.get().gl.domElement);
      const right = r(document.querySelector('[data-testid="right-panel"]'));
      const overlap = right && canvas ? Math.max(0, canvas.right - right.left) * Math.max(0, Math.min(canvas.bottom, right.bottom) - Math.max(canvas.top, right.top)) : 0;
      const clipped = [...document.querySelectorAll('button, [role="tab"]')].filter((b) => b.offsetParent && b.scrollWidth > b.clientWidth + 2 && getComputedStyle(b).overflow !== 'visible').map((b) => b.textContent.trim().slice(0, 30)).slice(0, 8);
      return { share: (canvas.width * canvas.height) / (innerWidth * innerHeight), overlap, clipped, hscroll: document.documentElement.scrollWidth > innerWidth };
    });
    check(`S19-${w}x${h} viewport ≥ 35 % of the window, no panel over it, no horizontal scroll`, lay.share >= 0.35 && lay.overlap < 1 && !lay.hscroll, lay);
    await click('[data-testid="tab-scene"]');
    await shot(`layout-${w}x${h}`);
  }
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
}

const pass = results.filter((r) => r.ok).length;
const gl = await glInfo();
console.log(`${pass}/${results.length} passed; ${errors.length} page errors; geometries ${gl.geometries}; textures ${gl.textures}`);
for (const e of errors.slice(0, 20)) console.log('  ' + e);
fs.writeFileSync(path.join(out, `results-${lang}.json`), JSON.stringify({ lang, results, errors, gl }, null, 1));
await browser.close();
process.exit(pass === results.length && errors.length === 0 ? 0 : 1);
