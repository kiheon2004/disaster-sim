/**
 * Registered responses of the implemented channels (Phase 15). Earthquake and flood damage
 * dispatch through here; wind damage still lives in DamageSystem (Phase 3–11 code, unchanged —
 * see docs/PHENOMENA.md §8 for the migration path).
 */
import { ResponseRegistry } from './ObjectResponse';
import { updateBuildingQuake, updateInfraQuake, updatePersonQuake } from '../damage/behaviors/seismic';
import {
  updateBuildingFlood, updateCarFlood, updateExposureOnly, updateInfraFlood, updatePersonFlood, updateRoadFlood,
} from '../damage/behaviors/flood';

export const responses = new ResponseRegistry();

// ── groundMotion ──
responses.register({
  channel: 'groundMotion', target: { category: 'building' }, kinds: ['structural', 'transition'], model: 'structural',
  update: (e, ctx, dt) => updateBuildingQuake(e, ctx, ctx.runtime.seismic!.model, dt),
});
responses.register({
  channel: 'groundMotion', target: { category: 'infrastructure' }, kinds: ['structural', 'transition'], model: 'structural',
  update: (e, ctx, dt) => {
    if (e.seismic!.unit >= 0) updateInfraQuake(e, ctx, ctx.runtime.seismic!.model, dt);
  },
});
responses.register({
  channel: 'groundMotion', target: { category: 'human' }, kinds: ['stability', 'transition'], model: 'groundMotion',
  update: (e, ctx, dt) => {
    if (ctx.env.groundMotion.active) updatePersonQuake(e, ctx, dt);
  },
});

// ── water (flood) ──
responses.register({
  channel: 'water', target: { category: 'building' }, kinds: ['structural', 'exposure', 'transition'], model: 'floodDamage',
  update: (e, ctx, dt) => updateBuildingFlood(e, ctx, ctx.env.flood.field!, dt),
});
responses.register({
  channel: 'water', target: { category: 'vehicle' }, kinds: ['exposure', 'transition'], model: 'buoyancy',
  update: (e, ctx, dt) => updateCarFlood(e, ctx, ctx.env.flood.field!, dt),
});
responses.register({
  channel: 'water', target: { category: 'human' }, kinds: ['stability', 'exposure', 'transition'], model: 'floodDamage',
  update: (e, ctx, dt) => updatePersonFlood(e, ctx, ctx.env.flood.field!, dt),
});
responses.register({
  channel: 'water', target: { type: 'road' }, kinds: ['exposure', 'structural'], model: 'floodDamage',
  update: (e, ctx, dt) => updateRoadFlood(e, ctx, ctx.env.flood.field!, dt),
});
responses.register({
  channel: 'water', target: { category: 'infrastructure' }, kinds: ['structural', 'transition'], model: 'floodDamage',
  update: (e, ctx, dt) => updateInfraFlood(e, ctx, ctx.env.flood.field!, dt),
});
responses.register({
  channel: 'water', target: { category: 'tree' }, kinds: ['exposure'], model: 'floodDamage',
  update: (e, ctx, dt) => updateExposureOnly(e, ctx.env.flood.field!, dt),
});
