/**
 * Phase 37 (§14): the command bar's help — a grammar row for every canonical verb, example sentences per class taken
 * from the corpus in the current language, and the strings of the bar in both languages.
 */
import { describe, expect, it } from 'vitest';
import { parseCanonical, VERBS } from '@/command/canonical';
import { CORPUS_CLASSES, loadCorpus } from '@/command/corpus/index';
import { en } from '@/i18n/locales/en';
import { enP37Ui } from '@/i18n/locales/en.p37ui';
import { ko } from '@/i18n/locales/ko';
import { koP37Ui } from '@/i18n/locales/ko.p37ui';
import { COMMAND_KEYS, COMMAND_KEYS_MORE, EXAMPLES_PER_CLASS, GRAMMAR, GRAMMAR_TERMS, helpExamples } from './help';

describe('grammar table', () => {
  it('every canonical verb has a row, every row is about a canonical verb and starts with it', () => {
    const rows = new Set(GRAMMAR.map(([verb]) => verb));
    for (const v of VERBS) expect(rows.has(v), v).toBe(true);
    for (const [verb, form] of GRAMMAR) {
      expect((VERBS as readonly string[]).includes(verb), verb).toBe(true);
      expect(form.startsWith(verb), form).toBe(true);
    }
    expect(new Set(GRAMMAR.map(([, form]) => form)).size).toBe(GRAMMAR.length);
  });

  it('every row, term and key has its description in English and Korean', () => {
    for (const key of [...GRAMMAR.map((r) => r[2]), ...GRAMMAR_TERMS.map((r) => r[2]), ...COMMAND_KEYS.map((r) => r[1]), ...COMMAND_KEYS_MORE.map((r) => r[1])]) {
      expect(en[key], key).toBeTruthy();
      expect(ko[key], key).toBeTruthy();
    }
    // The keys the brief names for the help dialog: / , Ctrl/⌘+K, Enter, Esc, ↑ ↓, Tab.
    expect(COMMAND_KEYS.map((k) => k[0])).toEqual(['/', 'Ctrl/⌘ + K', 'Enter', 'Esc', '↑ / ↓', 'Tab / Shift + Tab']);
  });

  it('the forms without placeholders are commands the parser reads', () => {
    for (const line of ['run', 'pause', 'reset', 'undo', 'redo', 'select none']) expect(parseCanonical(line).ok, line).toBe(true);
    expect(GRAMMAR.filter(([, form]) => !/[<[|]/.test(form)).map(([, form]) => form).sort()).toEqual(['pause', 'redo', 'reset', 'run', 'undo']);
  });
});

describe('examples from the corpus', () => {
  const files = loadCorpus();

  it('per class 4 – 6 sentences of the language, each with the command it means, none twice', () => {
    for (const lang of ['ko', 'en'] as const) {
      const classes = helpExamples(files, lang, CORPUS_CLASSES);
      // Every class that has runnable sentences is there, in the corpus' order; the refused sentences are not examples.
      expect(classes.map((c) => c.class)).toEqual(CORPUS_CLASSES.filter((c) => c !== 'reject'));
      for (const c of classes) {
        expect(c.examples.length, `${lang} ${c.class}`).toBeGreaterThanOrEqual(4);
        expect(c.examples.length, `${lang} ${c.class}`).toBeLessThanOrEqual(6);
        expect(c.examples.length).toBe(EXAMPLES_PER_CLASS);
        expect(new Set(c.examples.map((e) => e.canonical.join('\n'))).size).toBe(c.examples.length);
        for (const e of c.examples) {
          expect(e.text.trim()).toBe(e.text);
          // The command shown under a sentence is a canonical command.
          for (const line of e.canonical) expect(parseCanonical(line).ok, `${lang} ${c.class}: ${line}`).toBe(true);
        }
      }
    }
  });

  it('the sentences are in the language asked for', () => {
    const hangul = /[가-힣]/;
    const ko_ = helpExamples(files, 'ko', CORPUS_CLASSES).flatMap((c) => c.examples);
    const en_ = helpExamples(files, 'en', CORPUS_CLASSES).flatMap((c) => c.examples);
    expect(ko_.filter((e) => hangul.test(e.text)).length).toBe(ko_.length);
    // (an English sentence may quote a Korean name; none of these does)
    expect(en_.filter((e) => hangul.test(e.text)).length).toBe(0);
  });

  it('an empty corpus gives no classes', () => {
    expect(helpExamples([], 'ko', CORPUS_CLASSES)).toEqual([]);
  });
});

describe('strings of the bar (cmd37.ui.*)', () => {
  const keys = Object.keys(enP37Ui) as (keyof typeof enP37Ui)[];

  it('every key has the prefix, a Korean text, and the same {parameters} in both languages', () => {
    expect(keys.length).toBeGreaterThan(100);
    const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of keys) {
      expect(k.startsWith('cmd37.ui.'), k).toBe(true);
      expect(enP37Ui[k].trim(), k).not.toBe('');
      expect(koP37Ui[k].trim(), k).not.toBe('');
      expect(params(koP37Ui[k]), k).toEqual(params(enP37Ui[k]));
    }
    expect(Object.keys(koP37Ui).sort()).toEqual([...keys].sort());
  });

  it('the placeholder names Enter in both languages (the older browser checks find the input by it)', () => {
    expect(enP37Ui['cmd37.ui.placeholder']).toContain('Enter');
    expect(koP37Ui['cmd37.ui.placeholder']).toContain('Enter');
  });

  it('Korean texts are Korean, and no state word is the same in both languages', () => {
    const hangul = /[가-힣]/;
    const latinOnly = keys.filter((k) => !hangul.test(koP37Ui[k]));
    // (symbols with counts and the word "id" need no translation)
    expect(latinOnly.sort()).toEqual(['cmd37.ui.cand.id']);
  });
});
