/**
 * LLM-backed parser (not enabled in the MVP).
 *
 * It implements the same CommandParser interface as RuleBasedParser, so switching is a one-line
 * change. The transport is injected: the app would pass a function that calls a backend endpoint
 * (never an API key in the browser), e.g. a server route that forwards to the Claude API with
 * `commandJsonSchema()` as the structured output format.
 */
import type { I18nMessage } from '@/i18n/i18n';
import type { CommandParser, ParseDefaults, ParseResult } from './CommandParser';
import { commandJsonSchema, simulationCommandSchema } from './schema';

export type LlmComplete = (request: { system: string; user: string; jsonSchema: unknown }) => Promise<string>;

export const LLM_SYSTEM_PROMPT = `You convert disaster-simulation instructions (Korean or English) into JSON commands.
Rules:
- Wind direction is where the wind blows FROM (meteorological convention), as N/NE/E/SE/S/SW/W/NW or degrees.
- Speeds are mean wind speed at 10 m in m/s. Convert km/h, mph and knots.
- "increase to X over T seconds" → rampDuration = T, speed = X.
- Only output commands that match the JSON schema. Unsupported hazards: omit them.`;

export class LlmParser implements CommandParser {
  readonly id = 'llm';
  constructor(private readonly complete: LlmComplete) {}

  async parse(input: string, defaults: ParseDefaults): Promise<ParseResult> {
    const result: ParseResult = { ok: false, commands: [], unsupported: [], errors: [], warnings: [] };
    let raw: string;
    try {
      raw = await this.complete({
        system: `${LLM_SYSTEM_PROMPT}\nDefaults: direction=${defaults.direction}, duration=${defaults.duration}s, gust=${defaults.gustStrength}.`,
        user: input,
        jsonSchema: commandJsonSchema(),
      });
    } catch (e) {
      result.errors.push({ key: 'parse.invalid', params: { detail: String(e) } } as I18nMessage);
      return result;
    }
    let data: { commands?: unknown[] };
    try {
      data = JSON.parse(raw);
    } catch {
      result.errors.push({ key: 'parse.invalid', params: { detail: 'non-JSON response' } });
      return result;
    }
    for (const c of data.commands ?? []) {
      const parsed = simulationCommandSchema.safeParse(c);
      if (parsed.success) result.commands.push({ command: parsed.data, source: input, notes: [] });
      else result.errors.push({ key: 'parse.invalid', params: { detail: parsed.error.issues[0]?.message ?? '' } });
    }
    result.ok = result.errors.length === 0 && result.commands.length > 0;
    return result;
  }
}
