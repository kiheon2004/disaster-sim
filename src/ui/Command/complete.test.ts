/**
 * Phase 37 (§14): Tab completion of the command bar — the word under the caret → candidates from the grammar's own
 * tables (verbs, kinds, disaster types and their value names, each verb's keys) and from the document (ids, names).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { identityTransform, type Vec3 } from '@/core/types';
import type { WorldDocument } from '@/core/model';
import { parseCanonical, VERB_ALIASES_KO, VERBS, type Verb } from '@/command/canonical';
import { KIND_TYPES, KINDS } from '@/command/kinds';
import { phenomena } from '@/phenomena/registry';
import { drawRoad } from '@/roads/network';
import { defaultProfile } from '@/roads/types';
import { createEmptyDocument } from '@/world/WorldDocument';
import { scratchWorld } from '@/world/worldStore';
import { applyCompletion, complete, disasterFieldNames, MAX_CANDIDATES, VERB_KEYS } from './complete';

const at = (x: number, z: number) => ({ ...identityTransform(), position: [x, 0, z] as Vec3 });

let doc: WorldDocument;
let ids: string[];
beforeEach(() => {
  const w = scratchWorld(createEmptyDocument());
  const S = () => w.getState();
  S().applyEdit({ roads: drawRoad(S().doc.roads, [[-60, 0], [60, 0]], { curved: false, profile: defaultProfile() }).network });
  ids = S().applyEdit({ add: [{ type: 'tree', transform: at(0, 30), seed: 1 }, { type: 'tree', transform: at(5, 30), seed: 2 }, { type: 'car', transform: at(0, 1.75), seed: 3 }] });
  S().applyEdit({ update: [{ ...S().doc.objects[ids[0]], group: 'grp_a' }, { ...S().doc.objects[ids[1]], group: 'grp_a', name: 'Old oak' }] });
  S().setGroupName('grp_a', 'North block');
  doc = S().doc;
});

/** Candidates at the end of `text` (or at the `|` mark). */
function at_(text: string) {
  const caret = text.includes('|') ? text.indexOf('|') : text.length;
  const clean = text.replace('|', '');
  const c = complete(clean, caret, doc);
  return { c, clean, texts: c.candidates.map((x) => x.text) };
}

describe('the first word: verbs', () => {
  it('an empty bar offers every canonical verb; letters narrow them; speed is written speed=', () => {
    const all = at_('').texts;
    expect(all.length).toBe(Math.min(VERBS.length, MAX_CANDIDATES));
    expect(at_('').c.total).toBe(VERBS.length);
    expect(at_('pl').texts).toEqual(['place']);
    expect(at_('s').texts).toEqual(['select', 'scale', 'set', 'show', 'speed=']);
    expect(at_('SE').texts).toEqual(['select', 'set']);
    // A finished word is not offered again.
    expect(at_('place').texts).toEqual([]);
  });

  it('a Korean prefix completes to the Korean aliases of the verbs', () => {
    const r = at_('배');
    expect(r.texts.sort()).toEqual(Object.keys(VERB_ALIASES_KO).filter((k) => k.startsWith('배')).sort());
    expect(r.c.candidates.find((x) => x.text === '배치')?.hint).toBe('place');
  });

  it('accepting a verb puts it in with one space; an open form (speed=) gets none', () => {
    const r = at_('pl');
    expect(applyCompletion(r.clean, r.c, 0)).toEqual({ text: 'place ', caret: 6 });
    const s = at_('sp');
    expect(applyCompletion(s.clean, s.c, 0)).toEqual({ text: 'speed=', caret: 6 });
  });
});

describe('kinds, presets, ids and names', () => {
  it('place <kind>: every placeable kind of the palette, with its presets', () => {
    // Bare types (`tree` = its default preset) and every kind with its preset, none twice.
    expect(at_('place ').c.total).toBe(new Set([...KIND_TYPES, ...KINDS.map((k) => k.key)]).size);
    expect(at_('place ').texts.slice(0, 3)).toEqual(KIND_TYPES.slice(0, 3));
    const b = at_('place building:').texts;
    expect(b.length).toBeGreaterThan(2);
    expect(b.every((x) => x.startsWith('building:'))).toBe(true);
    expect(b).toContain('building:house');
    expect(at_('place tre').texts[0]).toBe('tree');
  });

  it('targets: selection words, types with presets, the document\'s groups, names and object ids', () => {
    const t = at_('select ').c;
    expect(t.total).toBeGreaterThan(MAX_CANDIDATES);
    expect(at_('select se').texts).toEqual(['selection']);
    expect(at_('select n').texts).toEqual(['none', 'name:"Old oak"']);
    expect(at_('delete type:tr').texts.slice(0, 1)).toEqual(['type:tree']);
    expect(at_('delete type:building:h').texts).toContain('type:building:house');
    expect(at_('select group:').texts).toEqual(['group:"North block"']);
    expect(at_('select #').texts.sort()).toEqual(ids.map((i) => `#${i}`).sort());
    const tree = at_(`select #${ids[1].slice(0, 8)}`).c.candidates.find((x) => x.text === `#${ids[1]}`);
    expect(tree?.hint).toContain('Old oak');
    // `none` is a word of select only.
    expect(at_('delete n').texts).toEqual(['name:"Old oak"']);
  });

  it('a group that lost its members is not offered (the planner would not find it either)', () => {
    const w = scratchWorld(doc);
    w.getState().applyEdit({ remove: [ids[0], ids[1]] });
    expect(complete('select group:', 13, w.getState().doc).candidates).toEqual([]);
  });

  it('places: words, road nodes and segments of the document', () => {
    expect(at_('place tree at=').texts.slice(0, 6)).toEqual(['cursor', 'view', 'center', 'junction', 'selection', 'last']);
    expect(at_('place tree at=node:').texts).toEqual(['node:n1', 'node:n2']);
    const segs = Object.keys(doc.roads.segments);
    expect(segs.length).toBe(1);
    expect(at_('place tree at=seg:').texts).toEqual([`seg:${segs[0]}`]);
    expect(at_('place building:house along=').texts).toEqual(['road:main', 'road:any', `seg:${segs[0]}`]);
    expect(at_('road node:n1 ').texts).toEqual(['->']);
    expect(at_('road node:n1 -> no').texts).toEqual(['node:n1', 'node:n2']);
  });

  it('only the value after key= is replaced', () => {
    const r = at_('place tree at=cu');
    expect(r.texts).toEqual(['cursor']);
    expect(r.c.from).toBe('place tree at='.length);
    expect(applyCompletion(r.clean, r.c, 0).text).toBe('place tree at=cursor ');
  });

  it('the word under the caret is replaced whole, also in the middle of a line', () => {
    const r = at_('place tr| count=3');
    expect(r.texts[0]).toBe('tree');
    expect(applyCompletion(r.clean, r.c, 0)).toEqual({ text: 'place tree count=3', caret: 10 });
  });

  it('a name with spaces is one word: "North block" stays together', () => {
    const r = at_('select group:"Nor');
    expect(r.texts).toEqual(['group:"North block"']);
    expect(applyCompletion(r.clean, r.c, 0).text).toBe('select group:"North block" ');
    expect(at_('group last name=').texts).toEqual(['"North block"']);
  });
});

describe('keys and values of the verb being typed', () => {
  it('after the kind: the keys of place that are not used yet', () => {
    expect(at_('place tree ').texts).toEqual(['count=', 'at=', 'along=', 'side=', 'gap=', 'floors=', 'heading=']);
    expect(at_('place tree count=3 at=0,0 ').texts).toEqual(['along=', 'side=', 'gap=', 'floors=', 'heading=']);
    expect(at_('place tree s').texts).toEqual(['side=']);
    expect(at_('place building:house along=road:main side=').texts).toEqual(['left', 'right', 'north', 'south', 'east', 'west']);
  });

  it('every key the table offers is a key the canonical grammar reads for that verb', () => {
    const base: Partial<Record<Verb, string>> = {
      place: 'place tree', move: 'move selection', rotate: 'rotate selection', set: 'set selection', align: 'align selection', distribute: 'distribute selection',
      match: 'match selection heading', copy: 'copy scale', group: 'group selection', duplicate: 'duplicate selection', terrain: 'terrain raise circle 0,0 r=5',
      paint: 'paint circle 0,0 r=5', road: 'road 0,0 -> 0,40', forest: 'forest circle 0,0 r=5', disaster: 'disaster blast', focus: 'focus',
    };
    for (const verb of VERBS) {
      expect(VERB_KEYS[verb], verb).toBeDefined();
      for (const key of VERB_KEYS[verb]) {
        const line = `${base[verb] ?? verb} ${key}=__`;
        const r = parseCanonical(line);
        // The value is nonsense on purpose: the parser must get as far as reading it, not stop at the key.
        expect(r.ok ? 'ok' : r.error.code, line).not.toBe('unknownKey');
        expect(r.ok ? 'ok' : r.error.code, line).not.toBe('extra');
      }
    }
  });

  it('values of the keys that have a fixed set', () => {
    expect(at_('align selection axis=').texts).toEqual(['x', 'z']);
    expect(at_('distribute selection axis=').texts).toEqual(['x', 'z', 'auto']);
    expect(at_('align selection axis=x mode=').texts).toEqual(['min', 'center', 'max']);
    expect(at_('paint circle 0,0 r=5 ground=').texts).toContain('asphalt');
    expect(at_('road 0,0 -> 0,40 preset=').texts).toContain('avenue');
    expect(at_('terrain ').texts).toEqual(['raise', 'lower', 'flatten', 'smooth']);
    expect(at_('terrain raise ').texts).toEqual(['rect', 'circle', 'around']);
    expect(at_('match selection ').texts.slice(0, 4)).toEqual(['to=', 'heading', 'height', 'scale']);
    expect(at_('select type:tree where ').texts).toContain('hidden');
    expect(at_('count ').texts).toEqual(expect.arrayContaining(['disasters', 'groups', 'roads', 'sim', 'selection']));
  });
});

describe('disasters', () => {
  it('types come from the registry; value names are the ones the planner accepts', () => {
    const types = phenomena.listImplemented().map((d) => d.type);
    expect(at_('disaster ').texts).toEqual(types.slice(0, MAX_CANDIDATES));
    expect(at_('disaster bl').texts).toEqual(['blast']);
    const fields = disasterFieldNames('blast');
    expect(fields).toContain('energy');
    const offered = at_('disaster blast ').texts;
    expect(offered).toEqual(expect.arrayContaining(['at=', 'start=', 'now', 'energy=']));
    for (const f of fields) expect(offered).toContain(`${f}=`);
    expect(at_('disaster blast at=0,0 en').texts).toEqual(['energy=']);
    // A used key is not offered again.
    expect(at_('disaster blast energy=2e9 ').texts).not.toContain('energy=');
    expect(disasterFieldNames('noSuchDisaster')).toEqual([]);
  });

  it('a placed disaster is offered by its id, with the operations it takes', () => {
    const w = scratchWorld(doc);
    const def = phenomena.implemented('blast')!;
    w.getState().setExperiment({ instances: [{ id: 'p1', type: 'blast', enabled: true, visualize: true, start: { at: 0 }, spec: def.defaults() }] });
    const d = w.getState().doc;
    expect(complete('disaster p', 10, d).candidates.map((c) => c.text)).toEqual(['p1']);
    expect(complete('disaster p1 ', 12, d).candidates.map((c) => c.text)).toEqual(expect.arrayContaining(['move', 'delete', 'stop', 'pause', 'resume']));
    expect(complete('disaster p1 move ', 17, d).candidates.map((c) => c.text)).toEqual(['to=']);
  });
});

describe('scripts and odd input', () => {
  it('a script is completed line by line', () => {
    const text = 'place tree at=0,30\npl\nundo';
    const c = complete(text, 21, doc);
    expect(c.candidates.map((x) => x.text)).toEqual(['place']);
    expect(applyCompletion(text, c, 0).text).toBe('place tree at=0,30\nplace \nundo');
  });

  it('after something that is not a verb there is nothing to offer; nothing throws on broken text', () => {
    expect(at_('frobnicate ').texts).toEqual([]);
    for (const text of ['select group:"unterminated', 'place tree at=(', 'disaster', '   ', 'move selection by=1,2,3 )))', 'copy scale from=(selection first 1']) {
      for (let caret = 0; caret <= text.length; caret++) expect(() => complete(text, caret, doc)).not.toThrow();
    }
    expect(applyCompletion('abc', { from: 0, to: 3, candidates: [], total: 0 }, 0)).toEqual({ text: 'abc', caret: 3 });
  });
});
