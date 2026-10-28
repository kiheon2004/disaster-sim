/**
 * Command contract (zod). The rule-based parser, the UI form, and any future LLM integration
 * must all produce values that validate against these schemas.
 */
import { z } from 'zod';
import { SIM_SPEEDS } from '@/core/units';
import type { EventSpec } from '@/events/specs';
import { earthquakeEventSchema } from '@/events/earthquake/earthquakeSchema';
import { rainEventSchema, risingWaterEventSchema, waterSourceEventSchema } from '@/events/flood/floodSchema';

import { compassSchema, windEventSchema } from '@/events/wind/windSchema';

export { compassSchema, windEventSchema, earthquakeEventSchema, rainEventSchema, risingWaterEventSchema, waterSourceEventSchema };

export const eventSpecSchema = z.discriminatedUnion('event', [windEventSchema, earthquakeEventSchema, rainEventSchema, risingWaterEventSchema, waterSourceEventSchema]);

export const simulationCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), spec: eventSpecSchema }),
  z.object({ kind: z.literal('control'), action: z.enum(['play', 'pause', 'reset']) }),
  z.object({ kind: z.literal('speed'), value: z.union(SIM_SPEEDS.map((s) => z.literal(s)) as unknown as [z.ZodLiteral<0.25>, z.ZodLiteral<0.5>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<4>, z.ZodLiteral<8>, z.ZodLiteral<16>]) }),
]);

export type SimulationCommand = z.infer<typeof simulationCommandSchema>;

/** A hazard the parser recognized but the simulator does not support yet. */
export interface UnsupportedRequest {
  /** Planned phenomenon type (PhenomenonRegistry), recognized but not simulated. */
  event: string;
  params: Record<string, number>;
}

// Compile-time guarantee that the schema matches the Event System's spec type.
type _Check = z.infer<typeof eventSpecSchema> extends EventSpec ? true : never;
export const _schemaMatchesSpec: _Check = true;

/** JSON Schema of a command list — ready to hand to an LLM as a tool/response format. */
export function commandJsonSchema() {
  return z.toJSONSchema(z.object({ commands: z.array(simulationCommandSchema) }));
}
