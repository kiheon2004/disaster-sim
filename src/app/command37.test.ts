/**
 * Phase 37 (§9, §10, §11, §14, §15, §20): the command bar's flow on the app's own stores — plan → preview → confirm →
 * one undo step; Esc; questions; commands that act at once; scripts; a disaster placed by a command is the instance a
 * mouse placement makes; a failed command leaves document, history and selection as they were.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { identityTransform, type Vec3 } from '@/core/types';
import { drawRoad } from '@/roads/network';
import { defaultProfile } from '@/roads/types';
import { phenomena } from '@/phenomena/registry';
import type { EventSpec } from '@/events/specs';
import { useWorldStore } from '@/world/worldStore';
import { createEmptyDocument } from '@/world/WorldDocument';
import { terrainBitsHash, worldFingerprint } from '@/world/fingerprint';
import { useEditorStore } from '@/editor/editorStore';
import { usePlacementStore } from '@/ui/placement/placementStore';
import { useCommandSession } from '@/ui/Command/commandSession';
import { cancelCommand, chooseOption, commandContext, confirmPlan, draftCommand, enterAppliesAtOnce, escapeCommand, historyScript, installCommandSession, proposeCommand, runScript, submitCommand, understandCommand } from './commandActions';
import { placeAt } from './placementActions';
import { installInputPolicy } from './inputPolicy';

beforeAll(() => {
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame ??= (f: () => void) => setTimeout(f, 0);
  installCommandSession();
});

const W = () => useWorldStore.getState();
const ED = () => useEditorStore.getState();
const S = () => useCommandSession.getState();
const at = (x: number, z: number) => ({ ...identityTransform(), position: [x, 0, z] as Vec3 });
const bits = () => `${worldFingerprint(W().doc)} ${terrainBitsHash(W().doc)}`;
const type = (text: string) => S().setText(text);
const enter = async (text: string) => {
  type(text);
  return submitCommand();
};
const instances = () => W().doc.scenario.experiment?.instances ?? [];

beforeEach(() => {
  W().setLocked(false);
  W().replaceDocument(createEmptyDocument());
  W().applyEdit({ roads: drawRoad(W().doc.roads, [[-60, 0], [60, 0]], { curved: false, profile: defaultProfile() }).network });
  ED().setMode('editor');
  ED().select(null);
  usePlacementStore.getState().disarm();
  usePlacementStore.getState().select(null);
  S().setText('');
  S().setPlan(null);
  S().setFeedback({ k: 'none' });
  S().setResults([]);
  S().setSettings({ applySmall: false, scriptPerLine: false });
});

describe('plan → preview → confirm', () => {
  it('Enter makes the plan (nothing changes yet); Enter again confirms it as ONE undo step; undo takes all of it back', async () => {
    const before = bits();
    const steps = W().past.length;
    expect(await enter('place building:house count=3 along=road:main side=north gap=2')).toBe('planned');
    expect(bits()).toBe(before);
    expect(W().past.length).toBe(steps);
    const plan = S().plan!;
    expect(plan.armed).toBe(true);
    expect(plan.canonical).toEqual(['place building:house count=3 along=road:main side=north gap=2']);
    expect(plan.preview.diff!.added.length).toBe(3);
    expect(await submitCommand()).toBe('applied');
    expect(Object.keys(W().doc.objects).length).toBe(3);
    expect(W().past.length).toBe(steps + 1);
    expect(S().plan).toBeNull();
    expect(S().text).toBe('');
    expect(S().results.length).toBe(1);
    expect(S().results[0].length).toBe(3);
    expect(S().feedback.k).toBe('done');
    expect(S().history[S().history.length - 1]).toBe('place building:house count=3 along=road:main side=north gap=2');
    W().undo();
    expect(bits()).toBe(before);
    // "The ones just made" no longer exist: the result set is gone with them.
    expect(S().results).toEqual([]);
  });

  it('"group them and call them …" after that is one more step, on what the first command made', async () => {
    await enter('place building:house count=3 along=road:main side=north');
    await submitCommand();
    const steps = W().past.length;
    expect(await enter('group last name="북쪽 블록"')).toBe('planned');
    expect(await submitCommand()).toBe('applied');
    expect(W().past.length).toBe(steps + 1);
    expect(Object.values(W().doc.groups ?? {})).toEqual([{ name: '북쪽 블록' }]);
    W().undo();
    expect(W().doc.groups).toBeUndefined();
    expect(Object.values(W().doc.objects).every((o) => o.group === undefined)).toBe(true);
  });

  it('editing the text of an open plan drops it (Enter then plans anew); Esc cancels the plan, then has nothing to cancel', async () => {
    const before = bits();
    await enter('place tree count=2 at=0,30');
    expect(S().plan?.armed).toBe(true);
    type('place tree count=3 at=0,30');
    expect(S().plan).toBeNull();
    expect(await submitCommand()).toBe('planned');
    expect(S().plan!.preview.diff!.added.length).toBe(3);
    expect(cancelCommand()).toBe(true);
    expect(S().plan).toBeNull();
    expect(bits()).toBe(before);
    expect(cancelCommand()).toBe(false);
    expect(await confirmPlan()).toBe('empty');
  });

  it('while typing a draft plan follows the text; it cannot be confirmed without Enter and never shows an error', () => {
    const before = bits();
    type('place tree count=2 at=0,30');
    draftCommand();
    expect(S().plan).toMatchObject({ armed: false });
    expect(S().plan!.preview.diff!.added.length).toBe(2);
    expect(S().understood).toEqual(['place tree count=2 at=0,30']);
    type('place tree count=2 at=');
    draftCommand();
    expect(S().plan).toBeNull();
    expect(S().understood).toBeNull();
    expect(S().feedback.k).toBe('none');
    // Commands that act at once are understood, not run, by typing them.
    type('count type:tree');
    draftCommand();
    expect(S().plan).toBeNull();
    expect(S().understood).toEqual(['count type:tree']);
    expect(S().feedback.k).toBe('none');
    expect(bits()).toBe(before);
  });

  it('a large edit asks for one more Enter', async () => {
    // (210 barrels in a row, 0.1 m apart: about 150 m — inside the 200 m world)
    expect(await enter('place barrel count=210 at=0,40 gap=0.1')).toBe('planned');
    expect(S().plan!.preview.diff!.added.length).toBe(210);
    expect(S().plan!.confirm).toEqual({ key: 'cmd37.confirm.many', params: { count: 210 } });
    expect(await submitCommand()).toBe('confirm');
    expect(Object.keys(W().doc.objects).length).toBe(0);
    expect(await submitCommand()).toBe('applied');
    expect(Object.keys(W().doc.objects).length).toBe(210);
  });

  it('the world changed under an open plan: planned again — the same result is applied, another result is shown first', async () => {
    W().applyEdit({ add: [{ type: 'tree', transform: at(0, 30), seed: 1 }] });
    await enter('move type:tree by=1,0,0');
    // Something else changes that the plan does not depend on: confirmed as planned.
    W().applyEdit({ add: [{ type: 'crate', transform: at(40, 40), seed: 2 }] });
    expect(await submitCommand()).toBe('applied');
    expect(Object.values(W().doc.objects).find((o) => o.type === 'tree')!.transform.position[0]).toBe(1);
    // A second tree appears under the next plan: it would move two trees now — shown, with a notice, not applied.
    await enter('move type:tree by=1,0,0');
    W().applyEdit({ add: [{ type: 'tree', transform: at(10, 30), seed: 3 }] });
    const steps = W().past.length;
    expect(await submitCommand()).toBe('replanned');
    expect(S().plan?.notice).toEqual({ key: 'cmd37.notice.replanned' });
    expect(S().plan!.preview.diff!.moved.length).toBe(2);
    expect(W().past.length).toBe(steps);
    expect(await submitCommand()).toBe('applied');
    expect(Object.values(W().doc.objects).filter((o) => o.type === 'tree').map((o) => o.transform.position[0]).sort((a, b) => a - b)).toEqual([2, 11]);
  });
});

describe('an open plan ends with what ends every preview (§9)', () => {
  it('arming an edit tool or a disaster placement, switching mode, replacing the document: the plan is dropped', async () => {
    const off = installInputPolicy();
    const open = async () => {
      await enter('place tree count=2 at=0,30');
      expect(S().plan?.armed).toBe(true);
    };
    await open();
    ED().setTool('brush');
    expect(S().plan).toBeNull();
    ED().setTool('select');
    await open();
    usePlacementStore.getState().arm('blast', phenomena.implemented('blast')!.defaults());
    expect(S().plan).toBeNull();
    usePlacementStore.getState().disarm();
    await open();
    ED().setMode('simulation');
    expect(S().plan).toBeNull();
    ED().setMode('editor');
    await open();
    await submitCommand();
    expect(S().results.length).toBe(1);
    await open();
    W().replaceDocument(createEmptyDocument());
    expect(S().plan).toBeNull();
    // A new document: nothing was "just made" in it.
    expect(S().results).toEqual([]);
    off();
  });
});

describe('commands that act at once', () => {
  it('queries, the camera and selection: applied by the first Enter, the document and the history untouched', async () => {
    W().applyEdit({ add: [{ type: 'tree', transform: at(0, 30), seed: 1 }, { type: 'tree', transform: at(5, 30), seed: 2 }, { type: 'car', transform: at(0, 1.75), seed: 3 }] });
    const before = bits(), past = W().past, doc = W().doc;
    expect(await enter('count type:tree')).toBe('applied');
    const f = S().feedback;
    expect(f.k === 'done' && f.lines[0].plan.table?.title).toEqual({ key: 'cmd37.sum.count', params: { count: 2 } });
    expect(f.k === 'done' && f.changed).toBe(false);
    expect(ED().selectedIds).toEqual([]);
    expect(await enter('select type:tree')).toBe('applied');
    expect(ED().selectedIds.length).toBe(2);
    expect(await enter('focus type:car')).toBe('applied');
    // (the camera moved; the selection is still the trees)
    expect(ED().selectedIds.length).toBe(2);
    expect(await enter('select none')).toBe('applied');
    expect(ED().selectedIds).toEqual([]);
    expect(W().doc).toBe(doc);
    expect(W().past).toBe(past);
    expect(bits()).toBe(before);
  });

  it('with "small edits apply at once" switched on: one tree is placed by the first Enter; a delete still previews', async () => {
    S().setSettings({ applySmall: true });
    expect(await enter('place tree at=0,30')).toBe('applied');
    expect(Object.keys(W().doc.objects).length).toBe(1);
    expect(W().past.length).toBe(2);
    expect(await enter('delete type:tree')).toBe('planned');
    expect(await enter('terrain raise circle 30,30 r=5 by=1')).toBe('planned');
    expect(await enter('road 0,0 -> 0,40')).toBe('planned');
    expect(await enter('place tree count=30 at=0,40 gap=1')).toBe('planned');
  });
});

describe('questions and things not understood', () => {
  it('"which side of the road?": the options are complete commands; choosing one plans it', async () => {
    expect(await enter('place building:house count=2 along=road:main')).toBe('feedback');
    const f = S().feedback;
    if (f.k !== 'clarify') throw new Error('expected a question');
    expect(f.question.key).toBe('cmd37.ask.side');
    expect(f.options.map((o) => o.canonical)).toEqual(['place building:house count=2 along=road:main side=left', 'place building:house count=2 along=road:main side=right']);
    expect(Object.keys(W().doc.objects).length).toBe(0);
    await chooseOption(1);
    expect(S().text).toBe('place building:house count=2 along=road:main side=right');
    expect(S().plan?.armed).toBe(true);
    expect(await submitCommand()).toBe('applied');
    expect(Object.values(W().doc.objects).every((o) => o.transform.position[2] > 0)).toBe(true);
  });

  it('text that is not a command, and a command about nothing: a message, and nothing changes', async () => {
    const before = bits(), past = W().past;
    expect(await enter('frobnicate the widgets')).toBe('feedback');
    expect(S().feedback.k).toBe('unknown');
    expect(await enter('move type:crate by=1,0,0')).toBe('feedback');
    expect(S().feedback).toMatchObject({ k: 'error', error: { key: 'cmd37.err.noMatch' } });
    expect(cancelCommand()).toBe(true);
    expect(S().feedback.k).toBe('none');
    expect(bits()).toBe(before);
    expect(W().past).toBe(past);
    expect(await enter('   ')).toBe('empty');
  });

  it('a failed script leaves the selection as it was', async () => {
    const ids = W().applyEdit({ add: [{ type: 'tree', transform: at(0, 30), seed: 1 }, { type: 'tree', transform: at(5, 30), seed: 2 }] });
    ED().setSelection(ids, ids[0]);
    const before = bits();
    S().setSettings({ applySmall: true });
    // Line 1 would delete the selected trees; line 2 fails — everything is taken back, the selection included.
    expect(await runScript('delete selection\nmove type:crate by=1,0,0')).toBe('feedback');
    expect(S().feedback).toMatchObject({ k: 'error', line: 1 });
    expect(bits()).toBe(before);
    expect([...ED().selectedIds].sort()).toEqual([...ids].sort());
    expect(ED().selectedId).toBe(ids[0]);
  });
});

describe('scripts', () => {
  const SCRIPT = ['# a small block north of the road', 'place building:house count=3 along=road:main side=north gap=2', 'group last name="North block"', '', 'place car count=2 along=road:main', 'disaster blast at=0,-30 energy=2e9 start=3'].join('\n');

  it('several lines: one plan, one preview, one undo step — or one step per line', async () => {
    const before = bits(), steps = W().past.length;
    expect(await runScript(SCRIPT)).toBe('planned');
    expect(S().plan!.canonical.length).toBe(4);
    expect(S().plan!.preview.diff!.added.length).toBe(5);
    expect(bits()).toBe(before);
    expect(await submitCommand()).toBe('applied');
    expect(W().past.length).toBe(steps + 1);
    expect(instances().length).toBe(1);
    W().undo();
    expect(bits()).toBe(before);
    // One step per line.
    expect(await runScript(SCRIPT, true)).toBe('planned');
    expect(await submitCommand()).toBe('applied');
    expect(W().past.length).toBe(steps + 4);
    for (let k = 0; k < 4; k++) W().undo();
    expect(bits()).toBe(before);
    expect(historyScript().split('\n').length).toBeGreaterThan(0);
  });

  it('a line that is not understood stops the whole script before anything is planned', async () => {
    const before = bits();
    expect(await runScript('place tree at=0,30\nfrobnicate\nplace tree at=5,30')).toBe('feedback');
    expect(S().feedback).toMatchObject({ k: 'unknown', reason: { key: 'cmd37.err.scriptLine', params: { line: 2 } } });
    expect(bits()).toBe(before);
    expect(await runScript(Array.from({ length: 501 }, (_, k) => `place tree at=${k % 90},30`).join('\n'))).toBe('feedback');
    expect(S().feedback).toMatchObject({ k: 'error', error: { key: 'cmd37.err.scriptTooLong' } });
  });
});

describe('disasters', () => {
  it('a disaster placed by a command is the instance a mouse click places — and one world undo step', async () => {
    // The mouse: arm the library card with this template, click the map at (60, 0).
    const def = phenomena.implemented('blast')!;
    usePlacementStore.getState().arm('blast', { ...def.defaults(), energy: 1.8e9 } as EventSpec);
    usePlacementStore.getState().setContinuous(false);
    const id = placeAt([60, 0])!;
    const byMouse = instances().find((i) => i.id === id)!;
    W().undo();
    expect(instances()).toEqual([]);
    usePlacementStore.getState().disarm();
    // The command.
    const steps = W().past.length;
    expect(await enter('disaster blast at=node:n2 energy=1.8e9')).toBe('planned');
    expect(S().plan!.preview.diff!.instances.added.length).toBe(1);
    expect(instances()).toEqual([]);
    expect(await submitCommand()).toBe('applied');
    expect(instances()).toEqual([byMouse]);
    expect(W().past.length).toBe(steps + 1);
    W().undo();
    expect(instances()).toEqual([]);
  });

  it('while a simulation runs on the world: edits are refused with the reason, a disaster is written (no undo step)', async () => {
    W().applyEdit({ add: [{ type: 'tree', transform: at(0, 30), seed: 1 }] });
    W().setLocked(true);
    expect(commandContext().simulating).toBe(true);
    const past = W().past;
    expect(await enter('move type:tree by=1,0,0')).toBe('feedback');
    expect(S().feedback).toMatchObject({ k: 'error', error: { key: 'cmd37.err.simulating' } });
    expect(await enter('count type:tree')).toBe('applied');
    expect(await enter('disaster blast at=10,10 energy=2e9')).toBe('planned');
    expect(await submitCommand()).toBe('applied');
    expect(instances().map((i) => i.type)).toEqual(['blast']);
    expect(W().past).toBe(past);
    W().setLocked(false);
  });
});

describe('for the bar\'s own controls (ui)', () => {
  it('a proposed command (context menu, suggestion, example) is put in the bar and drafted — it does not run', () => {
    const before = bits(), past = W().past;
    proposeCommand('place tree count=2 at=12.3,-4.5');
    expect(S().text).toBe('place tree count=2 at=12.3,-4.5');
    expect(S().understood).toEqual(['place tree count=2 at=12.3,-4.5']);
    expect(S().plan).toMatchObject({ armed: false });
    expect(S().plan!.preview.diff!.added.length).toBe(2);
    expect(bits()).toBe(before);
    expect(W().past).toBe(past);
  });

  it('a proposed command replaces an open plan; a sentence that is not understood is proposed without an error', async () => {
    await enter('place tree at=0,30');
    expect(S().plan?.armed).toBe(true);
    proposeCommand('disaster blast at=5,5');
    expect(S().plan).toMatchObject({ armed: false, text: 'disaster blast at=5,5' });
    proposeCommand('frobnicate here');
    expect(S().plan).toBeNull();
    expect(S().understood).toBeNull();
    expect(S().feedback.k).toBe('none');
  });

  it('with the live preview paused only the parser follows the text: "understood as" is kept up, no plan is made, nothing is timed', async () => {
    const before = bits();
    S().setDraftMs(450);
    type('place tree count=2 at=0,30');
    understandCommand();
    expect(S().understood).toEqual(['place tree count=2 at=0,30']);
    expect(S().plan).toBeNull();
    // (the slow time stays: the pause lasts until the bar is empty and drafted again)
    expect(S().draftMs).toBe(450);
    type('place tree count=2 at=');
    understandCommand();
    expect(S().understood).toBeNull();
    expect(S().feedback.k).toBe('none');
    // Enter still plans; an open plan is not touched by the parser pass.
    expect(await enter('place tree count=2 at=0,30')).toBe('planned');
    const plan = S().plan;
    S().setUnderstood(null);
    understandCommand();
    expect(S().plan).toBe(plan);
    expect(S().understood).toBeNull();
    cancelCommand();
    type('');
    draftCommand();
    expect(S().draftMs).toBeLessThan(50);
    expect(bits()).toBe(before);
  });

  it('enterAppliesAtOnce: only a draft of the current text that needs no preview', async () => {
    expect(enterAppliesAtOnce()).toBe(false);
    proposeCommand('place tree at=0,30');
    expect(enterAppliesAtOnce()).toBe(false);
    S().setSettings({ applySmall: true });
    expect(enterAppliesAtOnce()).toBe(true);
    // The text moved on from the draft: nothing is promised about it.
    type('place tree at=0,31');
    expect(enterAppliesAtOnce()).toBe(false);
    proposeCommand('delete type:tree');
    expect(enterAppliesAtOnce()).toBe(false);
    // A disaster that starts at once has nothing to preview, with or without the setting.
    S().setSettings({ applySmall: false });
    proposeCommand('disaster blast at=5,5 now');
    expect(S().plan).toMatchObject({ armed: false });
    expect(enterAppliesAtOnce()).toBe(true);
    // An open plan is confirmed, not "applied at once".
    await enter('place tree at=0,30');
    expect(enterAppliesAtOnce()).toBe(false);
  });

  it('Esc outside the bar: an open plan, then an open question, goes first; a draft or a message does not take the key', async () => {
    const before = bits();
    expect(escapeCommand()).toBe(false);
    // A draft (typed, no Enter): Esc stays the editor's.
    proposeCommand('place tree at=0,30');
    expect(escapeCommand()).toBe(false);
    expect(S().plan).toMatchObject({ armed: false });
    // An open plan: cancelled, once.
    await enter('place tree count=2 at=0,30');
    expect(escapeCommand()).toBe(true);
    expect(S().plan).toBeNull();
    expect(escapeCommand()).toBe(false);
    // A question.
    await enter('place building:house count=2 along=road:main');
    expect(S().feedback.k).toBe('clarify');
    expect(escapeCommand()).toBe(true);
    expect(S().feedback.k).toBe('none');
    // A message about a command that could not run is not a reason to take Esc from the viewport.
    await enter('move type:crate by=1,0,0');
    expect(S().feedback.k).toBe('error');
    expect(escapeCommand()).toBe(false);
    expect(S().feedback.k).toBe('error');
    expect(bits()).toBe(before);
  });
});

describe('a line that starts with an object id', () => {
  it('"#<id> …" is a command, not a script comment — a sentence, a canonical line, and a line of a script', async () => {
    // Found in Chrome (S11): "#building_…에 화재, 12초 뒤에" did nothing at all — every line starting with # was dropped as
    // a comment, with no message.
    const [id] = W().applyEdit({ add: [{ type: 'tree', transform: at(10, 20) }] });
    expect(await enter(`#${id}에 화재, 12초 뒤에`)).toBe('planned');
    expect(S().plan!.canonical).toEqual([`disaster fire at=#${id} start=12`]);
    expect(await confirmPlan()).toBe('applied');
    expect(instances().map((i) => [i.type, i.start])).toEqual([['fire', { at: 12 }]]);
    // In a script: comments ("# …", "#") are skipped, an id line runs.
    expect(await enter(`# a comment\n#\n#${id} 숨겨\n   # another comment\nselect none`)).toBe('planned');
    expect(S().plan!.canonical).toEqual([`hide #${id}`, 'select none']);
    expect(await confirmPlan()).toBe('applied');
    expect(W().doc.objects[id].hidden).toBe(true);
    // "#word" that is neither a comment nor an id is reported, never skipped: the script does not run.
    const before = bits();
    expect(await enter('#todo\nplace tree at=0,30')).toBe('feedback');
    expect(S().feedback.k).toBe('unknown');
    expect(bits()).toBe(before);
    // Only comments: Enter says so.
    expect(await enter('# nothing here')).toBe('feedback');
    expect(S().feedback).toMatchObject({ k: 'error', error: { key: 'cmd37.err.onlyComments' } });
    expect(bits()).toBe(before);
  });
});

