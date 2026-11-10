import type { EventContext, SimulationEvent } from './SimulationEvent';

/**
 * Phase 35.5: 'cancelled' = removed before it started (never ran); 'stopped' = ended early by the user (what it already did
 * stays); 'paused' = a sustained source switched off for a while (its local clock does not advance).
 */
export type EventStatus = 'pending' | 'active' | 'paused' | 'done' | 'superseded' | 'stopped' | 'cancelled';

/** A user control on one instance, at an absolute simulation time (replayed after a reset, so runs stay deterministic). */
export type EventControlOp = 'cancel' | 'stop' | 'pause' | 'resume';
export interface EventControl {
  t: number;
  op: EventControlOp;
}

export interface ScheduledEvent {
  event: SimulationEvent;
  /** Stable, deterministic key of the instance (experiment id "p3", or "blast#2" for a directly started event). */
  key: string;
  status: EventStatus;
  /** Time it actually ended (may be earlier than planned if superseded / stopped). */
  endedAt?: number;
  /** Seconds the instance spent paused (its local time = t − start − shift). */
  shift: number;
  pausedAt?: number;
  /** Pending controls, sorted by time. */
  controls: EventControl[];
}

/** Which controls an event supports while it runs (before its start every instance can be cancelled). */
export function controlsOf(event: SimulationEvent): { stop: boolean; pause: boolean } {
  return { stop: typeof event.stop === 'function', pause: typeof event.pause === 'function' && typeof event.resume === 'function' };
}

/** Starts, updates and ends events against the simulation clock. */
export class EventScheduler {
  private items: ScheduledEvent[] = [];
  /** Bumped when the schedule changes (for UI). */
  rev = 0;

  add(event: SimulationEvent, key: string = event.id, controls: readonly EventControl[] = []) {
    this.items.push({ event, key, status: 'pending', shift: 0, controls: [...controls].sort((a, b) => a.t - b.t) });
    // Stable sort: same-time events keep their insertion order (deterministic).
    this.items.sort((a, b) => a.event.startTime - b.event.startTime);
    this.rev++;
  }

  /** Queue a control for the instance `key` at absolute time `t` (applied at the first step at or after `t`). */
  control(key: string, op: EventControlOp, t: number): boolean {
    const item = this.items.find((i) => i.key === key);
    if (!item) return false;
    item.controls.push({ t, op });
    item.controls.sort((a, b) => a.t - b.t);
    this.rev++;
    return true;
  }

  private apply(item: ScheduledEvent, op: EventControlOp, ctx: EventContext) {
    const t = ctx.time;
    const ev = item.event;
    if (op === 'cancel') {
      if (item.status === 'pending') {
        item.status = 'cancelled';
        item.endedAt = t;
      }
      return;
    }
    if (op === 'stop') {
      if ((item.status === 'active' || item.status === 'paused') && ev.stop) {
        ev.stop(ctx);
        item.status = 'stopped';
        item.endedAt = t;
      } else if (item.status === 'pending') {
        item.status = 'cancelled';
        item.endedAt = t;
      }
      return;
    }
    if (op === 'pause') {
      if (item.status === 'active' && ev.pause && ev.resume) {
        ev.pause(ctx);
        item.status = 'paused';
        item.pausedAt = t;
      }
      return;
    }
    if (item.status === 'paused' && ev.resume) {
      item.shift += t - (item.pausedAt ?? t);
      item.pausedAt = undefined;
      item.status = 'active';
      ev.resume(ctx, item.shift);
    }
  }

  /**
   * Apply every control due at `ctx.time` (all instances, before any event updates — a live control applied between steps
   * and its replay after a reset take effect at the same point of the step).
   */
  applyDue(ctx: EventContext) {
    for (const item of this.items) {
      while (item.controls.length && item.controls[0].t <= ctx.time) {
        this.apply(item, item.controls.shift()!.op, ctx);
        this.rev++;
      }
    }
  }

  update(ctx: EventContext, dt: number, onStart?: (e: SimulationEvent) => void) {
    const t = ctx.time;
    this.applyDue(ctx);
    for (const item of this.items) {
      if (item.status === 'pending' && t >= item.event.startTime) {
        // Supersede active events on the same channel.
        for (const other of this.items) {
          if ((other.status === 'active' || other.status === 'paused') && other.event.channel === item.event.channel) {
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
        const local = t - item.event.startTime - item.shift;
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

  find(key: string): ScheduledEvent | undefined {
    return this.items.find((i) => i.key === key);
  }

  /** Planned end of the last event. */
  plannedEnd(): number {
    let end = 0;
    for (const i of this.items) {
      if (i.status === 'cancelled') continue;
      const e = i.endedAt ?? i.event.startTime + i.event.duration + i.shift;
      if (e > end) end = e;
    }
    return end;
  }

  hasPendingOrActive() {
    return this.items.some((i) => i.status === 'pending' || i.status === 'active' || i.status === 'paused');
  }

  clear() {
    this.items = [];
    this.rev++;
  }
}
