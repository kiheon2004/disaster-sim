/**
 * Phase 33: segment model of a standing person (educational reduced model).
 *
 * Mass fractions: Dempster (1955) as tabulated by Winter, "Biomechanics and Motor Control of Human Movement" (Table 4.1):
 * head + neck 0.081, thorax + abdomen 0.355, pelvis 0.142, whole arm 0.050, whole leg 0.161 (sum 1.000). Segment boundary
 * heights as fractions of the stature H: Drillis & Contini (1966) as drawn by Winter (Fig. 4.1): chin 0.870, shoulder 0.818,
 * wrist 0.485, greater trochanter 0.530, hand length 0.108, shoulder width 0.259, hip width 0.191, foot length 0.152, foot
 * width 0.055. The values were transcribed from that standard table; they are population averages, not a person.
 *
 * MODEL ASSUMPTIONS (not from the tables, stated so they can be questioned):
 *  - the head + neck mass is split by volume with a neck radius of half the head radius;
 *  - the pelvis segment spans 0.530 H – 0.600 H (greater trochanter to roughly the iliac crest), the torso 0.600 H – 0.818 H;
 *  - arms hang at the side (fingertip at wrist − hand length), arm axes at ± half the shoulder width; leg axes at ± a quarter
 *    of the hip width;
 *  - every segment is a solid cylinder of uniform density ρ = 1000 kg/m³ along the body axis (radius from mass and length),
 *    which gives its own inertia; the whole-body inertia follows by the parallel-axis theorem.
 * Local frame: origin between the soles on the ground, +y along the body axis (head), +z the facing direction, +x the
 * person's anatomical LEFT (a person facing +z with +y up has their left at +x).
 */
import type { Vec3 } from '@/core/types';

export const SEGMENT_IDS = ['head', 'neck', 'torso', 'pelvis', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg'] as const;
export type SegmentId = (typeof SEGMENT_IDS)[number];

/** Stature (m) and mass (kg) ranges the model accepts (adults; outside → rejected by validateBody). */
export const HEIGHT_RANGE: readonly [number, number] = [1.0, 2.3];
export const MASS_RANGE: readonly [number, number] = [20, 250];
/** Body mass index range inside which the proportions of the tables are plausible (warning outside, not rejection). */
export const BMI_PLAUSIBLE: readonly [number, number] = [15, 45];

const RHO = 1000;
/** Table fractions (see header). */
export const MASS_FRACTION = { headNeck: 0.081, thoraxAbdomen: 0.355, pelvis: 0.142, arm: 0.05, leg: 0.161 } as const;
export const HEIGHT_FRACTION = { chin: 0.87, shoulder: 0.818, wrist: 0.485, trochanter: 0.53, hand: 0.108, shoulderWidth: 0.259, hipWidth: 0.191, footLength: 0.152, footWidth: 0.055 } as const;
/** Assumptions (see header). */
export const ASSUMED = { neckRadiusShare: 0.5, iliacCrest: 0.6 } as const;

export interface Segment {
  id: SegmentId;
  mass: number;
  /** Axial extent along the body axis (m above the soles). */
  y0: number;
  y1: number;
  /** Lateral offset of the segment axis (m, +x = left). */
  x: number;
  radius: number;
  /** Centre (local frame). */
  centre: Vec3;
}

export interface BodyModel {
  height: number;
  mass: number;
  segments: Segment[];
  /** Whole-body centre of mass (local frame). */
  com: Vec3;
  /** Principal moments about the COM along the local x, y, z axes (kg·m²; the segment layout is symmetric so the axes are principal). */
  inertia: Vec3;
  /** Support rectangle half extents around the stance centre: forward (z) and lateral (x) (m). */
  support: { forward: number; lateral: number };
}

export interface BodyCheck {
  ok: boolean;
  /** Reason when rejected. */
  error?: 'height' | 'mass' | 'nonFinite';
  /** Plausibility warning (kept running). */
  warning?: 'bmi';
  bmi: number;
}

export function validateBody(height: number, mass: number): BodyCheck {
  const bmi = mass / (height * height);
  if (!Number.isFinite(height) || !Number.isFinite(mass)) return { ok: false, error: 'nonFinite', bmi };
  if (height < HEIGHT_RANGE[0] || height > HEIGHT_RANGE[1]) return { ok: false, error: 'height', bmi };
  if (mass < MASS_RANGE[0] || mass > MASS_RANGE[1]) return { ok: false, error: 'mass', bmi };
  return { ok: true, bmi, ...(bmi < BMI_PLAUSIBLE[0] || bmi > BMI_PLAUSIBLE[1] ? { warning: 'bmi' as const } : {}) };
}

function seg(id: SegmentId, mass: number, y0: number, y1: number, x: number, radius?: number): Segment {
  const L = y1 - y0;
  const r = radius ?? Math.sqrt(mass / (RHO * Math.PI * L));
  return { id, mass, y0, y1, x, radius: r, centre: [x, (y0 + y1) / 2, 0] };
}

/** The segment model of a person of stature H (m) and mass M (kg). Throws on a body validateBody rejects. */
export function bodyModel(H: number, M: number): BodyModel {
  const chk = validateBody(H, M);
  if (!chk.ok) throw new Error(`human body rejected: ${chk.error}`);
  const f = HEIGHT_FRACTION, m = MASS_FRACTION;
  // Head + neck split by volume (same density) with r_neck = ½ r_head: V_n / V_h = ¼ · L_n / L_h.
  const Lh = (1 - f.chin) * H, Ln = (f.chin - f.shoulder) * H;
  const share = (ASSUMED.neckRadiusShare ** 2 * Ln) / Lh;
  const mHead = (M * m.headNeck) / (1 + share), mNeck = M * m.headNeck - mHead;
  const head = seg('head', mHead, f.chin * H, H, 0);
  const neck = seg('neck', mNeck, f.shoulder * H, f.chin * H, 0, head.radius * ASSUMED.neckRadiusShare);
  // The neck's radius is fixed by the assumption; its mass by the same density: ρ π r² L must equal mNeck (true by construction).
  const ax = (f.shoulderWidth / 2) * H, lx = (f.hipWidth / 4) * H;
  const fingertip = (f.wrist - f.hand) * H;
  const segments: Segment[] = [
    head,
    neck,
    seg('torso', M * m.thoraxAbdomen, ASSUMED.iliacCrest * H, f.shoulder * H, 0),
    seg('pelvis', M * m.pelvis, f.trochanter * H, ASSUMED.iliacCrest * H, 0),
    seg('leftArm', M * m.arm, fingertip, f.shoulder * H, ax),
    seg('rightArm', M * m.arm, fingertip, f.shoulder * H, -ax),
    seg('leftLeg', M * m.leg, 0, f.trochanter * H, lx),
    seg('rightLeg', M * m.leg, 0, f.trochanter * H, -lx),
  ];
  const com: Vec3 = [0, 0, 0];
  let mt = 0;
  for (const s of segments) {
    mt += s.mass;
    com[0] += s.mass * s.centre[0];
    com[1] += s.mass * s.centre[1];
    com[2] += s.mass * s.centre[2];
  }
  com[0] /= mt; com[1] /= mt; com[2] /= mt;
  // Solid cylinder about its centre: axial ½ m r², transverse m (3 r² + L²) / 12; parallel axis to the body COM.
  const I: Vec3 = [0, 0, 0];
  for (const s of segments) {
    const L = s.y1 - s.y0, r2 = s.radius * s.radius;
    const it = (s.mass * (3 * r2 + L * L)) / 12, ia = 0.5 * s.mass * r2;
    const dx = s.centre[0] - com[0], dy = s.centre[1] - com[1], dz = s.centre[2] - com[2];
    I[0] += it + s.mass * (dy * dy + dz * dz);
    I[1] += ia + s.mass * (dx * dx + dz * dz);
    I[2] += it + s.mass * (dx * dx + dy * dy);
  }
  // Support: feet side by side under the hip axes; the rectangle spans the foot length and the outer foot edges.
  const support = { forward: (f.footLength / 2) * H, lateral: lx + (f.footWidth / 2) * H };
  return { height: H, mass: mt, segments, com, inertia: I, support };
}

/** Distance (m) from a local point to a segment's cylinder surface (0 inside). */
export function segmentDistance(s: Segment, p: Readonly<Vec3>): number {
  const y = Math.min(s.y1, Math.max(s.y0, p[1]));
  const dr = Math.hypot(p[0] - s.x, p[2]) - s.radius;
  return Math.hypot(Math.max(0, dr), p[1] - y);
}

/**
 * Share of a contact at a local point (body frame) per segment. The single collision shape of the reduced model (one
 * capsule) does not say which segment was struck, so the point is attributed to the segments whose cylinders lie within
 * `slack` of it: the nearest gets the contact, and segments within `tie` m of the nearest share it equally (a sole contact
 * between both feet → ½ each leg). Empty = unknown (point not near any segment). Shares sum to 1.
 */
export function segmentShares(model: BodyModel, p: Readonly<Vec3>, slack = 0.12, tie = 0.02): { id: SegmentId; share: number }[] {
  let dMin = Infinity;
  const d = model.segments.map((s) => {
    const v = segmentDistance(s, p);
    if (v < dMin) dMin = v;
    return v;
  });
  if (!(dMin <= slack)) return [];
  const hit = model.segments.filter((_, i) => d[i] <= dMin + tie);
  return hit.map((s) => ({ id: s.id, share: 1 / hit.length }));
}
