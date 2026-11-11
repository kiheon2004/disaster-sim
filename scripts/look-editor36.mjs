// Phase 36 visual look — not a pass / fail check: screenshots for a person to look at (spec §67). Brush previews (raise
// circle / square, lower, flatten ring, paint), a disaster pin before / after a raise stroke under it (the pin is drawn on
// the new ground), and the width taper where a 2-lane road meets the 10 m main street (seen from above).
//
//   npx vite build && npx vite preview --port 4196 --strictPort &
//   LANG_UI=ko node scripts/look-editor36.mjs http://localhost:4196/ ./docs/verify/editor36/look      (PIN_ONLY=1: pin shots only)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:4196/', out = './docs/verify/editor36/look'] = process.argv.slice(2);
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

async function armItem(id) {
  await click('[data-testid="tab-objects"]');
  await page.waitForSelector(`[data-item="${id}"]`, { timeout: 15000 });
  await click(`[data-item="${id}"]`);
}

// Open ground: a point at least 14 m from every object centre and 12 m from every road node / segment midpoint.
await fresh();
const P = await ev(() => {
  const d = window.__ds.world.getState().doc;
  const objs = Object.values(d.objects).map((o) => o.transform.position);
  const nodes = Object.values(d.roads.nodes).map((n) => n.position ?? n.p ?? [n.x ?? 0, 0, n.z ?? 0]);
  for (const [x, z] of [[-75, -75], [75, 75], [-75, 75], [75, -75], [-60, -85], [85, -40], [-85, 40], [0, -85], [0, 85]]) {
    if (objs.every((p) => Math.hypot(p[0] - x, p[2] - z) > 14) && nodes.every((p) => Math.hypot((p[0] ?? 0) - x, (p[2] ?? p[1] ?? 0) - z) > 12)) return [x, z];
  }
  return [-75, -75];
});
console.log('open ground', P);
await view(P[0], P[1], 34, 26);
await click('[data-testid="tab-terrain"]');
const hover = async (tool, opts = {}) => {
  await ev(([t, o]) => { const e = window.__ds.editor.getState(); e.setTerrainTool(t); e.setBrush({ radius: 8, strength: 0.5 }); e.setBrushOptions(o); }, [tool, opts]);
  await wait(300);
  const [sx, sy] = await screen(P[0], P[1]);
  await page.mouse.move(sx - 30, sy); await page.mouse.move(sx, sy, { steps: 6 }); await wait(900);
  return ev(() => { const p = window.__ds.editor.getState().brushPreview; return p ? { keys: Object.keys(p) } : null; });
};
if (!process.env.PIN_ONLY) {
console.log('raise circle', JSON.stringify(await hover('raise', { brushShape: 'circle' }))); await shot('brush-raise-circle');
console.log('raise square', JSON.stringify(await hover('raise', { brushShape: 'square' }))); await shot('brush-raise-square');
console.log('lower', JSON.stringify(await hover('lower', { brushShape: 'circle' }))); await shot('brush-lower');
console.log('flatten', JSON.stringify(await hover('flatten', { brushShape: 'circle' }))); await shot('brush-flatten');
console.log('paint', JSON.stringify(await hover('paint', { brushShape: 'circle' }))); console.log('paint text', await ev(() => document.querySelector('[data-testid="brush-preview"]')?.textContent)); await shot('brush-paint');
}

// Pin re-drape: a blast pin on the open ground, then a raise stroke over it — the pin and its ground ring sit on the new ground.
await ev(() => window.__ds.editor.getState().setTerrainTool(null));
await page.keyboard.press('Escape');
await click('[data-tab="phenomena"]');
await click('[data-testid="lib-blast"]');
await clickWorld(P[0], P[1]);
await page.keyboard.press('Escape');
await wait(400);
await view(P[0], P[1] + 6, 14, 30);
await shot('pin-before-stroke');
await click('[data-testid="tab-terrain"]');
await ev(() => { const e = window.__ds.editor.getState(); e.setTerrainTool('raise'); e.setBrush({ radius: 10, strength: 1 }); e.setBrushOptions({ brushShape: 'circle' }); });
await wait(300);
const [px, py] = await screen(P[0], P[1]);
await page.mouse.move(px, py); await page.mouse.down();
for (let k = 0; k < 6; k++) { await page.mouse.move(px + (k % 2 ? 6 : -6), py, { steps: 4 }); await wait(250); }
await page.mouse.up(); await wait(900);
await ev(() => window.__ds.editor.getState().setTerrainTool(null));
await page.mouse.move(5, 5); await wait(600);
const pinY = await ev(([x, z]) => window.__ds.buildLib.samplerFor(window.__ds.world.getState().doc.terrain).sampleHeight(x, z), P);
console.log('ground under pin after stroke', pinY);
await click('[data-tab="phenomena"]');
await view(P[0], P[1], 26, 48); await wait(600);
const pinDrawn = await ev(() => { let ys = []; window.__r3f.get().scene.traverse((o) => { if (o.isMesh && o.renderOrder === 8 && o.parent?.position) ys.push(+o.parent.position.y.toFixed(2)); }); return ys; });
console.log('pin group y in the scene', JSON.stringify(pinDrawn));
await shot('pin-after-stroke');

if (!process.env.PIN_ONLY) {
// Road taper: the S7 palette 2-lane road at the end of the 10 m main street, seen from above and from a low angle.
await fresh();
await above(66, 0, 80);
await armItem('env.road');
await clickWorld(66, 0);
await page.keyboard.press('Escape');
await wait(600);
await above(62, 0, 36); await shot('road-taper-above');
}
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();
