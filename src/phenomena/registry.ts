/**
 * PhenomenonRegistry (Phase 15): one place that knows every phenomenon — implemented ones (which
 * create events) and planned ones (recognized and documented, never executed).
 * The Phase 3–14 event factory (events/eventRegistry.ts) now delegates here.
 */
import type { EventSpec } from '@/events/specs';
import type { AnyPhenomenonDefinition, ImplementedPhenomenon, PlannedPhenomenon } from './types';
import { IMPLEMENTED, PLANNED } from './definitions';

export class PhenomenonRegistry {
  private readonly defs = new Map<string, AnyPhenomenonDefinition>();

  register(def: AnyPhenomenonDefinition) {
    if (this.defs.has(def.type)) throw new Error(`Phenomenon already registered: ${def.type}`);
    this.defs.set(def.type, def);
  }

  get(type: string): AnyPhenomenonDefinition | undefined {
    return this.defs.get(type);
  }

  /** The implemented definition for a type, or undefined (planned / unknown). */
  implemented(type: string): ImplementedPhenomenon<EventSpec> | undefined {
    const d = this.defs.get(type);
    return d && d.status === 'implemented' ? d : undefined;
  }

  list(): AnyPhenomenonDefinition[] {
    return [...this.defs.values()];
  }

  listImplemented(): ImplementedPhenomenon<EventSpec>[] {
    return this.list().filter((d): d is ImplementedPhenomenon<EventSpec> => d.status === 'implemented');
  }

  listPlanned(): PlannedPhenomenon[] {
    return this.list().filter((d): d is PlannedPhenomenon => d.status === 'planned');
  }

  /** First planned phenomenon whose keywords match a (normalized) text. */
  matchPlanned(text: string): PlannedPhenomenon | undefined {
    return this.listPlanned().find((d) => d.keywords.test(text));
  }
}

export const phenomena = new PhenomenonRegistry();
for (const d of IMPLEMENTED) phenomena.register(d);
for (const d of PLANNED) phenomena.register(d);
