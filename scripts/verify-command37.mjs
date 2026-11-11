// Browser verification of Phase 37 (command / natural-language editing) in real Chrome, Korean / English, with the real
// keyboard and mouse. State is READ through window.__ds; a line marked "setup" prepares a scene through the API (the
// thing under test is always typed into the command bar). Scenario groups run in order; ONLY=<comma list> runs a subset:
//   bar (S1 S2) · build (S3–S6) · select (S7 S8) · terrain (S9 S10) · disaster (S11 S12) · query (S13–S15) ·
//   script (S16 S22) · menu (S17) · left (S18 S19) · layout (S20) · life (S21)
//
//   npx vite build && npx vite preview --port 4196 --strictPort &
//   LANG_UI=ko node scripts/verify-command37.mjs http://localhost:4196/ ./docs/verify/command37
//
// The sentences are the specification's own examples (they are also corpus cases): each check that types a sentence
// first compares what the bar says it understood with the canonical command expected here, then checks what happened.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:4196/', out = './docs/verify/command37'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const lang = process.env.LANG_UI ?? 'ko';
const KO = lang === 'ko';
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
const cdp = await page.createCDPSession();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const shot = (n) => page.screenshot({ path: path.join(out, `${n}-${lang}.png`) });
const t0 = Date.now();
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${typeof detail === 'string' ? detail : JSON.stringify(detail)} [${((Date.now() - t0) / 1000).toFixed(0)} s]`);
};
const want = (g) => !ONLY || ONLY.has(g);
const near = (a, b, tol = 0.05) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);

// ── page helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────
async function fresh(query = '') {
  await page.goto(url + '?devtools' + query, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__ds && window.__r3f);
  await ev(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__ds && window.__r3f);
  await ev((l) => window.__ds.locale.getState().setLocale(l), lang);
  await wait(1200);
}
/** setup: an empty flat world (no roads, no objects), history cleared. */
async function emptyWorld() {
  await ev(() => { const w = window.__ds.world; w.getState().replaceDocument(window.__ds.buildLib.createEmptyDocument('')); w.setState({ past: [], future: [] }); window.__ds.editor.getState().select(null); });
  await wait(500);
}
async function view(x = 0, z = 0, h = 120, back = 60) {
  await ev(([x, z, h, back]) => { const st = window.__r3f.get(); st.camera.position.set(x, h, z + back); st.controls.target.set(x, 0, z); st.controls.update(); }, [x, z, h, back]);
  await wait(400);
}
const above = (x, z, h = 60) => view(x, z, h, 0.5);
const screen = (x, z, dy = 0) => ev(([x, z, dy]) => {
  const st = window.__r3f.get(); const r = st.gl.domElement.getBoundingClientRect();
  const s = window.__ds.buildLib.samplerFor(window.__ds.world.getState().doc.terrain);
  const v = st.camera.position.clone().set(x, s.sampleHeight(x, z) + dy, z).project(st.camera);
  return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
}, [x, z, dy]);
/** Move the real pointer over a world point (the cursor tracker follows it: "here"). */
async function pointAt(x, z) {
  const [sx, sy] = await screen(x, z);
  await page.mouse.move(sx - 9, sy - 6);
  await page.mouse.move(sx, sy, { steps: 4 });
  await wait(250);
}
const click = async (sel) => { await page.click(sel); await wait(180); };
const has = (sel) => ev((s) => !!document.querySelector(s), sel);
const textOf = (sel) => ev((s) => document.querySelector(s)?.textContent ?? null, sel);
const objects = () => ev(() => Object.values(window.__ds.world.getState().doc.objects).map((o) => ({ id: o.id, type: o.type, name: o.name, p: o.transform.position, r: o.transform.rotation, s: o.transform.scale, group: o.group ?? null, hidden: !!o.hidden, locked: !!o.locked, preset: o.building?.preset ?? null, seed: o.seed })));
const ofType = async (t) => (await objects()).filter((o) => o.type === t);
const sel = () => ev(() => window.__ds.editor.getState().selectedIds);
const undoDepth = () => ev(() => window.__ds.world.getState().past.length);
const insts = () => ev(() => window.__ds.world.getState().doc.scenario.experiment?.instances ?? []);
const hashes = () => ev(() => ({ raw: window.__ds.hash.raw(), canonical: window.__ds.hash.canonical(), terrain: window.__ds.hash.terrain() }));
const sameBits = (a, b) => a.raw === b.raw && a.terrain === b.terrain;
const tr = (key, params) => ev(([k, p]) => window.__ds.tr(k, p), [key, params ?? null]);
const glInfo = () => ev(() => { const g = window.__r3f.get().gl.info; return { geometries: g.memory.geometries, textures: g.memory.textures }; });
const drawn = () => ev(() => window.__ds.command.preview());
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
async function chord(key, ...mods) {
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.press(key);
  for (const m of mods.reverse()) await page.keyboard.up(m);
  await wait(300);
}
/** Ctrl+Z / Ctrl+Shift+Z with the focus in the viewport (in the bar they would edit its text). */
async function undoKey() { await leaveBar(); await chord('KeyZ', 'Control'); }
async function redoKey() { await leaveBar(); await chord('KeyZ', 'Control', 'Shift'); }

// ── the command bar ──────────────────────────────────────────────────────────────────────────────────────────────────
const INPUT = '[data-testid="command-input"]';
const barFocused = () => ev((s) => document.activeElement === document.querySelector(s), INPUT);
/** What the bar's session says (read only). */
const bar = () => ev(() => {
  const s = window.__ds.command.session.getState();
  const p = s.plan;
  const q = (id) => document.querySelector(`[data-testid="${id}"]`);
  const lines = p && p.preview.result.ok ? p.preview.result.lines.map((l) => l.plan) : [];
  const fb = s.feedback;
  return {
    text: s.text, understood: s.understood, history: s.history.length, results: s.results.length,
    fb: fb.k, fbKeys: fb.k === 'error' ? [fb.error.key, ...fb.notes.map((n) => n.key)] : fb.k === 'unknown' ? [fb.reason.key] : fb.k === 'ask' || fb.k === 'clarify' ? [fb.question.key] : [],
    options: fb.k === 'clarify' ? fb.options.map((o) => o.canonical) : [], suggestions: fb.k === 'unknown' ? fb.suggestions : [],
    done: fb.k === 'done' ? fb.lines.map((l) => ({ canonical: l.plan.canonical, table: l.plan.table ? { rows: l.plan.table.rows.length, title: l.plan.table.title, ids: l.plan.table.ids.length } : null, notes: l.plan.notes.map((n) => n.key), added: l.added.length })) : [],
    plan: p ? {
      armed: p.armed, canonical: p.canonical, confirm: !!p.confirm, confirmed: p.confirmed, notice: p.notice?.key ?? null,
      counts: lines.reduce((a, l) => ({ create: a.create + l.counts.create, change: a.change + l.counts.change, remove: a.remove + l.counts.remove }), { create: 0, change: 0, remove: 0 }),
      items: lines.flatMap((l) => l.items.map((i) => ({ status: i.status, snap: i.snap ?? null, reasons: (i.reasons ?? []).map((r) => (typeof r === 'string' ? r : r.key)) }))),
      notes: lines.flatMap((l) => l.notes.map((n) => n.key)), warnings: lines.flatMap((l) => l.warnings.map((n) => n.key)),
      diff: p.preview.diff ? { added: p.preview.diff.added.length, removed: p.preview.diff.removed.length, moved: p.preview.diff.moved.length, changed: p.preview.diff.changed.length, terrain: p.preview.diff.terrain ? { up: p.preview.diff.terrain.up, down: p.preview.diff.terrain.down, area: p.preview.diff.terrain.area } : null, roads: p.preview.diff.roads ? p.preview.diff.roads.added.length : 0, instances: p.preview.diff.instances.added.length } : null,
    } : null,
    dom: { state: q('command-state')?.textContent ?? null, summary: q('command-summary')?.textContent ?? null, understood: q('command-understood')?.textContent ?? null, results: !!q('command-results') && q('command-results').getBoundingClientRect().height > 4, value: q('command-input')?.value ?? null },
  };
});
/** Focus the bar with its key from the viewport. */
async function openBar() {
  if (!(await barFocused())) {
    await page.keyboard.press('Slash');
    await wait(200);
  }
  if (!(await barFocused())) { await page.focus(INPUT); await wait(100); }
}
/** Leave the bar: Esc until nothing is open and the input has lost the focus. */
async function leaveBar() {
  for (let k = 0; k < 4 && (await barFocused()); k++) { await page.keyboard.press('Escape'); await wait(150); }
  if (await barFocused()) { await ev(() => document.activeElement?.blur()); await wait(100); }
}
/** Replace the bar's text by typing (non-ASCII goes through Input.insertText, as an IME's committed text does). */
async function typeBar(text) {
  await openBar();
  await chord('KeyA', mod);
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text, { delay: 4 });
  await wait(450); // the debounced draft
}
const enter = async (ms = 500) => { await page.keyboard.press('Enter'); await wait(ms); };
/** Type a line and press Enter once: an edit opens its plan, a query / selection / run control is applied. */
async function say(text) { await typeBar(text); await enter(); return bar(); }
/** Type a line and confirm it: Enter (plan), Enter (confirm) — and once more for a large edit. */
async function run(text) {
  let b = await say(text);
  for (let k = 0; k < 2 && b.plan?.armed; k++) { await enter(700); b = await bar(); }
  return b;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** The canonical commands the bar understood a sentence as — from the open plan, the result, or the draft. */
const understoodOf = (b) => b.plan?.canonical ?? (b.done.length ? b.done.map((d) => d.canonical) : b.understood);

// ── sentences (the specification's examples; both are corpus cases with these canonical forms) ────────────────────────
const T = KO ? {
  road: ['(-60, 0)에서 (60, 0)까지 도로 그려', ['road -60,0 -> 60,0']],
  houses: ['도로 북쪽에 주택 세 채 간격 2 m', ['place building:house count=3 along=road:any side=north gap=2']],
  group: ['방금 만든 것 묶어서 "북쪽 블록"이라고 해', ['group last name="북쪽 블록"'], '북쪽 블록'],
  allTrees: ['모든 나무 선택해', ['select type:tree']],
  nearN4: ['n4에서 30 m 이내 건물들 선택해', ['select type:building where near node:n4 r=30']],
  steep: ['경사 20도 넘는 곳의 나무 다 선택', ['select type:tree where slope>20']],
  setX: ['선택한 것 x를 10으로', ['set selection x=10']],
  flatten: ['여기 반경 10 m 평평하게', ['terrain flatten circle cursor r=10']],
  forest: ['(30, 30) 반경 25 m에 숲, 밀도 0.4, 시드 7', ['forest circle 30,30 r=25 density=0.4 seed=7']],
  blast: ['교차로에 폭발 1.8×10⁹ J, 5초 뒤', ['disaster blast at=junction energy=1.8e9 start=5']],
  quake: ['여기에 규모 7 지진', ['disaster earthquake at=cursor magnitude=7']],
  fireAt: (id) => [`#${id}에 화재, 12초 뒤에`, [`disaster fire at=#${id} start=12`]],
  runSim: ['실행', ['run']], pauseSim: ['일시정지', ['pause']], resetSim: ['리셋', ['reset']],
  stopRain: ['비 멈춰', ['disaster rain stop']], pauseBlast: ['폭발 일시정지', ['disaster blast pause']],
  howMany: ['건물 몇 채야?', ['count type:building']],
  tallest: ['가장 높은 건물 보여 줘', ['focus type:building tallest']],
  nonsense: '하늘을 보라색으로 칠해',
} : {
  road: ['draw a road from (-60, 0) to (60, 0)', ['road -60,0 -> 60,0']],
  houses: ['three houses north of the road, 2 m apart', ['place building:house count=3 along=road:any side=north gap=2']],
  group: ['group the ones I just made, named "North block"', ['group last name="North block"'], 'North block'],
  allTrees: ['select all trees', ['select type:tree']],
  nearN4: ['select buildings within 30 m of n4', ['select type:building where near node:n4 r=30']],
  steep: ['select every tree on slopes over 20°', ['select type:tree where slope>20']],
  setX: ['set x to 10 for the selection', ['set selection x=10']],
  flatten: ['flatten a 10 m circle here', ['terrain flatten circle cursor r=10']],
  forest: ['a forest within 25 m of (30, 30), density 0.4, seed 7', ['forest circle 30,30 r=25 density=0.4 seed=7']],
  blast: ['a 1.8e9 J explosion at the junction in 5 s', ['disaster blast at=junction energy=1.8e9 start=5']],
  quake: ['a magnitude 7 earthquake here', ['disaster earthquake at=cursor magnitude=7']],
  fireAt: (id) => [`a fire at #${id} after 12 seconds`, [`disaster fire at=#${id} start=12`]],
  runSim: ['run', ['run']], pauseSim: ['pause', ['pause']], resetSim: ['reset', ['reset']],
  stopRain: ['stop the rain', ['disaster rain stop']], pauseBlast: ['pause the explosion', ['disaster blast pause']],
  howMany: ['how many buildings?', ['count type:building']],
  tallest: ['show me the tallest building', ['focus type:building tallest']],
  nonsense: 'paint the sky purple',
};

// ── G1 (S1, S2): the bar's keys, the Esc order, Enter during a Korean composition ─────────────────────────────────────
if (want('bar')) {
  await fresh();
  await view(0, 0, 120, 60);
  await ev(() => window.__r3f.get().gl.domElement.focus?.());
  const before = await ev(() => ({ tool: window.__ds.editor.getState().tool, snap: window.__ds.editor.getState().snapEnabled ?? null, mode: window.__ds.editor.getState().transformMode ?? null }));
  await page.keyboard.press('Slash');
  await wait(250);
  check('S1-1 "/" from the viewport focuses the command input', await barFocused(), {});
  await page.keyboard.type('weg', { delay: 20 });
  await wait(300);
  const afterKeys = await ev(() => ({ tool: window.__ds.editor.getState().tool, snap: window.__ds.editor.getState().snapEnabled ?? null, mode: window.__ds.editor.getState().transformMode ?? null }));
  let b = await bar();
  check('S1-2 W / E / G typed in the bar are text — the editing shortcuts rest', b.dom.value === 'weg' && same(before, afterKeys), { value: b.dom.value, before, afterKeys });
  await page.keyboard.press('Escape');
  await wait(200);
  check('S1-3 Esc with nothing open leaves the input', !(await barFocused()), {});
  await chord('KeyK', 'Control');
  check('S1-4 Ctrl+K focuses it again', await barFocused(), {});
  const n0 = (await objects()).length;
  b = await say('place tree at=0,30');
  let d = await drawn();
  check('S1-5 Enter on an edit opens a plan with a ghost — the document is not changed', b.plan?.armed === true && b.dom.state === 'plan' && d.ghosts === 1 && (await objects()).length === n0, { state: b.dom.state, d });
  await page.keyboard.press('Escape');
  await wait(300);
  b = await bar();
  d = await drawn();
  check('S1-6 the first Esc cancels the plan (the input keeps the focus, no ghost is left)', b.plan === null && (await barFocused()) && d.sceneObjects === 0 && (await objects()).length === n0, { plan: b.plan, d });
  await page.keyboard.press('Escape');
  await wait(200);
  check('S1-7 the second Esc leaves the input', !(await barFocused()), {});
  // An open plan is cancelled by Esc from the VIEWPORT too (before the Esc of deselect).
  await say('place tree at=0,30');
  await ev(() => document.activeElement?.blur());
  await page.keyboard.press('Escape');
  await wait(300);
  b = await bar();
  check('S1-8 Esc in the viewport cancels an open plan first', b.plan === null && (await drawn()).sceneObjects === 0, { plan: b.plan });
  // The key works while a simulation runs (the simulation branch of the hotkeys returns early).
  await run(T.runSim[0]);
  await wait(1500);
  const st = await ev(() => window.__ds.simStore.getState().status);
  await leaveBar();
  await page.keyboard.press('Slash');
  await wait(250);
  check('S1-9 "/" focuses the bar while a simulation runs', (await barFocused()) && (st === 'running' || st === 'loading'), { st });
  await run(T.resetSim[0]);
  await wait(800);
  await shot('S1-bar');

  // S2 — Enter during a Korean composition must not submit. The composition is made with raw CDP IME calls: the
  // input has a real composition (compositionstart fired, isComposing on its key events).
  await leaveBar();
  await openBar();
  await chord('KeyA', mod);
  await page.keyboard.press('Backspace');
  await ev((s) => {
    const el = document.querySelector(s);
    window.__ime = { starts: 0, ends: 0, keys: [] };
    el.addEventListener('compositionstart', () => { window.__ime.starts++; });
    el.addEventListener('compositionend', () => { window.__ime.ends++; });
    el.addEventListener('keydown', (e) => { window.__ime.keys.push({ key: e.key, keyCode: e.keyCode, composing: e.isComposing }); }, true);
  }, INPUT);
  const b0 = await bar();
  const hist0 = b0.history;
  const sel0 = (await sel()).length;
  // "나무 선택" typed as an IME would: the last syllable is still being composed when Enter is pressed.
  await cdp.send('Input.insertText', { text: '나무 선' });
  await cdp.send('Input.imeSetComposition', { text: 'ㅌ', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.imeSetComposition', { text: '태', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.imeSetComposition', { text: '택', selectionStart: 1, selectionEnd: 1 });
  await wait(150);
  // The real keyboard's Enter while the composition is open: Chrome sends it with isComposing = true. (A key event the
  // IME consumes arrives as keyCode 229 / "Process" on a real Korean IME; sending one through CDP commits the composition
  // in headless Chrome, so that third sign is covered by the unit test barKeys.test.ts, not here.)
  await page.keyboard.press('Enter');
  await wait(400);
  const ime1 = await ev(() => window.__ime);
  b = await bar();
  check('S2-1 the composition is real: compositionstart fired, not ended, and the Enter key event carries isComposing',
    ime1.starts >= 1 && ime1.ends === 0 && ime1.keys.some((k) => k.key === 'Enter' && k.composing), ime1);
  check('S2-2 Enter during the composition does not submit (selection, history and feedback as before, no plan, the text is kept)',
    b.history === hist0 && (await sel()).length === sel0 && b.fb === b0.fb && same(b.done, b0.done) && b.plan?.armed !== true && b.dom.value.startsWith('나무 선'), { value: b.dom.value, fb: [b0.fb, b.fb], history: [hist0, b.history], sel: [sel0, (await sel()).length] });
  // Commit the syllable (compositionend), then a real Enter submits.
  await cdp.send('Input.insertText', { text: '택' });
  await wait(250);
  const ime2 = await ev(() => window.__ime);
  const value = (await bar()).dom.value;
  await enter(600);
  b = await bar();
  const trees = (await ofType('tree')).length;
  check('S2-3 after the composition ended Enter submits "나무 선택" (every tree selected)', ime2.ends >= 1 && value === '나무 선택' && (await sel()).length === trees && trees > 0 && b.history === hist0 + 1, { value, ends: ime2.ends, selected: (await sel()).length, trees });
  await leaveBar();
}

// ── G2 (S3–S6): a road, houses beside it, no room, group + name — each one undo step ─────────────────────────────────
if (want('build')) {
  await fresh();
  await emptyWorld();
  await view(0, 0, 150, 40);
  // S3
  let b = await say(T.road[0]);
  let d = await drawn();
  check('S3-1 the road sentence is understood as its canonical command and previewed (document unchanged)', same(understoodOf(b), T.road[1]) && b.plan?.armed && d.roads >= 1 && (await ev(() => Object.keys(window.__ds.world.getState().doc.roads.segments).length)) === 0, { understood: understoodOf(b), d });
  const u0 = await undoDepth();
  await enter(900);
  const net = await ev(() => { const r = window.__ds.world.getState().doc.roads; return { nodes: Object.values(r.nodes).map((n) => [n.id, n.x, n.z]), segs: Object.values(r.segments).map((s) => [s.id, s.a, s.b]) }; });
  check('S3-2 Enter draws it: n1 (−60, 0) → n2 (60, 0), one segment, one undo step', net.nodes.length === 2 && net.segs.length === 1 && near([net.nodes[0][1], net.nodes[0][2]], [-60, 0]) && near([net.nodes[1][1], net.nodes[1][2]], [60, 0]) && (await undoDepth()) === u0 + 1, net);

  // S4
  b = await say(T.houses[0]);
  d = await drawn();
  check('S4-1 "three houses north of the road, 2 m apart" → the canonical command, 3 ghosts, 3 frontage snaps, nothing placed yet',
    same(understoodOf(b), T.houses[1]) && d.ghosts === 3 && b.plan.items.length === 3 && b.plan.items.every((i) => i.status !== 'rejected' && i.snap === 'roadFront') && (await ofType('building')).length === 0, { understood: understoodOf(b), d, items: b.plan?.items });
  await shot('S4-preview');
  const u1 = await undoDepth();
  await enter(900);
  let houses = (await ofType('building')).sort((a, c) => a.p[0] - c.p[0]);
  const geo = await ev((ids) => {
    const doc = window.__ds.world.getState().doc;
    return ids.map((id) => {
      const o = doc.objects[id];
      const [hx, hz] = window.__ds.snapLib.footprintHalves(o.type, o.params, o.transform.scale);
      // The object's local +z (a building's front) in the world: Euler XYZ rotation applied to (0, 0, 1).
      const st = window.__r3f.get();
      const v = st.camera.position.clone().set(0, 0, 1).applyEuler(st.camera.rotation.clone().set(o.transform.rotation[0], o.transform.rotation[1], o.transform.rotation[2], 'XYZ'));
      return { x: o.transform.position[0], z: o.transform.position[2], hx, hz, front: [v.x, v.z] };
    });
  }, houses.map((h) => h.id));
  const gaps = geo.slice(1).map((g, k) => g.x - g.hx - (geo[k].x + geo[k].hx));
  // The mouse's own rule for the same spot: the snap engine's frontage point for the middle house, asked directly.
  const mouse = await ev((g) => {
    const doc = window.__ds.world.getState().doc;
    const o = Object.values(doc.objects).find((x) => x.type === 'building' && Math.abs(x.transform.position[0] - g.x) < 0.01);
    const half = window.__ds.snapLib.footprintHalves(o.type, o.params, o.transform.scale);
    // A point 0.5 m off the house's own spot (as a mouse would hover), the other houses excluded so they do not attract it.
    const r = window.__ds.snapLib.snapPoint({ x: o.transform.position[0], z: o.transform.position[2] - 0.5, yaw: 0, half, type: o.type, exclude: new Set(Object.keys(doc.objects)) }, { objects: [], roads: doc.roads, grid: 1 });
    return { x: r?.x ?? null, z: r?.z ?? null, kind: r?.kind ?? null };
  }, geo[1]).catch((e) => ({ error: String(e).slice(0, 120) }));
  check('S4-2b the middle house stands exactly where the mouse\'s snap engine puts a house at that spot (roadFront)', mouse.kind === 'roadFront' && Math.abs(mouse.z - geo[1].z) < 0.01, { mouse, z: geo[1].z });
  check('S4-2 Enter places 3 houses north of the road (−z), in one row, 2 m between footprints, fronts facing the road',
    houses.length === 3 && geo.every((g) => g.z < -3 && Math.abs(g.z - geo[0].z) < 0.01 && g.front[1] > 0.99) && gaps.every((g) => Math.abs(g - 2) < 0.05) && (await undoDepth()) === u1 + 1, { geo, gaps, mouse });
  // The frontage rule itself: the front edge is 1 m behind the outer edge of the sidewalk (road half width from the profile).
  const setback = await ev((g) => {
    const doc = window.__ds.world.getState().doc;
    const seg = Object.values(doc.roads.segments)[0];
    const p = seg.profile;
    // The curbs stand at ± width / 2; the sidewalk's outer edge is sidewalkWidth further out (roads/crossSection.ts).
    const half = p.width / 2 + (p.sidewalk === 'none' ? 0 : p.sidewalkWidth);
    return { half, frontEdge: -(g.z + g.hz), expected: half + 1 };
  }, geo[1]);
  check('S4-3 the front edge is 1 m behind the outer edge of the sidewalk (the snap engine\'s frontage setback)', Math.abs(setback.frontEdge - setback.expected) < 0.06, setback);
  await undoKey();
  check('S4-4 ONE undo removes all three', (await ofType('building')).length === 0 && (await undoDepth()) === u1, { left: (await ofType('building')).length });

  // S5 — no room: ten houses on a 20 m street
  await run('road -60,60 -> -40,60 preset=street');
  b = await say('place building:house count=10 along=road:nearest(-50,60) side=north gap=2');
  d = await drawn();
  const fit = d.ghosts;
  const roomWarn = await tr('cmd37.warn.room', { placed: fit, count: 10 });
  const resultsText = (await textOf('[data-testid="command-results"]')) ?? '';
  check('S5-1 ten houses on a 20 m street: the plan shows the ones that fit and says how many of ten', fit >= 1 && fit < 10 && b.plan.warnings.includes('cmd37.warn.room') && resultsText.includes(roomWarn), { fit, warnings: b.plan?.warnings, roomWarn, shown: resultsText.slice(0, 200) });
  await enter(900);
  check('S5-2 Enter places exactly those', (await ofType('building')).length === fit, { placed: (await ofType('building')).length, fit });
  await undoKey();
  await undoKey(); // and the short street: with two roads "the road" is a question (S14), S6 wants the single one
  check('S5-3 two undo steps: the houses, then the short street', (await ofType('building')).length === 0 && (await ev(() => Object.keys(window.__ds.world.getState().doc.roads.segments).length)) === 1, {});

  // S6 — group + name, one step
  await run(T.houses[0]);
  houses = await ofType('building');
  const u2 = await undoDepth();
  b = await run(T.group[0]);
  const grp = await ev(() => { const doc = window.__ds.world.getState().doc; const gs = [...new Set(Object.values(doc.objects).map((o) => o.group).filter(Boolean))]; return { groups: gs, names: gs.map((g) => doc.groups?.[g]?.name ?? null) }; });
  await click('[data-testid="tab-scene"]');
  const outliner = (await textOf('[data-testid="outliner-list"]')) ?? (await ev(() => document.body.innerText));
  check('S6-1 "group the ones I just made, named …": the three houses are one group with that name, shown in the outliner, ONE undo step',
    houses.length === 3 && grp.groups.length === 1 && grp.names[0] === T.group[2] && outliner.includes(T.group[2]) && (await undoDepth()) === u2 + 1, { houses: houses.length, grp, understood: understoodOf(b), fb: b.fb });
  await undoKey();
  const after = await ev(() => { const doc = window.__ds.world.getState().doc; return { grouped: Object.values(doc.objects).filter((o) => o.group).length, names: Object.keys(doc.groups ?? {}).length, buildings: Object.values(doc.objects).filter((o) => o.type === 'building').length }; });
  check('S6-2 one undo: the group and its name are gone, the houses stay', after.grouped === 0 && after.names === 0 && after.buildings === 3, after);
  await shot('S6-group');
}

// ── G3 (S7, S8): selection queries, hidden / locked rules, the common field = the multi-selection inspector ───────────
if (want('select')) {
  await fresh();
  await view(0, 0, 150, 40);
  let b = await say(T.allTrees[0]);
  const trees = await ofType('tree');
  check('S7-1 "select all trees" selects every tree at once (no plan, no undo step)', same(understoodOf(b), T.allTrees[1]) && (await sel()).length === trees.length && trees.length > 0 && b.plan === null, { selected: (await sel()).length, trees: trees.length });
  b = await say(T.nearN4[0]);
  const expectNear = await ev(() => { const doc = window.__ds.world.getState().doc; const n = doc.roads.nodes.n4; return Object.values(doc.objects).filter((o) => o.type === 'building' && Math.hypot(o.transform.position[0] - n.x, o.transform.position[2] - n.z) <= 30).map((o) => o.id).sort(); });
  check('S7-2 "buildings within 30 m of n4": exactly the buildings whose centre is within 30 m of that node', same(understoodOf(b), T.nearN4[1]) && same((await sel()).slice().sort(), expectNear) && expectNear.length > 0, { selected: (await sel()).length, expected: expectNear.length });
  // setup: a steep mound with trees on it (the default town is flat)
  await run('terrain raise circle 70,-70 r=14 by=12');
  // setup: trees on the mound's flank (a forest plan rejects steep spots, so they are put there directly)
  await ev(() => { const w = window.__ds.world.getState(); w.addObjects(Array.from({ length: 12 }, (_, k) => { const a = (k / 12) * 2 * Math.PI, r = 4 + (k % 3) * 3; return { type: 'tree', transform: { position: [70 + r * Math.cos(a), 0, -70 + r * Math.sin(a)], rotation: [0, 0, 0], scale: [1, 1, 1] } }; })); });
  await wait(300);
  b = await say(T.steep[0]);
  const expectSteep = await ev(() => { const doc = window.__ds.world.getState().doc; const s = window.__ds.buildLib.samplerFor(doc.terrain); return Object.values(doc.objects).filter((o) => o.type === 'tree' && s.sampleSlope(o.transform.position[0], o.transform.position[2]) > 20).map((o) => o.id).sort(); });
  check('S7-3 "trees on slopes over 20°": exactly the trees standing on ground steeper than 20°', same(understoodOf(b), T.steep[1]) && same((await sel()).slice().sort(), expectSteep) && expectSteep.length > 0, { selected: (await sel()).length, expected: expectSteep.length, fb: b.fb, keys: b.fbKeys });
  // setup: two trees locked, one hidden
  const marked = await ev(() => { const w = window.__ds.world.getState(); const t = Object.values(w.doc.objects).filter((o) => o.type === 'tree').slice(0, 3); w.applyEdit({ update: [{ ...t[0], locked: true }, { ...t[1], locked: true }, { ...t[2], hidden: true }] }); return t.map((o) => o.id); });
  const allTrees = (await ofType('tree')).length;
  b = await say('delete type:tree');
  const lockedNote = b.plan?.notes.includes('cmd37.note.lockedSkipped'), hiddenNote = b.plan?.notes.includes('cmd37.note.hiddenSkipped');
  check('S7-4 "delete type:tree": locked trees and the hidden one are left out and reported; a delete is always previewed',
    b.plan?.armed && b.plan.counts.remove === allTrees - 3 && lockedNote && hiddenNote && (await ofType('tree')).length === allTrees, { remove: b.plan?.counts.remove, allTrees, notes: b.plan?.notes, marked, fb: b.fb, keys: b.fbKeys, understood: understoodOf(b), flags: (await objects()).filter((o) => marked.includes(o.id)).map((o) => [o.locked, o.hidden]) });
  await page.keyboard.press('Escape');
  await wait(200);
  b = await say('select type:tree where hidden');
  check('S7-5 a hidden object named by its filter is included', (await sel()).length === 1 && (await sel())[0] === marked[2], { sel: await sel(), fb: b.fb, keys: b.fbKeys, understood: understoodOf(b) });

  // S8 — the same value for all: command vs the multi-selection inspector
  const cars = (await ofType('car')).slice(0, 3).map((o) => o.id);
  await ev((ids) => window.__ds.editor.getState().setSelection(ids, ids[0]), cars); // setup
  await wait(300);
  const u0 = await undoDepth();
  b = await run(T.setX[0]);
  const byCommand = (await objects()).filter((o) => cars.includes(o.id)).map((o) => ({ id: o.id, p: o.p, r: o.r }));
  check('S8-1 "set x to 10 for the selection": the three cars are at x = 10, one undo step', same(understoodOf(b) ?? T.setX[1], T.setX[1]) && byCommand.every((o) => Math.abs(o.p[0] - 10) < 1e-9) && (await undoDepth()) === u0 + 1, { byCommand, fb: b.fb, keys: b.fbKeys, understood: understoodOf(b), plan: b.plan && { canonical: b.plan.canonical, counts: b.plan.counts }, selBefore: cars.length, selNow: (await sel()).length });
  await undoKey();
  await ev((ids) => window.__ds.editor.getState().setSelection(ids, ids[0]), cars);
  await wait(400);
  await page.click('[data-testid="multi-x"]', { clickCount: 3 });
  await page.keyboard.type('10');
  await page.keyboard.press('Enter');
  await wait(500);
  const byPanel = (await objects()).filter((o) => cars.includes(o.id)).map((o) => ({ id: o.id, p: o.p, r: o.r }));
  check('S8-2 the multi-selection inspector\'s common X field gives exactly the same objects', same(byCommand, byPanel) && (await undoDepth()) === u0 + 1, { byPanel });
  await shot('S8-common');
}

// ── G4 (S9, S10): terrain flatten with a heat map, bit-identical undo; forest rejects, the same trees twice ───────────
if (want('terrain')) {
  await fresh();
  await view(40, 55, 110, 50);
  // setup: a mound with a house on its side
  await run('terrain raise circle 40,55 r=16 by=5');
  await run('place building:house at=44,58');
  const h0 = await hashes();
  const u0 = await undoDepth();
  await pointAt(40, 55);
  const cursor = await ev(() => window.__ds.command.session.getState().cursor);
  let b = await say(T.flatten[0]);
  let d = await drawn();
  check('S9-1 "flatten a 10 m circle here": "here" is the ground point under the pointer; the preview is a height-change heat map, the document is unchanged',
    same(understoodOf(b), T.flatten[1]) && cursor && near(cursor, [40, 55], 1.5) && d.terrain && d.terrain.area > 100 && b.plan.diff.terrain.area > 100 && sameBits(await hashes(), h0), { cursor, d, diff: b.plan?.diff });
  await shot('S9-heatmap');
  await enter(900);
  const seated = await ev(() => { const doc = window.__ds.world.getState().doc; const s = window.__ds.buildLib.samplerFor(doc.terrain); const o = Object.values(doc.objects).find((x) => x.type === 'building' && Math.abs(x.transform.position[0] - 44) < 1 && Math.abs(x.transform.position[2] - 58) < 1); const c = window.__ds.command.session.getState().cursor; return { y: o.transform.position[1], ground: s.sampleHeight(o.transform.position[0], o.transform.position[2]), centre: s.sampleHeight(40, 55), edge: s.sampleHeight(40 + 6, 55), c }; });
  const h1 = await hashes();
  check('S9-2 Enter flattens it (the circle is level) and the house sits on the new ground; one undo step', Math.abs(seated.centre - seated.edge) < 0.05 && Math.abs(seated.y - seated.ground) < 0.35 && !sameBits(h1, h0) && (await undoDepth()) === u0 + 1, seated);
  await undoKey();
  const h2 = await hashes();
  check('S9-3 undo is bit-identical (document and every terrain / layer array)', sameBits(h2, h0), { h0, h2 });
  await redoKey();
  check('S9-4 redo is bit-identical to the confirmed state', sameBits(await hashes(), h1), {});

  // S10
  await view(30, 30, 130, 40);
  const t0n = (await ofType('tree')).length;
  b = await say(T.forest[0]);
  d = await drawn();
  const rejectLine = (await textOf('[data-testid="command-results"]')) ?? '';
  const rejected = b.plan?.items.filter((i) => i.status === 'rejected').length ?? 0;
  check('S10-1 the forest plan shows its trees as ghosts and says why spots were rejected', same(understoodOf(b), T.forest[1]) && d.ghosts > 5 && (rejected > 0 || b.plan.notes.some((n) => n.startsWith('cmd37.note.forest'))) && rejectLine.length > 0, { ghosts: d.ghosts, rejected, notes: b.plan?.notes });
  await enter(1000);
  const first = (await ofType('tree')).slice(t0n).map((o) => [o.p.map((v) => +v.toFixed(4)), o.seed]).sort();
  await undoKey();
  check('S10-2 undo removes the forest', (await ofType('tree')).length === t0n, {});
  await run(T.forest[0]);
  const second = (await ofType('tree')).slice(t0n).map((o) => [o.p.map((v) => +v.toFixed(4)), o.seed]).sort();
  check('S10-3 the same command again plants the same trees (places and seeds)', first.length > 5 && same(first, second), { n: first.length });
  await shot('S10-forest');
}

// ── G5 (S11, S12): disasters = the mouse's instances; run control; edits refused during a run ─────────────────────────
if (want('disaster')) {
  await fresh();
  await view(0, 0, 150, 40);
  const u0 = await undoDepth();
  let b = await say(T.blast[0]);
  let d = await drawn();
  check('S11-1 the explosion sentence → its canonical command, one ghost pin, nothing placed yet', same(understoodOf(b), T.blast[1]) && d.pins === 1 && (await insts()).length === 0, { understood: understoodOf(b), d });
  await shot('S11-pin');
  await enter(700);
  let list = await insts();
  const n4 = await ev(() => { const n = window.__ds.world.getState().doc.roads.nodes.n4; return [n.x, n.z]; });
  const blast = list[0];
  // The mouse path for the same spot: arm the explosion (setup) and click the junction with the real mouse.
  await ev(() => window.__ds.placement.arm('blast'));
  await wait(300);
  await above(n4[0], n4[1], 70);
  const [sx, sy] = await screen(n4[0], n4[1]);
  await page.mouse.move(sx - 8, sy - 5); await page.mouse.move(sx, sy, { steps: 3 }); await wait(200);
  await page.mouse.click(sx, sy);
  await wait(500);
  await ev(() => window.__ds.placement.disarm?.());
  list = await insts();
  const byMouse = list[1];
  const strip = (i) => { const { id: _i, key: _k, ...rest } = i; const spec = { ...rest.spec }; delete spec.energy; delete spec.startTime; return { ...rest, at: undefined, spec: { ...spec, position: spec.position?.map((v) => Math.round(v)) } }; };
  check('S11-2 Enter places a blast instance at the junction: 1.8e9 J, starting at 5 s — every other value is what the mouse placement gives',
    blast?.type === 'blast' && blast.spec.energy === 1.8e9 && (blast.at === 5 || blast.spec.startTime === 5) && near(blast.spec.position, n4, 0.11) && byMouse?.type === 'blast' && same(strip(blast), strip(byMouse)), { blast, byMouse });
  await undoKey(); // the mouse-placed one
  await view(0, 0, 150, 40);
  await pointAt(30, -40);
  b = await run(T.quake[0]);
  list = await insts();
  const quake = list.find((i) => i.type === 'earthquake');
  check('S11-3 "a magnitude 7 earthquake here": an earthquake instance, M 7, epicentre at the pointer', same(understoodOf(b) ?? T.quake[1], T.quake[1]) && quake && quake.spec.magnitude === 7 && near(quake.spec.epicenter ?? [], [30, -40], 1.5), { quake });
  const target = (await ofType('building'))[0];
  const fire = T.fireAt(target.id);
  b = await run(fire[0]);
  list = await insts();
  const f = list.find((i) => i.type === 'fire');
  check('S11-4 "a fire at #<id> after 12 seconds": a fire instance at that building, starting at 12 s', f && (f.at === 12 || f.spec.startTime === 12) && near(f.spec.position ?? f.spec.center ?? [], [target.p[0], target.p[2]], 0.11), { f, target: target.p });
  check('S11-5 three commands = three undo steps; the pins are in the scene', (await undoDepth()) === u0 + 3 && list.length === 3, { depth: (await undoDepth()) - u0, n: list.length });

  // S12
  await run('disaster rain intensity=60 duration=600');
  const docBefore = await hashes();
  b = await run(T.runSim[0]);
  await page.waitForFunction(() => window.__ds.simStore.getState().status === 'running', { timeout: 120_000 }).catch(() => null);
  await wait(1500);
  let st = await ev(() => window.__ds.simStore.getState().status);
  check('S12-1 "run" starts the simulation', st === 'running', { st });
  b = await run(T.pauseSim[0]);
  st = await ev(() => window.__ds.simStore.getState().status);
  check('S12-2 "pause" pauses it', st === 'paused', { st });
  b = await say(T.houses[0]);
  const simMsg = await tr('cmd37.err.simulating');
  const shown = (await textOf('[data-testid="command-results"]')) ?? '';
  check('S12-3 an editing command during a run is refused with the reason, nothing is changed', b.fb === 'error' && b.fbKeys.includes('cmd37.err.simulating') && shown.includes(simMsg) && b.plan === null, { fb: b.fb, keys: b.fbKeys, simMsg });
  await page.keyboard.press('Escape');
  await run(T.runSim[0]);
  await wait(1200);
  b = await run(T.stopRain[0]);
  await wait(600);
  const rain = await ev(() => window.__ds.sim.instances().find((i) => i.type === 'rain'));
  check('S12-4 "stop the rain" stops that instance', rain && (rain.status === 'stopped' || rain.status === 'ended' || rain.status === 'cancelled'), { rain });
  b = await say(T.pauseBlast[0]);
  check('S12-5 "pause the explosion" is refused: an explosion cannot be paused (said, not done)', b.fb === 'error' && b.fbKeys.some((k) => k.startsWith('cmd37.err.control')), { fb: b.fb, keys: b.fbKeys });
  await page.keyboard.press('Escape');
  b = await run(T.resetSim[0]);
  await wait(1200);
  st = await ev(() => ({ status: window.__ds.simStore.getState().status, mode: window.__ds.editor.getState().mode }));
  check('S12-6 "reset" goes back to the unchanged document', (st.status === 'idle' || st.mode === 'edit') && sameBits(await hashes(), docBefore), { st });
  await shot('S12-run');
}

// ── G6 (S13–S15): queries, an ambiguous reference, a sentence that is not understood ──────────────────────────────────
if (want('query')) {
  await fresh();
  await view(0, 0, 150, 40);
  const h0 = await hashes();
  const u0 = await undoDepth();
  const sel0 = await sel();
  let b = await say(T.howMany[0]);
  const nb = (await ofType('building')).length;
  const tableText = (await textOf('[data-testid="command-table"]')) ?? (await textOf('[data-testid="command-results"]')) ?? '';
  check('S13-1 "how many buildings?" answers with a table (the count is right); no plan, no undo step, the document untouched',
    same(understoodOf(b), T.howMany[1]) && b.fb === 'done' && b.done[0]?.table && b.done[0].table.title.params.count === nb && tableText.includes(String(nb)) && sameBits(await hashes(), h0) && (await undoDepth()) === u0, { nb, done: b.done, tableText: tableText.slice(0, 120) });
  const cam0 = await ev(() => window.__r3f.get().controls.target.toArray());
  b = await say(T.tallest[0]);
  await wait(900);
  const tall = await ev(() => { const doc = window.__ds.world.getState().doc; const P = window.__ds.command.lib; const r = P.planIntent(P.parseCanonical('list type:building tallest').intent, P.envOf(doc, window.__ds.command.context()), { seed: 1 }); const id = r.plan.table.ids[0]; return doc.objects[id].transform.position; });
  const cam1 = await ev(() => window.__r3f.get().controls.target.toArray());
  check('S13-2 "show me the tallest building" moves the camera to it; selection, history and document unchanged',
    same(understoodOf(b), T.tallest[1]) && Math.hypot(cam1[0] - tall[0], cam1[2] - tall[2]) < 3 && Math.hypot(cam1[0] - cam0[0], cam1[2] - cam0[2]) > 1 && same(await sel(), sel0) && (await undoDepth()) === u0 && sameBits(await hashes(), h0), { cam0, cam1, tall });
  await shot('S13-query');

  // S14 — two junctions: "at the junction" asks which
  await run('road 20,0 -> 20,40 preset=street');
  const u1 = await undoDepth();
  b = await say(T.blast[0]);
  const nOpts = await ev(() => document.querySelectorAll('[data-testid="command-option"]').length);
  check('S14-1 with two junctions "at the junction" asks which one: two options, nothing placed', b.fb === 'clarify' && b.options.length === 2 && nOpts === 2 && (await insts()).length === 0 && b.dom.state === 'question', { options: b.options, nOpts, state: b.dom.state });
  await page.hover('[data-testid="command-option"]:nth-of-type(2)').catch(() => null);
  await wait(300);
  const hl = await drawn();
  await shot('S14-clarify');
  const second = b.options[1];
  await ev(() => document.querySelectorAll('[data-testid="command-option"]')[1].click());
  await wait(700);
  b = await bar();
  check('S14-2 pointing at an option highlights it in the viewport; choosing it opens the plan of exactly that command', hl.highlight > 0 && b.plan?.armed && same(b.plan.canonical, [second]), { hl, canonical: b.plan?.canonical, second });
  await openBar();
  await enter(700);
  const placed = (await insts())[0];
  const node = await ev((c) => { const id = /at=node:(\w+)/.exec(c)[1]; const n = window.__ds.world.getState().doc.roads.nodes[id]; return [n.x, n.z]; }, second);
  check('S14-3 Enter places it at the chosen junction, one undo step', placed && near(placed.spec.position, node, 0.11) && (await undoDepth()) === u1 + 1, { placed: placed?.spec.position, node });

  // S15 — not understood
  const h1 = await hashes();
  const u2 = await undoDepth();
  b = await say(T.nonsense);
  const sug = await ev(() => [...document.querySelectorAll('[data-testid="command-suggestion"]')].map((x) => x.textContent));
  check('S15-1 a sentence that is not understood runs nothing: "not understood" with 1–3 nearest commands and the help',
    b.fb === 'unknown' && b.plan === null && b.suggestions.length >= 1 && b.suggestions.length <= 3 && (await has('[data-testid="command-help"]')) && sameBits(await hashes(), h1) && (await undoDepth()) === u2 && (await drawn()).sceneObjects === 0, { fb: b.fb, suggestions: b.suggestions, sug });
  await shot('S15-unknown');
  await page.keyboard.press('Escape');
}

// ── G7 (S16, S22): scripts — one step, all or nothing; the same world from Korean and from English sentences ─────────
const SCRIPT = [
  '# verify-command37 S16',
  'place building:house count=3 along=road:main side=north gap=2 floors=2',
  'group last name="script block"',
  'place car count=3 along=road:main',
  'terrain raise circle 60,60 r=12 by=3',
  'paint circle 60,60 r=12 ground=grass',
  'forest circle 60,60 r=13 density=low seed=3',
  'road 20,0 -> 20,30 preset=street',
  'move group:"script block" by=0,0,-3',
  'disaster blast at=node:n4 energy=1.8e9 start=5',
  'disaster fire at=next(last)',
  'select type:tree where near 60,60 r=20',
  'hide selection',
];
const SENTENCES = {
  ko: ['큰길 북쪽에 2층 주택 세 채 간격 2미터', '방금 만든 것 묶어서 "블록"이라고 해', '(60, 60) 반경 12 m 지면을 3 m 높여', '(30, 30) 반경 25 m에 숲, 밀도 0.4, 시드 7', '교차로에 폭발 1.8×10⁹ J, 5초 뒤', '모든 나무 선택해'],
  en: ['put three 2-storey houses north of the main road, 2 m apart', 'group the ones I just made, named "블록"', 'raise the ground within 12 m of (60, 60) by 3 m', 'a forest within 25 m of (30, 30), density 0.4, seed 7', 'a 1.8e9 J explosion at the junction in 5 s', 'select all trees'],
};
async function scriptRun(text) {
  await openBar();
  if (!(await has('[data-testid="command-script-text"]'))) await click('[data-testid="command-script"]');
  await page.click('[data-testid="command-script-text"]', { clickCount: 3 });
  await chord('KeyA', mod);
  await page.keyboard.press('Backspace');
  // (typed line by line: Enter in the script box is a new line)
  for (const line of text.split('\n')) { await page.keyboard.type(line, { delay: 1 }); await page.keyboard.press('Enter'); }
  await wait(200);
  await click('[data-testid="command-script-run"]');
  await wait(1200);
  return bar();
}
if (want('script')) {
  await fresh();
  await view(0, 0, 150, 40);
  const h0 = await hashes();
  const u0 = await undoDepth();
  let b = await scriptRun(SCRIPT.join('\n'));
  let d = await drawn();
  check('S16-1 a 12-line script is planned as a whole: one preview of everything (ghosts, heat map, road, pins), the document unchanged',
    b.plan?.armed && b.plan.canonical.length === 12 && d.ghosts > 6 && d.terrain && d.roads >= 1 && d.pins === 2 && sameBits(await hashes(), h0), { lines: b.plan?.canonical.length, d });
  await shot('S16-script');
  await openBar();
  await enter(1500);
  b = await bar();
  if (b.plan?.armed) { await enter(1500); b = await bar(); }
  const h1 = await hashes();
  check('S16-2 confirming applies all of it as ONE undo step', !sameBits(h1, h0) && (await undoDepth()) === u0 + 1 && (await insts()).length === 2, { depth: (await undoDepth()) - u0 });
  await undoKey();
  check('S16-3 one undo gives the start back bit for bit', sameBits(await hashes(), h0), {});
  const bad = [...SCRIPT.slice(0, 5), 'place building:house at=500,500', ...SCRIPT.slice(5)].join('\n');
  b = await scriptRun(bad);
  check('S16-4 one failing line (outside the world) cancels the whole script: the line is named, nothing is changed, no undo step',
    b.fb === 'error' && b.plan === null && sameBits(await hashes(), h0) && (await undoDepth()) === u0 && (await drawn()).sceneObjects === 0, { fb: b.fb, keys: b.fbKeys });
  await page.keyboard.press('Escape');

  // S22 — the same script as Korean sentences and as English sentences → the same document (ids aside)
  const world = async (lines) => {
    await fresh();
    await view(0, 0, 150, 40);
    const u = await undoDepth();
    const r = await scriptRun(lines.join('\n'));
    const canonical = r.plan?.canonical ?? null;
    await openBar();
    await enter(1500);
    if ((await bar()).plan?.armed) await enter(1500);
    const h = await hashes();
    return { canonical, hash: h.canonical, terrain: h.terrain, steps: (await undoDepth()) - u, objects: (await objects()).length };
  };
  const ko = await world(SENTENCES.ko);
  const en = await world(SENTENCES.en);
  check('S22-1 the Korean and the English script are understood as the same canonical commands', ko.canonical && same(ko.canonical, en.canonical) && ko.canonical.length === SENTENCES.ko.length, { ko: ko.canonical, en: en.canonical });
  check('S22-2 …and give the same document (canonical hash and terrain bits), each as one undo step', ko.hash === en.hash && ko.terrain === en.terrain && ko.steps === 1 && en.steps === 1, { ko, en });
  fs.writeFileSync(path.join(out, `s22-${lang}.json`), JSON.stringify({ ko, en }, null, 1));
}

// ── G8 (S17): right click → a command with the position filled in ─────────────────────────────────────────────────────
if (want('menu')) {
  await fresh();
  await above(40, 60, 70);
  const [sx, sy] = await screen(40, 60);
  const n0 = (await objects()).length;
  await page.mouse.move(sx - 6, sy - 4); await page.mouse.move(sx, sy, { steps: 3 }); await wait(250);
  await page.mouse.down({ button: 'right' }); await wait(60); await page.mouse.up({ button: 'right' });
  await wait(350);
  const menu = await ev(() => { const m = document.querySelector('[data-testid="context-menu"]'); return m ? { items: [...m.querySelectorAll('[role="menuitem"]')].map((x) => x.textContent.trim()), disabled: [...m.querySelectorAll('[role="menuitem"][aria-disabled="true"], [role="menuitem"]:disabled')].length } : null; });
  check('S17-1 a right click (no drag) on the ground opens the context menu with "place here" / "disaster here" entries', menu && menu.items.length >= 2 && menu.disabled === 0, menu);
  await shot('S17-menu');
  await ev(() => document.querySelector('[data-testid="context-menu"] [role="menuitem"]').click());
  await wait(700);
  let b = await bar();
  const m = /^(place|disaster) \S+.* at=(-?[\d.]+),(-?[\d.]+)/.exec(b.text) ?? [];
  check('S17-2 choosing an entry puts a command with that position into the bar and drafts it — nothing is placed', m.length === 4 && near([Number(m[2]), Number(m[3])], [40, 60], 1.5) && (await barFocused()) && (await objects()).length === n0 && b.plan?.armed !== true, { text: b.text });
  await enter(600);
  await enter(800);
  check('S17-3 Enter, Enter: placed there through the same plan path', (await objects()).length + (await insts()).length === n0 + 1, { text: b.text });
  // A right DRAG is still the camera pan: no menu.
  await leaveBar();
  const cam0 = await ev(() => window.__r3f.get().controls.target.toArray());
  await page.mouse.move(sx + 120, sy + 40); await wait(100);
  await page.mouse.down({ button: 'right' }); await page.mouse.move(sx + 220, sy + 90, { steps: 8 }); await wait(80); await page.mouse.up({ button: 'right' });
  await wait(350);
  const cam1 = await ev(() => window.__r3f.get().controls.target.toArray());
  check('S17-4 a right drag pans the camera and opens no menu', !(await has('[data-testid="context-menu"]')) && Math.hypot(cam1[0] - cam0[0], cam1[2] - cam0[2]) > 0.5, { cam0, cam1 });
}

// ── G9 (S18, S19): Phase 36 leftovers — car settings follow copies; outliner range / keys ─────────────────────────────
if (want('left')) {
  await fresh();
  await view(0, 0, 150, 40);
  // setup: one car with its own settings and a passenger, a second car with settings, grouped with a tree
  const made = await ev(() => {
    const w = window.__ds.world.getState();
    const doc = w.doc;
    const cars = Object.values(doc.objects).filter((o) => o.type === 'car').slice(0, 2);
    const people = Object.values(doc.objects).filter((o) => o.type === 'human').slice(0, 2);
    const tree = Object.values(doc.objects).find((o) => o.type === 'tree');
    const vehicles = { ...(doc.settings.simulation.vehicles ?? { model: 'dynamics' }), cars: {
      [cars[0].id]: { controls: { gear: 'D', throttle: 0.3 }, occupants: [{ human: people[0].id, seat: 0, restrained: true }, { human: people[1].id, seat: 1, restrained: false }] },
      [cars[1].id]: { controls: { gear: 'R', throttle: 0.1 } },
    } };
    w.updateSimulationSettings({ vehicles });
    // people[0] is copied along; people[1] is not part of the selection
    const ids = [cars[0].id, cars[1].id, people[0].id, tree.id];
    window.__ds.editor.getState().setSelection(ids, ids[0]);
    return { cars: cars.map((c) => c.id), people: people.map((p) => p.id), ids };
  });
  await wait(400);
  const carsOf = () => ev(() => window.__ds.world.getState().doc.settings.simulation.vehicles?.cars ?? {});
  const before = await carsOf();
  const ids0 = new Set((await objects()).map((o) => o.id));
  const u0 = await undoDepth();
  await ev(() => window.__r3f.get().gl.domElement.focus?.());
  await chord('KeyD', 'Control');
  await wait(600);
  const news = (await objects()).filter((o) => !ids0.has(o.id));
  const after = await carsOf();
  const newCars = news.filter((o) => o.type === 'car').map((o) => o.id);
  const newPeople = news.filter((o) => o.type === 'human').map((o) => o.id);
  const copied = newCars.map((id) => after[id]).filter(Boolean);
  const gears = copied.map((c) => c.controls?.gear).sort();
  const withOcc = copied.find((c) => c.occupants);
  check('S18-1 Ctrl+D of two cars + a person + a tree: both copies have their car\'s settings, in the SAME undo step',
    newCars.length === 2 && copied.length === 2 && same(gears, ['D', 'R']) && (await undoDepth()) === u0 + 1 && Object.keys(after).length === Object.keys(before).length + 2, { newCars, gears, depth: (await undoDepth()) - u0 });
  check('S18-2 passengers: the person copied along is the copy\'s passenger (new id), the one left behind is not carried over',
    withOcc && withOcc.occupants.length === 1 && withOcc.occupants[0].human === newPeople[0] && withOcc.occupants[0].seat === 0, { occupants: withOcc?.occupants, newPeople, original: made.people });
  await undoKey();
  check('S18-3 one undo removes the copies and their settings', same(await carsOf(), before) && (await objects()).length === ids0.size, {});
  // …and through the command (same stamp path)
  await ev((ids) => window.__ds.editor.getState().setSelection(ids, ids[0]), made.ids);
  await run('duplicate selection offset=3,3');
  const after2 = await carsOf();
  check('S18-4 "duplicate selection" does the same', Object.keys(after2).length === Object.keys(before).length + 2, { n: Object.keys(after2).length });
  await undoKey();
  // paste
  await ev((ids) => window.__ds.editor.getState().setSelection(ids, ids[0]), made.ids);
  await ev(() => window.__r3f.get().gl.domElement.focus?.());
  await chord('KeyC', 'Control');
  await chord('KeyV', 'Control');
  await wait(600);
  const after3 = await carsOf();
  check('S18-5 copy / paste carries the settings too', Object.keys(after3).length === Object.keys(before).length + 2, { n: Object.keys(after3).length });
  await undoKey();

  // S19 — outliner: Shift = range, ↑ / ↓ move
  await click('[data-testid="tab-scene"]');
  await wait(300);
  const rows = await ev(() => [...document.querySelectorAll('[data-testid="outliner-row"]')].slice(0, 8).map((r) => r.getAttribute('data-id')));
  await page.click(`[data-testid="outliner-row"][data-id="${rows[1]}"]`);
  await wait(200);
  await page.keyboard.down('Shift');
  await page.click(`[data-testid="outliner-row"][data-id="${rows[4]}"]`);
  await page.keyboard.up('Shift');
  await wait(300);
  check('S19-1 click a row, Shift+click another: the range between them is selected', same((await sel()).slice().sort(), rows.slice(1, 5).sort()), { sel: await sel(), rows: rows.slice(1, 5) });
  await page.click(`[data-testid="outliner-row"][data-id="${rows[2]}"]`);
  await wait(200);
  await page.keyboard.press('ArrowDown');
  await wait(200);
  const down = await sel();
  await page.keyboard.down('Shift'); await page.keyboard.press('ArrowDown'); await page.keyboard.up('Shift');
  await wait(200);
  check('S19-2 ↓ moves the selection to the next row, Shift+↓ extends it', same(down, [rows[3]]) && same((await sel()).slice().sort(), [rows[3], rows[4]].sort()), { down, sel: await sel() });
  check('S19-3 the list says its keys (Shift = range differs from the viewport\'s Shift = add)', await has('[data-testid="outliner-keys"]'), {});
  await shot('S19-outliner');
}

// ── G10 (S20): layout at four sizes with the bar and its result area open ─────────────────────────────────────────────
if (want('layout')) {
  for (const [w, h] of [[1920, 1080], [1440, 900], [1366, 768], [1280, 720]]) {
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await fresh();
    await wait(600);
    // The tallest content the result area has: an open plan with a long item list, then the help panel.
    await say('place building:house count=8 along=road:main side=north gap=2');
    const measure = () => ev(() => {
      const r = (el) => el?.getBoundingClientRect();
      const canvas = r(window.__r3f.get().gl.domElement);
      const barEl = r(document.querySelector('[data-testid="command-bar"]'));
      const right = r(document.querySelector('[data-testid="right-panel"]'));
      const over = (a, c) => (a && c ? Math.max(0, Math.min(a.right, c.right) - Math.max(a.left, c.left)) * Math.max(0, Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top)) : 0);
      const clipped = [...document.querySelectorAll('button, [role="tab"]')].filter((b) => b.offsetParent && b.scrollWidth > b.clientWidth + 2 && getComputedStyle(b).overflow !== 'visible').map((b) => b.textContent.trim().slice(0, 30)).slice(0, 8);
      return { share: +((canvas.width * canvas.height) / (innerWidth * innerHeight)).toFixed(3), barOverCanvas: Math.round(over(barEl, canvas)), rightOverCanvas: Math.round(over(right, canvas)), clipped, hscroll: document.documentElement.scrollWidth > innerWidth, results: Math.round(r(document.querySelector('[data-testid="command-results"]'))?.height ?? 0), bar: Math.round(barEl?.height ?? 0) };
    });
    const plan = await measure();
    await shot(`S20-${w}x${h}-plan`);
    await page.keyboard.press('Escape');
    await click('[data-testid="command-help"]');
    await wait(500);
    const help = await measure();
    await shot(`S20-${w}x${h}-help`);
    const okLay = (l) => l.share >= 0.35 && l.barOverCanvas < 1 && l.rightOverCanvas < 1 && !l.hscroll && l.clipped.length === 0 && l.results > 20;
    check(`S20-${w}x${h} with the result area open (a plan, the help): 3D view ≥ 35 %, nothing over it, no horizontal scroll, no clipped button`, okLay(plan) && okLay(help), { plan, help });
  }
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
}

// ── G11 (S21): an open plan ends with the mode, the document, a tool, a disaster placement — no ghost is left ─────────
if (want('life')) {
  await fresh();
  await view(0, 0, 150, 40);
  await wait(500);
  const base = await glInfo();
  const open = async () => { const b = await say('place building:house count=3 along=road:main side=north gap=2'); const d = await drawn(); return b.plan?.armed === true && d.ghosts === 3; };
  const gone = async () => { await wait(500); const b = await bar(); const d = await drawn(); return { plan: b.plan, scene: d.sceneObjects, state: b.dom.state }; };
  const cases = [
    ['a tool is armed (B = brush)', async () => { await leaveBarKeepPlan(); await page.keyboard.press('KeyB'); }],
    ['a palette placement is armed', async () => { await ev(() => window.__ds.editor.getState().setPlacing?.({ type: 'tree' }) ?? window.__ds.editor.getState().setTool('place')); }],
    ['a disaster placement is armed', async () => { await ev(() => window.__ds.placement.arm('blast')); }],
    ['the document is replaced', async () => { await ev(() => window.__ds.actions.loadSampleTown()); }],
    ['the mode switches (simulation starts)', async () => { await leaveBarKeepPlan(); await page.keyboard.press('Space'); }],
  ];
  /** Blur the input without Esc (Esc would cancel the plan itself). */
  async function leaveBarKeepPlan() { await ev(() => document.activeElement?.blur()); await wait(100); }
  for (const [name, act] of cases) {
    const was = await open();
    await act();
    const g = await gone();
    check(`S21 an open plan is cancelled when ${name}: no plan, no ghost in the scene`, was && g.plan === null && g.scene === 0, { was, g });
    // back to a clean editor for the next case
    await ev(() => { window.__ds.placement.disarm?.(); const e = window.__ds.editor.getState(); e.setTool('select'); });
    if ((await ev(() => window.__ds.simStore.getState().status)) !== 'idle') { await run(T.resetSim[0]); await wait(1000); }
    await wait(300);
  }
  // 20 plans opened and cancelled: the renderer's geometry / texture counts come back to where they were.
  await fresh();
  await view(0, 0, 150, 40);
  await say('place building:house count=3 along=road:main side=north gap=2');
  await page.keyboard.press('Escape');
  await wait(400);
  const g0 = await glInfo();
  for (let k = 0; k < 20; k++) { await say(`place building:house count=${3 + (k % 3)} along=road:main side=north gap=2`); await page.keyboard.press('Escape'); await wait(120); }
  await wait(600);
  const g1 = await glInfo();
  check('S21 20 plans opened and cancelled leave no geometry / texture behind', g1.geometries <= g0.geometries + 2 && g1.textures <= g0.textures + 1 && (await drawn()).sceneObjects === 0, { base, g0, g1 });
}

const pass = results.filter((r) => r.ok).length;
const gl = await glInfo();
console.log(`${pass}/${results.length} passed; ${errors.length} page errors; geometries ${gl.geometries}; textures ${gl.textures}`);
for (const e of errors.slice(0, 20)) console.log('  ' + e);
fs.writeFileSync(path.join(out, `results-${lang}.json`), JSON.stringify({ lang, results, errors, gl }, null, 1));
await browser.close();
process.exit(pass === results.length && errors.length === 0 ? 0 : 1);
