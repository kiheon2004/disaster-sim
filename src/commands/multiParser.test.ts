import { describe, expect, it } from 'vitest';
import { parseCommands } from './RuleBasedParser';
import { dispatchCommands, type CommandTarget } from './CommandDispatcher';
import type { ParseDefaults } from './CommandParser';
import type { EventSpec } from '@/events/specs';

const D: ParseDefaults = { direction: 'E', duration: 60, gustStrength: 0.25 };

async function run(input: string, scheduled: Record<string, number> = {}) {
  const r = parseCommands(input, D);
  const got: { spec: EventSpec; delay: number }[] = [];
  const target: CommandTarget = {
    runEvents: async (ev) => void got.push(...ev),
    play: () => {}, pause: () => {}, reset: async () => {}, setSpeed: () => {},
    findScheduled: (type) => scheduled[type] ?? null,
  };
  const report = await dispatchCommands(r.commands, target);
  return { r, got, report, types: got.map((g) => g.spec.event) };
}

describe('multi-phenomenon commands (Phase 15)', () => {
  it('"태풍을 발생시키고 10초 후 지진을 발생시켜" → wind now, earthquake at +10 s', async () => {
    const { r, got, types } = await run('태풍을 발생시키고 10초 후 지진을 발생시켜');
    expect(r.ok).toBe(true);
    expect(types).toEqual(['wind', 'earthquake']);
    expect(got.map((g) => g.delay)).toEqual([0, 10]);
  });

  it('"시간당 100mm의 비와 초속 30m의 바람을 동시에 발생시켜" → rain 100 mm/h and wind 30 m/s, both now', async () => {
    const { got } = await run('시간당 100mm의 비와 초속 30m의 바람을 동시에 발생시켜');
    expect(got.find((g) => g.spec.event === 'rain')!.spec).toMatchObject({ intensity: 100 });
    expect(got.find((g) => g.spec.event === 'wind')!.spec).toMatchObject({ speed: 30 });
    expect(got.every((g) => g.delay === 0)).toBe(true);
  });

  it('"Start an earthquake 10 seconds after the typhoon begins" → relative to the scheduled typhoon', async () => {
    const { r, got, report } = await run('Start an earthquake 10 seconds after the typhoon begins', { wind: 5 });
    expect(r.commands[0].after).toEqual({ type: 'wind', anchor: 'start', offset: 10 });
    expect(got).toHaveLength(1);
    expect(got[0].spec.event).toBe('earthquake');
    expect(got[0].delay).toBe(15);
    expect(report.unresolved).toEqual([]);
    // No typhoon scheduled → starts at now + 10 and is reported (never silently reinterpreted).
    const none = await run('Start an earthquake 10 seconds after the typhoon begins');
    expect(none.got[0].delay).toBe(10);
    expect(none.report.unresolved).toEqual([{ type: 'wind', offset: 10 }]);
  });

  it('relative to a phenomenon in the same command, also to its end', async () => {
    const { got } = await run('동쪽에서 30m/s 바람 40초 그리고 태풍이 끝나고 5초 뒤에 폭우를 시간당 50mm로 내려줘');
    expect(got.map((g) => [g.spec.event, g.delay])).toEqual([['wind', 0], ['rain', 45]]);
  });

  it('"Run heavy rainfall and strong wind simultaneously"', async () => {
    const { types, got } = await run('Run heavy rainfall and strong wind simultaneously');
    expect(types.sort()).toEqual(['rain', 'wind']);
    expect(got.every((g) => g.delay === 0)).toBe(true);
  });

  it('ground failure phenomena are executable since Phase 22 (default parameters)', async () => {
    for (const [text, type] of [['싱크홀을 만들어줘', 'sinkhole'], ['Trigger a landslide', 'landslide'], ['운석을 떨어뜨려', 'impact'], ['Drop an asteroid', 'impact']] as const) {
      const { got } = await run(text);
      expect(got.map((g) => g.spec.event)).toEqual([type]);
    }
  });

  it('planned phenomena (black hole, gravity …) are recognized but never executed (meteor: implemented since Phase 23)', async () => {
    for (const [text, type] of [['Create a black hole in the center', 'blackHole'], ['산소 농도를 낮춰', 'atmosphereLoss'], ['토네이도 발생', 'tornado']]) {
      const { r, got } = await run(text);
      expect(got).toHaveLength(0);
      expect(r.unsupported[0]?.event).toBe(type);
      expect(r.warnings[0].key).toBe('parse.unsupported.planned');
    }
    // Phase 31: gravity is implemented — recognized and pointed to the experiment editor, never executed from text.
    for (const text of ['중력을 절반으로 줄여', 'Switch to zero gravity']) {
      const { r, got } = await run(text);
      expect(got).toHaveLength(0);
      expect(r.unsupported[0]?.event).toBe('gravity');
      expect(r.warnings[0].key).toBe('parse.gravity.editor');
    }
  });
});
