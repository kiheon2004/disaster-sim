// Browser verification of the Creative Build Mode (Phase 16) with real mouse / keyboard input:
// palette search + thumbnails, brush stroke (one undo step), line placement, area fill with
// preview + Enter, Shift+drag box selection, group / align / rotate, copy + paste, Delete,
// undo / redo, simulation lock + original-world restore, KO / EN.
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/verify-build.mjs http://localhost:4173/ ./shots        (LANG_UI=en for English)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:4173/', out = './shots'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const lang = process.env.LANG_UI ?? 'ko';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,1000'],
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 }, protocolTimeout: 600_000,
});
const errors = [];
const results = [];
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('dialog', (d) => d.accept());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (n) => page.screenshot({ path: path.join(out, `build-${n}-${lang}.png`) });
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const ds = (fn, ...args) => page.evaluate(fn, ...args);
const count = () => ds(() => Object.keys(window.__ds.world.getState().doc.objects).length);
const past = () => ds(() => window.__ds.world.getState().past.length);

await page.goto(url + '?devtools', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
await ds(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
await ds((l) => window.__ds.locale.getState().setLocale(l), lang);
// Empty flat world, camera looking down at the origin.
await ds(() => window.__ds.actions.newProject());
await ds(() => {
  const s = window.__r3f.get();
  s.camera.position.set(0, 120, 70);
  s.controls.target.set(0, 0, 0);
  s.controls.update();
});
await wait(1200);

/** World (x, y, z) → page pixel coordinates. */
const toScreen = (x, y, z) => ds(([x, y, z]) => {
  const s = window.__r3f.get();
  const v = s.camera.position.clone().set(x, y, z).project(s.camera);
  const r = s.gl.domElement.getBoundingClientRect();
  return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
}, [x, y, z]);
const drag = async (pts, opts = {}) => {
  const first = await toScreen(...pts[0]);
  await page.mouse.move(first[0], first[1]);
  if (opts.shift) await page.keyboard.down('Shift');
  await page.mouse.down();
  for (const p of pts.slice(1)) {
    const s = await toScreen(...p);
    await page.mouse.move(s[0], s[1], { steps: 8 });
  }
  await page.mouse.up();
  if (opts.shift) await page.keyboard.up('Shift');
  await wait(400);
};
const click = async (p, opts = {}) => {
  const s = await toScreen(...p);
  if (opts.shift) await page.keyboard.down('Shift');
  await page.mouse.click(s[0], s[1]);
  if (opts.shift) await page.keyboard.up('Shift');
  await wait(250);
};
const clickSel = (sel) => page.click(sel);

// ── Palette: search + filter + thumbnails ───────────────────────────────
await page.waitForFunction(() => document.querySelectorAll('[data-testid="palette"] img').length > 5, { timeout: 15000 }).catch(() => {});
const thumbs = await ds(() => document.querySelectorAll('[data-testid="palette"] img').length);
check('palette thumbnails rendered', thumbs >= 10, `${thumbs} images`);
await page.type('input[aria-label="' + (lang === 'ko' ? '오브젝트 검색' : 'Search objects') + '"]', lang === 'ko' ? '침엽' : 'conifer');
await wait(200);
const found = await ds(() => [...document.querySelectorAll('[data-testid="palette"] [data-item]')].map((b) => b.dataset.item));
check('palette search', found.length === 1 && found[0] === 'tree.conifer', found.join(','));
await shot('01-search');
await page.click('[data-item="tree.conifer"]');
await page.evaluate(() => { const i = document.querySelector('input[aria-label]'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
await page.keyboard.press('Escape');

// ── Brush: one stroke of trees, one undo step ──────────────────────────
await ds(() => window.__ds.editor.getState().armPlacement('tree.conifer'));
await page.keyboard.press('b');
await ds(() => window.__ds.build.getState().setBrushSettings({ radius: 10, density: 3, spacing: 3 }));
await wait(200);
const before = await count();
const pastBefore = await past();
await drag([[-50, 0, -10], [-30, 0, -5], [-10, 0, 5], [10, 0, 0]]);
const afterBrush = await count();
check('brush stroke places many objects', afterBrush - before >= 20, `${afterBrush - before} trees`);
check('brush stroke = one undo step', (await past()) === pastBefore + 1);
await shot('02-brush');
await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
await wait(300);
check('undo removes the whole stroke', (await count()) === before);
await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('z'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
await wait(300);
check('redo restores the stroke', (await count()) === afterBrush);

// ── Line: street lights along a polyline ───────────────────────────────
await ds(() => window.__ds.editor.getState().armPlacement('infra.streetLight'));
await page.keyboard.press('l');
await ds(() => window.__ds.build.getState().setLine({ spacing: 8, orient: 'along', offset: 0, bothSides: false }));
const c0 = await count();
await click([-40, 0, 15]);
await click([0, 0, 15]);
await click([0, 0, 35]);
await wait(300);
await shot('03-line-preview');
await page.keyboard.press('Enter');
await wait(400);
const lineAdded = (await count()) - c0;
check('line placement (8 m spacing, 60 m path)', lineAdded >= 7 && lineAdded <= 9, `${lineAdded} lamps`);

// ── Area fill: rectangle, preview, Enter ───────────────────────────────
await ds(() => window.__ds.editor.getState().armPlacement('car.sedan'));
await page.keyboard.press('a');
await ds(() => window.__ds.build.getState().setArea({ shape: 'rect', mode: 'grid', spacing: 6, jitter: 0 }));
await ds(() => window.__ds.build.getState().setPlacement({ randomRotation: false }));
const c1 = await count();
await drag([[20, 0, -40], [50, 0, -15]]);
await page.waitForSelector('[data-testid="area-apply"]', { timeout: 5000 }).catch(() => {});
const preview = await ds(() => document.querySelector('[data-testid="area-apply"]')?.textContent ?? '');
check('area preview shown before applying', preview.length > 0 && (await count()) === c1, preview);
await shot('04-area-preview');
await page.keyboard.press('Enter');
await wait(400);
const areaAdded = (await count()) - c1;
check('area fill applied (grid)', areaAdded >= 12, `${areaAdded} cars`);

// ── Box selection (Shift+drag) + group editing ─────────────────────────
await page.keyboard.press('v');
await wait(200);
await drag([[15, 0, -45], [55, 0, -10]], { shift: true });
const sel = await ds(() => window.__ds.editor.getState().selectedIds.length);
check('Shift+drag box selection', sel === areaAdded, `${sel} selected`);
await shot('05-multi-select');
const multiPanel = await ds(() => !!document.querySelector('[data-testid="multi-inspector"]'));
check('selection inspector for multi-selection', multiPanel);
await page.keyboard.down('Control'); await page.keyboard.press('g'); await page.keyboard.up('Control');
await wait(200);
const groups = await ds(() => new Set(window.__ds.editor.getState().selectedIds.map((id) => window.__ds.world.getState().doc.objects[id].group)).size);
check('Ctrl+G groups the selection', groups === 1);
// Clicking one member selects the whole group.
await page.keyboard.press('Escape');
const member = await ds(() => window.__ds.world.getState().doc.objects[Object.values(window.__ds.world.getState().doc.objects).find((o) => o.type === 'car').id].transform.position);
await click([member[0], 0.8, member[2]]);
const groupSel = await ds(() => window.__ds.editor.getState().selectedIds.length);
check('click on a group member selects the group', groupSel === areaAdded, `${groupSel}`);
// Rotate the group 90° from the inspector: relative layout kept, one undo step.
const dist = () => ds(() => {
  const ids = window.__ds.editor.getState().selectedIds;
  const o = window.__ds.world.getState().doc.objects;
  const a = o[ids[0]].transform.position, b = o[ids[ids.length - 1]].transform.position;
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
});
const d0 = await dist();
const p0 = await past();
await page.evaluate(() => [...document.querySelectorAll('[data-testid="multi-inspector"] button')].find((b) => b.textContent.includes('↺')).click());
await wait(300);
check('group rotation keeps relative distances', Math.abs((await dist()) - d0) < 1e-6 && (await past()) === p0 + 1);
await shot('06-group-rotated');

// ── Copy / paste ───────────────────────────────────────────────────────
await page.keyboard.down('Control'); await page.keyboard.press('c'); await page.keyboard.up('Control');
await page.keyboard.down('Control'); await page.keyboard.press('v'); await page.keyboard.up('Control');
await wait(200);
const c2 = await count();
const target = await toScreen(-40, 0, -45);
await page.mouse.move(target[0], target[1], { steps: 5 });
await wait(300);
await shot('07-paste-preview');
await page.mouse.click(target[0], target[1]);
await wait(400);
const pasted = (await count()) - c2;
const ids = await ds(() => Object.keys(window.__ds.world.getState().doc.objects));
check('paste places a copy with new unique ids', pasted === areaAdded && new Set(ids).size === ids.length, `${pasted} pasted`);
const newGroup = await ds(() => {
  const o = window.__ds.world.getState().doc.objects;
  return new Set(window.__ds.editor.getState().selectedIds.map((id) => o[id].group)).size;
});
check('pasted copy forms its own group', newGroup === 1);
await page.keyboard.press('Escape');

// ── Delete (multi) + undo ──────────────────────────────────────────────
await page.keyboard.press('v');
await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
const all = await ds(() => window.__ds.editor.getState().selectedIds.length);
check('Ctrl+A selects all', all === (await count()));
await page.keyboard.press('Delete');
await wait(300);
check('Delete removes the whole selection', (await count()) === 0);
await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
await wait(300);
check('one undo brings everything back', (await count()) === all);

// ── Draw calls (batched editor rendering) ──────────────────────────────
const calls = await ds(() => { const s = window.__r3f.get(); s.gl.info.autoReset = false; s.gl.info.reset(); s.gl.render(s.scene, s.camera); const c = s.gl.info.render.calls; s.gl.info.autoReset = true; return c; });
check('editor draw calls stay low', calls < 120, `${calls} draw calls for ${await count()} objects`);

// ── Simulation: world locked, original restored ────────────────────────
const fp = await ds(() => JSON.stringify(window.__ds.world.getState().doc.objects));
await ds(() => window.__ds.actions.runSimulation([{ event: 'wind', speed: 55, direction: 'E', duration: 20, gustStrength: 0.3, rampDuration: 2 }]));
await page.waitForFunction(() => window.__ds.simStore.getState().status === 'running', { timeout: 30000 });
await wait(4000);
await shot('08-simulation');
const badge = await ds(() => !!document.querySelector('[data-testid="original-world"]'));
check('original-world badge in simulation', badge);
const locked = await ds(() => { window.__ds.world.getState().applyEdit({ remove: Object.keys(window.__ds.world.getState().doc.objects) }); return Object.keys(window.__ds.world.getState().doc.objects).length; });
check('world edits refused while simulating', locked === all);
await ds(() => window.__ds.actions.exitSimulation());
await wait(800);
check('editor shows the original world after the experiment', (await ds(() => JSON.stringify(window.__ds.world.getState().doc.objects))) === fp);
await shot('09-restored');

// ── Place tool warning on overlap ──────────────────────────────────────
await ds(() => window.__ds.editor.getState().armPlacement('building.office'));
const someCar = await ds(() => Object.values(window.__ds.world.getState().doc.objects).find((o) => o.type === 'car').transform.position);
const sc = await toScreen(someCar[0], 0, someCar[2]);
await page.mouse.move(sc[0], sc[1], { steps: 4 });
await wait(400);
const warn = await ds(() => document.querySelector('[data-testid="ghost-warning"]')?.textContent ?? '');
check('place ghost warns about overlap', warn.length > 0, warn);
await shot('10-overlap-warning');

console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page errors');
fs.writeFileSync(path.join(out, `verify-build-${lang}.json`), JSON.stringify({ results, errors }, null, 2));
await browser.close();
process.exit(results.every((r) => r.ok) && !errors.length ? 0 : 1);
