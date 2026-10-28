import type { SimSpeed } from '@/core/units';
import type { EventSpec } from '@/events/specs';
import type { ParsedCommand } from './CommandParser';

/**
 * What the Command System needs from the rest of the app. Injected so this module
 * never imports simulation/UI code (and can be tested with a fake).
 */
export interface CommandTarget {
  /** Schedule events (`delay` seconds from now) and start playing; enters simulation mode if needed. */
  runEvents(events: { spec: EventSpec; delay: number }[]): Promise<void>;
  play(): void;
  pause(): void;
  reset(): Promise<void>;
  setSpeed(v: SimSpeed): void;
}

/** Execute parsed commands in order. Consecutive events are scheduled together. */
export async function dispatchCommands(commands: ParsedCommand[], target: CommandTarget): Promise<void> {
  let batch: { spec: EventSpec; delay: number }[] = [];
  const flush = async () => {
    if (batch.length) await target.runEvents(batch);
    batch = [];
  };
  for (const pc of commands) {
    const c = pc.command;
    switch (c.kind) {
      case 'event':
        batch.push({ spec: c.spec, delay: pc.delay ?? 0 });
        break;
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
}
