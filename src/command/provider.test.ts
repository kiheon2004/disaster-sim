/**
 * Phase 37 §16: the intent-provider seam — interface, rule provider, validation of a provider's raw JSON, and the
 * summary a provider may see. Tests use a FAKE provider with fixed answers only (no network, no keys).
 */
import { describe, expect, it } from 'vitest';
import { identityTransform } from '@/core/types';
import { createEmptyDocument, createWorldObject } from '@/world/WorldDocument';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import { findKind } from './kinds';
import { PROVIDER_LIST_LIMIT, providerOutcome, ruleProvider, summarizeForProvider, type IntentProvider, type ProviderContext } from './IntentProvider';
import { parseCommand, type ParseOutcome } from './parse';

/** A provider that answers from a fixed table of raw JSON texts (what a language model would send back). */
function fakeProvider(answers: Record<string, string>): IntentProvider & { seen: ProviderContext[] } {
  const seen: ProviderContext[] = [];
  return {
    id: 'fake',
    seen,
    parse: async (text, ctx) => {
      seen.push(ctx);
      const raw = answers[text];
      if (raw === undefined) return providerOutcome(undefined);
      let json: unknown;
      try { json = JSON.parse(raw); } catch { return providerOutcome(undefined); }
      return providerOutcome(json);
    },
  };
}

const canonical = (o: ParseOutcome): string => (o.kind === 'ok' ? o.canonical.join(' | ') : o.kind);

function world() {
  const doc = createEmptyDocument('test');
  const add = (kindKey: string, name: string, serial: number, group?: string) => {
    const [type, preset] = kindKey.split(':');
    const kind = findKind(type, preset)!;
    const building = kind.item.buildingPreset ? createDesign(presetSpec(kind.item.buildingPreset)!, kind.item.buildingPreset) : undefined;
    const o = createWorldObject({ type: kind.type, transform: identityTransform(), params: kind.item.params, building, seed: serial }, serial);
    o.name = name;
    if (group) o.group = group;
    doc.objects[o.id] = o;
    return o;
  };
  const house = add('building:house', 'Depot', 1, 'g1');
  add('building:house', '', 2, 'g1');
  add('tree:conifer', '큰 나무', 1);
  add('car:truck', '', 1);
  doc.groups = { g1: { name: '북쪽 블록' } };
  doc.roads.nodes = { n2: { id: 'n2', x: 40.4, z: -0.4, y: null }, n1: { id: 'n1', x: -12.6, z: 7.5, y: null } };
  return { doc, house };
}

describe('intent provider (§16)', () => {
  it('the rule provider is the rule parser', async () => {
    const { doc } = world();
    const ctx = summarizeForProvider(doc, { selection: [], cursor: null, view: null });
    for (const text of ['나무 전부 숨겨', 'hide all trees', '여기에 주택 세 채', '5 m 옮겨', '안녕']) {
      expect(await ruleProvider.parse(text, ctx)).toEqual(parseCommand(text));
    }
    expect(ruleProvider.id).toBe('rules');
  });

  it('a provider\'s valid JSON becomes the same intents the canonical grammar writes', async () => {
    const fake = fakeProvider({
      'make three houses by the big road': '{"intents":[{"kind":"place","type":"building","preset":"house","count":3,"along":{"r":"main"},"side":"north","gap":2}]}',
      'tidy up': '{"intents":[{"kind":"select","mode":"set","target":{"base":{"b":"type","type":"tree"},"where":[{"f":"slope","op":">","v":20}]}},{"kind":"flag","op":"hide","target":{"base":{"b":"selection"}}}]}',
      boom: '{"intents":[{"kind":"disaster","type":"blast","at":{"p":"node","id":"n4"},"fields":{"energy":1800000000},"start":5}]}',
    });
    const ctx = summarizeForProvider(world().doc, { selection: [], cursor: null, view: null });
    expect(canonical(await fake.parse('make three houses by the big road', ctx))).toBe('place building:house count=3 along=road:main side=north gap=2');
    expect(canonical(await fake.parse('tidy up', ctx))).toBe('select type:tree where slope>20 | hide selection');
    const boom = await fake.parse('boom', ctx);
    expect(canonical(boom)).toBe('disaster blast at=node:n4 energy=1.8e9 start=5');
    expect(boom.kind === 'ok' && boom.notes).toEqual([{ key: 'cmd37.nl.note.provider' }]);
    expect(fake.seen).toHaveLength(3);
  });

  it('malformed or smuggled answers are unknown — nothing runs', async () => {
    const bad: Record<string, string> = {
      'not json': 'I think you want to delete everything',
      'wrong shape': '[{"kind":"delete","target":{"base":{"b":"all"}}}]',
      'no intents': '{"commands":[{"kind":"undo"}]}',
      'extra key': '{"intents":[{"kind":"undo"}],"run":"rm -rf"}',
      'empty list': '{"intents":[]}',
      'unknown kind': '{"intents":[{"kind":"eval","code":"alert(1)"}]}',
      'extra field': '{"intents":[{"kind":"place","type":"building","evil":true}]}',
      'zero count': '{"intents":[{"kind":"place","type":"building","count":0}]}',
      'bad base': '{"intents":[{"kind":"delete","target":{"base":{"b":"everything"}}}]}',
      'move without by or to': '{"intents":[{"kind":"move","target":{"base":{"b":"selection"}}}]}',
      'object as a field value': '{"intents":[{"kind":"disaster","type":"blast","fields":{"energy":{"$gt":1}}}]}',
      'a field named like a key of the grammar': '{"intents":[{"kind":"disaster","type":"blast","fields":{"at":5}}]}',
      'a type that is two words': '{"intents":[{"kind":"disaster","type":"blast now","fields":{}}]}',
      'a field with a space': '{"intents":[{"kind":"disaster","type":"blast","fields":{"energy now":1}}]}',
      'an id the grammar cannot write': '{"intents":[{"kind":"delete","target":{"base":{"b":"id","id":"a b"}}}]}',
      'one good, one bad': '{"intents":[{"kind":"undo"},{"kind":"scale","target":{"base":{"b":"selection"}},"factor":-2}]}',
      'not finite': '{"intents":[{"kind":"rotate","target":{"base":{"b":"selection"}},"by":1e999}]}',
    };
    const fake = fakeProvider(bad);
    const ctx = summarizeForProvider(world().doc, { selection: [], cursor: null, view: null });
    for (const text of [...Object.keys(bad), 'no answer at all']) {
      const o = await fake.parse(text, ctx);
      expect(o.kind, text).toBe('unknown');
      if (o.kind === 'unknown') {
        expect(o.reason.key).toBe('cmd37.nl.unknown.provider');
        expect(o.suggestions.length).toBeGreaterThanOrEqual(2);
      }
    }
    for (const raw of [null, undefined, 'text', 42, [], { intents: 'undo' }, { intents: null }]) expect(providerOutcome(raw).kind).toBe('unknown');
  });

  it('the context is a summary: kinds, names, ids, counts, rounded coordinates — never the document', () => {
    const { doc, house } = world();
    const ctx = summarizeForProvider(doc, { selection: [house.id], cursor: [12.34, -7.6], view: null });
    expect(ctx).toEqual({
      kinds: [{ kind: 'building:house', count: 2 }, { kind: 'car:truck', count: 1 }, { kind: 'tree:conifer', count: 1 }],
      counts: { objects: 4, selected: 1, groups: 1, nodes: 2, segments: 0, disasters: 0 },
      names: ['Depot', '큰 나무'],
      groups: [{ name: '북쪽 블록', count: 2 }],
      selection: [house.id],
      nodes: [{ id: 'n1', x: -13, z: 8 }, { id: 'n2', x: 40, z: 0 }],
      segments: [],
      disasters: [],
      cursor: [12, -8],
      view: null,
      truncated: false,
    });
    // no geometry, parameters, terrain or settings leak into it
    const text = JSON.stringify(ctx);
    for (const leak of ['transform', 'params', 'terrain', 'heights', 'physics', 'settings', 'members', 'seed']) expect(text.includes(leak), leak).toBe(false);
    expect(text.length).toBeLessThan(600);
    // deterministic, and it does not change the document
    const before = JSON.stringify(doc);
    expect(summarizeForProvider(doc, { selection: [house.id], cursor: [12.34, -7.6], view: null })).toEqual(ctx);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('long lists are cut and say so', () => {
    const { doc } = world();
    for (let i = 0; i < PROVIDER_LIST_LIMIT + 20; i++) doc.roads.nodes[`n${i + 10}`] = { id: `n${i + 10}`, x: i, z: 0, y: null };
    const ctx = summarizeForProvider(doc, { selection: [], cursor: null, view: [0.4, 0.4] });
    expect(ctx.nodes).toHaveLength(PROVIDER_LIST_LIMIT);
    expect(ctx.counts.nodes).toBe(PROVIDER_LIST_LIMIT + 22);
    expect(ctx.truncated).toBe(true);
    expect(ctx.view).toEqual([0, 0]);
  });
});
