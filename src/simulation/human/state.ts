/**
 * Phase 33: per-person state of the extended human model (src/human = the pure model; this = its runtime record).
 * Present only on people of a run with settings.simulation.humans.model = 'extended' (absent = Phase 0–32 behaviour).
 */
import type { Vec3 } from '@/core/types';
import type { HumanSettings } from '@/core/model';
import { bodyModel, validateBody, type BodyModel, type SegmentId } from '@/human/anthropometry';
import { newBalance, type BalanceParams, type BalanceState } from '@/human/balance';
import { newRisk, V_REF, type Mobility, type SegmentRisk } from '@/human/injury';
import type { Posture } from '@/human/posture';
import type { TidalLoad } from '@/human/tidal';
import { FORCE_SOURCES, newHumAccumulator } from '../forces/ForceLedger';

const FORCE_SOURCE_COUNT = FORCE_SOURCES.length;

/** An open contact episode with one partner. */
export interface Episode {
  partner: string;
  startStep: number;
  lastStep: number;
  steps: number;
  /**
   * Per segment (SEGMENT_IDS order): Σ normal impulse of the solver contact points attributed to it and Σ impulse × local
   * point (body frame) — 4 floats each; plus the impulse of points near no segment (unknown).
   */
  seg: Float64Array;
  unknown: number;
  /** Σ impulse × contact normal pointing at the person (the contact plane's orientation). */
  N: Vec3;
  /** Σ impulse on the person (N·s, world), Σ |J|-weighted contact point, peak force (N). */
  J: Vec3;
  P: Vec3;
  jw: number;
  peak: number;
  /** Velocity / angular velocity before the first contact step, closing speed along the normal (m/s). */
  v0: Vec3;
  w0: Vec3;
  /** Body state at the last contact step: velocity, angular velocity, COM, pose (the struck point's kinematics). */
  v1: Vec3;
  w1: Vec3;
  c1: Vec3;
  p1: Vec3;
  q1: [number, number, number, number];
  closing: number;
  /** Partner mass (kg; Infinity for the ground and fixed bodies). */
  mp: number;
  /** The person was free (airborne / falling) just before: a landing. */
  landing: boolean;
  hazard: string | null;
}

export interface LastImpact {
  time: number;
  partner: string;
  impulse: number;
  dv: number;
  decel: number;
  closing: number;
  segments: { id: SegmentId; share: number }[];
  /** Direction of the impulse on the person (unit, world). */
  dir: Vec3;
  /** Contact point (world). */
  point: Vec3;
}

/** Chart series of one person (4 Hz, NaN = not measured at that sample — e.g. the balance margin of a fallen person). */
export interface HumanSeries {
  /** Current sampling interval (s; doubles each time the series is thinned). */
  dt: number;
  t: number[];
  speed: number[];
  height: number[];
  spin: number[];
  margin: number[];
  impulse: number[];
  risk: number[];
  contact: number[];
  posture: number[];
}

export interface HumanState {
  model: BodyModel;
  bp: BalanceParams;
  bal: BalanceState;
  /** Standing (rotations held by posture control) vs released (passive rigid body). */
  standing: boolean;
  /** The first step was evaluated (a person placed lying starts released, without a fall event). */
  started: boolean;
  /** Ledger accumulator (also on the entity as `hum` while standing). */
  acc: Float64Array;
  /**
   * Recent tipping angular impulse per cause (2 floats each: ledger sources, then gravity, slip, contact), decaying with
   * TIP_MEMORY — the fall is attributed to the largest along the fall direction (a blast acts for one step, the person
   * tips a moment later).
   */
  tipHist: Float64Array;
  /** Recent impulse along the body axis (lift) per ledger source, same memory (thrown off the support). */
  liftHist: Float64Array;
  vRef: Record<SegmentId, number>;
  posture: Posture;
  postureChanges: number;
  freeSteps: number;
  /** Supported (contact or terrain) at the last awake step — a body asleep in Rapier is supported only if it fell asleep so. */
  sleepSupported: boolean;
  stillFor: number;
  lastLanding: number;
  /** Highest COM height along "up" of the current free phase (NaN outside), and the largest drop landed. */
  airTop: number;
  maxDrop: number;
  v: Vec3;
  w: Vec3;
  risk: Record<SegmentId, SegmentRisk>;
  episodes: Map<string, Episode>;
  impacts: number;
  maxImpulse: number;
  maxClosing: number;
  maxDecel: number;
  maxSpin: number;
  falls: number;
  firstFall: number;
  fallCause: string | null;
  last: LastImpact | null;
  /** Impulse of contact episodes in the current step (N·s; chart). */
  stepImpulse: number;
  tidal: TidalLoad | null;
  tidalPeak: number;
  incapacitated: boolean;
  mobility: Mobility;
  buried: boolean;
  /** Energy handed to the body when the standing lean was released (J) — the pendulum's kinetic energy. */
  releaseEnergy: number;
  /** Seconds a released body has stood still upright on its feet; stance regained / collapse count. */
  uprightFor: number;
  regained: number;
  collapsed: number;
  /** Potential energy dissipated by collapses (m g Δh of the COM, J — absorbed in the legs, not an impact). */
  collapseEnergy: number;
  /** Model-limit flags met during the run: bmi (implausible proportions), nonFinite, extremeSpin, extremeImpact. */
  limits: string[];
  /**
   * Energy ledger (J) since the start: kinetic energy (translation + rotation) now and at the start; the work of gravity
   * (m g·v̄ dt at the COM), of the external hazard forces (ledger sources: F·v̄ + τ·ω̄), the energy handed over when a
   * standing lean was released; the remainder of each step's kinetic-energy change booked as contact work on steps with
   * a contact episode event, else as 'other' (contacts below the event threshold — sliding / rolling friction, resting —
   * linear / angular damping, integrator error). Collapses lower the COM without kinetic energy: collapseEnergy.
   */
  energy: { ke0: number; ke: number; gravity: number; external: number; release: number; contact: number; other: number; pendingRelease: number };
  series: HumanSeries | null;
}

/** People with chart series (the first ones in entity order — bounded memory in crowds). */
export const SERIES_PEOPLE = 32;
export const SERIES_DT = 0.25;
export const SERIES_MAX = 4000;
export const SERIES_KEYS = ['t', 'speed', 'height', 'spin', 'margin', 'impulse', 'risk', 'contact', 'posture'] as const;

export function createHumanState(height: number, mass: number, settings: HumanSettings, withSeries: boolean): HumanState | null {
  const chk = validateBody(height, mass);
  if (!chk.ok) return null;
  const model = bodyModel(height, mass);
  const hc = model.com[1];
  const k = settings.riskScale ?? 1;
  const vRef = { ...V_REF };
  for (const id of Object.keys(vRef) as SegmentId[]) vRef[id] *= k;
  return {
    model,
    bp: { mass: model.mass, hc, Ia: (model.inertia[0] + model.inertia[2]) / 2 + model.mass * hc * hc, forward: model.support.forward, lateral: model.support.lateral },
    bal: newBalance(),
    standing: true,
    started: false,
    acc: newHumAccumulator(),
    tipHist: new Float64Array((FORCE_SOURCE_COUNT + 3) * 2),
    liftHist: new Float64Array(FORCE_SOURCE_COUNT),
    vRef,
    posture: 'upright',
    postureChanges: 0,
    freeSteps: 0,
    sleepSupported: true,
    stillFor: 0,
    lastLanding: -Infinity,
    airTop: NaN,
    maxDrop: 0,
    v: [0, 0, 0],
    w: [0, 0, 0],
    risk: newRisk(),
    episodes: new Map(),
    impacts: 0,
    maxImpulse: 0,
    maxClosing: 0,
    maxDecel: 0,
    maxSpin: 0,
    falls: 0,
    firstFall: NaN,
    fallCause: null,
    last: null,
    stepImpulse: 0,
    tidal: null,
    tidalPeak: 0,
    incapacitated: false,
    mobility: 'mobile',
    buried: false,
    releaseEnergy: 0,
    uprightFor: 0,
    regained: 0,
    collapsed: 0,
    collapseEnergy: 0,
    limits: chk.warning ? [chk.warning] : [],
    energy: { ke0: NaN, ke: 0, gravity: 0, external: 0, release: 0, contact: 0, other: 0, pendingRelease: 0 },
    series: withSeries ? { dt: SERIES_DT, t: [], speed: [], height: [], spin: [], margin: [], impulse: [], risk: [], contact: [], posture: [] } : null,
  };
}
