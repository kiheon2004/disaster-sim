/** English strings of meteoroid / asteroid impacts (Phase 23). */
import type { koImpact } from './ko.impact';

export const enImpact: Record<keyof typeof koImpact, string> = {
  'impact.mat.stony': 'Stony (ordinary chondrite)',
  'impact.mat.iron': 'Iron',
  'impact.mat.icy': 'Icy / comet-like',
  'impact.issue.mass': 'Mass {m} kg does not match the sphere of this diameter and density ({sphere} kg, > 1 % apart) — change one of them',
  'impact.issue.density': 'Density {rho} kg/m³ is outside the representative range of this material ({lo}–{hi})',
  'impact.issue.strengthRange': 'Density {rho} kg/m³ is outside 1000–8000 kg/m³, where the strength–density relation (Collins et al. 2005) was fitted — break-up altitude extrapolated',
  'impact.warn.breakup': 'Break-up at {z} km: ram pressure exceeds the strength (pancake model)',
  'impact.warn.direct': 'Direct impact (no atmosphere) — no atmospheric slowing, ablation or break-up computed',
  'impact.warn.outside': 'The actual impact point is outside the world',
  'impact.warn.miss': 'The actual impact point is {d} m from the aim point (terrain in the way / gravity bending)',
  'impact.warn.oblique': 'Impact angle below 15° — real craters become elongated; this model keeps them circular',
  'impact.warn.swarm': 'Fragment swarm {L} m wide exceeds the crater — a crater field would form; computed as one crater',
  'impact.warn.large': 'Crater diameter {D} m — large for the world (ejecta from the edge leave it)',
  'impact.warn.rock': 'Rock target — strength regime, walls stand (rock-slope failure is not modelled)',
  'impact.warn.pulse': 'The {tau} ms ground-shock pulse cannot be resolved at 60 Hz; it is applied broadened to {app} ms with the same peak velocity',
  'impact.warn.airburst': 'Airburst at {z} km — no ground impact, no crater (the atmospheric blast is Phase 24)',
  'impact.warn.ablated': 'Ablated away in the atmosphere — no ground impact',
  'impact.warn.lowSpeed': 'Impact speed {v} m/s — below the hypervelocity data the scaling rests on (closer to penetration); extrapolated',
};
