/**
 * Phase 37 — text → intents. PLACEHOLDER on the core branch: canonical commands only. The rule-based Korean / English
 * parser (branch p37-nl) replaces this file with the same exported names.
 */
import { msg, type Msg } from './context';
import { formatCanonical, parseCanonical } from './canonical';
import type { Intent } from './intent';

export type AskSlot = 'direction' | 'amount' | 'target' | 'kind' | 'name' | 'field' | 'axis' | 'place';
export type ParseOutcome =
  | { kind: 'ok'; intents: Intent[]; canonical: string[]; source: 'canonical' | 'rules' | 'legacy'; notes: Msg[] }
  | { kind: 'ask'; slot: AskSlot; question: Msg; understood: string }
  | { kind: 'unknown'; reason: Msg; suggestions: string[] };

export function parseCommand(text: string): ParseOutcome {
  const r = parseCanonical(text);
  if (r.ok) return { kind: 'ok', intents: [r.intent], canonical: [formatCanonical(r.intent)], source: 'canonical', notes: [] };
  return { kind: 'unknown', reason: msg('cmd37.parse.unknown', { code: r.error.code, token: r.error.token ?? '', expected: r.error.expected ?? '' }), suggestions: [] };
}
