/**
 * Phase 37 (§9, §14): the command bar's summary line on the real session — the state as one of seven words, what an
 * open plan would change (counted from the preview's difference), and what Enter / Esc do at each step.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { identityTransform, type Vec3 } from '@/core/types';
import { drawRoad } from '@/roads/network';
import { defaultProfile } from '@/roads/types';
import { useWorldStore } from '@/world/worldStore';
import { createEmptyDocument } from '@/world/WorldDocument';
import { useEditorStore } from '@/editor/editorStore';
import { cancelCommand, confirmPlan, draftCommand, enterAppliesAtOnce, installCommandSession, submitCommand } from '@/app/commandActions';
import { en } from '@/i18n/locales/en';
import { ko } from '@/i18n/locales/ko';
import { useCommandSession } from './commandSession';
import { actAtOnce, BAR_STATES, barState, diffCounts, hints, planLines, richResult, STATE_SYMBOL, warningCount } from './summary';

beforeAll(() => {
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame ??= (f: () => void) => setTimeout(f, 0);
  installCommandSession();
});

const W = () => useWorldStore.getState();
const S = () => useCommandSession.getState();
const at = (x: number, z: number) => ({ ...identityTransform(), position: [x, 0, z] as Vec3 });
const facts = (stale = false) => ({ text: S().text, plan: S().plan, feedback: S().feedback, stale });
const state = (stale = false) => barState(facts(stale));
const hint = (stale = false, paused = false) => hints({ ...facts(stale), understood: S().understood, appliesAtOnce: enterAppliesAtOnce(), paused }).map((m) => m.key);
const enter = async (text: string) => {
  S().setText(text);
  return submitCommand();
};

beforeEach(() => {
  W().setLocked(false);
  W().replaceDocument(createEmptyDocument());
  W().applyEdit({ roads: drawRoad(W().doc.roads, [[-60, 0], [60, 0]], { curved: false, profile: defaultProfile() }).network });
  useEditorStore.getState().setMode('editor');
  useEditorStore.getState().select(null);
  S().setText('');
  S().setPlan(null);
  S().setFeedback({ k: 'none' });
  S().setResults([]);
  S().setUnderstood(null);
  S().setDraftMs(0);
  S().setSettings({ applySmall: false, scriptPerLine: false });
});

describe('the state: one of seven words, each with its own mark', () => {
  it('idle → draft (typing) → plan (Enter) → done (Enter) — and what Enter does at each step', async () => {
    expect(state()).toBe('idle');
    expect(hint()).toEqual(['cmd37.ui.hint.idle']);
    S().setText('place tree count=2 at=0,30');
    // Typed, not planned yet: a draft that is not understood yet.
    expect(state()).toBe('draft');
    expect(hint()).toEqual(['cmd37.ui.hint.notUnderstood']);
    draftCommand();
    expect(state()).toBe('draft');
    expect(hint()).toEqual(['cmd37.ui.hint.plan']);
    expect(diffCounts(S().plan!.preview.diff).created).toBe(2);
    await submitCommand();
    expect(state()).toBe('plan');
    expect(hint()).toEqual(['cmd37.ui.hint.confirm', 'cmd37.ui.hint.esc']);
    expect(planLines(S().plan).map((p) => p.canonical)).toEqual(['place tree count=2 at=0,30']);
    await submitCommand();
    expect(state()).toBe('done');
    expect(hint()).toEqual(['cmd37.ui.hint.idle']);
  });

  it('Esc on a plan: back to the draft of the same text', async () => {
    await enter('place tree at=0,30');
    expect(state()).toBe('plan');
    cancelCommand();
    expect(state()).toBe('draft');
  });

  it('a large edit: plan (Enter twice) → confirm (Enter once more) → done', async () => {
    await enter('place barrel count=210 at=0,40 gap=0.1');
    expect(state()).toBe('plan');
    expect(hint()).toEqual(['cmd37.ui.hint.confirmTwice', 'cmd37.ui.hint.esc']);
    await submitCommand();
    expect(state()).toBe('confirm');
    expect(hint()).toEqual(['cmd37.ui.hint.confirmOnce', 'cmd37.ui.hint.esc']);
    await submitCommand();
    expect(state()).toBe('done');
  });

  it('a question, and a message — until the text is edited (then it is a draft again; the message stays readable)', async () => {
    await enter('place building:house count=2 along=road:main');
    expect(state()).toBe('question');
    expect(hint()).toEqual(['cmd37.ui.hint.choose', 'cmd37.ui.hint.esc']);
    expect(state(true)).toBe('draft');
    await enter('frobnicate the widgets');
    expect(state()).toBe('error');
    expect(hint()).toEqual(['cmd37.ui.hint.dismiss']);
    expect(state(true)).toBe('draft');
    await enter('move type:crate by=1,0,0');
    expect(state()).toBe('error');
    cancelCommand();
    expect(state()).toBe('draft');
  });

  it('commands that act at once: understood while typing ("Enter = run"), done after Enter; a table is a rich result', async () => {
    W().applyEdit({ add: [{ type: 'tree', transform: at(0, 30), seed: 1 }] });
    S().setText('count type:tree');
    draftCommand();
    expect(state()).toBe('draft');
    expect(hint()).toEqual(['cmd37.ui.hint.run']);
    await submitCommand();
    expect(state()).toBe('done');
    expect(richResult(S().feedback)).toBe(true);
    await enter('select type:tree');
    expect(richResult(S().feedback)).toBe(false);
  });

  it('with "apply small edits at once": the draft says Enter applies now — a delete still says plan', async () => {
    S().setSettings({ applySmall: true });
    S().setText('place tree at=0,30');
    draftCommand();
    expect(hint()).toEqual(['cmd37.ui.hint.applyNow']);
    await submitCommand();
    S().setText('delete type:tree');
    draftCommand();
    expect(hint()).toEqual(['cmd37.ui.hint.plan']);
  });

  it('without a draft plan (after Esc, or paused) the verbs say whether Enter plans or runs', () => {
    expect(actAtOnce(['count type:tree'])).toBe(true);
    expect(actAtOnce(['select type:tree', 'focus selection', 'run', 'speed=2', 'undo'])).toBe(true);
    expect(actAtOnce(['disaster blast at=0,0 now'])).toBe(true);
    expect(actAtOnce(['disaster rain stop'])).toBe(true);
    expect(actAtOnce(['disaster blast at=0,0'])).toBe(false);
    expect(actAtOnce(['select type:tree', 'delete selection'])).toBe(false);
    expect(actAtOnce(['place tree at=0,30'])).toBe(false);
    expect(actAtOnce([])).toBe(false);
    S().setText('place tree at=0,30');
    S().setUnderstood(['place tree at=0,30']);
    expect(hint()).toEqual(['cmd37.ui.hint.plan']);
    S().setText('count type:tree');
    S().setUnderstood(['count type:tree']);
    expect(hint()).toEqual(['cmd37.ui.hint.run']);
  });

  it('a paused live preview says so instead of guessing what Enter does', () => {
    S().setText('place tree at=0,30');
    expect(hint(false, true)).toEqual(['cmd37.ui.hint.pausedUnknown']);
    S().setUnderstood(['place tree at=0,30']);
    expect(hint(false, true)).toEqual(['cmd37.ui.hint.paused']);
    S().setUnderstood(null);
  });

  it('every state has a mark, and a word in both languages', () => {
    expect(new Set(BAR_STATES.map((s) => STATE_SYMBOL[s])).size).toBe(BAR_STATES.length);
    for (const s of BAR_STATES) {
      expect(en[`cmd37.ui.state.${s}`], s).toBeTruthy();
      expect(ko[`cmd37.ui.state.${s}`], s).toBeTruthy();
    }
  });
});

describe('what a plan would change', () => {
  it('counts come from the difference the preview found: objects, a road, a disaster, ground', async () => {
    W().applyEdit({ add: [{ type: 'tree', transform: at(0, 30), seed: 1 }, { type: 'tree', transform: at(5, 30), seed: 2 }] });
    await enter('move type:tree by=1,0,0');
    expect(diffCounts(S().plan!.preview.diff)).toMatchObject({ created: 0, changed: 2, removed: 0 });
    await enter('delete type:tree');
    expect(diffCounts(S().plan!.preview.diff)).toMatchObject({ created: 0, changed: 0, removed: 2 });
    await enter('road 0,0 -> 0,40');
    expect(diffCounts(S().plan!.preview.diff).roadsAdded).toBeGreaterThan(0);
    await enter('disaster blast at=10,10 energy=2e9');
    expect(diffCounts(S().plan!.preview.diff)).toMatchObject({ disastersAdded: 1, disastersChanged: 0, disastersRemoved: 0 });
    await enter('terrain raise circle 30,30 r=5 by=1');
    expect(diffCounts(S().plan!.preview.diff).terrainArea).toBeGreaterThan(50);
    expect(diffCounts(null)).toEqual({ created: 0, changed: 0, removed: 0, terrainArea: 0, roadsAdded: 0, roadsRemoved: 0, disastersAdded: 0, disastersChanged: 0, disastersRemoved: 0 });
  });

  it('warnings: every item that is not plainly ok, plus the planner\'s warnings about anything else — an item is not counted twice', async () => {
    // Thirty houses on a 120 m road: not all fit — one warning ("N of 30"), and every placed item is ok.
    await enter('place building:house count=30 along=road:main side=north gap=2');
    const lines = planLines(S().plan);
    expect(lines.length).toBe(1);
    expect(lines[0].warnings.map((w) => w.key)).toEqual(['cmd37.warn.room']);
    expect(lines[0].items.every((i) => i.status === 'ok')).toBe(true);
    expect(warningCount(lines)).toBe(1);
    // Two crates on top of the first row of houses: both items are warned (overlap) and the planner sums that up in
    // one sentence — two things to look at, not three (the bar said "3 warnings" for two warned houses).
    await confirmPlan();
    const [hx, hz] = Object.values(useWorldStore.getState().doc.objects)[0].transform.position.filter((_, k) => k !== 1);
    await enter(`place crate count=2 at=${hx},${hz} gap=0.2`);
    const warned = planLines(S().plan);
    expect(warned[0].items.filter((i) => i.status === 'warn').length).toBe(2);
    expect(warned[0].warnings.map((w) => w.key)).toEqual(['cmd37.warn.placement']);
    expect(warningCount(warned)).toBe(2);
    expect(warningCount([])).toBe(0);
    expect(planLines(null)).toEqual([]);
  });
});
