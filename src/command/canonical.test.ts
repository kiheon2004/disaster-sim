/**
 * Phase 37 (§5, §20): the canonical command language. Canonical text → Intent → the same text; looser spellings
 * (case, units, Korean verbs, defaults left out) → the canonical text; anything else → an error that names the token
 * (never a guess).
 */
import { describe, expect, it } from 'vitest';
import { formatCanonical, formatNumber, parseCanonical, tokenize } from './canonical';
import { intentSchema, validateIntents, type Intent } from './intent';

/** Canonical lines, written by hand from the grammar: each must come back unchanged. */
const CANONICAL = [
  'place building:house count=3 along=road:main side=north gap=2 floors=2',
  'place building:house at=10,-20 heading=90',
  'place car:sedan count=5 along=road:n2-n3',
  'place tree at=cursor',
  'place container:40ft at=view',
  'select type:container:20ft',
  'place human count=4 at=next(#building_ab12cd3)',
  'place building:office at=north(node:n4,12)',
  'place car at=seg:s2@0.25 heading=180',
  'place streetLight count=6 along=seg:s1 side=left gap=15',
  'place crate at=east(group:"북쪽 블록")',
  'place tree at=feature:f2',
  'place barrel at=south(next(name:"Depot \\"A\\""),3.5)',
  'select selection',
  'select all',
  'select type:tree where slope>20',
  'select type:building:house where floors>=2 and near cursor r=30',
  'select type:car where on road',
  'select type:car where on road seg:s3 first 3',
  'select type:building where warning=braceDangling',
  'select type:building where warning tallest',
  'select all where hidden',
  'select all where locked and height<5',
  'select type:building nearest view first 2',
  'select group:"North block"',
  'select #tree_0a1b2c3d4',
  'select none',
  'add type:tree',
  'remove last',
  'move selection by=5,0,0',
  'move last by=0,0.5,0',
  'move group:"북쪽 블록" to=40,60',
  'move #car_1 to=node:n4',
  'rotate selection by=30',
  'rotate last by=-90',
  'scale selection x2',
  'scale type:tree x0.5',
  'set selection x=12.5',
  'set selection y=3 heading=270',
  'set last z=-4 scale=1.5',
  'set selection lift=0.5',
  'align selection axis=x mode=min ref=footprint',
  'align last axis=z mode=center ref=origin',
  'distribute selection axis=x',
  'distribute selection axis=z gaps',
  'match selection heading',
  'match selection height to=#building_1',
  'match last scale to=(selection first 1)',
  'copy structure from=(selection first 1) to=selection',
  'copy scale,heading from=#building_1 to=last',
  'copy params,physics,structure from=(type:building largest) to=(type:building where floors=2)',
  'group last name="북쪽 블록"',
  'group selection',
  'ungroup selection',
  'rename group:"북쪽 블록" "North block"',
  'rename selection "Depot"',
  'hide type:tree',
  'show all where hidden',
  'lock selection',
  'unlock all',
  'delete selection',
  'delete type:tree where near 0,0 r=15',
  'duplicate selection',
  'duplicate last offset=10,0',
  'terrain raise circle cursor r=10 by=2',
  'terrain lower rect -20,-20,20,20 by=1.5',
  'terrain flatten circle cursor r=10',
  'terrain flatten around selection r=4 to=3',
  'terrain smooth feature:f1',
  'paint circle view r=8 ground=grass',
  'paint rect 0,0,30,10 ground=asphalt',
  'road node:n4 -> 40,60 preset=street',
  'road 0,0 -> 50,0',
  'road cursor -> node:n1 preset=avenue',
  'forest feature:f3 density=low',
  'forest circle 30,30 r=25 density=0.4 seed=7',
  'forest rect -90,-90,-40,-40',
  'disaster blast at=node:n4 energy=1.8e9 start=5',
  'disaster earthquake magnitude=6.5 pga=0.4',
  'disaster fire at=#building_1 start=12',
  'disaster rain intensity=80 start=0',
  'disaster wind direction=E speed=40 now',
  'disaster earthquake magnitude=7 start=10 now',
  'disaster blast now',
  'disaster p3 delete',
  'disaster earthquake stop',
  'disaster fire#3 delete',
  'disaster p2 move to=10,10',
  'disaster all stop',
  'disaster blast pause',
  'disaster p1 resume',
  'run',
  'pause',
  'reset',
  'speed=2',
  'speed=0.25',
  'focus type:building tallest',
  'focus selection',
  'focus at=node:n4',
  'undo',
  'redo',
  'count type:building',
  'count all where hidden',
  'list type:building where warning',
  'list disasters',
  'count groups',
  'list roads',
  'info sim',
  'info selection',
  'info #building_1',
  'measure selection',
  'measure cursor view',
  'measure #a #b',
  'measure node:n1 node:n4',
];

/** Looser input → the canonical line it means. */
const LOOSE: [string, string][] = [
  ['PLACE Building:house COUNT=3', 'place Building:house count=3'],
  ['place tree at=(10, 20)', 'place tree at=10,20'],
  ['place car at=seg:s2', 'place car at=seg:s2@0.5'],
  ['place building gap=2m floors=2 along=road:main side=North', 'place building along=road:main side=north gap=2 floors=2'],
  ['move selection by=5m,0,0', 'move selection by=5,0,0'],
  ['rotate selection by=30°', 'rotate selection by=30'],
  ['select type:tree where slope>20°', 'select type:tree where slope>20'],
  ['align selection axis=x mode=min', 'align selection axis=x mode=min ref=origin'],
  ['copy structure from=#b1', 'copy structure from=#b1 to=selection'],
  ['copy structure,structure,scale from=#b1', 'copy structure,scale from=#b1 to=selection'],
  ['terrain flatten circle cursor r=10m', 'terrain flatten circle cursor r=10'],
  ['disaster blast energy=1800000000 at=node:n4 start=5s', 'disaster blast at=node:n4 energy=1.8e9 start=5'],
  ['disaster blast height=1 energy=4.184e6', 'disaster blast energy=4.184e6 height=1'],
  ['disaster P3 delete', 'disaster p3 delete'],
  ['speed 2', 'speed=2'],
  ['speed=2x', 'speed=2'],
  ['   run   ', 'run'],
  // Korean verb aliases (§5)
  ['배치 building:house count=3', 'place building:house count=3'],
  ['선택 type:tree', 'select type:tree'],
  ['이동 selection by=5,0,0', 'move selection by=5,0,0'],
  ['회전 selection by=30', 'rotate selection by=30'],
  ['정렬 selection axis=x mode=min ref=footprint', 'align selection axis=x mode=min ref=footprint'],
  ['그룹 last name="북쪽 블록"', 'group last name="북쪽 블록"'],
  ['삭제 selection', 'delete selection'],
  ['재난 blast at=node:n4 energy=1.8e9', 'disaster blast at=node:n4 energy=1.8e9'],
  ['실행', 'run'],
  ['일시정지', 'pause'],
  ['실행취소', 'undo'],
  ['개수 type:building', 'count type:building'],
];

/** Text that must NOT become a command, with the reason. */
const ERRORS: [string, string][] = [
  ['', 'empty'],
  ['   ', 'empty'],
  ['frobnicate selection', 'unknownVerb'],
  ['건물 세 채 놓아 줘', 'unknownVerb'],
  ['place', 'expected'],
  ['place building count=three', 'badValue'],
  ['place building count=0', 'badValue'],
  ['place building count=2.5', 'badValue'],
  ['place building colour=red', 'unknownKey'],
  ['place building count=2 count=3', 'duplicateKey'],
  ['place building at=somewhere', 'badValue'],
  ['place building at=1,2 along=seg:s1', 'invalid'],
  ['place building side=left', 'invalid'],
  ['place building extra', 'extra'],
  ['select', 'expected'],
  ['select trees', 'expected'],
  ['select type:tree where', 'expected'],
  ['select type:tree where slope', 'expected'],
  ['select type:tree where near cursor', 'expected'],
  ['select type:tree first', 'badValue'],
  ['select type:tree and then delete them', 'extra'],
  ['select none please', 'expected'],
  ['move selection', 'expected'],
  ['move selection by=5,0', 'badValue'],
  ['move selection by=5,0,0 to=1,1', 'expected'],
  ['rotate selection', 'expected'],
  ['scale selection 2', 'expected'],
  ['scale selection x0', 'expected'],
  ['set selection', 'expected'],
  ['set selection y=1 lift=2', 'invalid'],
  ['align selection axis=y mode=min', 'badValue'],
  ['match selection colour', 'badValue'],
  ['copy colour from=#a', 'badValue'],
  ['copy structure', 'expected'],
  ['group last name=North', 'badValue'],
  ['rename selection North', 'expected'],
  ['delete', 'expected'],
  ['delete selection now', 'extra'],
  ['terrain dig circle cursor r=3', 'badValue'],
  ['terrain raise circle cursor', 'expected'],
  ['terrain raise circle cursor r=10 to=3', 'invalid'],
  ['terrain raise blob', 'expected'],
  ['paint circle cursor r=3', 'expected'],
  ['road 0,0 50,0', 'expected'],
  ['road 0,0 ->', 'expected'],
  ['forest circle cursor r=10 seed=-1', 'badValue'],
  ['disaster', 'expected'],
  ['disaster blast at=nowhere', 'badValue'],
  ['disaster blast energy=1e9 energy=2e9', 'duplicateKey'],
  ['disaster blast boom', 'extra'],
  ['disaster blast now energy=1e9', 'extra'],
  ['disaster p3 delete now', 'extra'],
  ['disaster p3 move', 'expected'],
  ['disaster p3 delete to=1,1', 'unknownKey'],
  ['speed=fast', 'expected'],
  ['speed=0', 'expected'],
  ['focus', 'expected'],
  ['run now', 'extra'],
  ['undo that', 'extra'],
  ['count', 'expected'],
  ['measure', 'expected'],
  ['select group:"unterminated', 'unterminated'],
  ['place tree at=north(cursor', 'unterminated'],
  ['place tree at=north(cursor))', 'unterminated'],
];

describe('canonical command language', () => {
  it('canonical → Intent → the same canonical text (every command of the grammar)', () => {
    const bad: string[] = [];
    for (const line of CANONICAL) {
      const r = parseCanonical(line);
      if (!r.ok) { bad.push(`${line}  →  ${JSON.stringify(r.error)}`); continue; }
      const back = formatCanonical(r.intent);
      if (back !== line) bad.push(`${line}  →  ${back}`);
    }
    expect(bad).toEqual([]);
    // Every verb of the grammar is covered by the list.
    const kinds = new Set(CANONICAL.map((l) => { const r = parseCanonical(l); return r.ok ? r.intent.kind : '?'; }));
    expect([...kinds].sort()).toEqual([...intentSchema.options.map((o) => o.shape.kind.value)].sort());
  });

  it('Intent → canonical → the same Intent', () => {
    for (const line of CANONICAL) {
      const a = parseCanonical(line);
      expect(a.ok).toBe(true);
      if (!a.ok) continue;
      const b = parseCanonical(formatCanonical(a.intent));
      expect(b.ok && b.intent).toEqual(a.intent);
      expect(validateIntents([a.intent]).ok).toBe(true);
    }
  });

  it('looser spellings (case, units, defaults, Korean verbs, key order) → canonical', () => {
    const bad: string[] = [];
    for (const [input, want] of LOOSE) {
      const r = parseCanonical(input);
      const got = r.ok ? formatCanonical(r.intent) : JSON.stringify(r.error);
      if (got !== want) bad.push(`${input}  →  ${got}  (want ${want})`);
    }
    expect(bad).toEqual([]);
  });

  it('anything else is an error with a reason — never a guess', () => {
    const bad: string[] = [];
    for (const [input, code] of ERRORS) {
      const r = parseCanonical(input);
      if (r.ok) bad.push(`${JSON.stringify(input)} was accepted as ${formatCanonical(r.intent)}`);
      else if (r.error.code !== code) bad.push(`${JSON.stringify(input)}: ${r.error.code} (want ${code}) ${JSON.stringify(r.error)}`);
    }
    expect(bad).toEqual([]);
  });

  it('errors name the token they stopped at', () => {
    const r = parseCanonical('place building count=three');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ code: 'badValue', token: 'three', expected: 'count' });
    const r2 = parseCanonical('select type:tree and then delete them');
    if (!r2.ok) expect(r2.error.token).toBe('and');
  });

  it('numbers: shortest text, exponent form for large / tiny values, read back exactly', () => {
    const cases: [number, string][] = [[0, '0'], [-0, '0'], [2, '2'], [0.5, '0.5'], [-12.25, '-12.25'], [999999, '999999'], [1e6, '1e6'], [1.8e9, '1.8e9'], [4.184e6, '4.184e6'], [0.0001, '0.0001'], [0.00005, '5e-5'], [1 / 3, '0.3333333333333333']];
    for (const [v, s] of cases) {
      expect(formatNumber(v)).toBe(s);
      const r = parseCanonical(`set selection x=${s}`);
      expect(r.ok && (r.intent as Extract<Intent, { kind: 'set' }>).x).toBe(v === 0 ? 0 : v);
    }
  });

  it('tokens keep quoted text and parentheses whole', () => {
    expect(tokenize('group last name="a b \\" c"')).toEqual(['group', 'last', 'name="a b \\" c"']);
    expect(tokenize('copy scale from=(selection first 1) to=last')).toEqual(['copy', 'scale', 'from=(selection first 1)', 'to=last']);
    expect(tokenize('place tree at=north(next(#a), 5)')).toEqual(['place', 'tree', 'at=north(next(#a), 5)']);
    expect(tokenize('a "b')).toBeNull();
    expect(tokenize('a (b')).toBeNull();
    const r = parseCanonical('rename selection "say \\"hi\\" \\\\ there"');
    expect(r.ok && (r.intent as Extract<Intent, { kind: 'rename' }>).name).toBe('say "hi" \\ there');
    if (r.ok) expect(formatCanonical(r.intent)).toBe('rename selection "say \\"hi\\" \\\\ there"');
  });

  it('the schema refuses values the grammar cannot write (a provider cannot smuggle them in)', () => {
    const bad: unknown[] = [
      { kind: 'place', type: 'building', count: 0 },
      { kind: 'place', type: 'building', evil: true },
      { kind: 'move', target: { base: { b: 'selection' } } },
      { kind: 'move', target: { base: { b: 'selection' } }, by: [1, 2, Infinity] },
      { kind: 'delete', target: { base: { b: 'everything' } } },
      { kind: 'group', target: { base: { b: 'last' } }, name: 'x'.repeat(81) },
      { kind: 'eval', code: 'alert(1)' },
      { kind: 'query', op: 'count' },
      { kind: 'disaster', type: 'blast', fields: { energy: { $gt: 1 } } },
    ];
    for (const b of bad) expect(validateIntents([b]).ok).toBe(false);
    expect(validateIntents('nope').ok).toBe(false);
  });
});
