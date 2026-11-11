// Phase 37 visual look — not a pass / fail check: screenshots for a person to look at (spec §21). What the command bar
// shows while a plan is open (ghost houses on the road frontage, the summary line), a rejected / warned placement, a
// moved group and a delete preview, the terrain heat map of a typed flatten, a new road, ghost disaster pins, the
// question with its options (and the option under the pointer highlighted), "not understood" with its suggestions, a
// query table, the help panel and the script editor.
//
//   npx vite build && npx vite preview --port 4196 --strictPort &
//   LANG_UI=ko node scripts/look-command37.mjs http://localhost:4196/ ./docs/verify/command37/look
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:4196/', out = './docs/verify/command37/look'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const lang = process.env.LANG_UI ?? 'ko';
const KO = lang === 'ko';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = Number(process.env.VW ?? 1600), H = Number(process.env.VH ?? 1000);
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 }, protocolTimeout: 1_800_000, timeout: 180_000,
});
const errors = [];
const page = await browser.newPage();
page.setDefaultNavigationTimeout(180_000);
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('dialog', (d) => d.accept());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (fn, ...a) => page.evaluate(fn, ...a);
let n = 0;
const shot = async (name) => { n++; const f = `${String(n).padStart(2, '0')}-${name}-${lang}.png`; await page.screenshot({ path: path.join(out, f) }); console.log(`shot ${f} ${JSON.stringify(await ev(() => window.__ds.command.preview?.() ?? null))}`); };

async function fresh() {
  await page.goto(url + '?devtools', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__ds && window.__r3f);
  await ev(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__ds && window.__r3f);
  await ev((l) => window.__ds.locale.getState().setLocale(l), lang);
  await wait(1200);
}
async function view(x = 0, z = 0, h = 120, back = 60) {
  await ev(([x, z, h, back]) => { const st = window.__r3f.get(); st.camera.position.set(x, h, z + back); st.controls.target.set(x, 0, z); st.controls.update(); }, [x, z, h, back]);
  await wait(400);
}
const screen = (x, z) => ev(([x, z]) => {
  const st = window.__r3f.get(); const r = st.gl.domElement.getBoundingClientRect();
  const s = window.__ds.buildLib.samplerFor(window.__ds.world.getState().doc.terrain);
  const v = st.camera.position.clone().set(x, s.sampleHeight(x, z), z).project(st.camera);
  return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
}, [x, z]);
async function pointAt(x, z) { const [sx, sy] = await screen(x, z); await page.mouse.move(sx - 8, sy - 5); await page.mouse.move(sx, sy, { steps: 4 }); await wait(250); }
const INPUT = '[data-testid="command-input"]';
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
async function type(text) {
  await page.focus(INPUT);
  await page.keyboard.down(mod); await page.keyboard.press('KeyA'); await page.keyboard.up(mod);
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text, { delay: 3 });
  await wait(500);
}
const enter = async (ms = 700) => { await page.keyboard.press('Enter'); await wait(ms); };
const esc = async () => { await page.keyboard.press('Escape'); await wait(250); };
/** Type, Enter (plan), Enter (confirm). */
async function run(text) { await type(text); await enter(); if (await ev(() => !!window.__ds.command.session.getState().plan?.armed)) await enter(900); }

await fresh();
await view(-10, -8, 70, 45);

// 1 — the draft while typing, then the open plan: three ghost houses on the frontage, the summary line
await type(KO ? '큰길 북쪽에 2층 주택 세 채 간격 2미터' : 'put three 2-storey houses north of the main road, 2 m apart');
await shot('draft-houses');
await enter();
await shot('plan-houses');
await enter(900);
await shot('placed-houses');

// 2 — no room: ten houses → the ones that fit, the rest reported
await type(KO ? '큰길 남쪽에 주택 열 채 간격 2미터' : 'ten houses south of the main road, 2 m apart');
await enter();
await shot('plan-no-room');
await esc();

// 3 — group, move the group (ghosts at the new place), delete preview (marked)
await run(KO ? '방금 만든 것 묶어서 "북쪽 블록"이라고 해' : 'group the ones I just made, named "North block"');
await type(KO ? '"북쪽 블록" 그룹을 북쪽으로 6 m 옮겨' : 'move the group "North block" 6 m north');
await enter();
await shot('plan-move-group');
await esc();
await view(0, 0, 150, 50);
await type(KO ? '침엽수 전부 지워' : 'delete all the conifers');
await enter();
await shot('plan-delete');
await esc();

// 4 — terrain: a typed flatten "here" → the height-change heat map
await run('terrain raise circle 45,55 r=16 by=5');
await view(45, 55, 80, 55);
await pointAt(45, 55);
await type(KO ? '여기 반경 10 m 평평하게' : 'flatten a 10 m circle here');
await enter();
await shot('plan-flatten-heatmap');
await esc();

// 5 — a new road and a forest with rejected spots
await view(20, 20, 150, 50);
await type(KO ? 'n4에서 (40, 60)까지 2차로 도로' : 'a two-lane road from n4 to (40, 60)');
await enter();
await shot('plan-road');
await esc();
await type(KO ? '(30, 30) 반경 25 m에 숲, 밀도 0.4, 시드 7' : 'a forest within 25 m of (30, 30), density 0.4, seed 7');
await enter();
await shot('plan-forest');
await esc();

// 6 — disasters: a ghost pin, then the placed pins
await view(-10, 0, 110, 50);
await type(KO ? '교차로에 폭발 1.8×10⁹ J, 5초 뒤' : 'a 1.8e9 J explosion at the junction in 5 s');
await enter();
await shot('plan-blast-pin');
await enter(900);
await shot('placed-blast');

// 7 — a question: two junctions → options, the one under the pointer highlighted
await run('road 20,0 -> 20,40 preset=street');
await type(KO ? '교차로에 화재' : 'a fire at the junction');
await enter();
await shot('question-junction');
await page.hover('[data-testid="command-option"]').catch(() => null);
await wait(400);
await shot('question-junction-hover');
await esc();

// 8 — not understood, a missing piece, a query table, the help, the script editor
await type(KO ? '하늘을 보라색으로 칠해' : 'paint the sky purple');
await enter();
await shot('unknown');
await esc();
await type(KO ? '선택한 것 동쪽으로 옮겨' : 'move the selection east');
await enter();
await shot('ask-amount');
await esc();
await type(KO ? '건물 몇 채야?' : 'how many buildings?');
await enter();
await shot('query-count');
await type(KO ? '3층 이상 건물 목록' : 'list buildings with at least 3 floors');
await enter();
await shot('query-list');
await page.click('[data-testid="command-help"]').catch(() => null);
await wait(700);
await shot('help');
await page.click('[data-testid="command-script"]').catch(() => null);
await wait(500);
await shot('script-editor');

console.log(`${n} screenshots in ${out}; ${errors.length} page errors`);
for (const e of errors.slice(0, 20)) console.log('  ' + e);
await browser.close();
process.exit(errors.length ? 1 : 0);
