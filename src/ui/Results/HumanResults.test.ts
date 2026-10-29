import { describe, expect, it } from 'vitest';
import type { RuntimeEntity } from '@/simulation/SimulationRuntime';
import { createHumanState } from '@/simulation/human/state';
import { aggregateHumans, HUMAN_CSV_COLUMNS, HUMAN_EXPORT_SCHEMA, humanCsv, humanJson, seriesAt } from '@/simulation/human/summary';
import { seriesRuns } from './HumanResults';

const person = (id: string, ext: boolean) => {
  const human = ext ? createHumanState(1.75, 70, { model: 'extended' }, true)! : undefined;
  return { id, source: { type: 'human' }, flags: {}, human } as unknown as RuntimeEntity;
};

describe('human results (Phase 33 UI)', () => {
  it('NaN samples are gaps, not zeros', () => {
    expect(seriesRuns([1, 2, NaN, NaN, 3, NaN, 4, 5])).toEqual([[0, 1], [4], [6, 7]]);
    expect(seriesRuns([NaN])).toEqual([]);
  });

  it('aggregates, CSV and JSON carry the schema and units, unmeasured values as reasons', () => {
    const a = person('p1', true), b = person('p2', true);
    const st = a.human!;
    st.falls = 1; st.firstFall = 2.5; st.fallCause = 'wind'; st.impacts = 2; st.maxImpulse = 120; st.maxDecel = 300;
    st.risk.head = { peak: 0.7, cum: 0.7, hits: 1, level: 'moderate' };
    st.series!.t.push(0, 0.25); st.series!.speed.push(0, 1.5); st.series!.margin.push(1, NaN);
    const ag = aggregateHumans([a, b, person('p3', false)]);
    expect(ag).toMatchObject({ people: 2, legacy: 1, fallen: 1, falls: 1, firstFall: 2.5, impacts: 2, maxImpulse: 120 });
    expect(ag.levels.head.moderate).toBe(1);
    expect(ag.worst.none).toBe(1);
    expect(seriesAt(st.series, 'speed', 0.3)).toBe(1.5);
    expect(seriesAt(null, 'speed', 0.3)).toBeNaN();
    const csv = humanCsv([a, b], [], 3).split('\n');
    expect(csv[0]).toBe(`# schema: disaster-sim.human v${HUMAN_EXPORT_SCHEMA}`);
    expect(csv).toContain(HUMAN_CSV_COLUMNS.join(','));
    const row = csv.find((l) => l.startsWith('3.000,p1,extended,final'))!;
    expect(row.split(',')).toHaveLength(HUMAN_CSV_COLUMNS.length);
    expect(csv.some((l) => l.startsWith('p1,0.25,') && l.includes('not-measured'))).toBe(true);
    const j = humanJson([a, b], [])!;
    expect(j.schemaVersion).toBe(HUMAN_EXPORT_SCHEMA);
    expect(j.model).toBe('extended');
    expect(JSON.parse(JSON.stringify(j)).people[0].series.margin).toEqual([1, null]);
    expect(humanJson([person('x', false)], [])).toMatchObject({ model: 'legacy', people: 1 });
  });
});
