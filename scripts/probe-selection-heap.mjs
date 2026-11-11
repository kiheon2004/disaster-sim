// Phase 18 §Phase 17 residual A: WHERE does the ~3 KB per select/deselect cycle go?
// Two heap snapshots (after forced GCs) around N select/deselect cycles of one object in a
// 1000-object scene; reports the node classes that grew, and retainer paths of new nodes.
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/probe-selection-heap.mjs http://localhost:4173/ [cycles=200]
//
// Phase 37 (§17, the editor's ~12 KB per lap): OP=saveLoad cycles a save → load of the document instead (the one operation
// of the Phase 36 leak lap whose heap never levels off); SCENE=<objects> sets the scene size (default 1000).
import puppeteer from 'puppeteer-core';

const [url = 'http://localhost:4173/', cyclesArg = '200'] = process.argv.slice(2);
const N = Number(cyclesArg);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,900', '--js-flags=--expose-gc'],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 }, protocolTimeout: 900_000,
});
const page = await browser.newPage();
await page.goto(url + `?devtools&scene=${process.env.SCENE ?? 1000}`, { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ds && window.__r3f);
const cdp = await page.createCDPSession();
await cdp.send('HeapProfiler.enable');
await page.evaluate(async () => {
  window.__frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.__ds.actions.loadStressScene(Number(new URLSearchParams(location.search).get('scene') ?? 1000));
  await window.__frames();
});
await new Promise((r) => setTimeout(r, 1500));

const OP = process.env.OP ?? 'select';
const cycle = (n) => page.evaluate(async ([n, op]) => {
  if (op === 'saveLoad') {
    const W = window.__ds.world, L = window.__ds.buildLib;
    for (let i = 0; i < n; i++) {
      W.getState().replaceDocument(L.parseDocument(L.serializeDocument(W.getState().doc, false)).doc);
      await window.__frames();
    }
    return;
  }
  const ed = window.__ds.editor.getState();
  const id = Object.keys(window.__ds.world.getState().doc.objects).sort()[0];
  for (let i = 0; i < n; i++) {
    ed.select(id);
    await window.__frames();
    ed.select(null);
    await window.__frames();
  }
}, [n, OP]);

async function gc() {
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.gc?.());
    await cdp.send('HeapProfiler.collectGarbage');
  }
}

async function snapshot() {
  await gc();
  let data = '';
  const onChunk = (e) => { data += e.chunk; };
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  return parse(JSON.parse(data));
}

function parse(s) {
  const m = s.snapshot.meta;
  const nf = m.node_fields, ef = m.edge_fields;
  const NL = nf.length, EL = ef.length;
  const types = m.node_types[0], etypes = m.edge_types[0];
  const iType = nf.indexOf('type'), iName = nf.indexOf('name'), iId = nf.indexOf('id'), iSize = nf.indexOf('self_size'), iEdges = nf.indexOf('edge_count');
  const eType = ef.indexOf('type'), eName = ef.indexOf('name_or_index'), eTo = ef.indexOf('to_node');
  const nodes = s.nodes, edges = s.edges, strings = s.strings;
  const count = nodes.length / NL;
  const info = { ids: new Int32Array(count), name: new Array(count), type: new Array(count), size: new Float64Array(count), firstEdge: new Int32Array(count + 1) };
  let e = 0;
  for (let i = 0; i < count; i++) {
    const b = i * NL;
    info.ids[i] = nodes[b + iId];
    info.type[i] = types[nodes[b + iType]];
    info.name[i] = strings[nodes[b + iName]];
    info.size[i] = nodes[b + iSize];
    info.firstEdge[i] = e;
    e += nodes[b + iEdges] * EL;
  }
  info.firstEdge[count] = e;
  // Reverse edges (retainers) for retainer paths.
  const retainers = new Map();
  for (let i = 0; i < count; i++) {
    for (let k = info.firstEdge[i]; k < info.firstEdge[i + 1]; k += EL) {
      const to = edges[k + eTo] / NL;
      const et = etypes[edges[k + eType]];
      if (et === 'weak') continue;
      const nm = et === 'element' || et === 'hidden' ? `[${edges[k + eName]}]` : strings[edges[k + eName]];
      let list = retainers.get(to);
      if (!list) retainers.set(to, (list = []));
      if (list.length < 4) list.push({ from: i, edge: nm, et });
    }
  }
  return { ...info, count, retainers };
}

if (process.env.SERIES) {
  // Retained heap (after GC) at checkpoints: does it level off?
  const series = [];
  await cycle(10);
  let done = 0;
  for (const target of [0, 200, 400, 800, 1200]) {
    await cycle(target - done);
    done = target;
    await gc();
    const mb = await page.evaluate(() => performance.memory.usedJSHeapSize / 1048576);
    series.push({ cycles: target, heapMB: +mb.toFixed(2) });
    console.log(JSON.stringify(series[series.length - 1]));
  }
  for (let i = 1; i < series.length; i++) console.log(`${series[i - 1].cycles}→${series[i].cycles}: ${(((series[i].heapMB - series[i - 1].heapMB) * 1024) / (series[i].cycles - series[i - 1].cycles)).toFixed(2)} KB/cycle`);
  await browser.close();
  process.exit(0);
}
await cycle(10);
const A = await snapshot();
await cycle(N);
const B = await snapshot();
const idsA = new Set(A.ids);
const growth = new Map();
const fresh = [];
for (let i = 0; i < B.count; i++) {
  if (idsA.has(B.ids[i])) continue;
  const key = `${B.type[i]}:${B.name[i]}`.slice(0, 90);
  const g = growth.get(key) ?? { n: 0, bytes: 0, sample: i };
  g.n++;
  g.bytes += B.size[i];
  growth.set(key, g);
  fresh.push(i);
}
const top = [...growth.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 25);
console.log(`new nodes after ${N} cycles: ${fresh.length}, bytes ${(fresh.reduce((a, i) => a + B.size[i], 0) / 1024).toFixed(1)} KB`);
for (const [k, g] of top) console.log(`${(g.bytes / 1024).toFixed(1).padStart(8)} KB  ${String(g.n).padStart(6)}  ${k}`);
// Retainer paths (up to 8 hops) for samples of the top classes.
const path = (i) => {
  const out = [];
  let cur = i;
  for (let h = 0; h < 10; h++) {
    const r = (B.retainers.get(cur) ?? []).find((x) => B.type[x.from] !== 'synthetic') ?? (B.retainers.get(cur) ?? [])[0];
    if (!r) break;
    out.push(`${B.type[r.from]}:${String(B.name[r.from]).slice(0, 40)} -[${r.edge}]->`);
    cur = r.from;
  }
  return out.join('  ');
};
for (const [k, g] of top.filter(([k]) => !k.startsWith('code:') && !k.startsWith('hidden:')).slice(0, 8)) console.log(`\n${k}\n   ${path(g.sample)}`);
await browser.close();
