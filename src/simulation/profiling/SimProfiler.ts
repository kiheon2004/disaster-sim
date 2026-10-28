/**
 * Opt-in timing of the simulation core (no React / Three.js dependency).
 *
 * The controller times the physics step and every system; the wind field adds the time spent
 * inside `sample()`. Disabled by default — when off, each timed section costs one boolean check.
 * Values are accumulated and turned into averages when `snapshot()` is called (the dev HUD does
 * that a few times per second).
 */
export interface SimProfileSnapshot {
  /** Fixed simulation steps per controller tick (≈ per rendered frame). */
  stepsPerTick: number;
  /** Per-tick (frame) cost in ms. */
  tickMs: number;
  physicsMs: number;
  windMs: number;
  damageMs: number;
  /** Per-system ms per tick (includes the wind sampling they trigger). */
  systems: Record<string, number>;
  windSamplesPerStep: number;
  /** Simulated seconds per wall-clock second over the window. */
  simSpeed: number;
}

export class SimProfiler {
  enabled = false;
  /** Accumulated by SpatialWindField.sample(). */
  windMs = 0;
  windSamples = 0;
  private sections: Record<string, number> = {};
  private steps = 0;
  private ticks = 0;
  private tickMs = 0;
  private simTime = 0;
  private windowStart = 0;

  now(): number {
    return this.enabled ? performance.now() : 0;
  }

  add(name: string, since: number) {
    if (this.enabled) this.sections[name] = (this.sections[name] ?? 0) + performance.now() - since;
  }

  endStep(dt: number) {
    if (!this.enabled) return;
    this.steps++;
    this.simTime += dt;
  }

  endTick(since: number) {
    if (!this.enabled) return;
    this.ticks++;
    this.tickMs += performance.now() - since;
  }

  /** Averages since the previous snapshot; resets the window. */
  snapshot(): SimProfileSnapshot {
    const ticks = Math.max(1, this.ticks);
    const per = (ms: number) => ms / ticks;
    const systems: Record<string, number> = {};
    for (const [k, v] of Object.entries(this.sections)) if (k.startsWith('sys.')) systems[k.slice(4)] = per(v);
    const wall = (performance.now() - this.windowStart) / 1000;
    const snap: SimProfileSnapshot = {
      stepsPerTick: this.steps / ticks,
      tickMs: per(this.tickMs),
      physicsMs: per(this.sections.physics ?? 0),
      windMs: per(this.windMs),
      damageMs: systems.damage ?? 0,
      systems,
      windSamplesPerStep: this.steps ? this.windSamples / this.steps : 0,
      simSpeed: this.windowStart && wall > 0 ? this.simTime / wall : 0,
    };
    this.sections = {};
    this.windMs = 0;
    this.windSamples = 0;
    this.steps = 0;
    this.ticks = 0;
    this.tickMs = 0;
    this.simTime = 0;
    this.windowStart = performance.now();
    return snap;
  }
}

/** Process-wide profiler (there is one simulation at a time). */
export const simProfiler = new SimProfiler();
