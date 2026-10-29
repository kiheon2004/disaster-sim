/**
 * Validation of stored designs (project files, blueprints). Lenient like the rest of the file
 * format: an invalid member is dropped and COUNTED (the loader reports it), an invalid spec field
 * falls back to its default; a design without any valid member is rejected as a whole (the
 * object then stays a legacy building built from its params — nothing else is lost).
 */
import { z } from 'zod';
import type { Vec3 } from '@/core/types';
import { isMaterialId, type MaterialId } from './materials';
import { normalizeSpec } from './spec';
import { defaultOptions, DESIGN_VERSION, MEMBER_TYPES, ROLES_BY_TYPE, type BuildingDesign, type BuildingMember, type Facade, type MemberType } from './types';

const finite = z.number().refine(Number.isFinite);
const vec3 = z.tuple([finite, finite, finite]);

const memberSchema = z.object({
  id: z.string().min(1).max(120),
  type: z.enum(MEMBER_TYPES as [MemberType, ...MemberType[]]),
  role: z.string(),
  level: z.number().int().min(-1).max(200),
  position: vec3,
  rotation: vec3.catch([0, 0, 0]).default([0, 0, 0]),
  size: z.tuple([finite, finite, finite]).refine((v) => v.every((x) => x > 0.005 && x < 500)),
  material: z.string(),
  host: z.string().optional().catch(undefined),
  facade: z.enum(['n', 's', 'e', 'w']).optional().catch(undefined),
  initialDamage: z.number().min(0).max(1).optional().catch(undefined),
});

const DEFAULT_MATERIAL: Record<MemberType, MaterialId> = {
  foundation: 'reinforcedConcrete', column: 'reinforcedConcrete', beam: 'reinforcedConcrete', slab: 'reinforcedConcrete',
  wall: 'masonry', window: 'glass', door: 'timber', roof: 'lightCladding',
};

export const designSchema = z.object({
  version: z.literal(DESIGN_VERSION),
  spec: z.record(z.string(), z.unknown()).optional(),
  members: z.array(z.unknown()),
  options: z.object({
    foundationPolicy: z.enum(['refit', 'preserve']).catch('refit'),
    allowUnsupported: z.boolean().catch(false),
    plinthDepth: z.number().min(0).max(100).nullable().catch(null),
  }).partial().optional().catch(undefined),
  edits: z.number().int().nonnegative().catch(0).default(0),
  preset: z.string().max(40).optional().catch(undefined),
  convertedFrom: z.literal('legacy').optional().catch(undefined),
});

export interface DesignParseResult {
  design: BuildingDesign | null;
  /** Members dropped as invalid. */
  dropped: number;
  /** Members whose role / material / id was repaired. */
  repaired: number;
}

export function parseDesign(raw: unknown): DesignParseResult {
  const r = designSchema.safeParse(raw);
  if (!r.success) return { design: null, dropped: 0, repaired: 0 };
  let dropped = 0;
  let repaired = 0;
  const seen = new Set<string>();
  const members: BuildingMember[] = [];
  for (const item of r.data.members) {
    const m = memberSchema.safeParse(item);
    if (!m.success) {
      dropped++;
      continue;
    }
    const d = m.data;
    let id = d.id;
    if (seen.has(id)) {
      let k = 2;
      while (seen.has(`${d.id}~${k}`)) k++;
      id = `${d.id}~${k}`;
      repaired++;
    }
    seen.add(id);
    const roles = ROLES_BY_TYPE[d.type];
    const role = (roles as readonly string[]).includes(d.role) ? (d.role as BuildingMember['role']) : roles[0];
    const material = isMaterialId(d.material) ? d.material : DEFAULT_MATERIAL[d.type];
    if (role !== d.role || material !== d.material) repaired++;
    const out: BuildingMember = { id, type: d.type, role, level: d.level, position: d.position as Vec3, rotation: d.rotation as Vec3, size: d.size as Vec3, material };
    if (d.host) out.host = d.host;
    if (d.facade) out.facade = d.facade as Facade;
    if (d.initialDamage) out.initialDamage = d.initialDamage;
    members.push(out);
  }
  if (!members.length) return { design: null, dropped, repaired };
  const spec = normalizeSpec(r.data.spec as Parameters<typeof normalizeSpec>[0]);
  const design: BuildingDesign = { version: DESIGN_VERSION, spec, members, options: { ...defaultOptions(), ...(r.data.options ?? {}) }, edits: r.data.edits };
  if (r.data.preset) design.preset = r.data.preset;
  if (r.data.convertedFrom) design.convertedFrom = r.data.convertedFrom;
  return { design, dropped, repaired };
}
