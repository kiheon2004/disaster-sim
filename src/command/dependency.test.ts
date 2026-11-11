/**
 * Phase 37 §18 / §23 — which way the command layer may be imported, checked on the source text.
 *
 *  - The simulation side (physics, phenomena, world, terrain, roads, objects, … — everything that is not the UI side)
 *    never imports the command layer (`src/command`) or its panel (`src/ui/Command`): a typed command is an EDIT that
 *    goes through the same store actions as a mouse edit, and nothing a run computes may depend on it.
 *  - The command core is pure: no clock, no random numbers, no React / three.js, no code evaluation.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..');
/** Directories that may know the command layer: itself, the app glue, the panels, the viewport layers, the editor. */
const UI_SIDE = new Set(['command', 'app', 'ui', 'rendering', 'editor']);
/** …and the benchmark that measures the command layer (a test file: nothing a run executes). */
const BENCH = 'bench/command37.bench.test.ts';

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return sources(p);
    return /\.(tsx?|jsx?)$/.test(d.name) ? [p] : [];
  });
}

const rel = (f: string) => path.relative(SRC, f).split(path.sep).join('/');

/** Module specifiers of every import / export-from / dynamic import in a source text. */
function specifiers(text: string): string[] {
  const out: string[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[2]);
  return out;
}

/** The `src`-relative path a specifier points at ('' for a package). */
function target(file: string, spec: string): string {
  if (spec.startsWith('@/')) return spec.slice(2);
  if (spec.startsWith('.')) return rel(path.resolve(path.dirname(file), spec));
  return '';
}

const isCommandLayer = (t: string) => t === 'command' || t.startsWith('command/') || t === 'ui/Command' || t.startsWith('ui/Command/');

describe('command layer — dependency direction', () => {
  const all = sources(SRC);

  it('the scan sees the simulation side and the command layer', () => {
    const top = new Set(all.map((f) => rel(f).split('/')[0]));
    for (const d of ['physics', 'simulation', 'phenomena', 'world', 'terrain', 'roads', 'objects', 'command']) expect(top.has(d)).toBe(true);
    expect(specifiers("import a from './x';\nimport type { B } from \"@/command/intent\";\nexport * from '../y';\nconst z = await import('@/ui/Command/z');\nimport './side';")).toEqual([
      './x', '@/command/intent', '../y', '@/ui/Command/z', './side',
    ]);
    expect(isCommandLayer(target(path.join(SRC, 'world/a.ts'), '../command/plan'))).toBe(true);
    expect(isCommandLayer(target(path.join(SRC, 'world/a.ts'), '@/commands/parser'))).toBe(false);
  });

  it('nothing on the simulation side imports src/command or src/ui/Command', () => {
    const offenders: string[] = [];
    for (const f of all) {
      const r = rel(f);
      if (UI_SIDE.has(r.split('/')[0]) || r === BENCH) continue;
      for (const s of specifiers(fs.readFileSync(f, 'utf8'))) if (isCommandLayer(target(f, s))) offenders.push(`${r} → ${s}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the editor imports the command layer only for its viewport pieces, never from the edit rules', () => {
    // src/editor/build, snap and placement are the shared edit rules the planner calls — they must not call back.
    const offenders: string[] = [];
    for (const f of all) {
      const r = rel(f);
      if (!/^editor\/(build|snap|input|brush)\//.test(r) && !/^editor\/[^/]+Store\.ts$/.test(r)) continue;
      for (const s of specifiers(fs.readFileSync(f, 'utf8'))) if (isCommandLayer(target(f, s))) offenders.push(`${r} → ${s}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the command core is pure: no clock, no random numbers, no React / three.js / DOM, no code evaluation', () => {
    const core = all.filter((f) => rel(f).startsWith('command/') && !/\.test\.tsx?$/.test(f));
    expect(core.length).toBeGreaterThan(10);
    const banned: [string, RegExp][] = [
      ['clock', /\bDate\.now\b|\bnew Date\(|\bperformance\.now\b/],
      ['random', /\bMath\.random\b|\bcrypto\.\w+/],
      ['evaluation', /\beval\s*\(|\bnew\s+Function\b/],
      ['dom', /\b(?:window|document|localStorage|navigator)\./],
    ];
    const offenders: string[] = [];
    for (const f of core) {
      const text = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      for (const [name, re] of banned) if (re.test(text)) offenders.push(`${rel(f)}: ${name}`);
      for (const s of specifiers(text)) {
        if (/^(react|react-dom|three|@react-three\/.*)$/.test(s)) offenders.push(`${rel(f)}: imports ${s}`);
        const t = target(f, s);
        if (t.startsWith('ui/') || t.startsWith('rendering/')) offenders.push(`${rel(f)}: imports ${s}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
