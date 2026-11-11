/**
 * Phase 37 (§6, §20) — the natural-language corpus: Korean / English sentences with the canonical commands they mean.
 *
 * One file per sentence class and language (`<class>.<lang>.json`). The expected values are written BY HAND from the
 * written rules (NL-CONVENTIONS), never copied from a parser's output — that is what makes the corpus a test of the
 * parser. Every sentence has exactly one outcome:
 *
 *   expect   the canonical lines it means, in order (each one exactly as `formatCanonical` writes it)
 *   ask      understood except one missing piece — the slot the user is asked for; nothing runs
 *   unknown  not understood / not supported / negated — nothing runs (`why` says which)
 *
 * This module only loads and checks the shape; it knows nothing about parsing sentences.
 */
import { z } from 'zod';

export const CORPUS_LANGS = ['ko', 'en'] as const;
export type CorpusLang = (typeof CORPUS_LANGS)[number];

/**
 * The sentence classes: the 17 of the specification's §6 table, `edit` (delete / duplicate — the canonical grammar's
 * own line for them), `mixed` (several commands in one sentence) and `reject` (sentences that must not become a command).
 */
export const CORPUS_CLASSES = [
  'place', 'vehicles', 'nature', 'select', 'transform', 'align', 'properties', 'group', 'flags', 'edit', 'terrain', 'road',
  'disaster', 'run', 'instance', 'camera', 'query', 'undo', 'mixed', 'reject',
] as const;
export type CorpusClass = (typeof CORPUS_CLASSES)[number];

/** What an `ask` outcome asks for. */
export const ASK_SLOTS = ['direction', 'amount', 'target', 'kind', 'name', 'field', 'axis', 'place'] as const;
export type AskSlot = (typeof ASK_SLOTS)[number];

export type CorpusCase =
  | { text: string; expect: string[] }
  | { text: string; ask: AskSlot }
  | { text: string; unknown: true; why: string };

export interface CorpusFile {
  /** The file's name (`place.ko.json`). */
  file: string;
  class: CorpusClass;
  lang: CorpusLang;
  cases: CorpusCase[];
}

const text = z.string().min(1);

/** One case: a sentence and exactly one of expect / ask / unknown (strict — no other keys). */
export const corpusCaseSchema: z.ZodType<CorpusCase> = z.union([
  z.object({ text, expect: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ text, ask: z.enum(ASK_SLOTS) }).strict(),
  z.object({ text, unknown: z.literal(true), why: z.string().min(1) }).strict(),
]);

export const corpusFileSchema = z.object({ class: z.enum(CORPUS_CLASSES), lang: z.enum(CORPUS_LANGS), cases: z.array(corpusCaseSchema).min(1) }).strict();

const MODULES = import.meta.glob<unknown>('./*.json', { eager: true, import: 'default' });

/** Every corpus file as it is on disk (not validated), by file name. */
export function rawCorpus(): { file: string; data: unknown }[] {
  return Object.keys(MODULES).sort().map((path) => ({ file: path.slice(path.lastIndexOf('/') + 1), data: MODULES[path] }));
}

/** The corpus, validated (throws with the file name when a file does not have the shape above). */
export function loadCorpus(): CorpusFile[] {
  return rawCorpus().map(({ file, data }) => {
    const r = corpusFileSchema.safeParse(data);
    if (!r.success) throw new Error(`${file}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    return { file, ...r.data };
  });
}

export const isExpect = (c: CorpusCase): c is Extract<CorpusCase, { expect: string[] }> => 'expect' in c;
export const isAsk = (c: CorpusCase): c is Extract<CorpusCase, { ask: AskSlot }> => 'ask' in c;
export const isUnknown = (c: CorpusCase): c is Extract<CorpusCase, { unknown: true }> => 'unknown' in c;
