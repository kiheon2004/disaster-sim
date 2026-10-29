// Browser verification of the Road Network & City Builder (Phase 18): 20 scenarios through the
// real UI (Roads tab, viewport clicks, keys, inspector) with state checks after each step.
//
//   npx vite --port 5199 &    (or: npm run build && npx vite preview --port 4173 &)
//   node scripts/verify-roads.mjs http://localhost:5199/ ./docs/verify/roads     (LANG_UI=en for English)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:5199/', out = './docs/verify/roads'] = process.argv.slice(2);
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
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
};
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const frames = () => ev(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function screenOf(x, z) {
  return ev(([x, z]) => {
    const st = window.__r3f.get();
    const y = window.__ds.buildLib.samplerFor(window.__ds.world.getState().doc.terrain).sampleHeight(x, z);
    const v = st.camera.position.clone().set(x, y, z).project(st.camera);
    const r = st.gl.domElement.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  }, [x, z]);
}
async function clickWorld(x, z, opts = {}) {
  const [sx, sy] = await screenOf(x, z);
  await page.mouse.move(sx, sy);
  await wait(50);
  if (opts.shift) await page.keyboard.down('Shift');
  await page.mouse.click(sx, sy, { count: opts.double ? 2 : 1 });
  if (opts.shift) await page.keyboard.up('Shift');
  await wait(120);
}
async function view(x = 0, z = 0, h = 160, tilt = 0.01) {
  await ev(([x, z, h, tilt]) => {
    const st = window.__r3f.get();
    st.camera.position.set(x, h, z + h * tilt);
    if (st.controls) { st.controls.target.set(x, 0, z); st.controls.update(); }
    st.camera.lookAt(x, 0, z);
  }, [x, z, h, tilt]);
  await wait(250);
}
const roads = () => ev(() => {
  const n = window.__ds.world.getState().doc.roads;
  const L = window.__ds.roadLib;
  const ints = [...L.intersectionsOf(n).values()];
  return { segments: Object.keys(n.segments).length, nodes: Object.keys(n.nodes).length, junctions: ints.filter((i) => i.junction).length, blocks: L.blocksOf(n).length, past: window.__ds.world.getState().past.length };
});
const groundAt = (x, z) => ev(([x, z]) => {
  const t = window.__ds.world.getState().doc.terrain;
  const i = Math.round((z - t.originZ) / t.cellSize) * t.nx + Math.round((x - t.originX) / t.cellSize);
  return { g: t.ground[i], h: t.heights[i] };
}, [x, z]);
const mode = async (m) => { await page.click(`[data-road-mode="${m}"]`); await wait(150); };
const clickTestId = async (id) => { await page.click(`[data-testid="${id}"]`); await wait(300); };

// ── 1. Roads tab → draw a straight road with clicks ────────────────────────────────
await ev(() => window.__ds.actions.newProject());
await wait(300);
await page.click('[data-testid="tab-roads"]');
await wait(300);
await view(0, 0, 215);
await clickWorld(-70, -30);
await clickWorld(70, -30);
await shot('01-draw-preview');
await page.keyboard.press('Enter');
await wait(500);
let r = await roads();
let g = await groundAt(0, -30);
check('1 draw straight road (click, click, Enter)', r.segments === 1 && g.g === 3 && r.past === 1, { ...r, ground: g.g });

// ── 2. Polyline ending on the road → T-junction ───────────────────────────────────
await clickWorld(0, 60);
await clickWorld(-20, 20);
await clickWorld(-20, -30.5);
await page.keyboard.press('Enter');
await wait(500);
r = await roads();
check('2 polyline + T-junction on the road', r.segments === 4 && r.junctions === 1, r);

// ── 3. Curved road (curve mode, double-click to finish) ───────────────────────────
await mode('curve');
await clickWorld(20, 70);
await clickWorld(45, 40);
await clickWorld(70, 70, { double: true });
await wait(500);
r = await roads();
const curved = await ev(() => Object.values(window.__ds.world.getState().doc.roads.segments).filter((s) => s.control.length > 0).length);
check('3 curved road (one segment with control points)', r.segments === 5 && curved === 1, { ...r, curved });

// ── 4. Crossing an existing road → 4-way intersection ─────────────────────────────
await mode('draw');
await clickWorld(40, -70);
await clickWorld(40, 10);
await page.keyboard.press('Enter');
await wait(500);
r = await roads();
const fourWay = await ev(() => [...window.__ds.roadLib.intersectionsOf(window.__ds.world.getState().doc.roads).values()].filter((i) => i.roads.length === 4).length);
check('4 crossing makes a 4-way junction', fourWay === 1 && r.junctions === 2, { ...r, fourWay });
await view(10, -20, 120, 0.6);
await shot('04-junctions');

// ── 5. Edit mode: select by click, inspector, drag a node handle (one undo step) ───
await view(0, 0, 215);
await mode('edit');
await clickWorld(-50, -30);
await wait(300);
const sel = await ev(() => window.__ds.roads.getState().selection.segments);
const inspector = await ev(() => !!document.querySelector('[data-testid="road-inspector"]')?.textContent?.match(/m/));
check('5a click selects a road; inspector shows it', sel.length === 1 && inspector, { sel });
const endNode = await ev(() => {
  const n = window.__ds.world.getState().doc.roads;
  const s = n.segments[window.__ds.roads.getState().selection.segments[0]];
  const a = n.nodes[s.a], b = n.nodes[s.b];
  return a.x < b.x ? a : b;
});
const pastBefore = (await roads()).past;
{
  const [sx, sy] = await screenOf(endNode.x, endNode.z);
  const [tx, ty] = await screenOf(endNode.x, endNode.z - 15);
  await page.mouse.move(sx, sy - 3);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) { await page.mouse.move(sx + ((tx - sx) * k) / 8, sy - 3 + ((ty - sy) * k) / 8); await wait(30); }
  await shot('05-drag-node');
  await page.mouse.up();
  await wait(500);
}
const movedNode = await ev((id) => window.__ds.world.getState().doc.roads.nodes[id], endNode.id);
r = await roads();
check('5b drag a node handle moves it (one undo step)', movedNode && movedNode.z < endNode.z - 10 && r.past === pastBefore + 1, { from: endNode, to: movedNode });

// ── 6. Profile change from the inspector (surface, width) ─────────────────────────
await ev(() => window.__ds.roadActions.updateRoadProfile(window.__ds.roads.getState().selection.segments, { material: 'concrete', width: 10 }));
await wait(400);
const segMid = await ev(() => {
  const n = window.__ds.world.getState().doc.roads;
  const s = n.segments[window.__ds.roads.getState().selection.segments[0]];
  const line = window.__ds.roadLib.segmentLine(n, s);
  const p = line.samples[Math.floor(line.samples.length / 2)];
  return [p.x, p.z];
});
g = await groundAt(segMid[0], segMid[1]);
check('6 change surface / width of the selected road (terrain re-baked)', g.g === 4, g);
await view(segMid[0], segMid[1], 60, 0.8);
await shot('06-concrete');

// ── 7. Split mode ──────────────────────────────────────────────────────────────────
await view(0, 0, 215);
await mode('split');
const before7 = await roads();
await clickWorld(60, -30);
await wait(400);
r = await roads();
check('7 split a road by clicking', r.segments === before7.segments + 1, r);

// ── 8. Delete mode keeps linked objects ────────────────────────────────────────────
await ev(() => window.__ds.roadActions.addInfrastructure([], 'streetLight', 'both', 25, 1));
await wait(400);
const lamps = await ev(() => Object.values(window.__ds.world.getState().doc.objects).filter((o) => o.roadLink).length);
await mode('delete');
await clickWorld(-10, 40);
await wait(400);
const after8 = await roads();
const lampsAfter = await ev(() => Object.keys(window.__ds.world.getState().doc.objects).length);
check('8 delete a road by clicking; linked objects are kept', after8.segments === r.segments - 1 && lampsAfter === lamps && lamps > 5, { segments: after8.segments, lamps, lampsAfter });

// ── 9. Undo / redo of everything ───────────────────────────────────────────────────
const snap = () => ev(() => {
  const d = window.__ds.world.getState().doc;
  let hsum = 0; for (let i = 0; i < d.terrain.heights.length; i += 7) hsum += d.terrain.heights[i] * (i % 13);
  return JSON.stringify({ r: Object.keys(d.roads.segments).sort(), o: Object.keys(d.objects).length, hsum: hsum.toFixed(3), gsum: d.terrain.ground.reduce((a, b) => a + b, 0) });
});
const s9 = await snap();
const steps = (await roads()).past;
for (let k = 0; k < steps; k++) { await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); await wait(40); }
await wait(300);
const empty9 = await ev(() => ({ seg: Object.keys(window.__ds.world.getState().doc.roads.segments).length, g: window.__ds.world.getState().doc.terrain.ground.reduce((a, b) => a + b, 0) }));
for (let k = 0; k < steps; k++) { await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control'); await wait(40); }
await wait(300);
check('9 undo all → empty original ground; redo all → identical world', empty9.seg === 0 && empty9.g === 0 && (await snap()) === s9, { steps, empty9 });

// ── 10. Terrain preset under roads: roads re-baked, graded cross-section level ─────
await ev(() => window.__ds.actions.applyTerrainPreset('gentleHills', 4));
await wait(600);
const hill = await ev(() => {
  const d = window.__ds.world.getState().doc;
  const n = d.roads;
  const L = window.__ds.roadLib;
  const s = Object.values(n.segments).find((x) => x.profile.elevation === 'graded');
  const line = L.segmentLine(n, s);
  const p = line.samples[Math.floor(line.samples.length / 2)];
  const t = d.terrain;
  const at = (x, z) => t.heights[Math.round((z - t.originZ) / t.cellSize) * t.nx + Math.round((x - t.originX) / t.cellSize)];
  const w = s.profile.width / 2 - 0.6;
  return { left: at(p.x - p.tz * -w, p.z + p.tx * -w), right: at(p.x - p.tz * w, p.z + p.tx * w), g: t.ground[Math.round((p.z - t.originZ)) * t.nx + Math.round(p.x - t.originX)] };
});
check('10 terrain preset: roads re-baked on the hills, symmetric crown', Math.abs(hill.left - hill.right) < 0.06 && (hill.g === 3 || hill.g === 4), hill);
await view(0, 0, 120, 0.9);
await shot('10-hills');

// ── 11. Blocks: closed loop → zone → fill (buildings face the road, not on roads) ──
await ev(() => window.__ds.actions.newProject());
await wait(300);
await page.click('[data-testid="tab-roads"]');
await view(0, 0, 215);
await mode('draw');
for (const [x, z] of [[-70, -50], [70, -50], [70, 50], [-70, 50], [-70, -50]]) await clickWorld(x, z);
await page.keyboard.press('Enter');
await wait(400);
await clickWorld(0, -50.5);
await clickWorld(0, 50.5);
await page.keyboard.press('Enter');
await wait(400);
r = await roads();
await mode('zone');
await clickWorld(-35, 0);
await wait(200);
const block = await ev(() => window.__ds.roads.getState().block);
await ev((b) => window.__ds.roadActions.assignZone(b, 'residential'), block);
await wait(200);
await ev(() => window.__ds.roadActions.fillBlocks([window.__ds.roads.getState().block], 3, 1));
await wait(800);
const fill = await ev(() => {
  const d = window.__ds.world.getState().doc;
  const L = window.__ds.roadLib;
  const objs = Object.values(d.objects).filter((o) => o.type === 'building');
  return { buildings: objs.length, linked: objs.filter((o) => o.roadLink).length, onRoad: objs.filter((o) => L.footprintOnRoad(d.roads, { x: o.transform.position[0], z: o.transform.position[2], hx: Number(o.params.width) / 2, hz: Number(o.params.depth) / 2, yaw: o.transform.rotation[1] })).length };
});
check('11 enclosed blocks detected, zoned and filled (facing roads, none on roads)', r.blocks === 2 && fill.buildings > 3 && fill.onRoad === 0 && fill.linked === fill.buildings, { ...r, ...fill });
await view(-35, 0, 110, 0.8);
await shot('11-block-fill');

// ── 12. Street furniture: lights, signals, signs ───────────────────────────────────
await ev(() => { const a = window.__ds.roadActions; a.addInfrastructure([], 'streetLight', 'both', 25, 1); a.addInfrastructure([], 'signal', 'both', 0, 1); a.addInfrastructure([], 'sign', 'both', 0, 1); });
await wait(600);
const infra = await ev(() => {
  const o = Object.values(window.__ds.world.getState().doc.objects);
  return { lights: o.filter((x) => x.type === 'streetLight').length, signs: o.filter((x) => x.type === 'sign').length };
});
check('12 street furniture along roads and at junctions', infra.lights > 10 && infra.signs >= 6, infra);
await view(0, -50, 50, 0.9);
await shot('12-infra');

// ── 13. Vehicles in lanes ──────────────────────────────────────────────────────────
await ev(() => window.__ds.roadActions.addVehiclesAlong([], 'lanes', 16, 2));
await wait(500);
const cars = await ev(() => Object.values(window.__ds.world.getState().doc.objects).filter((o) => o.type === 'car' && o.roadLink).length);
check('13 vehicles placed in lanes, linked to roads', cars > 5, { cars });

// ── 14. Neighbourhood preset by clicking in the viewport ───────────────────────────
await ev(() => window.__ds.actions.newProject());
await wait(300);
await page.click('[data-testid="tab-roads"]');
await view(0, 0, 215);
await page.click('[data-hood="residentialStreet"]');
await wait(200);
await clickWorld(0, 0);
await wait(1200);
const hood = await ev(() => ({ seg: Object.keys(window.__ds.world.getState().doc.roads.segments).length, objs: Object.keys(window.__ds.world.getState().doc.objects).length, past: window.__ds.world.getState().past.length }));
check('14 neighbourhood preset placed with one click (one undo step)', hood.seg >= 1 && hood.objs > 10 && hood.past === 1, hood);
await view(0, 0, 90, 0.8);
await shot('14-neighbourhood');

// ── 15. Linked objects follow a moved road ─────────────────────────────────────────
const lamp15 = await ev(() => Object.values(window.__ds.world.getState().doc.objects).find((o) => o.type === 'streetLight'));
await ev(() => {
  const n = window.__ds.world.getState().doc.roads;
  const node = Object.values(n.nodes).sort((a, b) => a.x - b.x)[0];
  window.__ds.roadActions.moveRoadNode(node.id, node.x, node.z + 12);
});
await wait(500);
const lamp15b = await ev((id) => window.__ds.world.getState().doc.objects[id], lamp15.id);
check('15 linked objects follow the edited road (policy follow)', lamp15b && Math.abs(lamp15b.transform.position[2] - lamp15.transform.position[2]) > 0.5, { before: lamp15.transform.position, after: lamp15b?.transform.position });

// ── 16. Legacy road objects → network (safe conversion, one undo step) ─────────────
await ev(() => window.__ds.actions.loadSampleTown());
await wait(500);
await page.click('[data-testid="tab-roads"]');
await wait(300);
const legacy = await ev(() => Object.values(window.__ds.world.getState().doc.objects).filter((o) => o.type === 'road').length);
await shot('16-legacy-before');
await clickTestId('road-convert-legacy');
await wait(600);
const conv = await ev(() => ({ legacy: Object.values(window.__ds.world.getState().doc.objects).filter((o) => o.type === 'road').length, segments: Object.keys(window.__ds.world.getState().doc.roads.segments).length, junctions: [...window.__ds.roadLib.intersectionsOf(window.__ds.world.getState().doc.roads).values()].filter((i) => i.junction).length }));
check('16 legacy road objects converted safely (side street → T-junction)', legacy > 0 && conv.legacy === 0 && conv.segments >= legacy && conv.junctions === 1, { legacyBefore: legacy, ...conv });
await view(0, 0, 130, 0.6);
await shot('16-legacy-converted');

// ── 17. Copy / paste roads (road mode Ctrl+C, paste with connection policy) ────────
await mode('edit');
const segs17 = await ev(() => Object.keys(window.__ds.world.getState().doc.roads.segments));
await ev((ids) => window.__ds.roads.getState().select({ segments: ids.slice(0, 1), node: null }), segs17);
await page.keyboard.down('Control'); await page.keyboard.press('c'); await page.keyboard.up('Control');
await wait(200);
const clip = await ev(() => !!window.__ds.build.getState().clipboard?.roads);
await ev(() => window.__ds.build.getState().setRoadPaste('isolate'));
await ev(() => window.__ds.buildActions.pasteAt(0, 80));
await wait(500);
const after17 = await ev(() => Object.keys(window.__ds.world.getState().doc.roads.segments));
check('17 copy roads (Ctrl+C) and paste with new ids', clip && after17.length === segs17.length + 1 && after17.filter((id) => !segs17.includes(id)).length === 1, { clip, before: segs17.length, after: after17.length });

// ── 18. Save / load round trip ─────────────────────────────────────────────────────
const rt = await ev(() => {
  const L = window.__ds.buildLib;
  const d = window.__ds.world.getState().doc;
  const json = L.serializeDocument(d);
  const res = L.parseDocument(json);
  if (!res.ok) return { ok: false };
  const same = JSON.stringify(res.doc.roads) === JSON.stringify(d.roads) && res.doc.terrain.heights.every((v, i) => v === d.terrain.heights[i]) && L.serializeDocument(res.doc) === json;
  window.__ds.world.getState().replaceDocument(res.doc);
  return { ok: true, same, schema: JSON.parse(json).schemaVersion, kb: Math.round(json.length / 1024), report: res.roads };
});
check('18 save / load round trip identical (schema v6)', rt.ok && rt.same && rt.schema === 6, rt);

// ── 19. Flood: inundated roads, drains, overlay, live inspector ────────────────────
const roadsBefore = await ev(() => JSON.stringify(window.__ds.world.getState().doc.roads));
await ev(async () => {
  // A strong water source on a road (burst main / overflowing channel) + heavy rain.
  const n = window.__ds.world.getState().doc.roads;
  const s = Object.values(n.segments)[0];
  const line = window.__ds.roadLib.segmentLine(n, s);
  const p = line.samples[Math.floor(line.samples.length / 2)];
  await window.__ds.actions.runSimulation([{ event: 'rain', intensity: 150, duration: 600 }, { event: 'waterSource', position: [p.x, p.z], rate: 4, duration: 600 }]);
  window.__ds.sim.pause();
});
await page.waitForFunction(() => window.__ds.sim.isLoaded());
await ev(() => window.__ds.sim.play());
await page.waitForFunction(() => window.__ds.sim.getTime() >= 40, { timeout: 240_000 });
await ev(() => window.__ds.sim.pause());
await wait(800);
const flood = await ev(() => {
  const rt = window.__ds.sim.getRuntime();
  return { summary: rt.roads?.summary(), inlets: rt.roads?.inlets.length, section: !!document.querySelector('[data-testid="road-sim"]') };
});
check('19 flood: roads inundated, inlets active, live road section', flood.summary && flood.summary.inundated > 0 && flood.inlets > 0 && flood.section, flood);
await view(0, 30, 120, 0.8);
await shot('19-flood');

// ── 20. Earthquake: road cracking; original world untouched after leaving ─────────
await ev(() => window.__ds.actions.exitSimulation());
await wait(400);
await ev(async () => { await window.__ds.actions.runSimulation([{ event: 'earthquake', magnitude: 7.5, pga: 1.0, duration: 15, seed: 3 }]); window.__ds.sim.pause(); });
await page.waitForFunction(() => window.__ds.sim.isLoaded());
await ev(() => window.__ds.sim.play());
await page.waitForFunction(() => window.__ds.sim.getTime() >= 16, { timeout: 240_000 });
await ev(() => window.__ds.sim.pause());
await wait(800);
const quake = await ev(() => window.__ds.sim.getRuntime().roads?.summary());
await view(0, 0, 110, 0.7);
await shot('20-quake');
await ev(() => window.__ds.actions.exitSimulation());
await wait(400);
const roadsAfter = await ev(() => JSON.stringify(window.__ds.world.getState().doc.roads));
check('20 earthquake cracks roads; the original road network is unchanged', quake && quake.cracked > 0 && roadsAfter === roadsBefore, quake);

// ── Draw calls / FPS with the converted town + neighbourhood ───────────────────────
const perf = await ev(async () => {
  const b = window.__ds.roadBatches();
  const gl = window.__r3f.get().gl;
  let frames = 0;
  const t0 = performance.now();
  await new Promise((res) => { const f = () => { frames++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
  return { roadDrawCalls: b?.drawCalls, roadTriangles: b?.triangles, chunks: b?.chunkCount, fps: +(frames / ((performance.now() - t0) / 1000)).toFixed(1), totalCalls: gl.info.render.calls };
});
console.log('perf', JSON.stringify(perf));

// Panel + inspector screenshots in this language.
await page.click('[data-testid="tab-roads"]');
await mode('edit');
await ev(() => { const n = window.__ds.world.getState().doc.roads; window.__ds.roads.getState().select({ segments: [Object.keys(n.segments)[0]], node: null }); });
await wait(400);
await view(0, 0, 130, 0.5);
await shot('21-panel-inspector');

console.log(JSON.stringify({ errors }, null, 1));
fs.writeFileSync(path.join(out, `results-${lang}.json`), JSON.stringify({ results, perf, errors }, null, 2));
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
await browser.close();
