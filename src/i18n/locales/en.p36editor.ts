/** Phase 36 (advanced world editor) English strings. */
export const enP36Editor = {
  'ed36.pos': 'Position (m)',
  'ed36.rot': 'Rotation (°) — tilt X · heading Y · tilt Z',
  'ed36.scale': 'Scale (×)',
  'ed36.hag': 'Height above ground',
  'ed36.hag.hint': '0 = standing on the ground at this X / Z (the same seat rule as placement).',
  'ed36.drop': 'Drop to ground',
  'ed36.drop.title': 'Put the object on the ground here (height, and tilt on a slope); heading kept.',
  'ed36.alignSlope': 'Follow the slope',
  'ed36.alignSlope.hint': 'On: tilt with the ground under the footprint. Off: stay upright.',
  'ed36.clamped': 'Kept inside the world: {axes} limited to the map / elevation range.',
  'ed36.rejected': 'Not a number: {axes} unchanged.',
  'ed36.lockedSkipped': '{count} locked object(s) left as they are (unlock them to move or delete).',
} as const;
