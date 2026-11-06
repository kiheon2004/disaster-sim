/**
 * Phase 35: road / ground surface for a tyre — peak friction and rolling resistance at a contact point (level B/C).
 *
 * Bare ground: the tyre friction of its ground type (params TIRE.muGround — paved roads from Wallman & Åström 2001, unpaved
 * ground as orders of magnitude). A climate cover (Phase 30 surface states) replaces it where it covers the ground, with the
 * same blending as the Phase 30 contact friction (thin frost grips partly through): μ = μ_g (1 − cover) + min(μ_g, μ_state) cover,
 * μ_state = SURFACE_MU (wet 0.5, snow 0.3, packed 0.25, slush 0.25, ice 0.1, wet ice 0.05, frost 0.3). A wet surface without a
 * climate run (flood water ≥ 5 mm) scales the friction by 0.5 / 0.7 (Wallman & Åström wet / dry asphalt).
 * Rolling resistance: C_rr of the ground type + crrSnowPerM × snow depth (capped) — the extra drag of ploughing snow (assumption).
 */
import { ICE_COVER, SURF, SURFACE_MU } from '@/climate/surfaceState';
import { TIRE } from './params';

export const WET_DEPTH = 0.005;
export const WET_SHARE = 0.5 / 0.7;

export interface SurfaceCover {
  /** Phase 30 surface state index (SURF), ice cover (kg/m²) and snow depth (m). */
  state: number;
  ice: number;
  snowDepth: number;
}

export function tireMu(ground: number, cover: SurfaceCover | null, water: number): number {
  const mg = TIRE.muGround[ground] ?? TIRE.muGround[0];
  if (!cover) return water >= WET_DEPTH ? mg * WET_SHARE : mg;
  const st = cover.state;
  if (st === SURF.dry) return mg;
  if (st === SURF.wet) return mg * WET_SHARE;
  const share = st === SURF.frost ? Math.min(1, cover.ice / ICE_COVER) : 1;
  return mg * (1 - share) + Math.min(mg, SURFACE_MU[st]) * share;
}

export function tireCrr(ground: number, cover: SurfaceCover | null): number {
  const c = TIRE.crrGround[ground] ?? TIRE.crrGround[0];
  return cover && cover.snowDepth > 0 ? c + TIRE.crrSnowPerM * Math.min(cover.snowDepth, TIRE.snowCap) : c;
}
