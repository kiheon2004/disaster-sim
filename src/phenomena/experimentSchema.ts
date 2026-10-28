/**
 * Experiment plan validation (save format v5). Every instance is checked against its phenomenon
 * definition's own schema; unknown or planned types and invalid parameters are dropped (the file
 * still loads), never silently "fixed" into different physical values.
 */
import { z } from 'zod';
import { phenomena } from './registry';
import { defaultExperiment, type ExperimentSettings, type PhenomenonInstance } from './types';

const startSchema = z.union([
  z.object({ at: z.number().min(0).max(86400) }),
  z.object({ after: z.string().min(1), anchor: z.enum(['start', 'end']), offset: z.number().min(-86400).max(86400) }),
]);

const instanceShape = z.object({
  id: z.string().min(1).max(40),
  type: z.string(),
  spec: z.record(z.string(), z.unknown()),
  enabled: z.boolean().catch(true),
  start: startSchema,
  seed: z.number().int().nonnegative().optional().catch(undefined),
  visualize: z.boolean().catch(true),
});

/** Validate one instance; null when it cannot be run as stored. */
export function parseInstance(raw: unknown): PhenomenonInstance | null {
  const r = instanceShape.safeParse(raw);
  if (!r.success) return null;
  const def = phenomena.implemented(r.data.type);
  if (!def) return null;
  const { startTime: _ignored, ...specRaw } = r.data.spec as Record<string, unknown>;
  const spec = def.schema.safeParse({ ...specRaw, event: r.data.type });
  if (!spec.success) return null;
  return { id: r.data.id, type: r.data.type, spec: spec.data, enabled: r.data.enabled, start: r.data.start, seed: r.data.seed, visualize: r.data.visualize };
}

export function parseExperiment(raw: unknown): ExperimentSettings {
  const d = defaultExperiment();
  if (!raw || typeof raw !== 'object') return d;
  const o = raw as Record<string, unknown>;
  const seen = new Set<string>();
  const instances = (Array.isArray(o.instances) ? o.instances : []).flatMap((x) => {
    const i = parseInstance(x);
    if (!i || seen.has(i.id)) return [];
    seen.add(i.id);
    return [i];
  });
  return {
    instances,
    notes: typeof o.notes === 'string' ? o.notes.slice(0, 4000) : '',
    compareDuration: typeof o.compareDuration === 'number' && o.compareDuration >= 0 && o.compareDuration <= 3600 ? o.compareDuration : 0,
  };
}
