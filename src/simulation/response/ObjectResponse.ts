/**
 * Object Response Framework (Phase 15).
 *
 *   effect channel (what the world does)  ×  object category (what reacts)  →  response handler
 *
 * A phenomenon never talks to people or buildings directly: it writes a channel, and every
 * object category has registered responses to that channel (motion, stability, structural
 * damage, environmental exposure, state transition). A new phenomenon that writes an existing
 * channel (a tornado → airflow, a tsunami → water) gets every existing response for free; a new
 * channel adds handlers here without touching the other channels' code.
 *
 * Handlers are looked up by object TYPE first, then by category, so a road can respond to water
 * differently from a pole while both are "infrastructure".
 */
import type { ObjectType } from '@/core/types';
import type { ChannelId } from '@/phenomena/types';
import type { RuntimeEntity } from '../SimulationRuntime';
import type { SystemContext } from '../systems/SimulationSystem';

export type ObjectCategory = 'human' | 'vehicle' | 'building' | 'tree' | 'infrastructure' | 'debris';
export type ResponseKind = 'motion' | 'stability' | 'structural' | 'exposure' | 'transition';

export function objectCategory(type: ObjectType | 'debris'): ObjectCategory {
  switch (type) {
    case 'human':
      return 'human';
    case 'car':
      return 'vehicle';
    case 'building':
      return 'building';
    case 'tree':
      return 'tree';
    case 'debris':
      return 'debris';
    default:
      return 'infrastructure'; // street lights, signs, walls, roads
  }
}

export interface ResponseHandler {
  channel: ChannelId;
  /** Exact object type, or a whole category. */
  target: { type: ObjectType } | { category: ObjectCategory };
  kinds: ResponseKind[];
  /** Model id (phenomena/models.ts) behind the response. */
  model: string;
  update(e: RuntimeEntity, ctx: SystemContext, dt: number): void;
}

export class ResponseRegistry {
  private readonly byType = new Map<string, ResponseHandler>();
  private readonly byCategory = new Map<string, ResponseHandler>();
  readonly all: ResponseHandler[] = [];

  register(h: ResponseHandler) {
    const key = 'type' in h.target ? `${h.channel}:${h.target.type}` : `${h.channel}:${h.target.category}`;
    const map = 'type' in h.target ? this.byType : this.byCategory;
    if (map.has(key)) throw new Error(`Response already registered: ${key}`);
    map.set(key, h);
    this.all.push(h);
  }

  handler(channel: ChannelId, e: RuntimeEntity): ResponseHandler | undefined {
    return this.byType.get(`${channel}:${e.source.type}`) ?? this.byCategory.get(`${channel}:${objectCategory(e.source.type)}`);
  }

  /** Dispatch one object's response to a channel (no-op without a handler). */
  respond(channel: ChannelId, e: RuntimeEntity, ctx: SystemContext, dt: number) {
    this.handler(channel, e)?.update(e, ctx, dt);
  }
}

/**
 * Responses that are produced by forces in the rigid-body solver rather than by a handler —
 * listed so the full matrix (UI, docs, tests) is complete. "planned" = channel not implemented.
 */
export const FORCE_RESPONSES: { channel: ChannelId; categories: ObjectCategory[]; kinds: ResponseKind[]; via: string }[] = [
  { channel: 'airflow', categories: ['human', 'vehicle', 'debris', 'tree', 'infrastructure'], kinds: ['motion', 'stability'], via: 'WindForceSystem → ForceLedger' },
  { channel: 'airflow', categories: ['building', 'tree', 'infrastructure', 'human', 'vehicle'], kinds: ['structural', 'stability', 'transition'], via: 'DamageSystem (wind behaviors)' },
  { channel: 'groundMotion', categories: ['human', 'vehicle', 'debris'], kinds: ['motion'], via: 'SeismicForceSystem → ForceLedger' },
  { channel: 'water', categories: ['human', 'vehicle', 'debris', 'tree', 'infrastructure'], kinds: ['motion', 'stability'], via: 'WaterForceSystem → ForceLedger' },
];
