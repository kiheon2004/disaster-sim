import type { I18nMessage } from '@/i18n/i18n';
import type { CompassDir } from '@/core/compass';
import type { SimulationCommand, UnsupportedRequest } from './schema';

export interface ParsedCommand {
  command: SimulationCommand;
  /** The clause of the input this command came from. */
  source: string;
  /** Assumptions made while parsing (defaults applied, units converted …). */
  notes: I18nMessage[];
  /** Seconds from "now" until an event starts ("10초 후 …"). */
  delay?: number;
  /**
   * Start relative to another phenomenon (Phase 15): "10 s after the typhoon begins". Resolved
   * at dispatch against the same command batch, then against the scheduled events.
   */
  after?: { type: string; anchor: 'start' | 'end'; offset: number };
}

export interface ParseResult {
  ok: boolean;
  commands: ParsedCommand[];
  unsupported: UnsupportedRequest[];
  errors: I18nMessage[];
  warnings: I18nMessage[];
}

/** Values used when the input leaves something unspecified (taken from the wind form). */
export interface ParseDefaults {
  direction: CompassDir;
  duration: number;
  gustStrength: number;
}

/**
 * Natural-language (or structured) input → validated SimulationCommands.
 * Async so that an LLM-backed implementation can be swapped in without changing callers.
 */
export interface CommandParser {
  readonly id: string;
  parse(input: string, defaults: ParseDefaults): Promise<ParseResult>;
}
