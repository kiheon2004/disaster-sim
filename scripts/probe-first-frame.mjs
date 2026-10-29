// First-deformation frame analysis (Phase 22, Phase 21 residual): runs a deformation on a
// prepared world in Chrome with a performance trace and splits the long frames into
//   simulation tick (deformation first update: priming, field, collider, water bed, responses;
//   physics), heightfield render-mesh build, garbage collection (V8 trace), shader programs
//   compiled, and the remainder (render submit, GPU upload).
//
//   npm run build && npx vite preview --port 4191 --strictPort &
//   node scripts/probe-first-frame.mjs http://localhost:4191/ [empty|town] [runs]
import puppeteer from 'puppeteer-core';
import os from 'node:os';

const [url = 'http://localhost:4191/', scene = 'empty', runsArg = '3'] = process.argv.slice(2);
const runs = Number(runsArg);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const results = [];
for (let r = 0; r < runs; r++) {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,900', '--enable-precise-memory-info'],
    defaultViewport: { width: 1600, height: 900 }, protocolTimeout: 300_000,
  });
  const page = await browser.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto(url + '?devtools', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__ds && window.__r3f);
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  await ev((scene) => {
    const ds = window.__ds;
    ds.actions.newProject();
    if (scene === 'town') {
      const L = ds.roadLib, d = L.presetDesign('house', 1), inputs = [];
      for (let z = -60; z <= 60; z += 12) for (let x = -60; x <= 60; x += 12) inputs.push({ type: 'building', building: d, seed: inputs.length + 1, transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] } });
      ds.world.getState().applyEdit({ add: inputs });
    }
  }, scene);
  await ev(() => window.__ds.actions.enterSimulation());
  await new Promise((res) => setTimeout(res, 1500));
  if (process.env.NODEFORM) await ev(() => { window.__NODEFORM = true; });
  await page.tracing.start({ categories: ['devtools.timeline', 'v8', 'disabled-by-default-v8.gc', 'blink.user_timing'] });
  await ev(() => {
    const ds = window.__ds, P = ds.profiler, gl = window.__r3f.get().gl;
    P.enabled = true; P.snapshot();
    window.__progs0 = new Set(gl.info.programs.map((p) => p.cacheKey));
    ds.deformLib.terrainStats.reset();
    window.__frames = [];
    let last = performance.now();
    const f = () => {
      const now = performance.now();
      const s = P.snapshot();
      window.__frames.push({ t0: last, t1: now, ms: now - last, tick: s.tickMs, physics: s.physicsMs, deform: s.systems.deformation ?? 0, programs: gl.info.programs.length, mesh: ds.deformLib.terrainStats.surfaceBuildMs });
      last = performance.now();
      if (window.__frames.length < 240) requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
    performance.mark('deform-start');
    ds.actions.runSimulation(window.__NODEFORM ? [] : [{ event: 'terrainDeformation', kind: 'subsidence', center: [0, 0], radius: 20, amount: 2, duration: 4, profile: 'smooth', falloff: 'smooth' }]);
  });
  await page.waitForFunction(() => window.__frames.length >= 240, { timeout: 120_000 });
  const trace = JSON.parse(Buffer.from(await page.tracing.stop()).toString('utf8'));
  const data = await ev(() => ({ newPrograms: window.__r3f.get().gl.info.programs.filter((p) => !window.__progs0.has(p.cacheKey)).map((p) => p.cacheKey.split(',').map((v, i) => (v !== 'false' && v !== '' ? i + '=' + v : '')).filter(Boolean).join(' ')), frames: window.__frames, first: window.__ds.sim.getEnvironment().deformation.stats?.first ?? null, timeOrigin: performance.timeOrigin }));
  // Worst frame and the GC inside it (trace timestamps are µs on the same monotonic clock).
  const worst = data.frames.reduce((a, b) => (b.ms > a.ms ? b : a));
  const startMark = trace.traceEvents.find((e) => e.name === 'deform-start');
  const gcNames = /^(MinorGC|MajorGC|V8\.GC_SCAVENGER|V8\.GCScavenger|V8\.GCFinalizeMC|V8\.GCIncrementalMarking|Scavenge|MarkCompact)/;
  let gcAll = 0, gcWorst = 0;
  if (startMark) {
    const t0 = startMark.ts; // µs, corresponds to performance.now() at the mark
    const nowAtMark = data.frames[0].t0; // close enough to align
    for (const e of trace.traceEvents) {
      if (e.ph !== 'X' || !gcNames.test(e.name)) continue;
      const tMs = nowAtMark + (e.ts - t0) / 1000;
      gcAll += e.dur / 1000;
      if (tMs >= worst.t0 - 1 && tMs <= worst.t1 + 1) gcWorst += e.dur / 1000;
    }
  }
  const programsCompiled = worst.programs - data.frames[0].programs;
  const meshMs = worst.mesh - (data.frames[data.frames.indexOf(worst) - 1]?.mesh ?? 0);
  const row = {
    run: r, scene, load: os.loadavg()[0].toFixed(1),
    worstFrameMs: Math.round(worst.ms), frameIndex: data.frames.indexOf(worst),
    tickMs: +worst.tick.toFixed(1), physicsMs: +worst.physics.toFixed(1), deformationSystemMs: +worst.deform.toFixed(1),
    meshBuildMs: +meshMs.toFixed(1), gcInWorstMs: +gcWorst.toFixed(1), gcFirst4sMs: +gcAll.toFixed(1),
    programsCompiledByWorst: programsCompiled,
    restMs: Math.round(worst.ms - worst.tick - meshMs - gcWorst),
    firstUpdate: data.first && Object.fromEntries(Object.entries(data.first).map(([k, v]) => [k, +v.toFixed(2)])),
    newPrograms: data.newPrograms,
    framesOver50: data.frames.filter((f) => f.ms > 50).map((f) => Math.round(f.ms)),
  };
  console.log(JSON.stringify(row));
  results.push(row);
  await browser.close();
}
