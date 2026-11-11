/** Keyboard helpers shared by the global shortcuts and the tools' own key handlers (Phase 36). */

/** The key event comes from a text field / select / editable element: shortcuts stay out. */
export function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/**
 * Layout-independent key name (Phase 36): letters and brackets come from the physical key
 * (`e.code`), so shortcuts work with the Korean IME in Hangul mode (`e.key` is then a jamo or
 * 'Process') and Shift+[ / Shift+] arrive as '[' / ']' (before, `e.key` was '{' / '}' and the ×5
 * brush steps never fired). Other keys keep `e.key` (Escape, Enter, Delete …).
 */
export function keyOf(e: KeyboardEvent): string {
  const c = e.code ?? '';
  if (c.startsWith('Key') && c.length === 4) return c.slice(3).toLowerCase();
  if (c === 'BracketLeft') return '[';
  if (c === 'BracketRight') return ']';
  return (e.key ?? '').toLowerCase();
}
