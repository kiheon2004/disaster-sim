/** English strings of ground failure — sinkholes and landslides (Phase 22). */
import type { koGround } from './ko.ground';

export const enGround: Record<keyof typeof koGround, string> = {
  'geo.mat.rock': 'Rock',
  'geo.mat.denseGranular': 'Dense granular soil',
  'geo.mat.looseGranular': 'Loose granular soil',
  'geo.mat.cohesive': 'Cohesive soil',
  'geo.mat.fill': 'Fill / artificial ground',
};
