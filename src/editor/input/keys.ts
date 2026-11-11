/** Keyboard helpers shared by the global shortcuts and the tools' own key handlers (Phase 36). */

/** `<input>` types that are controls, not text: a slider, a switch, a colour, a button. */
const CONTROL_INPUTS = new Set(['range', 'checkbox', 'radio', 'color', 'button', 'submit', 'reset', 'file', 'image']);

/**
 * The key event belongs to the element it comes from: shortcuts stay out.
 *
 * Text fields, text areas, selects and editable elements take every key. An `<input>` that is a control — a slider,
 * a checkbox, a radio button, a colour or a button — takes only the keys it works with itself: the arrows (and
 * Home / End / Page keys) of a slider, Space of a checkbox / radio, Space and Enter of a button-like input. Everything
 * else is a shortcut again (Phase 37: before, ANY input blocked every shortcut — after a slider or a checkbox was
 * touched no key worked until something else was clicked). One rule for the global shortcuts, the tools and the
 * keyboard driving of a car (Phase 35).
 */
export function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true;
  if (tag !== 'INPUT') return false;
  const type = ((el as HTMLInputElement).type ?? 'text').toLowerCase();
  if (!CONTROL_INPUTS.has(type)) return true;
  const code = e.code ?? '';
  if (type === 'range') return code.startsWith('Arrow') || code === 'Home' || code === 'End' || code === 'PageUp' || code === 'PageDown';
  if (type === 'checkbox' || type === 'radio') return code === 'Space';
  return code === 'Space' || code === 'Enter' || code === 'NumpadEnter';
}

/**
 * Layout-independent key name (Phase 36): letters and brackets come from the physical key
 * (`e.code`), so shortcuts work with the Korean IME in Hangul mode (`e.key` is then a jamo or
 * 'Process') and Shift+[ / Shift+] arrive as '[' / ']' (before, `e.key` was '{' / '}' and the ×5
 * brush steps never fired). Phase 37: the slash key too ('/' — it opens the command bar; with Shift
 * `e.key` is '?'). Other keys keep `e.key` (Escape, Enter, Delete …).
 */
export function keyOf(e: KeyboardEvent): string {
  const c = e.code ?? '';
  if (c.startsWith('Key') && c.length === 4) return c.slice(3).toLowerCase();
  if (c === 'BracketLeft') return '[';
  if (c === 'BracketRight') return ']';
  if (c === 'Slash') return '/';
  return (e.key ?? '').toLowerCase();
}

/**
 * The keys that put the keyboard in the command bar (Phase 37 §14): `/` (the physical Slash key, no modifier) and
 * Ctrl / ⌘ + K. Neither is bound to anything else, and neither is a jamo key of the Korean keyboard.
 */
export function opensCommandBar(e: KeyboardEvent): boolean {
  const mod = !!(e.metaKey || e.ctrlKey);
  if (e.altKey || e.shiftKey) return false;
  // (the Slash key itself, not any key that types '/': the numeric pad's divide key stays free)
  return (e.code === 'Slash' && !mod) || (keyOf(e) === 'k' && mod);
}
