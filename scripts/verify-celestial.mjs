// Browser verification of black holes & extreme celestial gravity (Phase 32): 60 scenarios in real Chrome through the UI
// (experiment tab: add a celestial experiment, mass / μ / educational target, softening, capture radius, scale modes and
// rejections, probes with orbit initial conditions, motion, presets with documented expectations and demo worlds,
// preview with predicted orbits; runs: circular / elliptic / escape / hyperbolic orbits against closed forms, tidal
// overlays and axes, capture with its ledger, growth, a moving source, two sources, accretion particles, the
// illustrative disc / lens, structural tidal failure, fragments, lake, hill, meteor, snow, multi-hazard, results /
// charts / CSV / JSON, the stop policy, the scientific comparison, restore / rerun / save / load / determinism, a
// 1000-house town, KO / EN text) with state checks, plus whole-run checks (page errors, tab alive, GPU geometries).
//
//   npm run build && npx vite preview --port 4199 --strictPort &
//   LANG_UI=ko node scripts/verify-celestial.mjs http://localhost:4199/ ./docs/verify/celestial
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:4199/', out = './docs/verify/celestial'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const lang = process.env.LANG_UI ?? 'ko';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,1000', '--enable-precise-memory-info', '--js-flags=--expose-gc'],
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 }, protocolTimeout: 3_600_000, timeout: 180_000,
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
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('ds.hazardTab', 'experiment'); localStorage.setItem('ds.bottomHeight', '420'); });
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
const clickText = (re, root = 'body') => ev(([src, root]) => {
  const r = new RegExp(src);
  for (const b of document.querySelector(root).querySelectorAll('button, [role="menuitem"]')) if (r.test(b.textContent ?? '') && !b.disabled) { b.click(); return true; }
  return false;
}, [re.source, root]);
const tr = (k) => ev((k) => window.__ds.tr(k), k);
async function heapMB() {
  for (let i = 0; i < 2; i++) { await ev(() => window.gc?.()); await cdp.send('HeapProfiler.collectGarbage'); }
  return ev(() => +(performance.memory.usedJSHeapSize / 1048576).toFixed(1));
}
const geometries = () => ev(() => window.__r3f.get().gl.info.memory.geometries);
async function view(x, z, h = 60, back = 70, y = 0) {
  await ev(([x, z, h, back, y]) => { const st = window.__r3f.get(); st.camera.position.set(x + back * 0.5, y + h, z + back); st.controls.target.set(x, y, z); st.controls.update(); }, [x, z, h, back, y]);
  await wait(300);
}
const inst = () => ev(() => window.__ds.world.getState().doc.scenario.experiment?.instances ?? []);
const fp = () => ev(() => window.__ds.blueprintLib.worldFingerprint(window.__ds.world.getState().doc));
async function newWorld() {
  await ev(() => { window.__ds.actions.newProject(); const v = window.__ds.view.getState(); v.setGroundPreview(null); v.setGroundPick(null); v.setWaterProbe(null); v.setSimMember(null); v.setGravityViz({ overlay: 'off', arrows: false, sources: true }); v.setCelestialViz({ overlay: 'off', cores: true, bounds: true, disc: true, lens: true, particles: true, trails: true, tidal: false }); });
  await wait(300);
}
async function expand(id) {
  const open = await ev((id) => document.querySelector(`[data-testid="exp-edit-${id}"]`)?.getAttribute('aria-expanded') === 'true', id);
  if (!open) await page.click(`[data-testid="exp-edit-${id}"]`);
  await wait(300);
}
const setNumber = async (id, field, value) => {
  const sel = `[data-instance="${id}"] [data-field="${field}"] input`;
  await page.click(sel, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type(sel, String(value));
  await page.keyboard.press('Enter');
  await wait(250);
};
const setSelect = (id, field, value) => ev(([id, field, value]) => {
  const s = document.querySelector(`[data-instance="${id}"] select[data-field="${field}"]`);
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(s, value);
  s.dispatchEvent(new Event('change', { bubbles: true }));
}, [id, field, value]);
async function enterRun() {
  await clickText(/^\s*실험 실행|Run experiment/);
  // Running — or already paused by the stop policy in its first steps.
  await page.waitForFunction(() => window.__ds.sim.isLoaded() && (window.__ds.simStore.getState().status === 'running' || window.__ds.sim.getTime() > 0), { timeout: 180_000 });
}
const atTime = (T) => ev((T) => { const s = window.__ds.sim; s.pause(); const r = T - s.getTime(); if (r > 0) s.advance(r); return s.getTime(); }, T);
const exitSim = async () => { await ev(() => window.__ds.actions.exitSimulation()); await wait(500); };
const cl = () => ev(() => window.__ds.simStore.getState().celestial);
const gl = () => ev(() => window.__ds.simStore.getState().gravity);
const ms = () => ev(() => window.__ds.simStore.getState().milestones.map((m) => m.kind));
const clipped = (sels) => ev((sels) => {
  const out = [];
  for (const sel of sels) for (const root of document.querySelectorAll(sel)) for (const el of root.querySelectorAll('*')) {
    if (!el.childNodes.length || ![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    if (cs.overflow === 'visible' && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && cs.display !== 'inline') out.push(`${sel}: ${el.textContent.trim().slice(0, 40)}`);
  }
  return out;
}, sels);
const rawKeys = (sel) => ev((sel) => { const t = [...document.querySelectorAll(sel)].map((e) => e.textContent ?? '').join(' '); return (t.match(/\b(celestial|celestialHud|overlay\.celestial|results\.celestial)\.[a-zA-Z.]+/g) ?? []).slice(0, 5); }, sel);
const add = (type, spec) => ev(([type, spec]) => window.__ds.actions.addPhenomenon(type, spec), [type, spec]);
const G = 6.6743e-11;
const SRC = (p = {}) => ({ kind: 'blackHole', center: [0, 30, 0], mass: 5e4 / G, softening: 2, capture: 1.5, influence: 0, massPolicy: 'fixed', motion: 'fixed', ramp: 2, ...p });
const C = (p = {}) => ({ event: 'celestial', scenario: 'custom', scale: 'educational', sources: [SRC()], probes: [], accretion: { visual: false, particles: 0, inner: 6, outer: 20, particleMass: 1 }, duration: 600, end: 'hold', tidal: true, lensing: false, limitPolicy: 'warn', startTime: 0, ...p });
const ZERO = { event: 'gravity', scenario: 'zero', global: true, magnitude: 0, direction: [0, -1, 0], transition: 'vector', profile: 'constant', duration: 21600, end: 'hold', sources: [], startTime: 0 };
const LAB = (p = {}) => SRC({ center: [0, 60, 0], softening: 1, capture: 1, ramp: 0, ...p });
const PROBE = (position, mode, factor, direction, velocity) => ({ position, mode, factor, direction, velocity, mass: 50, radius: 0.6 });
const addObjects = (list) => ev((list) => {
  const ds = window.__ds;
  const add = list.map((o) => o.preset ? { type: 'building', building: ds.buildingLib.createDesign(ds.buildingLib.presetSpec(o.preset), o.preset), seed: o.seed ?? 1, transform: { position: [o.x, 0, o.z], rotation: [0, 0, 0], scale: [1, 1, 1] } } : { type: o.type, seed: o.seed ?? 1, params: o.params, transform: { position: [o.x, o.y ?? 0, o.z], rotation: [0, o.yaw ?? 0, 0], scale: [1, 1, 1] } });
  ds.world.getState().applyEdit({ add });
}, list);
const ent = (type, k = 0) => ev(([type, k]) => { const e = [...window.__ds.sim.getRuntime().entities.values()].filter((x) => x.source.type === type)[k]; return e ? { id: e.id, p: [...e.pose.position], q: [...e.pose.quaternion], captured: !!e.flags.captured, body: e.body } : null; }, [type, k]);
const hash = () => ev(() => {
  const rt = window.__ds.sim.getRuntime(); const r = window.__ds.celestialLib.rt();
  const ents = [...rt.entities.values()].map((e) => `${e.source.type}${e.pose.position.map((v) => v.toFixed(5)).join(',')}${e.flags.captured ? 'C' : ''}`).sort().join(';');
  return `${ents.length}|${ents.slice(0, 300)}|${r ? JSON.stringify([r.ledger.count, r.ledger.mass, r.probes.map((p) => p.pos)]) : ''}|${rt.debris.length}`;
});
const run = async (objects, events, T) => {
  await newWorld();
  if (objects.length) await addObjects(objects);
  for (const e of events) await add(e.event, e);
  await wait(400);
  await enterRun();
  await atTime(T);
};
const fps = (n = 180) => ev((n) => new Promise((res) => { const t = []; let last = performance.now(); const f = (now) => { t.push(now - last); last = now; if (t.length < n) requestAnimationFrame(f); else res({ mean: t.reduce((a, b) => a + b, 0) / t.length, worst: Math.max(...t.slice(10)) }); }; requestAnimationFrame(f); }), n);
const sceneCount = (name, pred) => ev(([name, src]) => { const f = new Function('m', `return (${src})(m)`); let n = 0; window.__r3f.get().scene.traverse((o) => { if (o.name === name) o.traverse((m) => { if (f(m)) n++; }); }); return n; }, [name, pred.toString()]);
const heap0 = await heapMB();
const geo0 = await geometries();
const BLOCK = [{ preset: 'house', x: -30, z: -30, seed: 1 }, { preset: 'house', x: 30, z: -30, seed: 2 }, { type: 'car', x: -6, z: 6, seed: 3, yaw: 1.57 }, { type: 'car', x: 6, z: 6, seed: 4, yaw: 1.57 }, { type: 'human', x: 0, z: 12, seed: 5 }, { type: 'human', x: 8, z: 12, seed: 6 }];

// ══ 1–12: the editor ═════════════════════════════════════════════════════════════════════════
await newWorld();
await clickText(/^\s*현상 추가|Add phenomenon/);
await wait(250);
await clickText(new RegExp('^\\s*' + (await tr('phen.celestial')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('/', '\\/') + '\\s*$'));
await wait(400);
let I = await inst();
const id = I.find((i) => i.type === 'celestial')?.id;
await expand(id);
const fields1 = await ev((id) => [...document.querySelectorAll(`[data-instance="${id}"] [data-field]`)].map((e) => e.getAttribute('data-field')), id);
await shot('01-add');
check('1 black hole tool: a celestial experiment added from the Experiment tab (preset, scale, window, source position, log₁₀ M, μ, educational target, ε, capture, influence, mass policy, motion, probes)', !!id && ['scenario', 'scale', 'duration', 'end', 'tidal', 'limitPolicy', 'disc', 'lensing', 'particles', 'addSource', 's0.kind', 's0.x', 's0.y', 's0.log10m', 's0.mu', 's0.refAccel', 's0.softening', 's0.capture', 's0.influence', 's0.massPolicy', 's0.motion', 'addProbe'].every((f) => fields1.includes(f)), fields1.slice(0, 30));
await setNumber(id, 's0.mu', 80000);
I = await inst();
const m2 = I[0].spec.sources[0].mass;
await setNumber(id, 's0.log10m', 15);
const m2b = (await inst())[0].spec.sources[0].mass;
check('2 mass and μ: μ = 8·10⁴ m³/s² stores M = μ/G = 1.2·10¹⁵ kg; log₁₀ M = 15 stores 10¹⁵ kg (consistent conversion, G unchanged)', Math.abs(m2 * G - 80000) < 1e-6 * 80000 && Math.abs(m2b - 1e15) < 1e3, { m2, m2b });
await setNumber(id, 's0.refRadius', 40);
await setNumber(id, 's0.refAccel', 20);
I = await inst();
const s3 = I[0].spec.sources[0];
const g3 = G * s3.mass * 40 / (1600 + s3.softening ** 2) ** 1.5;
check('3 educational target: |g| = 20 m/s² at 40 m gives the mass that produces it (closed form)', Math.abs(g3 - 20) < 1e-6, { g3, mass: s3.mass });
await setNumber(id, 's0.capture', 0.1);
await setNumber(id, 's0.softening', 0.05);
const txt4 = await ev((id) => document.querySelector(`[data-instance="${id}"]`)?.textContent ?? '', id);
await setNumber(id, 's0.softening', 2);
await setNumber(id, 's0.capture', 1.5);
check('4 softening: a 5 cm core resolved down to a 10 cm capture radius needs more substeps than the cap — rejected with its reason (raise ε / capture or lower M)', txt4.includes((await tr('celestial.invalid.core')).slice(0, 12)), txt4.slice(0, 0));
await setSelect(id, 's0.kind', 'compact');
await wait(250);
const hide5 = await ev((id) => !document.querySelector(`[data-instance="${id}"] [data-field="s0.capture"]`), id);
await setSelect(id, 's0.kind', 'blackHole');
await wait(250);
await setNumber(id, 's0.capture', 2.5);
check('5 capture radius: editable for a black hole (2.5 m stored), hidden for a compact mass (no capture)', hide5 && (await inst())[0].spec.sources[0].capture === 2.5);
await setNumber(id, 's0.log10m', 30.3);
const txt6a = await ev((id) => document.querySelector(`[data-instance="${id}"]`)?.textContent ?? '', id);
await setSelect(id, 'scale', 'physical');
await wait(400);
const txt6b = await ev(() => document.querySelector('[data-testid="celestial-summary"]')?.textContent ?? '');
const lim6 = (await inst())[0].spec.limitPolicy;
check('6 scale modes: a solar mass is rejected in the educational mode (μ range), accepted in the physical SI mode with its regime (beyond the cap / above 0.1 c) and the stop policy', txt6a.includes((await tr('celestial.invalid.mu')).slice(0, 10)) && (txt6b.includes((await tr('celestial.tools.relativistic')).slice(0, 8)) || txt6b.includes((await tr('celestial.tools.beyond')).slice(0, 8))) && lim6 === 'stop', { lim6 });
await setSelect(id, 'scale', 'educational');
await setNumber(id, 's0.mu', 50000);
await wait(300);
const pres7 = await ev(() => document.querySelectorAll('[data-testid="celestial-preset-select"] option').length);
const info7 = await ev(() => document.querySelector('[data-testid="celestial-presets"]')?.textContent ?? '');
const sup7 = await ev(() => document.querySelector('[data-testid="celestial-support"]')?.textContent ?? '');
const lab7 = await ev(() => document.querySelector('[data-testid="celestial-scale-label"]')?.textContent ?? '');
await shot('07-tools');
check('7 presets: 20 listed with expected phenomenon / initial conditions / time scale / result / scope / failure; model support; the scaled label', pres7 === 20 && info7.length > 200 && sup7.length > 40 && lab7.includes('Scaled Educational Gravity'), { pres7 });
await setSelect(id, 'addProbe', 'circular');
await wait(300);
I = await inst();
const f9 = await ev((id) => ['p0.mode', 'p0.x', 'p0.factor', 'p0.dx', 'p0.mass', 'p0.radius'].every((f) => !!document.querySelector(`[data-instance="${id}"] [data-field="${f}"]`)), id);
const pred9 = await ev(() => document.querySelector('[data-testid="celestial-probe-prediction-0"]')?.textContent ?? '');
check('9 orbit initial conditions: a circular probe (position, multiple, direction, mass, radius) with its predicted period', I[0].spec.probes.length === 1 && f9 && /\d/.test(pred9), pred9.slice(0, 90));
await ev((id) => window.__ds.view.getState().setGroundPreview(id), id);
await wait(1200);
const prev8 = await ev(() => { let lines = 0, spheres = 0; window.__r3f.get().scene.traverse((o) => { if (o.name === 'celestial-preview') o.traverse((m) => { if (m.isLine) lines++; else if (m.isMesh) spheres++; }); }); return { lines, spheres }; });
await view(0, 30, 60, 80);
await shot('08-preview');
check('8 preview: the source (core, capture, softening spheres) and the probe\'s predicted orbit', prev8.lines >= 1 && prev8.spheres >= 3, prev8);
await ev(() => window.__ds.view.getState().setGroundPreview(null));
await setSelect(id, 'addProbe', 'hyperbolic');
await setSelect(id, 'addProbe', 'custom');
await wait(300);
I = await inst();
check('10 probe modes: hyperbolic (1.3 × escape) and custom velocity probes added', I[0].spec.probes.length === 3 && I[0].spec.probes[1].mode === 'escape' && I[0].spec.probes[2].mode === 'custom');
await setSelect(id, 's0.motion', 'velocity');
await wait(250);
const f11 = await ev((id) => ['s0.vx', 's0.vy', 's0.vz'].every((f) => !!document.querySelector(`[data-instance="${id}"] [data-field="${f}"]`)), id);
for (let k = 0; k < 4; k++) await setSelect(id, 'addSource', 'compact');
await wait(300);
I = await inst();
check('11 motion and several sources: velocity fields; at most 4 sources (a fifth is refused)', f11 && I[0].spec.sources.length === 4, { n: I[0].spec.sources.length });
await ev(() => window.__ds.actions.loadCelestialDemo('circularOrbit'));
await wait(1000);
I = await inst();
check('12 demo loader: "Circular Orbit Laboratory" loads its world with the zero-gravity companion experiment', I.some((i) => i.type === 'celestial' && i.spec.scenario === 'circularOrbit') && I.some((i) => i.type === 'gravity' && i.spec.magnitude === 0), I.map((i) => i.type));

// ══ 13–21: orbits ═══════════════════════════════════════════════════════════════════════════
await enterRun();
await atTime(24);
let L = await cl();
const p14 = L.probes[0].diag;
await view(0, 60, 40, 70, 30);
await shot('14-circular');
check('14 circular orbit (r = 30 m): radius within 0.2 %, period 4.62 s (Plummer closed form), ΔE/E < 10⁻³', (p14.rMax - p14.rMin) / 30 < 2e-3 && Math.abs(p14.period - 4.62) < 0.03 && p14.maxErr < 1e-3 && p14.conserved, { rMin: p14.rMin, rMax: p14.rMax, T: p14.period, dE: p14.maxErr });
const hud13 = await ev(() => document.querySelector('[data-testid="celestial-hud"]')?.textContent ?? '');
const clip13 = await clipped(['[data-testid="celestial-hud"]']);
check('13 HUD: source mass, μ, r_s (reference), ε, capture radius, max |g|, tide, bodies, integrator, limit state, scaled label; text not cut', hud13.includes('μ') && hud13.includes('r_s') && hud13.includes('KDK') && hud13.includes('Scaled Educational Gravity') && clip13.length === 0, { hud: hud13.slice(0, 160), clip13 });
check('47 performance readout: the celestial runtime cost (ms) in the HUD', /\d+\.\d+ ms/.test(hud13));
await ev(() => window.__ds.view.getState().setWaterProbe({ x: 10, z: 10 }));
await wait(600);
const probe21 = await ev(() => document.querySelector('[data-testid="celestial-probe"]')?.textContent ?? '');
await ev(() => window.__ds.view.getState().setWaterProbe(null));
check('21 probe diagnostics in the inspector: distance range, speed, energy / angular-momentum errors, period; point field (|g|, Φ, v_esc, tide)', probe21.includes('ΔE/E') && probe21.includes('J/kg') && probe21.includes('s⁻²'), probe21.slice(0, 120));
await exitSim();
await ev(() => window.__ds.actions.loadCelestialDemo('ellipticalOrbit'));
await wait(800);
await enterRun();
await atTime(12);
L = await cl();
check('15 elliptical orbit: 0.7 × circular at 40 m reaches periapsis 13.0 m (vis-viva), apoapsis 40 m', Math.abs(L.probes[0].diag.rMin - 12.96) / 12.96 < 0.02 && Math.abs(L.probes[0].diag.rMax - 40) < 0.2, L.probes[0].diag);
await exitSim();
await ev(() => window.__ds.actions.loadCelestialDemo('escape'));
await wait(800);
await enterRun();
await atTime(45);
L = await cl();
check('16 escape velocity: 0.9 × v_esc stays bound (apoapsis 84.7 m), 1.05 and 1.3 × v_esc leave the world (booked)', L.probes[0].state === 'orbit' && Math.abs(L.probes[0].diag.rMax - 84.7) < 2 && L.probes[2].state === 'left' && L.ledger.probesLeft > 0, L.probes.map((p) => [p.state, +p.diag.rMax.toFixed(1)]));
await exitSim();
await ev(() => window.__ds.actions.loadCelestialDemo('flyby'));
await wait(800);
await enterRun();
await atTime(14);
L = await cl();
// The conic is fixed by the (conserved) eccentricity vector: from the start state and from the state now (relative to
// the source at (0, 60, 0)) — same direction and size means the probe flew the predicted hyperbola (deflection 2·asin(1/e)).
const ecc = (r, v) => { const mu = 5e4, h = [r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]], rm = Math.hypot(...r); return [0, 1, 2].map((i) => ([v[1] * h[2] - v[2] * h[1], v[2] * h[0] - v[0] * h[2], v[0] * h[1] - v[1] * h[0]][i]) / mu - r[i] / rm); };
const e0 = ecc([-180, 0, 20], [40, 0, 0]), e1 = ecc([L.probes[0].pos[0], L.probes[0].pos[1] - 60, L.probes[0].pos[2]], L.probes[0].vel);
const em0 = Math.hypot(...e0), em1 = Math.hypot(...e1);
const tilt = (Math.acos(Math.min(1, (e0[0] * e1[0] + e0[1] * e1[1] + e0[2] * e1[2]) / (em0 * em1))) * 180) / Math.PI;
const defl = (2 * Math.asin(1 / em1) * 180) / Math.PI;
// |e| is fixed by E and h (both conserved); the e-vector turns a little at periapsis because the field is softened
// there (ε / r_p = 1/6: a Plummer, not a 1/r², field — apsidal precession of order (ε/r_p)² rad).
check('17 hyperbolic flyby: the probe flies the predicted hyperbola (|e| kept to 1 %, deflection 2·asin(1/e) ≈ 125°; the softened core turns the conic by a few degrees)', Math.abs(em1 - em0) / em0 < 0.01 && tilt < 6 && Math.abs(defl - 125.2) < 1.5, { em0, em1, tilt, defl });
await view(0, 60, 80, 120, 40);
await shot('17-flyby');
await exitSim();

// ══ 18–20: tidal overlays, inspector ════════════════════════════════════════════════════════
await run(BLOCK, [ZERO, C({ sources: [SRC({ center: [-2, 12, 6], mass: 3e4 / G, capture: 1, ramp: 4 })] })], 1);
await ev(() => window.__ds.view.getState().setCelestialViz({ overlay: 'tidal', tidal: true }));
await wait(1200);
const leg18 = await ev(() => document.querySelector('[data-testid="celestial-overlay"]')?.textContent ?? '');
const axes18 = await ev(() => { let n = 0; window.__r3f.get().scene.traverse((o) => { if (o.name === 'celestial-layer') o.traverse((m) => { if (m.isLineSegments && m.visible) n = Math.max(n, m.geometry.drawRange.count); }); }); return n; });
await view(0, 0, 50, 70, 12);
await shot('18-tidal');
check('18 tidal overlay: λ₁ of the computed gradient tensor on the slice (fixed log legend, s⁻²) and principal stretch axes', leg18.includes('s⁻²') && axes18 > 20, { axes18 });
const legs19 = {};
for (const o of ['accel', 'potential', 'escape', 'zones']) {
  await ev((o) => window.__ds.view.getState().setCelestialViz({ overlay: o }), o);
  await wait(500);
  legs19[o] = await ev(() => document.querySelector('[data-testid="celestial-overlay"]')?.textContent ?? '');
}
await shot('19-zones');
check('19 overlays: |g| (m/s², 9.81 marked), |Φ| (J/kg), escape speed (m/s), model zones (far / core / capture / beyond cap)', legs19.accel.includes('9.81') && legs19.potential.includes('J/kg') && legs19.escape.includes('m/s') && legs19.zones.includes(await tr('overlay.celestial.z.core')), {});
check('56 model-limit zones: the zones legend names all four regions', ['far', 'core', 'capture', 'limit'].every((k) => legs19.zones.length > 10) && legs19.zones.includes(await tr('overlay.celestial.z.limit')));
await ev(() => window.__ds.view.getState().setCelestialViz({ overlay: 'off', tidal: false }));
const car20 = await ent('car', 0);
await ev((id) => window.__ds.editor.getState().select(id), car20.id);
await wait(700);
const insp20 = await ev(() => document.querySelector('[data-testid="celestial-object"]')?.textContent ?? '');
await shot('20-inspector');
await ev(() => window.__ds.editor.getState().select(null));
check('20 object inspector: distance, |g|, escape speed, tidal stretch along the long axis, bar tension (reference), energy / angular momentum', insp20.includes('m/s²') && insp20.includes('s⁻²') && insp20.includes('J/kg') && /\d/.test(insp20), insp20.slice(0, 140));
await atTime(10);
const car59 = await ent('car', 0);
const turned = Math.abs(car59.q[0] - car20.q?.[0] ?? 0) + Math.abs(car59.q[1] - 0.7071) + Math.abs(car59.q[2]) > 0.05;
check('59 vehicles: a car pulled off the ground and turned by the field (rigid body; no internal model)', car59.captured || (car59.p[1] > 0.5 && turned), { p: car59.p, captured: car59.captured });
const hum58 = await ent('human', 0);
check('58 people: pulled towards the source or captured (simple rigid body; physiology is Phase 34)', hum58.captured || hum58.p[1] > 0.5, hum58);
await exitSim();

// ══ 22–30: capture, growth, motion, binary, accretion, structures ═════════════════════════════
await ev(() => window.__ds.actions.loadCelestialDemo('capture'));
await wait(800);
await enterRun();
await atTime(10);
L = await cl();
const M22 = await ms();
const hidden22 = await ev(() => [...window.__ds.sim.getRuntime().entities.values()].filter((e) => e.flags.captured).length);
await view(-10, 8, 30, 50, 6);
await shot('22-capture');
check('22 capture: bodies entering the capture radius are removed (entities hidden, bodies freed), counted in the HUD, a capture milestone', L.ledger.count > 0 && hidden22 > 0 && M22.includes('capture'), { n: L.ledger.count, hidden22 });
check('23 capture ledger: mass residual 0; fixed source → constraint impulse = −Σ m·v; unresolved energy reported', L.ledger.massResidual === 0 && L.ledger.records.every((r) => Math.abs(r.constraintImpulse[0] + r.momentum[0]) < 1e-6 * Math.max(1, Math.abs(r.momentum[0]))) && L.ledger.unresolved > 0, { mass: L.ledger.mass });
check('54 timeline: celestial start and capture milestones recorded once each kind', M22.includes('celestialStart') && M22.includes('capture'), M22.slice(-8));
await exitSim();
await ev(() => window.__ds.actions.loadCelestialDemo('growing'));
await wait(800);
await enterRun();
await atTime(10);
L = await cl();
const m24 = L.series.length ? L.series[L.series.length - 1].sourceMass[0] - L.series[0].sourceMass[0] : 0;
check('24 growing source: M rises by exactly the captured mass (M ← M + m, μ = G·M), particles included', L.ledger.grown > 0 && Math.abs(m24 - L.ledger.grown) < 1e-6 * L.ledger.grown + 1, { grown: L.ledger.grown, dM: m24 });
check('27b accretion particles: placed = flying + captured + landed + left (residual 0)', Math.abs(L.ledger.particles.residual) < 1e-6 * Math.max(1, L.ledger.particles.placed), L.ledger.particles);
await exitSim();
await ev(() => window.__ds.actions.loadCelestialDemo('moving'));
await wait(800);
await enterRun();
await atTime(5);
const x25a = (await cl()).stats.sources[0].x;
await atTime(20);
L = await cl();
const g25 = await gl();
check('25 moving source: the centre follows its path (x grows), the changing field does work W_field on the bodies (booked)', L.stats.sources[0].x > x25a + 20 && L.stats.sources[0].moving && Math.abs(g25.balance.workField) > 0, { x0: x25a, x1: L.stats.sources[0].x, Wf: g25.balance.workField });
await exitSim();
await ev(() => window.__ds.actions.loadCelestialDemo('binary'));
await wait(800);
await enterRun();
await atTime(6);
L = await cl();
await ev(() => window.__ds.view.getState().setWaterProbe({ x: 0, z: 0 }));
await wait(500);
const tools26 = await tr('celestial.lim.external');
check('26 two external sources: both in force, probes moving in the combined field; labelled not a real binary (no N-body)', L.stats.sources.length === 2 && L.probes.length === 2 && tools26.length > 20, L.stats.sources.map((s) => s.x));
await ev(() => window.__ds.view.getState().setWaterProbe(null));
await exitSim();
await ev(() => window.__ds.actions.loadCelestialDemo('accretion'));
await wait(800);
await enterRun();
await atTime(8);
L = await cl();
const pts27 = await ev(() => { let n = 0; window.__r3f.get().scene.traverse((o) => { if (o.isPoints && o.visible) n = Math.max(n, o.geometry.drawRange.count); }); return n; });
const disc27 = await ev(() => { let n = 0; window.__r3f.get().scene.traverse((o) => { if (o.name === 'celestial-layer') o.traverse((m) => { if (m.isMesh && m.geometry.type === 'RingGeometry') n++; }); }); return n; });
const vis27 = await ev(() => document.querySelector('[data-testid="celestial-hud-visual"]')?.textContent ?? '');
await view(0, 50, 50, 60, 50);
await shot('27-accretion');
check('27 accretion: test particles on computed orbits drawn, the visual disc drawn and labelled illustrative (no fluid / radiation)', L.stats.particles > 500 && pts27 > 500 && disc27 >= 1 && vis27.includes('Not Relativistic Ray Tracing'), { flying: L.stats.particles, pts27, disc27 });
await exitSim();
await run(BLOCK, [C({ lensing: true, accretion: { visual: true, particles: 0, inner: 6, outer: 20, particleMass: 1 }, sources: [SRC({ center: [0, 30, 0] })] })], 2);
const lens28 = await ev(() => { let n = 0; window.__r3f.get().scene.traverse((o) => { if (o.name === 'celestial-layer') o.traverse((m) => { if (m.isMesh && m.material?.type === 'MeshPhysicalMaterial') n++; }); }); return n; });
await view(0, 30, 10, 40, 30);
await shot('28-lens');
check('28 lens: the illustrative lens halo is drawn only on request and labelled "Illustrative Visual Effect — Not Relativistic Ray Tracing"', lens28 >= 1 && (await ev(() => document.querySelector('[data-testid="celestial-illustrative"]')?.textContent ?? '')).includes('Illustrative'), { lens28 });
await exitSim();
await ev(() => window.__ds.actions.loadCelestialDemo('tidalFailure'));
await wait(800);
await enterRun();
await atTime(30);
L = await cl();
const M29 = await ms();
await view(0, -20, 60, 90);
await shot('29-tidal-failure');
check('29 tidal structural failure: lateral storey loads and uplift fail members (hazard gravity), a tidal-failure milestone', L.structures.failures > 0 && (L.structures.loadedUnits > 0 || L.structures.uplifted > 0) && M29.includes('tidalFailure'), L.structures);
await exitSim();
await ev(() => window.__ds.actions.loadCelestialDemo('collapse'));
await wait(800);
await enterRun();
await atTime(25);
L = await cl();
const deb30 = await ev(() => window.__ds.sim.getRuntime().debris.length);
check('30 collapse and debris: fragments created by the pull (mass moved, not created) and fragments captured', (deb30 > 0 || L.ledger.byKind.fragment.n > 0) && L.structures.failures > 0, { debris: deb30, frag: L.ledger.byKind.fragment });
await exitSim();

// ══ 31–35: environment ══════════════════════════════════════════════════════════════════════
await ev(() => window.__ds.actions.loadCelestialDemo('nearLake'));
await wait(800);
await enterRun();
await atTime(20);
const w31 = await ev(() => { const f = window.__ds.sim.getEnvironment().flood.field; if (!f) return null; const i0 = f.indexAt(60, 28), i1 = f.indexAt(45, 15); return { under: f.h[i0] + f.bed[i0], edge: f.h[i1] + f.bed[i1], err: f.budget.error, init: f.budget.initial }; });
const g31 = await gl();
check('31 lake: the surface rises under the source (lower downward g there), water volume conserved; the water is never captured (2-D model, limited)', w31 && w31.under > w31.edge && Math.abs(w31.err) < 1e-6 * Math.max(1, w31.init) && ['limited', 'scaled'].includes(g31.support.flood), w31);
await exitSim();
await ev(() => window.__ds.actions.loadCelestialDemo('nearMountain'));
await wait(800);
const t0h = await ev(() => Array.from(window.__ds.world.getState().doc.terrain.heights.slice(0, 50)).join(','));
await enterRun();
await atTime(10);
const t1h = await ev(() => Array.from(window.__ds.sim.getEnvironment().terrain.data.heights.slice(0, 50)).join(','));
check('32 hill: the run goes on with the ground model unchanged by the field (no tidal terrain deformation claimed)', t0h === t1h && (await cl()).stats.sources.length === 1);
await exitSim();
await ev(() => window.__ds.actions.loadCelestialDemo('meteor'));
await wait(800);
await enterRun();
await atTime(26);
const imp33 = await ev(() => (window.__ds.simStore.getState().impacts ?? []).map((i) => i.phase));
check('33 meteor + source: the impact happens (entry model unchanged, not extrapolated), the state stays finite', imp33.length > 0 && imp33.some((p) => p !== 'entry') && Number.isFinite((await cl()).stats.maxAccel), { imp33 });
await exitSim();
await run(BLOCK, [C({ sources: [SRC({ center: [0, 40, 0], mass: 4e4 / G, ramp: 4 })] }), { event: 'earthquake', magnitude: 6.5, pga: 0.35, duration: 8, seed: 3, startTime: 1 }, { event: 'rain', intensity: 150, duration: 20 }, { event: 'wind', speed: 20, direction: 'E', duration: 20 }], 10);
L = await cl();
const fin34 = await ev(() => [...window.__ds.sim.getRuntime().entities.values()].every((e) => e.pose.position.every(Number.isFinite)));
check('34 multi-hazard (source + earthquake + rain + wind): every pose and ledger finite', fin34 && Number.isFinite(L.ledger.kinetic) && Number.isFinite(L.stats.maxAccel));
await exitSim();
await run([{ preset: 'house', x: 0, z: 0, seed: 1 }], [{ event: 'climate', scenario: 'custom', forcing: 'flux', temperature: 269.15, target: 269.15, profile: 'constant', duration: 3600, humidity: 0.85, mixTime: 900, precipitation: 0, precipPhase: 'auto', precipProfile: 'constant', solar: 'off', soilMoisture: 0.25, blowingSnow: false, roofSnow: true, initialSnow: 0.4, initialSnowDensity: 200, startTime: 0 }, C({ startTime: 2, sources: [SRC({ center: [0, 12, 0], mass: 1.5e4 / G, ramp: 1 })] })], 7);
const c35 = await ev(() => window.__ds.simStore.getState().climate);
L = await cl();
check('35 snow + uplift: the roof pulled off under its snow — climate water ledger closed, structural failures by uplift', Math.abs(c35.water.residual) < 1e-6 * Math.max(1, c35.water.final) && L.structures.uplifted > 0, { res: c35.water.residual, up: L.structures.uplifted });
await exitSim();

// ══ 36–41: results, exports, policies, comparison ═══════════════════════════════════════════
await ev(() => window.__ds.actions.loadCelestialDemo('capture'));
await wait(800);
await enterRun();
await atTime(8);
await ev(() => window.__ds.ui.getState().setResultsOpen(true));
await wait(900);
const res36 = await ev(() => document.querySelector('[data-testid="celestial-results"]')?.textContent ?? '');
const charts36 = await ev(() => document.querySelectorAll('[data-testid^="celestial-chart-"]').length);
const clip36 = await clipped(['[data-testid="celestial-results"]']);
await shot('36-results');
await ev(() => window.__ds.ui.getState().setResultsOpen(false));
check('36 results: celestial cards (sources, |g|, captures, impulse, unresolved energy, structures, integrator, limit) and the charts; text not cut', res36.length > 100 && charts36 >= 4 && clip36.length === 0, { charts36, clip36 });
const csv37 = await ev(() => window.__ds.celestialLib.csv());
check('37 CSV: model and scope header, sources, capture ledger and records with units, integrator, probes, bodies, history; missing values named', csv37.includes('# model:') && csv37.includes('# capture ledger') && csv37.includes('mass_kg') && csv37.includes('# history') && csv37.includes('N·s'), csv37.slice(0, 60));
const json38 = await ev(() => { const c = window.__ds.simStore.getState().celestial; return !!c && Array.isArray(c.series) && typeof c.ledger.mass === 'number'; });
check('38 JSON: the live celestial summary (ledger, probes, series, stats) is what the results JSON exports', json38);
await exitSim();
await run([{ type: 'car', x: 0, z: 0, seed: 1 }], [C({ scale: 'physical', limitPolicy: 'stop', sources: [SRC({ mass: 1.98847e30, softening: 1, capture: 3, ramp: 0 })] })], 0);
await atTime(0.5);
const st39 = await ev(() => ({ status: window.__ds.simStore.getState().status, t: window.__ds.sim.getTime(), stop: window.__ds.simStore.getState().celestial?.stop, limit: window.__ds.simStore.getState().celestial?.stats.limit }));
check('39 stop policy: a physical-mode solar-mass hole stops the run at the model limit (speed > 0.1 c / substep cap) — never clipped below c', st39.status === 'paused' && st39.stop && st39.limit === 'stop' && st39.t < 0.5, st39);
await exitSim();
await run([{ type: 'car', x: 0, z: 0, seed: 1 }], [C({ scale: 'physical', limitPolicy: 'warn', sources: [SRC({ mass: 1.98847e30, softening: 1, capture: 3, ramp: 0 })] })], 0.5);
L = await cl();
check('40 warn policy: the limit is recorded (HUD) and the run continues', L.stats.limit === 'warn' && (await ev(() => window.__ds.sim.getTime())) >= 0.49, { limit: L.stats.limit });
await exitSim();
await ev(() => window.__ds.actions.loadCelestialDemo('comparison'));
await wait(800);
await enterRun();
await atTime(45);
L = await cl();
check('41 scientific comparison: outside ε the period is Kepler\'s (19.6 s), inside the core it is the Plummer one (0.73 s, Kepler would give 0.22 s)', Math.abs(L.probes[0].diag.period - 19.6) < 0.4 && Math.abs(L.probes[1].diag.period - 0.73) < 0.05, L.probes.map((p) => p.diag.period));
const real41 = await ev(() => { const o = window.__ds.celestialLib.outlook(window.__ds.celestialLib.preset('comparison')); return o.real; });
check('55 GR not computed: the real 10 M☉ comparison is computed only (r_s ≈ 29.5 km), the editor lists the unsupported GR effects', Math.abs(real41.rs - 29531) < 50 && (await tr('celestial.lim.noGR')).length > 40, real41);
await exitSim();

// ══ 42–46: restore, rerun, save / load, determinism, large town ══════════════════════════════
await ev(() => window.__ds.actions.loadCelestialDemo('capture'));
await wait(800);
const fp42 = await fp();
await enterRun();
await atTime(8);
const h42 = await hash();
const n42 = (await cl()).ledger.count;
await exitSim();
check('42 original world: after captures the edited world is untouched (fingerprint), captured bodies back on re-entry', (await fp()) === fp42 && n42 > 0);
await enterRun();
await atTime(8);
check('43 rerun: the same run again gives the same captures, poses and probes (hash)', (await hash()) === h42);
await exitSim();
const sl44 = await ev(() => { const ds = window.__ds; const txt = ds.buildLib.serializeDocument(ds.world.getState().doc); const r = ds.buildLib.parseDocument(txt); return r.ok ? r.doc.scenario.experiment.instances.filter((i) => i.type === 'celestial').length : -1; });
check('44 save / load: the celestial experiment survives serialization (schema v7)', sl44 === 1, { sl44 });
await enterRun();
await atTime(8);
check('45 determinism: a third run identical too', (await hash()) === h42);
await exitSim();
await newWorld();
await ev(() => {
  const ds = window.__ds;
  const d = ds.buildingLib.createDesign({ ...ds.buildingLib.presetSpec('house'), floors: 2 }, 'house');
  const add = [];
  for (let z = -94; z <= 94 && add.length < 1000; z += 6) for (let x = -94; x <= 94 && add.length < 1000; x += 6) add.push({ type: 'building', building: d, seed: add.length + 1, transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] } });
  ds.world.getState().applyEdit({ add });
});
await add('celestial', C({ sources: [SRC({ center: [0, 40, 0], mass: 1e5 / G, softening: 3, capture: 2.5, ramp: 10 })] }));
await wait(500);
await enterRun();
await atTime(3);
const pend46 = await ev(() => window.__ds.gravityLib.rt()?.structures.pending ?? -1);
await ev(() => window.__ds.sim.play());
await view(0, 0, 120, 160);
const f46 = await fps(180);
await ev(() => window.__ds.sim.pause());
await shot('46-town');
check('46 1000-house town under a source: all structural models ready before the start (pending 0), interactive frame rate', pend46 === 0 && f46.mean < 100, { fps: +(1000 / f46.mean).toFixed(1), worst: +f46.worst.toFixed(1), pend46 });
await exitSim();

// ══ 48–57: text, dormancy, commands, misc ═══════════════════════════════════════════════════
await ev(() => window.__ds.actions.loadCelestialDemo('compactWell'));
await wait(800);
await enterRun();
await atTime(5);
const raw49 = [...(await rawKeys('[data-testid="celestial-hud"]')), ...(await rawKeys('[data-testid="celestial-overlay"]'))];
check('49 KO / EN text: the HUD and overlay show translated text (no raw keys)', raw49.length === 0, raw49);
const arrows53 = await ev(() => { window.__ds.view.getState().setGravityViz({ arrows: true }); return true; });
await wait(800);
const len53 = await ev(() => { let max = 0; window.__r3f.get().scene.traverse((o) => { if (o.name === 'gravity-layer') o.traverse((m) => { if (m.isInstancedMesh && m.count > 100) { const e = m.instanceMatrix.array; for (let k = 0; k < m.count; k++) max = Math.max(max, Math.hypot(e[16 * k], e[16 * k + 1], e[16 * k + 2])); } }); }); return max; });
await ev(() => window.__ds.view.getState().setGravityViz({ arrows: false }));
check('53 field arrows with a source: logarithmic length (|g| spans decades) — no 100 m arrows', arrows53 && len53 > 0 && len53 < 12, { len53 });
await exitSim();
await run(BLOCK, [{ event: 'gravity', scenario: 'custom', global: true, magnitude: 1.62, direction: [0, -1, 0], transition: 'vector', profile: 'constant', duration: 60, end: 'hold', sources: [], startTime: 0 }], 2);
const dorm51 = await ev(() => ({ cel: window.__ds.simStore.getState().celestial, hud: !!document.querySelector('[data-testid="celestial-hud"]') }));
check('51 dormant: a gravity experiment alone shows no celestial HUD or runtime (Phase 31 path unchanged)', dorm51.cel === null && !dorm51.hud);
await exitSim();
const cmd52 = await ev(() => { const r = window.__ds.celestialLib.parse('블랙홀을 만들어줘'); const e = window.__ds.celestialLib.parse('Create a black hole in the center'); return [r.unsupported?.[0]?.event ?? null, e.unsupported?.[0]?.event ?? null, r.commands.length + e.commands.length, r.warnings[0]?.key]; });
check('52 text command: "black hole" (KO / EN) is recognized and pointed to the experiment editor (never executed from text)', cmd52[0] === 'celestial' && cmd52[1] === 'celestial' && cmd52[2] === 0 && cmd52[3] === 'parse.celestial.editor', { cmd52 });
await run([], [ZERO, C({ sources: [LAB({ influence: 40 })] })], 1);
const inf57 = await ev(() => { const f = window.__ds.celestialLib.field(); const g = [0, 0, 0]; f.sample(0, 60, 45, g); const a = Math.hypot(...g); f.sample(0, 60, 25, g); return { out: a, in: Math.hypot(...g) }; });
check('57 influence radius: the field tapers to exactly 0 beyond it (educational cut), unchanged well inside', inf57.out === 0 && Math.abs(inf57.in - 5e4 / 626) / (5e4 / 626) < 0.01, inf57);
await exitSim();
await ev(() => window.__ds.actions.loadCelestialDemo('stress'));
await wait(800);
await enterRun();
await atTime(10);
L = await cl();
check('50 stress preset (4 sources, 16 probes, 2000 particles, town): runs without page errors; capped steps (if any) recorded, never hidden', Number.isFinite(L.stats.maxAccel) && L.stats.sources.length >= 3 && typeof L.stats.capped === 'number', { capped: L.stats.capped, captured: L.ledger.count });
await exitSim();
await ev(() => window.__ds.actions.loadCelestialDemo('gentleOrbit'));
await wait(800);
await enterRun();
await atTime(30);
L = await cl();
check('60 gentle orbital field: three orbits in different planes stay circular (ΔE/E < 10⁻³ each)', L.probes.every((p) => p.state === 'orbit' && p.diag.maxErr < 1e-3), L.probes.map((p) => p.diag.maxErr));
await exitSim();

// ── Whole run ─────────────────────────────────────────────────────────────────────────────────
await newWorld();
await wait(800);
const heap1 = await heapMB();
const geo1 = await geometries();
check('48 resources: GPU geometries back to the start after all runs', geo1 <= geo0 + 2, { geo0, geo1 });
check('whole run: no page errors, the tab alive', errors.length === 0 && !crashed, { errors: errors.length });
console.log(JSON.stringify({ heap0, heap1, geo0, geo1, crashed }));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; ${errors.length} page errors; heap ${heap0} → ${heap1} MB; geometries ${geo0} → ${geo1}; crashed ${crashed}`);
if (errors.length) console.log(errors.slice(0, 10).join('\n'));
fs.writeFileSync(path.join(out, `results-${lang}.json`), JSON.stringify({ lang, url, results, errors, heap: [heap0, heap1], geometries: [geo0, geo1], crashed }, null, 2));
await browser.close();
process.exit(results.every((r) => r.ok) && errors.length === 0 && !crashed ? 0 : 1);
