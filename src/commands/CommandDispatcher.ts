import type { SimSpeed } from '@/core/units';
import type { EventSpec } from '@/events/specs';
import type { ParsedCommand } from './CommandParser';
import { phenomena } from '@/phenomena/registry';

/**
 * What the Command System needs from the rest of the app. Injected so this module
 * never imports simulation/UI code (and can be tested with a fake).
 */
export interface CommandTarget {
  /** Schedule events (`delay` seconds from now) and start playing; enters simulation mode if needed. */
  runEvents(events: { spec: EventSpec; delay: number }[]): Promise<void>;
  /**
   * Seconds from now to the start / end of the latest scheduled event of a phenomenon type
   * (negative = already passed), or null when none is scheduled (Phase 15, relative starts).
   */
  findScheduled?(type: string, anchor: 'start' | 'end'): number | null;
  play(): void;
  pause(): void;
  reset(): Promise<void>;
  setSpeed(v: SimSpeed): void;
}

export interface DispatchReport {
  /** Relative starts whose reference phenomenon was not found (started at now + offset). */
  unresolved: { type: string; offset: number }[];
}

/**
 * Delay of an event that starts relative to another phenomenon: the latest event of that type
 * earlier in the same command, else the scheduled one, else now + offset (reported).
 */
function resolveAfter(pc: ParsedCommand, earlier: { spec: EventSpec; delay: number }[], target: CommandTarget, report: DispatchReport): number {
  const a = pc.after!;
  for (let i = earlier.length - 1; i >= 0; i--) {
    const ref = earlier[i];
    if (ref.spec.event !== a.type) continue;
    const def = phenomena.implemented(a.type);
    const dur = a.anchor === 'end' && def ? def.duration(ref.spec, { seed: 1, terrain: null }) : 0;
    return Math.max(0, ref.delay + dur + a.offset);
  }
  const t = target.findScheduled?.(a.type, a.anchor) ?? null;
  if (t !== null) return Math.max(0, t + a.offset);
  report.unresolved.push({ type: a.type, offset: a.offset });
  return Math.max(0, a.offset);
}

/** Execute parsed commands in order. Consecutive events are scheduled together. */
export async function dispatchCommands(commands: ParsedCommand[], target: CommandTarget): Promise<DispatchReport> {
  const report: DispatchReport = { unresolved: [] };
  const all: { spec: EventSpec; delay: number }[] = [];
  let batch: { spec: EventSpec; delay: number }[] = [];
  const flush = async () => {
    if (batch.length) await target.runEvents(batch);
    batch = [];
  };
  for (const pc of commands) {
    const c = pc.command;
    switch (c.kind) {
      case 'event': {
        const item = { spec: c.spec, delay: pc.after ? resolveAfter(pc, all, target, report) : pc.delay ?? 0 };
        batch.push(item);
        all.push(item);
        break;
      }
      case 'control':
        await flush();
        if (c.action === 'play') target.play();
        else if (c.action === 'pause') target.pause();
        else await target.reset();
        break;
      case 'speed':
        await flush();
        target.setSpeed(c.value);
        break;
    }
  }
  await flush();
  return report;
}
