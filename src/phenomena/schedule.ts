/**
 * Experiment schedule resolution (Phase 15): PhenomenonInstances → absolute start times.
 *
 * An instance starts at a time (`{ at }`) or relative to another instance's start or end
 * (`{ after, anchor, offset }`, e.g. "earthquake 10 s after the typhoon starts"). Resolution is
 * a pure function of the plan (deterministic): references are followed depth-first, cycles,
 * missing / disabled references, invalid parameters and negative start times are reported and
 * those instances are NOT scheduled — nothing runs with a silently changed meaning.
 * The result is ordered by start time, ties by plan order (stable).
 */
import type { EventSpec } from '@/events/specs';
import { phenomena } from './registry';
import type { PhenomenonContext, PhenomenonInstance } from './types';

export interface ResolvedInstance {
  instance: PhenomenonInstance;
  /** Seconds after the experiment starts. */
  start: number;
  duration: number;
  end: number;
  /** Spec ready for the scheduler (startTime = experiment time base + start, seed applied). */
  spec: EventSpec;
}

export type ScheduleProblem = 'unknownType' | 'notImplemented' | 'invalidSpec' | 'missingRef' | 'disabledRef' | 'invalidRef' | 'cycle' | 'negativeStart';

export interface ScheduleIssue {
  id: string;
  problem: ScheduleProblem;
  detail?: string;
}

export interface Schedule {
  items: ResolvedInstance[];
  issues: ScheduleIssue[];
}

export function resolveSchedule(instances: readonly PhenomenonInstance[], ctx: PhenomenonContext, timeBase = 0): Schedule {
  const byId = new Map(instances.map((i) => [i.id, i]));
  const order = new Map(instances.map((i, k) => [i.id, k]));
  const issues: ScheduleIssue[] = [];
  const done = new Map<string, ResolvedInstance | null>();
  const visiting = new Set<string>();

  const resolve = (inst: PhenomenonInstance): ResolvedInstance | null => {
    if (done.has(inst.id)) return done.get(inst.id)!;
    const fail = (problem: ScheduleProblem, detail?: string) => {
      if (!done.has(inst.id)) {
        issues.push({ id: inst.id, problem, detail });
        done.set(inst.id, null);
      }
      return null;
    };
    if (visiting.has(inst.id)) return fail('cycle', inst.id);
    const def = phenomena.get(inst.type);
    if (!def) return fail('unknownType', inst.type);
    if (def.status !== 'implemented') return fail('notImplemented', inst.type);
    const parsed = def.schema.safeParse({ ...inst.spec, event: inst.type, startTime: undefined });
    if (!parsed.success) return fail('invalidSpec', parsed.error.issues[0]?.message);
    let spec = parsed.data;
    if (def.seeded && inst.seed !== undefined) spec = { ...spec, seed: inst.seed } as EventSpec;
    let start: number;
    if ('at' in inst.start) start = inst.start.at;
    else {
      const refId = inst.start.after;
      const ref = byId.get(refId);
      if (!ref) return fail('missingRef', refId);
      if (!ref.enabled) return fail('disabledRef', refId);
      visiting.add(inst.id);
      const r = resolve(ref);
      visiting.delete(inst.id);
      if (!r) return fail(issues.some((x) => x.id === refId && x.problem === 'cycle') ? 'cycle' : 'invalidRef', refId);
      start = (inst.start.anchor === 'start' ? r.start : r.end) + inst.start.offset;
    }
    if (!(start >= 0)) return fail('negativeStart', String(start));
    const duration = def.duration(spec, ctx);
    const item: ResolvedInstance = { instance: inst, start, duration, end: start + duration, spec: { ...spec, startTime: timeBase + start, ...((spec.event === 'terrainDeformation' || spec.event === 'sinkhole' || spec.event === 'landslide' || spec.event === 'impact' || spec.event === 'blast' || spec.event === 'heatSource' || spec.event === 'volcano' || spec.event === 'atmosphere' || spec.event === 'climate' || spec.event === 'gravity' || spec.event === 'celestial') && !spec.name ? { name: inst.id } : {}) } as EventSpec };
    done.set(inst.id, item);
    return item;
  };

  const items: ResolvedInstance[] = [];
  for (const inst of instances) {
    if (!inst.enabled) continue;
    const r = resolve(inst);
    if (r) items.push(r);
  }
  items.sort((a, b) => a.start - b.start || order.get(a.instance.id)! - order.get(b.instance.id)!);
  return { items, issues };
}

/** Next free instance id ("p1", "p2", …). */
export function nextInstanceId(instances: readonly PhenomenonInstance[]): string {
  let n = 1;
  const ids = new Set(instances.map((i) => i.id));
  while (ids.has(`p${n}`)) n++;
  return `p${n}`;
}

/** A new instance of an implemented phenomenon with its default parameters. */
export function createInstance(type: string, instances: readonly PhenomenonInstance[], spec?: EventSpec): PhenomenonInstance {
  const def = phenomena.implemented(type);
  if (!def) throw new Error(`Not an implemented phenomenon: ${type}`);
  const s = { ...(spec ?? def.defaults()) } as EventSpec & { startTime?: number };
  const at = s.startTime ?? 0;
  delete s.startTime;
  return { id: nextInstanceId(instances), type, spec: s, enabled: true, start: { at }, visualize: true };
}
