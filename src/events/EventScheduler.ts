import type { EventContext, SimulationEvent } from './SimulationEvent';

export type EventStatus = 'pending' | 'active' | 'done' | 'superseded';

export interface ScheduledEvent {
  event: SimulationEvent;
  status: EventStatus;
  /** Time it actually ended (may be earlier than planned if superseded). */
  endedAt?: number;
}

/** Starts, updates and ends events against the simulation clock. */
export class EventScheduler {
  private items: ScheduledEvent[] = [];
  /** Bumped when the schedule changes (for UI). */
  rev = 0;

  add(event: SimulationEvent) {
    this.items.push({ event, status: 'pending' });
    this.items.sort((a, b) => a.event.startTime - b.event.startTime);
    this.rev++;
  }

  update(ctx: EventContext, dt: number, onStart?: (e: SimulationEvent) => void) {
    const t = ctx.time;
    for (const item of this.items) {
      if (item.status === 'pending' && t >= item.event.startTime) {
        // Supersede active events on the same channel.
        for (const other of this.items) {
          if (other.status === 'active' && other.event.channel === item.event.channel) {
            other.event.onEnd?.(ctx, 'superseded');
            other.status = 'superseded';
            other.endedAt = t;
          }
        }
        item.status = 'active';
        item.event.onStart?.(ctx);
        onStart?.(item.event);
        this.rev++;
      }
      if (item.status === 'active') {
        const local = t - item.event.startTime;
        if (local >= item.event.duration) {
          item.event.onEnd?.(ctx, 'finished');
          item.status = 'done';
          item.endedAt = t;
          this.rev++;
        } else {
          item.event.update(ctx, local, dt);
        }
      }
    }
  }

  list(): readonly ScheduledEvent[] {
    return this.items;
  }

  /** Planned end of the last event. */
  plannedEnd(): number {
    let end = 0;
    for (const i of this.items) {
      const e = i.endedAt ?? i.event.startTime + i.event.duration;
      if (e > end) end = e;
    }
    return end;
  }

  hasPendingOrActive() {
    return this.items.some((i) => i.status === 'pending' || i.status === 'active');
  }

  clear() {
    this.items = [];
    this.rev++;
  }
}
