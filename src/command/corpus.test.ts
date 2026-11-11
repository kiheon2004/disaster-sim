/**
 * Phase 37 (§6, §20): the sentence corpus against the rule parser. The corpus (src/command/corpus/*.json) is written
 * by hand from NL-CONVENTIONS.md by someone other than the parser's author — sentence → expected canonical commands,
 * the slot that is asked for, or "must not run". Every case is run; the failing sentences are listed by class
 * (text, expected, got).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCanonical } from './canonical';
import { parseCommand, type ParseOutcome } from './parse';

interface CorpusCase { text: string; expect?: string[]; ask?: string; unknown?: true; why?: string }
interface CorpusFile { class: string; lang: string; cases: CorpusCase[] }

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'corpus');

function load(): { name: string; file: CorpusFile }[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).filter((f) => f.endsWith('.json')).sort().map((name) => ({ name, file: JSON.parse(readFileSync(join(DIR, name), 'utf-8')) as CorpusFile }));
}

const wanted = (c: CorpusCase): string => (c.expect ? c.expect.join(' | ') : c.ask ? `ask ${c.ask}` : 'unknown');
const got = (o: ParseOutcome): string => (o.kind === 'ok' ? o.canonical.join(' | ') : o.kind === 'ask' ? `ask ${o.slot}` : 'unknown');

/** Run every case; failures grouped by "class · language", and the pass count of each group. */
function runCorpus(files: { name: string; file: CorpusFile }[]): { total: number; failed: number; groups: Map<string, { total: number; failures: string[] }> } {
  const groups = new Map<string, { total: number; failures: string[] }>();
  let total = 0, failed = 0;
  for (const { name, file } of files) {
    const key = `${file.class ?? name} · ${file.lang ?? '?'}`;
    const g = groups.get(key) ?? { total: 0, failures: [] };
    groups.set(key, g);
    for (const c of Array.isArray(file.cases) ? file.cases : []) {
      total++;
      g.total++;
      const o = parseCommand(c.text);
      let problem = got(o) === wanted(c) ? '' : `got  ${got(o)}${o.kind === 'unknown' ? ` (${o.reason.key})` : ''}`;
      // "Must not run" also means: candidates are offered, and they are canonical commands.
      if (!problem && o.kind === 'unknown' && (o.suggestions.length < 2 || o.suggestions.length > 3 || o.suggestions.some((s) => !parseCanonical(s).ok))) problem = `got  unknown with suggestions ${JSON.stringify(o.suggestions)}`;
      if (problem) { failed++; g.failures.push(`  ${c.text}\n      want ${wanted(c)}\n      ${problem}`); }
    }
  }
  return { total, failed, groups };
}

describe('sentence corpus', () => {
  const files = load();
  // (a generous timeout: 1,774 sentences take ~4 s alone and much longer when the whole suite runs beside them)
  it(`every corpus sentence gives its expected outcome (${files.length} files)`, { timeout: 300_000 }, () => {
    const r = runCorpus(files);
    // The corpus is part of the repository: the test must not pass because the folder is missing or thinned out.
    expect(files.length).toBe(40);
    expect(r.total).toBeGreaterThanOrEqual(1774);
    const report = [...r.groups]
      .filter(([, g]) => g.failures.length)
      .map(([key, g]) => `${key}: ${g.total - g.failures.length} / ${g.total}\n${g.failures.join('\n')}`)
      .join('\n\n');
    expect(r.failed, `\n${r.failed} of ${r.total} corpus sentences failed\n\n${report}\n`).toBe(0);
  });
});
