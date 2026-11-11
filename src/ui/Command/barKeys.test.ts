/**
 * Phase 37 (§6, §14, §19): what a key does in the command bar — above all that Enter never submits inside an IME
 * composition (Korean), in each of the three ways a browser can say so — plus history walking and the pause of the
 * live preview when planning is slow.
 */
import { describe, expect, it } from 'vitest';
import { barKey, draftDelay, DRAFT_DELAY, DRAFT_DELAY_SLOW, inComposition, scriptKey, walkHistory, WALK_START, type BarFacts, type KeyFacts } from './barKeys';

const key = (k: string, over: Partial<KeyFacts> = {}): KeyFacts => ({ key: k, keyCode: k === 'Enter' ? 13 : k === 'Tab' ? 9 : k === 'Escape' ? 27 : 0, isComposing: false, shift: false, ctrl: false, meta: false, alt: false, ...over });
const bar = (over: Partial<BarFacts> = {}): BarFacts => ({ composing: false, listOpen: false, text: 'place tree', clarify: null, ...over });

describe('IME composition (S2)', () => {
  const GUARDED = ['Enter', 'Tab', 'ArrowUp', 'ArrowDown', 'Escape'];

  it('Enter / Tab / ↑ / ↓ / Esc are the IME\'s while the key event says isComposing', () => {
    for (const k of GUARDED) expect(barKey(key(k, { isComposing: true }), bar()), k).toEqual({ do: 'ime' });
  });

  it('… or while the key code is 229 (the Enter that ends a composition in Safari arrives after compositionend)', () => {
    for (const k of GUARDED) expect(barKey(key(k, { keyCode: 229 }), bar()), k).toEqual({ do: 'ime' });
  });

  it('… or between the input\'s own compositionstart and compositionend (a CDP composition reports key code 13)', () => {
    for (const k of GUARDED) expect(barKey(key(k), bar({ composing: true })), k).toEqual({ do: 'ime' });
    expect(inComposition({ isComposing: false, keyCode: 13 }, true)).toBe(true);
    expect(inComposition({ isComposing: false, keyCode: 13 }, false)).toBe(false);
  });

  it('after the composition has ended the next Enter submits', () => {
    expect(barKey(key('Enter', { isComposing: true, keyCode: 229 }), bar({ composing: true }))).toEqual({ do: 'ime' });
    expect(barKey(key('Enter'), bar({ composing: false }))).toEqual({ do: 'submit' });
  });

  it('a digit does not answer a question inside a composition', () => {
    const q = bar({ clarify: { options: 2, text: 'place tree' } });
    expect(barKey(key('1', { isComposing: true }), q)).toEqual({ do: 'ime' });
    expect(barKey(key('1'), q)).toEqual({ do: 'choose', k: 0 });
  });

  it('the script editor: Ctrl / ⌘ + Enter runs, never inside a composition; a bare Enter is a new line', () => {
    expect(scriptKey(key('Enter', { ctrl: true }), false)).toEqual({ do: 'run' });
    expect(scriptKey(key('Enter', { meta: true }), false)).toEqual({ do: 'run' });
    expect(scriptKey(key('Enter', { ctrl: true, isComposing: true }), false)).toEqual({ do: 'ime' });
    expect(scriptKey(key('Enter', { ctrl: true, keyCode: 229 }), false)).toEqual({ do: 'ime' });
    expect(scriptKey(key('Enter', { meta: true }), true)).toEqual({ do: 'ime' });
    expect(scriptKey(key('Enter'), false)).toEqual({ do: 'pass' });
    expect(scriptKey(key('Escape'), false)).toEqual({ do: 'cancel' });
    expect(scriptKey(key('Escape'), true)).toEqual({ do: 'ime' });
    expect(scriptKey(key('a'), false)).toEqual({ do: 'pass' });
  });
});

describe('keys of the bar', () => {
  it('Enter submits, Esc cancels, ↑ / ↓ walk the history, Tab completes (Shift = backwards)', () => {
    expect(barKey(key('Enter'), bar())).toEqual({ do: 'submit' });
    expect(barKey(key('Escape'), bar())).toEqual({ do: 'cancel' });
    expect(barKey(key('ArrowUp'), bar())).toEqual({ do: 'history', dir: -1 });
    expect(barKey(key('ArrowDown'), bar())).toEqual({ do: 'history', dir: 1 });
    expect(barKey(key('Tab'), bar())).toEqual({ do: 'complete', dir: 1 });
    expect(barKey(key('Tab', { shift: true }), bar())).toEqual({ do: 'complete', dir: -1 });
  });

  it('with the completion list open: Esc closes the list first, Enter keeps the candidate, ↑ / ↓ and Tab move in it', () => {
    const open = bar({ listOpen: true });
    expect(barKey(key('Escape'), open)).toEqual({ do: 'listClose' });
    expect(barKey(key('Enter'), open)).toEqual({ do: 'listAccept' });
    expect(barKey(key('ArrowDown'), open)).toEqual({ do: 'listMove', dir: 1 });
    expect(barKey(key('ArrowUp'), open)).toEqual({ do: 'listMove', dir: -1 });
    expect(barKey(key('Tab'), open)).toEqual({ do: 'complete', dir: 1 });
  });

  it('other keys, and keys with Ctrl / ⌘ / Alt, are left to the browser', () => {
    for (const k of ['a', ' ', 'Backspace', 'ArrowLeft', 'Home', '/', '1']) expect(barKey(key(k), bar()), k).toEqual({ do: 'pass' });
    expect(barKey(key('Tab', { ctrl: true }), bar())).toEqual({ do: 'pass' });
    expect(barKey(key('Tab', { alt: true }), bar())).toEqual({ do: 'pass' });
    expect(barKey(key('ArrowUp', { meta: true }), bar())).toEqual({ do: 'pass' });
    expect(barKey(key('ArrowDown', { shift: true }), bar())).toEqual({ do: 'pass' });
  });

  it('1 – 9 answer an open question while the text is the one it was asked about, or empty', () => {
    const q = { options: 3, text: 'place tree' };
    expect(barKey(key('2'), bar({ clarify: q }))).toEqual({ do: 'choose', k: 1 });
    expect(barKey(key('3'), bar({ clarify: q, text: '' }))).toEqual({ do: 'choose', k: 2 });
    // No such option, an edited text, a modifier, the list open: the digit is typed.
    expect(barKey(key('4'), bar({ clarify: q }))).toEqual({ do: 'pass' });
    expect(barKey(key('0'), bar({ clarify: q }))).toEqual({ do: 'pass' });
    expect(barKey(key('2'), bar({ clarify: q, text: 'place tree count=' }))).toEqual({ do: 'pass' });
    expect(barKey(key('2', { ctrl: true }), bar({ clarify: q }))).toEqual({ do: 'pass' });
    expect(barKey(key('2'), bar({ clarify: q, listOpen: true }))).toEqual({ do: 'pass' });
    expect(barKey(key('2'), bar())).toEqual({ do: 'pass' });
  });
});

describe('history (↑ / ↓)', () => {
  const H = ['one', 'two', 'three'];

  it('↑ goes back from the text being written, ↓ comes forward and ends at that text again', () => {
    let s = walkHistory(H, WALK_START, -1, 'unfinished')!;
    expect(s.text).toBe('three');
    s = walkHistory(H, s.walk, -1, s.text)!;
    expect(s.text).toBe('two');
    s = walkHistory(H, s.walk, -1, s.text)!;
    expect(s.text).toBe('one');
    // The oldest: ↑ does nothing more.
    expect(walkHistory(H, s.walk, -1, s.text)).toBeNull();
    s = walkHistory(H, s.walk, 1, s.text)!;
    expect(s.text).toBe('two');
    s = walkHistory(H, s.walk, 1, s.text)!;
    s = walkHistory(H, s.walk, 1, s.text)!;
    expect(s).toEqual({ walk: WALK_START, text: 'unfinished' });
  });

  it('↓ at the text being written and any key with no history do nothing', () => {
    expect(walkHistory(H, WALK_START, 1, 'x')).toBeNull();
    expect(walkHistory([], WALK_START, -1, 'x')).toBeNull();
    expect(walkHistory([], WALK_START, 1, 'x')).toBeNull();
  });

  it('a history that became shorter under the walk does not leave it outside', () => {
    const s = walkHistory(['only'], { at: 7, stash: 'mine' }, -1, 'whatever');
    expect(s).toBeNull();
    expect(walkHistory(['only'], { at: 7, stash: 'mine' }, 1, 'whatever')).toEqual({ walk: WALK_START, text: 'mine' });
  });
});

describe('planning while typing', () => {
  it('a slow draft makes the next ones wait longer; a very slow one pauses the live preview', () => {
    expect(draftDelay(0)).toBe(DRAFT_DELAY);
    expect(draftDelay(50)).toBe(DRAFT_DELAY);
    expect(draftDelay(51)).toBe(DRAFT_DELAY_SLOW);
    expect(draftDelay(300)).toBe(DRAFT_DELAY_SLOW);
    expect(draftDelay(301)).toBeNull();
    expect(DRAFT_DELAY).toBeLessThan(DRAFT_DELAY_SLOW);
  });
});
