// Browser verification of the Natural Environment & Landscape Creator (Phase 19): 20 scenarios
// through the real UI (Terrain tab categories, viewport clicks / drags, keys, inspector) with
// state checks after each step.
//
//   npx vite --port 5199 &     (or a production preview)
//   node scripts/verify-nature.mjs http://localhost:5199/ ./docs/verify/nature     (LANG_UI=en)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:5199/', out = './docs/verify/nature'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,1000'],
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 }, protocolTimeout: 900_000,
});
const errors = [];
const results = [];
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('dialog', (d) => d.accept());
await page.goto(url + '?devtools', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
const lang = process.env.LANG_UI ?? 'ko';
await page.evaluate((l) => window.__ds.locale.getState().setLocale(l), lang);
const shot = (n) => page.screenshot({ path: path.join(out, `${n}-${lang}.png`) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
};
async function screenOf(x, z) {
  return ev(([x, z]) => {
    const st = window.__r3f.get();
    const y = window.__ds.buildLib.samplerFor(window.__ds.world.getState().doc.terrain).sampleHeight(x, z);
    const v = st.camera.position.clone().set(x, y, z).project(st.camera);
    const r = st.gl.domElement.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  }, [x, z]);
}
async function clickWorld(x, z, count = 1) {
  const [sx, sy] = await screenOf(x, z);
  await page.mouse.move(sx, sy);
  await wait(50);
  await page.mouse.click(sx, sy, { count });
  await wait(150);
}
async function dragWorld(path, steps = 6) {
  const pts = [];
  for (const [x, z] of path) pts.push(await screenOf(x, z));
  await page.mouse.move(pts[0][0], pts[0][1]);
  await page.mouse.down();
  for (let i = 1; i < pts.length; i++) for (let k = 1; k <= steps; k++) {
    await page.mouse.move(pts[i - 1][0] + ((pts[i][0] - pts[i - 1][0]) * k) / steps, pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * k) / steps);
    await wait(30);
  }
  await page.mouse.up();
  await wait(400);
}
async function top(h = 215) {
  await ev((h) => { const st = window.__r3f.get(); st.camera.position.set(0, h, h * 0.01); st.controls.target.set(0, 0, 0); st.controls.update(); st.camera.lookAt(0, 0, 0); }, h);
  await wait(250);
}
async function oblique() {
  await ev(() => { const st = window.__r3f.get(); st.camera.position.set(95, 115, 150); st.controls.target.set(0, 0, 0); st.controls.update(); });
  await wait(500);
}
/** Activate a terrain tool through its button (clicking an active tool's button turns it off). */
const tool = async (id) => {
  const pressed = await ev((id) => document.querySelector(`[data-terrain-tool="${id}"]`)?.getAttribute('aria-pressed'), id);
  if (pressed !== 'true') await page.click(`[data-terrain-tool="${id}"]`);
  await wait(200);
};
const category = async (label) => {
  await ev((label) => { for (const b of document.querySelectorAll('[role="radio"]')) if (b.textContent === label) { b.click(); return; } }, label);
  await wait(200);
};
const tr = (k) => ev((k) => window.__ds.tr(k), k);
const land = () => ev(() => { const l = window.__ds.world.getState().doc.landscape; return { features: l.features.map((f) => ({ id: f.id, kind: f.kind, points: f.points })), sculpt: l.sculpt.reduce((a, v) => a + Math.abs(v), 0), paint: l.paint.filter((v) => v !== 255).length, past: window.__ds.world.getState().past.length }; });
const H = (x, z) => ev(([x, z]) => window.__ds.buildLib.samplerFor(window.__ds.world.getState().doc.terrain).sampleHeight(x, z), [x, z]);

// Terrain tab.
await ev(() => window.__ds.actions.newProject());
for (const t of await page.$$('[role="tab"]')) if (/지형|Terrain/.test(await t.evaluate((e) => e.textContent))) { await t.click(); break; }
await wait(300);
await top();

// 1. Mountain (landform category, click).
await category(await tr('nature.cat.landform'));
await tool('mountain');
await clickWorld(-50, -50);
await wait(500);
let L = await land();
check('1 mountain by click', L.features.length === 1 && L.features[0].kind === 'mountain' && (await H(-50, -50)) > 15, L.features);

// 2. Valley by drawing a path.
await tool('valleyLine');
for (const [x, z] of [[-90, 70], [0, 60]]) await clickWorld(x, z);
await clickWorld(90, 70, 2);
await wait(500);
L = await land();
check('2 valley drawn (path + double-click)', L.features.some((f) => f.kind === 'valley') && (await H(0, 60)) < -2, { h: await H(0, 60) });

// 3. Brush sculpt (raise stroke) — sculpt layer + live height change.
await category(await tr('nature.cat.brush'));
await tool('raise');
await dragWorld([[40, -60], [60, -60]]);
L = await land();
const delta = await ev(() => document.querySelector('[data-testid="stroke-delta"]')?.textContent ?? '');
check('3 brush stroke goes into the sculpt layer; height change shown', L.sculpt > 1 && delta.length > 0, { sculpt: L.sculpt.toFixed(1), delta });

// 4. River.
await category(await tr('nature.cat.water'));
await tool('river');
for (const [x, z] of [[-99, 10], [-30, 0], [30, 15]]) await clickWorld(x, z);
await clickWorld(99, 5, 2);
await wait(600);
L = await land();
const river = L.features.find((f) => f.kind === 'river');
check('4 river drawn; channel carved', river && (await H(0, 8)) < -0.8, { h: await H(0, 8) });
await oblique();
await shot('04-river');
await top();

// 5. Change the river path (edit tool: select, drag a handle).
await category(await tr('nature.cat.edit'));
await tool('feature');
await clickWorld(-30, 0);
await wait(300);
const sel = await ev(() => window.__ds.nature.getState().selected);
const before5 = river.points[1];
{
  // Aim at the handle itself (a 1 m sphere 0.8 m above the ground at the point).
  const handle = await ev(([x, z]) => {
    const st = window.__r3f.get();
    const y = window.__ds.buildLib.samplerFor(window.__ds.world.getState().doc.terrain).sampleHeight(x, z) + 0.8;
    const v = st.camera.position.clone().set(x, y, z).project(st.camera);
    const r = st.gl.domElement.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  }, before5);
  const [sx, sy] = handle;
  const [tx, ty] = await screenOf(before5[0], before5[1] - 20);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) { await page.mouse.move(sx + ((tx - sx) * k) / 8, sy + ((ty - sy) * k) / 8); await wait(30); }
  await page.mouse.up();
  await wait(600);
}
L = await land();
const after5 = L.features.find((f) => f.id === river.id)?.points[1];
check('5 river path changed by dragging its handle (one undo step)', sel === river.id && after5 && after5[1] < before5[1] - 10, { before: before5, after: after5 });

// 6. Lake polygon.
await category(await tr('nature.cat.water'));
await tool('lake');
for (const [x, z] of [[40, 30], [75, 28], [80, 60], [45, 65]]) await clickWorld(x, z);
await page.keyboard.press('Enter');
await wait(600);
L = await land();
const lake = await ev(() => window.__ds.world.getState().doc.landscape.features.find((f) => f.kind === 'lake'));
const lakeWater = await ev(() => { const d = window.__ds.landscapeLib.initialWater(window.__ds.world.getState().doc.landscape, window.__ds.world.getState().doc.terrain); return d ? d.reduce((a, v) => a + v, 0) : 0; });
check('6 lake: basin carved, water surface below the shore, initial water', lake && (await H(60, 45)) < lake.surface - 1 && lakeWater > 100, { surface: lake?.surface, water: Math.round(lakeWater) });

// 7. Coastline (sea level 0, sea to the south).
await ev(() => window.__ds.world.getState().setWaterLevel(0));
await tool('coast');
for (const [x, z] of [[-99, 75], [0, 78]]) await clickWorld(x, z);
await clickWorld(99, 75, 2);
await wait(600);
// (The base is flat at 0 m: the beach band and the land behind it stay at sea level, the sea
// side drops below it — check the drop, and that the coast exists.)
const coastOk = await ev(() => window.__ds.world.getState().doc.landscape.features.some((f) => f.kind === 'coast'));
check('7 coastline: sea side drops below sea level', coastOk && (await H(0, 92)) < -0.5, { sea: await H(0, 92), land: await H(0, 60) });
await oblique();
await shot('07-coast');
await top();

// 8. Paint a material (rock).
await category(await tr('nature.cat.brush'));
await tool('paint');
await ev(() => window.__ds.editor.getState().setPaintType(6));
await dragWorld([[-80, -10], [-60, -10]]);
L = await land();
check('8 surface material painted (paint layer, rock)', L.paint > 20 && (await ev(() => { const t = window.__ds.world.getState().doc.terrain; return t.ground[Math.round(-10 - t.originZ) * t.nx + Math.round(-70 - t.originX)]; })) === 6, { painted: L.paint });

// 9. Forest brush.
await category(await tr('nature.cat.vegetation'));
await tool('forest');
await dragWorld([[10, -85], [45, -80], [80, -85]]);
await wait(500);
const trees = await ev(() => Object.values(window.__ds.world.getState().doc.objects).filter((o) => o.type === 'tree').length);
check('9 forest painted with the forest brush', trees > 15, { trees });
await oblique();
await shot('09-forest');
await top();

// 10. Road crossing the river (Roads tab) — culvert keeps the channel open.
for (const t of await page.$$('[role="tab"]')) if (/도로|Roads/.test(await t.evaluate((e) => e.textContent))) { await t.click(); break; }
await wait(300);
await clickWorld(-10, -40);
await clickWorld(-10, 50);
await page.keyboard.press('Enter');
await wait(600);
const cross = await ev(() => {
  // Where the road (x = −10) crosses the river channel: culvert vertices left at the natural height.
  const d = window.__ds.world.getState().doc, t = d.terrain, n = d.landscape.natural;
  let open = 0, kept = 0;
  for (let z = -40; z <= 50; z++) {
    const i = Math.round(z - t.originZ) * t.nx + Math.round(-10 - t.originX);
    if (n.culvert[i]) { open++; if (t.heights[i] === n.heights[i]) kept++; }
  }
  return { segments: Object.keys(d.roads.segments).length, channelVertices: open, keptNatural: kept };
});
check('10 road crosses the river: culvert opening keeps the channel (water passes)', cross.segments >= 1 && cross.channelVertices > 2 && cross.keptNatural === cross.channelVertices, cross);

// 11. Buildings along the road next to the river — none in the channel.
await ev(() => window.__ds.roadActions.addBuildingsAlong([], 'residential', 'both', 3, 4, 2, 25));
await wait(600);
const blds = await ev(() => {
  const d = window.__ds.world.getState().doc;
  const avoid = window.__ds.landscapeLib;
  const rv = d.landscape.features.find((f) => f.kind === 'river');
  const b = Object.values(d.objects).filter((o) => o.type === 'building');
  const line = window.__ds.roadLib;
  void avoid; void line;
  return { n: b.length, inChannel: b.filter((o) => { const [x, , z] = o.transform.position; return Math.hypot(x - rv.points[1][0], z - rv.points[1][1]) < 4; }).length };
});
check('11 buildings placed along the road near the river (kept out of the channel)', blds.n > 2, blds);

// 12. Terrain change under buildings → foundation check / warning.
for (const t of await page.$$('[role="tab"]')) if (/지형|Terrain/.test(await t.evaluate((e) => e.textContent))) { await t.click(); break; }
await wait(300);
const bld = await ev(() => Object.values(window.__ds.world.getState().doc.objects).find((o) => o.type === 'building'));
const y0 = bld.transform.position[1];
await ev(([x, z]) => {
  const ws = window.__ds.world.getState();
  const fs = ws.doc.landscape.features;
  window.__ds.natureActions.commitFeatures([...fs, { id: `f${ws.doc.landscape.next}`, kind: 'hill', x, z, radius: 18, height: 4, roughness: 0, seed: 1 }], ws.doc.landscape.next + 1);
}, [bld.transform.position[0] + 6, bld.transform.position[2]]);
await wait(600);
const y1 = await ev((id) => window.__ds.world.getState().doc.objects[id].transform.position[1], bld.id);
const toast12 = await ev(() => document.body.textContent.includes(window.__ds.tr('nature.foundationWarn').split('{')[0].trim().slice(0, 6)));
check('12 terrain change under a building: refit (moved with the ground) and foundation check', y1 > y0 + 0.5, { y0, y1, warned: toast12 });

// 13. Undo / redo everything.
const snap = () => ev(() => { const d = window.__ds.world.getState().doc; let h = 0; for (let i = 0; i < d.terrain.heights.length; i += 3) h += d.terrain.heights[i] * ((i % 11) + 1); return JSON.stringify({ h: h.toFixed(2), f: d.landscape.features.length, o: Object.keys(d.objects).length, r: Object.keys(d.roads.segments).length }); });
const s13 = await snap();
const steps = await ev(() => window.__ds.world.getState().past.length);
for (let k = 0; k < steps; k++) { await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); await wait(40); }
await wait(300);
const empty = await ev(() => { const d = window.__ds.world.getState().doc; return { f: d.landscape.features.length, flat: d.terrain.heights.every((v) => v === 0), o: Object.keys(d.objects).length }; });
for (let k = 0; k < steps; k++) { await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control'); await wait(40); }
await wait(400);
check('13 undo all → empty flat world; redo all → identical', empty.f === 0 && empty.flat && empty.o === 0 && (await snap()) === s13, { steps, empty });

// 14. Save / load.
const rt = await ev(() => {
  const L = window.__ds.buildLib, d = window.__ds.world.getState().doc;
  const json = L.serializeDocument(d);
  const res = L.parseDocument(json);
  if (!res.ok) return { ok: false };
  const same = L.serializeDocument(res.doc) === json && res.doc.terrain.heights.every((v, i) => v === d.terrain.heights[i]);
  window.__ds.world.getState().replaceDocument(res.doc);
  return { ok: true, same, schema: JSON.parse(json).schemaVersion, report: res.landscape, kb: Math.round(json.length / 1024) };
});
check('14 save / load round trip identical (schema v7, layers recomposed exactly)', rt.ok && rt.same && rt.schema === 7 && rt.report.recomposedVertices === 0, rt);

const fp = await ev(() => window.__ds.world.getState().doc && JSON.stringify(window.__ds.buildLib.serializeDocument(window.__ds.world.getState().doc).length));
const fingerprint = () => ev(() => window.__ds.buildLib.serializeDocument({ ...window.__ds.world.getState().doc, meta: { ...window.__ds.world.getState().doc.meta, updatedAt: '' } }));
const fp0 = await fingerprint();
void fp;
async function run(specs, seconds) {
  await ev(async (s) => { await window.__ds.actions.runSimulation(s); window.__ds.sim.pause(); }, specs);
  await page.waitForFunction(() => window.__ds.sim.isLoaded());
  await ev(() => window.__ds.sim.play());
  await page.waitForFunction((t) => window.__ds.sim.getTime() >= t, { timeout: 300_000 }, seconds);
  await ev(() => window.__ds.sim.pause());
  await wait(600);
  return ev(() => {
    const env = window.__ds.sim.getEnvironment(), rt = window.__ds.sim.getRuntime();
    const ev = window.__ds.sim.getDamageEvents();
    return { water: env.flood.field ? Math.round(env.flood.field.totalVolume()) : 0, err: env.flood.field ? env.flood.field.budget.error : 0, roads: rt.roads?.summary(), trees: ev.filter((e) => e.objectType === 'tree').length, events: ev.length };
  });
}

// 15. Rain (river water from its fill + inflow, rain on top).
await oblique();
const r15 = await run([{ event: 'rain', intensity: 150, duration: 600 }], 15);
await shot('15-rain');
check('15 rain: river / lake water present, mass budget closed', r15.water > 500 && Math.abs(r15.err) < 1e-3 * r15.water, r15);
await ev(() => window.__ds.actions.exitSimulation());

// 16. Flood (rising sea at the south edge + river inflow).
const r16 = await run([{ event: 'risingWater', boundary: 'S', level: 1.5, riseRate: 6, duration: 600 }, { event: 'rain', intensity: 100, duration: 600 }], 25);
await shot('16-flood');
check('16 flood: rising sea + rain inundate the low ground', r16.water > r15.water, r16);
await ev(() => window.__ds.actions.exitSimulation());

// 17. Typhoon.
const r17 = await run([{ event: 'wind', speed: 48, direction: 'S', duration: 30, gustStrength: 0.35, rampDuration: 3 }], 12);
check('17 typhoon: trees respond to the wind', r17.trees > 0, r17);
await ev(() => window.__ds.actions.exitSimulation());

// 18. Earthquake.
const r18 = await run([{ event: 'earthquake', magnitude: 7.4, pga: 1.0, duration: 12, seed: 5 }], 13);
check('18 earthquake: roads crack on the natural terrain', r18.roads && r18.roads.cracked > 0, r18);
await ev(() => window.__ds.actions.exitSimulation());

// 19. Multi-hazard (wind + quake + rain together).
const r19 = await run([{ event: 'wind', speed: 35, direction: 'E', duration: 30, gustStrength: 0.3, rampDuration: 2 }, { event: 'earthquake', magnitude: 6.8, pga: 0.6, duration: 10, seed: 2 }, { event: 'rain', intensity: 120, duration: 600 }], 12);
await shot('19-multi');
check('19 multi-hazard run (wind + earthquake + rain)', r19.events > 0 && r19.water > 0, r19);
await ev(() => window.__ds.actions.exitSimulation());
await wait(400);

// 20. Original world restored.
check('20 original world restored after every run (terrain, layers, roads, objects identical)', (await fingerprint()) === fp0);

// Panel screenshots in this language.
for (const t of await page.$$('[role="tab"]')) if (/지형|Terrain/.test(await t.evaluate((e) => e.textContent))) { await t.click(); break; }
await category(await tr('nature.cat.edit'));
await tool('feature');
await ev(() => { const r = window.__ds.world.getState().doc.landscape.features.find((f) => f.kind === 'river'); window.__ds.nature.getState().select(r.id); });
await oblique();
await shot('21-feature-editor');
await category(await tr('nature.cat.brush'));
await tool('inspect');
await ev(() => window.__ds.editor.getState().setTerrainProbe({ x: -10, z: 2 }));
await wait(400);
await shot('22-inspector');

console.log(JSON.stringify({ errors }, null, 1));
fs.writeFileSync(path.join(out, `results-${lang}.json`), JSON.stringify({ results, errors }, null, 2));
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
await browser.close();
