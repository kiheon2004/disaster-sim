import { describe, expect, it } from 'vitest';
import { MetricsRecorder } from './MetricsRecorder';
import type { RuntimeEntity, SimulationRuntime } from '../SimulationRuntime';
import { DamageState } from '../damage/DamageState';

function fakeEntity(id: string, type: string, extra: Partial<RuntimeEntity> = {}): RuntimeEntity {
  return {
    id,
    source: { type } as RuntimeEntity['source'],
    def: { inert: false } as RuntimeEntity['def'],
    pose: { position: [1, 0, 2], quaternion: [0, 0, 0, 1] },
    localWind: { velocity: [0, 0, 0], speed: 30, freeStream: 35, global: 40, shelter: 0.86, turbulence: 0, shadowSource: 'b9', corner: false },
    windLoad: 1200,
    health: 0.4,
    peakState: DamageState.NORMAL,
    flags: {},
    displacement: 0,
    lastCause: null,
    ...extra,
  } as RuntimeEntity;
}

describe('MetricsRecorder', () => {
  it('records events with wind/force context and derives summary metrics', () => {
    const m = new MetricsRecorder(77);
    const tree = fakeEntity('t1', 'tree', { flags: { snapped: true }, peakState: DamageState.DESTROYED });
    const human = fakeEntity('h1', 'human', { flags: { fallen: true }, peakState: DamageState.CRITICAL });
    m.record(3.2, human, { eventType: 'FALLEN', cause: 'overload' });
    m.record(5.7, tree, { eventType: 'SNAPPED', cause: 'fatigue', damageAfter: 1 });
    m.record(5.9, tree, { eventType: 'DESTROYED', cause: 'fatigue' });
    const rt = { entities: new Map([['t1', tree], ['h1', human]]) } as unknown as SimulationRuntime;
    const env = { wind: { baseSpeed: 40 } } as never;
    m.sample(env, rt, 1);
    const s = m.summary(rt, 10);

    expect(m.events[0]).toMatchObject({ time: 3.2, objectId: 'h1', objectType: 'human', localWindSpeed: 30, globalWindSpeed: 40, force: 1200, shadowSource: 'b9' });
    expect(m.events[1].damageAfter).toBe(1);
    expect(s.totalDamageEvents).toBe(3);
    expect(s.firstDamageTime).toBe(3.2);
    expect(s.peakDamageTime).toBe(5.5);
    expect(s.peakDamageCount).toBe(2);
    expect(s.treesFallen).toBe(1);
    expect(s.humansFallen).toBe(1);
    expect(s.objectsDestroyed).toBe(1);
    expect(s.objectsDamaged).toBe(1);
    expect(s.maxWindSpeed).toBe(40);
    expect(s.seed).toBe(77);
  });
});
