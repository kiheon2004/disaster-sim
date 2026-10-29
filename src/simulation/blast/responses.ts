/**
 * Object responses to the pressure channel (Phase 24), registered in the Phase 15 response framework
 * (response/responses.ts). The BlastSystem activates an object when a wave approaches it (state.ts);
 * these handlers turn the computed face pressures into loads — every number below is a time integral
 * of the computed pressure (pulse.ts / loads.ts), never a pressure used as a force:
 *
 *  - structures with a structural unit (buildings, street lights, signs, walls): the net horizontal
 *    impulse of their box faces over the step → a lateral force distributed over the stories of the
 *    Phase 13/17 structural model (drift, member failures, collapse follow from the model — the
 *    seismic damage paths record them; attribution maps them to the blast when its load governs);
 *  - facade parts / attachments (windows, cladding, doors, roof panels, parapets, signs, lamp heads):
 *    an SDOF element driven by the face pressure at the part over its static capacity (the part's
 *    wind design pressure × break threshold): glass breaks, panels detach (debris with the impulse
 *    they received) — EXTERIOR damage, separate from the structure;
 *  - free bodies (vehicles, people, toppled poles / trees): net impulse + blast-wind drag through the
 *    ForceLedger ('blast') at the centre of pressure — sliding, rotation and overturning come out of
 *    the rigid-body solver; people additionally lose balance when the velocity change along the wave
 *    exceeds the rigid-block toppling threshold √(2g(√(h²+b²) − h)) (Housner 1963) — a mechanical
 *    criterion, no physiology;
 *  - trees: a base-moment oscillator (period ≈ 0.1·H s, 0.5–3 s, approximate) against their wind
 *    design moment → topple (they become free bodies).
 */
import type { Vec3 } from '@/core/types';
import { GRAVITY } from '@/core/units';
import { hashString, seededRandom } from '@/core/math';
import type { ComponentKind } from '@/core/model';
import type { SystemContext } from '../systems/SimulationSystem';
import type { RuntimeEntity } from '../SimulationRuntime';
import { DamageState, worst } from '../damage/DamageState';
import { componentWorldNormal, componentWorldPos, spawnDebris, spawnParticles } from '../damage/spawn';
import { heightFactor } from '../damage/windLoad';
import { noteFacadeFailure } from '../damage/behaviors/building';
import { knockDown } from '../damage/behaviors/human';
import { AIR, FOOT_LEVER } from '../ground/objects';
import { residualStrength } from '../interactions/integrity';
import { failMembers } from '../buildings/modular';
import { detachFacadeMember } from '../structure/facade';
import { MATERIALS } from '@/buildings/materials';
import { facadeNormal } from '@/buildings/generate';
import { advanceSdof, boxFaces, dragImpulse, faceFactor, reliefTime, responseBound, faceLoads, freeAmplitude, netImpulse, newSdof, pressureCentre, projectedArea, type FaceLoad, type Faces } from '@/blast/loads';
import { facePressure, faceImpulse, faceImpulseTo, negAmp, negDur, span } from '@/blast/pulse';
import { qRotate } from '@/core/math';
import type { Contribution } from '@/blast/wave';
import type { BlastEntityState, PartEntry, WaveLoad } from './state';
import { blastWave } from './access';
import { simProfiler } from '../profiling/SimProfiler';

/** Facade parts / attachments: SDOF period (s) and ductility (typical values, approximate). */
const PART: Partial<Record<ComponentKind, { T: number; mu: number }>> = {
  window: { T: 0.015, mu: 1 },
  cladding: { T: 0.03, mu: 2 },
  door: { T: 0.04, mu: 2 },
  exterior: { T: 0.04, mu: 2 },
  roof: { T: 0.08, mu: 3 },
  wall: { T: 0.05, mu: 1.5 },
  sign: { T: 0.1, mu: 3 },
};
const GLASS_BREAK = 1.5;
const HEIGHT_DESIGN_EXPONENT = 0.8;
/** ± deterministic scatter of part capacities (per object seed and part id). */
const SCATTER = 0.25;

const J: Vec3 = [0, 0, 0], L: Vec3 = [0, 0, 0], D: Vec3 = [0, 0, 0], P: Vec3 = [0, 0, 0], F: Vec3 = [0, 0, 0], V: Vec3 = [0, 0, 0];
const tmpLoads: FaceLoad[] = [];

const scatter = (seed: number, id: string) => 1 + (seededRandom((seed ^ hashString(`blast:${id}`)) >>> 0)() * 2 - 1) * SCATTER;

// ── Structures: lateral load into the structural model ─────────────────

const ZERO: Vec3 = [0, 0, 0];

/** Net horizontal blast impulse on a static box over [t0, t1] (all waves): face pressures + blast-wind drag. */
function staticImpulse(st: BlastEntityState, t1: number, out: Vec3, rho: number) {
  out[0] = out[1] = out[2] = 0;
  for (const w of st.waves) {
    const t0 = w.tDone;
    if (!w.faces || t1 < w.first || t0 > w.end) continue;
    w.tDone = t1;
    netImpulse(w.faces, w.loads, t0, t1, J, L, true);
    out[0] += J[0]; out[2] += J[2];
    if (w.cdA > 0) {
      dragImpulse(w.center, w.cdA, rho, ZERO, t0, t1, D);
      out[0] += D[0]; out[2] += D[2];
    }
  }
}

/** Buildings / poles / signs / walls with a structural unit: lateral force on the model. */
export function respondStructure(e: RuntimeEntity, ctx: SystemContext, dt: number) {
  const st = e.blast!, sr = ctx.runtime.seismic;
  if (!sr || !e.seismic || e.seismic.unit < 0 || e.flags.collapsed || e.flags.toppled || e.dynamic) return;
  staticImpulse(st, ctx.time + dt, F, ctx.env.airDensity);
  const fx = F[0] / dt, fz = F[2] / dt;
  if (fx === 0 && fz === 0) return;
  const m = sr.model, ui = e.seismic.unit;
  m.fbx[ui] += fx;
  m.fbz[ui] += fz;
  ctx.env.blast.loading = true;
  const f = Math.hypot(fx, fz);
  st.J += Math.hypot(F[0], F[2]);
  if (f > st.peakForce) st.peakForce = f;
  let mass = 0;
  for (let j = 1; j <= m.n[ui]; j++) mass += m.m[m.off[ui] + j];
  const a = mass > 0 ? f / mass : 0;
  if (a > st.aEq) st.aEq = a;
  if (a > e.seismic.pgaBlast) e.seismic.pgaBlast = a;
}

// ── Facade parts / attachments ─────────────────────────────────

/** Static pressure capacity of a part (Pa): its wind design pressure at its height × break threshold. */
function partCapacity(e: RuntimeEntity, ci: number, pos: Vec3, ctx: SystemContext): number {
  const c = e.components[ci];
  const brk = c.spec.kind === 'window' ? GLASS_BREAK : e.source.physics.breakThreshold;
  const design = Math.pow(heightFactor(Math.max(0, pos[1] - ctx.env.terrain.sampleHeight(pos[0], pos[2]))), HEIGHT_DESIGN_EXPONENT);
  const w = c.spec.windResistance * design;
  let cap = brk * 0.5 * AIR * w * w * scatter(e.source.seed, c.spec.id);
  if (ctx.interactions) cap *= residualStrength(e, 'blast');
  return cap;
}

/** Build the part entries of a building / anchored structure (at activation). */
export function buildParts(e: RuntimeEntity, ctx: SystemContext, faces: Faces): PartEntry[] {
  const st = e.blast!;
  const out: PartEntry[] = [];
  e.components.forEach((c, ci) => {
    if (c.spec.kind === 'structure' || c.condition !== 'intact') return;
    const prop = PART[c.spec.kind] ?? { T: 0.05, mu: 2 };
    const pos = (c.worldPos ??= componentWorldPos(e, c.spec));
    if (c.worldNormal === undefined) c.worldNormal = componentWorldNormal(e, c.spec);
    const n = c.worldNormal ?? (c.spec.kind === 'roof' ? ([0, 1, 0] as Vec3) : null);
    // Clearing size of the facade the part sits on.
    let S = faces.S[0], best = -Infinity;
    if (n) faces.n.forEach((fn, k) => { const d = fn[0] * n[0] + fn[1] * n[1] + fn[2] * n[2]; if (d > best) { best = d; S = faces.S[k]; } });
    const loads: FaceLoad[] = [];
    let first = Infinity, end = -Infinity;
    const tmp: Contribution[] = [];
    for (const w of st.waves) {
      tmp.length = 0;
      const wave = blastWave(ctx, w.wave);
      wave.contributions(pos, w.shield, tmp);
      for (const a of tmp) {
        if (a.dp <= 0) continue;
        const C = n ? faceFactor(n, a) : 1;
        const tc = reliefTime(C, S, wave.sourceAmbient.c);
        loads.push({ face: 0, a, C, tc });
        first = Math.min(first, a.t);
        end = Math.max(end, a.t + span(a) + tc);
      }
    }
    if (!loads.length) return;
    // A later wave: the part keeps its oscillator state (it may still be ringing from the first one).
    const prev = st.parts?.find((q) => q.ci === ci);
    if (prev) {
      prev.loads = loads; prev.first = Math.min(prev.first, first); prev.end = Math.max(prev.end, end); prev.done = false;
      out.push(prev);
      return;
    }
    const entry: PartEntry = { ci, sdof: newSdof(prop.T, prop.mu), cap: partCapacity(e, ci, pos, ctx), loads, first, end, impulse: 0, tDone: first - 1e-3, peakP: 0, done: false };
    if (!canDamage(entry)) return;
    out.push(entry);
  });
  return out;
}

/**
 * Exterior bearing walls of a modular building loaded OUT OF PLANE by the face pressure (the
 * "columns / walls" response — global drift is the structural model's): a one-way plate strip
 * spanning the story height h between floors, simply supported:
 *   capacity q = (4/3)·f_t·t_e²/h² (flexure of the effective section, f_t = the material's
 *              equivalent bending strength) + 4·N·t/h² (rocking of the wall under the gravity load
 *              N per metre it carries — the arching resistance of unreinforced walls, approximate)
 *   period   T = 2π / ((π/h)²·√(E·k·I/μ)), I = t_e³/12, μ = ρ·t_e (per m of width)
 *   ductility 1.5 (brittle), 2 (semi-ductile), 3 (ductile).
 * A failed wall leaves through the Phase 17 member path: load path re-analysis, members left
 * unsupported fall, a story that lost its bearing capacity collapses (Phase 25 refines this).
 */
export function buildWalls(e: RuntimeEntity, ctx: SystemContext, faces: Faces): PartEntry[] {
  const st = e.blast!, mr = e.modular;
  if (!mr) return [];
  const out: PartEntry[] = [];
  const k = e.source.transform.scale, q = e.initialPose.quaternion, base = e.initialPose.position;
  mr.design.members.forEach((m, i) => {
    if (m.type !== 'wall' || m.role !== 'bearing' || !m.facade || mr.failed[i] || m.level < 0 || m.level >= mr.floors) return;
    const mat = MATERIALS[m.material];
    if (!mat?.structural) return;
    const local = qRotate(q, [m.position[0] * k[0], m.position[1] * k[1], m.position[2] * k[2]]);
    const pos: Vec3 = [base[0] + local[0], base[1] + local[1], base[2] + local[2]];
    const n = qRotate(q, facadeNormal(m.facade));
    const h = Math.max(1, m.size[1] * k[1]), L = Math.max(0.5, m.size[0]);
    const t = Math.max(0.05, m.size[2]), te = t * mat.fill.wall;
    // Gravity load per metre the wall carries now (Phase 25: from the collapse engine when it exists).
    const N = (mr.structure ? mr.structure.model.s.load[i] : mr.current.members[i]?.load ?? 0) / L;
    let cap = ((4 / 3) * mat.flexural * te * te) / (h * h) + (4 * N * t) / (h * h);
    if (ctx.interactions) cap *= residualStrength(e, 'blast');
    const w1 = ((Math.PI / h) ** 2) * Math.sqrt((mat.E * mat.stiffnessFactor * te ** 3 / 12) / (mat.density * te));
    const mu = mat.failure === 'brittle' ? 1.5 : mat.failure === 'semiDuctile' ? 2 : 3;
    let S = faces.S[0], best = -Infinity;
    faces.n.forEach((fn, j) => { const d = fn[0] * n[0] + fn[1] * n[1] + fn[2] * n[2]; if (d > best) { best = d; S = faces.S[j]; } });
    const loads: FaceLoad[] = [];
    let first = Infinity, end = -Infinity;
    const tmp: Contribution[] = [];
    for (const w of st.waves) {
      tmp.length = 0;
      const wave = blastWave(ctx, w.wave);
      wave.contributions(pos, w.shield, tmp);
      for (const a of tmp) {
        if (a.dp <= 0) continue;
        const C = faceFactor(n, a);
        const tc = reliefTime(C, S, wave.sourceAmbient.c);
        loads.push({ face: 0, a, C, tc });
        first = Math.min(first, a.t);
        end = Math.max(end, a.t + span(a) + tc);
      }
    }
    if (!loads.length) return;
    const prev = st.parts?.find((p) => p.member === i);
    if (prev) { prev.loads = loads; prev.first = Math.min(prev.first, first); prev.end = Math.max(prev.end, end); prev.done = false; out.push(prev); return; }
    const entry: PartEntry = { ci: -1, member: i, sdof: newSdof((2 * Math.PI) / Math.max(1e-3, w1), mu), cap, loads, first, end, impulse: 0, tDone: first - 1e-3, peakP: 0, done: false };
    if (!canDamage(entry)) return;
    out.push(entry);
  });
  return out;
}

/**
 * Whether the loads of a part can bring it to its damage threshold at all (0.75·x_f): the rigorous
 * response bound (loads.ts) of the summed face pressures. Parts that cannot are never integrated —
 * far-field windows cost nothing.
 */
function canDamage(p: PartEntry): boolean {
  let fMax = 0, F = 0;
  for (const l of p.loads) {
    const C = Math.max(1, l.C);
    fMax += C * Math.max(l.a.dp, l.a.waveform === 'nWave' ? negAmp(l.a) : 0);
    F += C * 0.5 * l.a.dp * l.a.T + (l.a.waveform === 'nWave' ? 0.5 * negAmp(l.a) * negDur(l.a) : 0);
  }
  return responseBound(p.sdof, fMax / p.cap, F / p.cap) >= 0.75 * p.sdof.xFail;
}

/** Advance the parts of an object over the step; fail those that reach their limit. */
export function respondParts(e: RuntimeEntity, ctx: SystemContext, dt: number): number {
  const st = e.blast!;
  if (!st.parts) return 0;
  const t0 = ctx.time, t1 = t0 + dt;
  let n = 0;
  // Walls that reached their limit are re-analysed together, at most every WALL_ROUNDS steps.
  const walls = st.pendingWalls;
  for (const p of st.parts) {
    if (p.done || t1 < p.first) continue;
    if (p.member !== undefined) {
      if (!e.modular || e.modular.failed[p.member] || e.flags.collapsed) { p.done = true; continue; }
    } else if (e.components[p.ci].condition !== 'intact') { p.done = true; continue; }
    const c = p.member === undefined ? e.components[p.ci] : null;
    n++;
    const loads = p.loads, cap = p.cap;
    const from = Math.min(p.tDone, t0);
    p.tDone = t1;
    advanceSdof(p.sdof, (a, b) => {
      let s = 0;
      for (const l of loads) s += faceImpulse(l.a, l.C, l.tc, a, b);
      return s / cap;
    }, from, t1, (t) => {
      let s = 0;
      for (const l of loads) s += faceImpulseTo(l.a, l.C, l.tc, t);
      return s / cap;
    });
    for (const l of loads) {
      p.impulse += faceImpulse(l.a, l.C, l.tc, from, t1);
      const pk = facePressure(l.a, l.C, l.tc, Math.max(from, l.a.t));
      if (pk > p.peakP) p.peakP = pk;
    }
    const s = p.sdof;
    const ended = t0 > p.end;
    const peak = ended ? Math.max(s.peak, freeAmplitude(s)) : s.peak;
    if (peak >= s.xFail) {
      if (p.member !== undefined) walls.push({ p, ratio: peak / s.xFail });
      else {
        const tf = simProfiler.now();
        failPart(e, ctx, p, peak / s.xFail);
        simProfiler.add('blast.partFail', tf);
      }
      p.done = true;
      continue;
    }
    if (c && peak >= 0.75 * s.xFail) {
      c.health = Math.min(c.health, 1 - peak / s.xFail);
      c.state = worst(c.state, DamageState.DAMAGED);
    }
    if (ended) p.done = true;
  }
  // Each building has its own phase so the re-analyses do not bunch up — from its seed and placement,
  // not its id: ids are random per world creation, and the phase decides the step a wall fails on.
  if (walls.length && ((ctx.step + wallPhase(e)) % WALL_ROUNDS === 0 || st.parts.every((p) => p.done))) {
    const tf = simProfiler.now();
    if (!e.flags.collapsed) failWalls(e, ctx, walls.slice());
    walls.length = 0;
    simProfiler.add('blast.wallFail', tf);
  }
  return n;
}

const LOG_STEPS = [1, 10, 40, 160];
/**
 * Exterior walls failing within a building go through the Phase 17 load-path re-analysis in batches,
 * every 3 fixed steps (20 Hz — the rate the facade parts are evaluated at under wind): a wall that
 * reached its limit is removed at most 33 ms later (one re-analysis instead of one per wall / step).
 */
const WALL_ROUNDS = 3;
const wallPhase = (e: RuntimeEntity) => {
  const p = e.source.transform.position;
  return hashString(`walls:${e.source.seed}:${Math.round(p[0] * 100)}:${Math.round(p[2] * 100)}`) >>> 0;
};

/** Exterior walls that failed out of plane in this step: one batch through the member path. */
function failWalls(e: RuntimeEntity, ctx: SystemContext, list: { p: PartEntry; ratio: number }[]) {
  const st = e.blast!;
  let kx = 0, kz = 0, best = -1, ratio = 0;
  for (const { p, ratio: r } of list) {
    ratio = Math.max(ratio, r);
    for (const l of p.loads) if (l.a.dp > best) { best = l.a.dp; kx = l.a.k[0]; kz = l.a.k[2]; }
  }
  const kh = Math.hypot(kx, kz) || 1;
  st.broken += list.length;
  e.lastHazard = 'blast';
  e.lastCause = 'overpressure';
  // Phase 25: each wall leaves with the momentum the wave gave it — its received face impulse (Pa·s)
  // × its area / its mass, along the wave (building frame); out of its plan → a fragment.
  const mr = e.modular!, k = e.source.transform.scale, q = e.initialPose.quaternion;
  const inv: [number, number, number, number] = [-q[0], -q[1], -q[2], q[3]];
  const dirLocal = qRotate(inv, [kx / kh, 0, kz / kh]);
  const speed = new Map<number, number>();
  for (const { p } of list) {
    const m = mr.design.members[p.member!];
    const area = m.size[0] * m.size[1] * Math.max(k[0], k[2]) * k[1];
    speed.set(p.member!, (Math.abs(p.impulse) * area) / Math.max(1, mr.initial.members[p.member!].mass));
  }
  failMembers(e, ctx, list.map((w) => w.p.member!), {
    hazard: 'blast', cause: 'overpressure', response: ratio, dir: [kx / kh, 0, kz / kh], impulse: true,
    velocity: (i) => { const v = speed.get(i) ?? 0; return [dirLocal[0] * v, 0, dirLocal[2] * v]; },
  });
  const cnt = (e.counters.blastWall = (e.counters.blastWall ?? 0) + 1);
  if (cnt === 1) ctx.log(e.id, 'danger', { key: 'log.blast.wall' });
}

function failPart(e: RuntimeEntity, ctx: SystemContext, p: PartEntry, ratio: number) {
  const st = e.blast!;
  const c = e.components[p.ci];
  const pos = c.worldPos ?? componentWorldPos(e, c.spec);
  const n = c.worldNormal ?? ([0, 1, 0] as Vec3);
  const k = e.source.transform.scale;
  const size: Vec3 = [c.spec.size[0] * k[0], c.spec.size[1] * k[1], c.spec.size[2] * k[2]];
  const area = Math.max(size[0] * size[1], size[1] * size[2], size[0] * size[2]);
  const before = c.health;
  c.health = 0;
  c.state = DamageState.DESTROYED;
  e.rev++;
  st.broken++;
  if (e.source.type === 'building') noteFacadeFailure(e);
  e.lastHazard = 'blast';
  e.lastCause = 'overpressure';
  ctx.recordDamage(e, {
    eventType: c.spec.kind === 'window' ? 'BROKEN' : 'DETACHED', cause: 'overpressure', hazard: 'blast', componentId: c.spec.id, componentKind: c.spec.kind,
    worldPosition: pos, localWindSpeed: 0, force: p.peakP * area, damageBefore: 1 - before, damageAfter: 1, response: ratio, source: st.source,
  });
  // Direction of the strongest wave at the part; the part leaves with the impulse it took (∫p·A dt / m).
  let kx = 0, ky = 0, kz = 0, best = -1;
  for (const l of p.loads) if (l.a.dp > best) { best = l.a.dp; kx = l.a.k[0]; ky = l.a.k[1]; kz = l.a.k[2]; }
  const speed = Math.max(0.5, Math.min(30, (Math.abs(p.impulse) * area) / Math.max(1, c.spec.mass)));
  // Modular buildings (Phase 25): the member leaves with the momentum the wave gave it (∫p·A dt / m of
  // its own mass), without the Phase 24 speed bounds.
  const mi = e.modular ? e.modular.memberOfComp[p.ci] : -1;
  const vMember = mi >= 0 ? (Math.abs(p.impulse) * area) / Math.max(1, e.modular!.initial.members[mi].mass) : 0;
  const modular = e.modular !== undefined && detachFacadeMember(ctx, e, c, 'blast', [kx * vMember, ky * vMember, kz * vMember], true);
  if (c.spec.kind === 'window') {
    c.condition = 'broken';
    // Glass is driven along the wave (inward on the facing side) — particles are a visual effect.
    spawnParticles(ctx, 'glass', pos, 10, [kx * speed * 0.3 - n[0], ky * speed * 0.1, kz * speed * 0.3 - n[2]], 1.2, '#cfe6f7');
    const cnt = (e.counters.blastWindow = (e.counters.blastWindow ?? 0) + 1);
    if (LOG_STEPS.includes(cnt)) ctx.log(e.id, 'warn', { key: 'log.blast.windows', params: { n: cnt } });
    return;
  }
  c.condition = 'detached';
  if (!modular) spawnDebris(ctx, e, { kind: c.spec.kind, position: pos, size, mass: c.spec.mass, color: c.spec.color ?? '#888', push: [kx * speed, Math.max(0.2, ky * speed), kz * speed], hazard: 'blast' });
  const cnt = (e.counters.blastPart = (e.counters.blastPart ?? 0) + 1);
  if (LOG_STEPS.includes(cnt)) ctx.log(e.id, 'warn', { key: 'log.blast.parts', params: { n: cnt } });
}

// ── Free bodies ───────────────────────────────────────────────

/** Faces of a body at its current pose. */
function bodyFaces(e: RuntimeEntity): Faces {
  return boxFaces(e.pose.position, e.dims, e.pose.quaternion, e.areaFactor, true);
}

/** Vehicles, people, toppled structures: impulse + drag through the ForceLedger. */
export function respondBody(e: RuntimeEntity, ctx: SystemContext, dt: number) {
  const st = e.blast!;
  if (!e.dynamic || e.body === null) return;
  const t0 = ctx.time, t1 = t0 + dt;
  const faces = bodyFaces(e);
  const rho = ctx.env.airDensity;
  let any = false;
  F[0] = F[1] = F[2] = 0;
  L[0] = L[1] = L[2] = 0;
  const Lsum: Vec3 = [0, 0, 0];
  const vel = ctx.physics.getLinearVelocity(e.body);
  V[0] = vel[0]; V[1] = vel[1]; V[2] = vel[2];
  let kx = 0, kz = 0, best = -1;
  for (const w of st.waves) {
    if (t1 < w.first - 0.05 || t0 > w.end) continue;
    const wave = blastWave(ctx, w.wave);
    const end = faceLoads(faces, (p, out) => wave.contributions(p, w.shield, out), wave.sourceAmbient.c, tmpLoads);
    w.end = Math.max(w.end, end);
    const from = Math.min(w.tDone, t0);
    w.tDone = t1;
    netImpulse(faces, tmpLoads, from, t1, J, L);
    // Blast wind at the centre (drag area from the box projected along the wave).
    const centre: Contribution[] = [];
    wave.contributions(faces.center, w.shield, centre);
    let cdA = 0;
    if (centre.length) {
      const main = centre.reduce((a, b) => (b.dp > a.dp ? b : a));
      if (main.dp > best) { best = main.dp; kx = main.k[0]; kz = main.k[2]; }
      const q = e.pose.quaternion;
      const local = qRotate([-q[0], -q[1], -q[2], q[3]], main.k);
      cdA = e.source.physics.dragCoefficient * projectedArea(e.dims, local) * e.areaFactor;
    }
    dragImpulse(centre, cdA, rho, V, from, t1, D);
    F[0] += J[0] + D[0]; F[1] += J[1] + D[1]; F[2] += J[2] + D[2];
    Lsum[0] += L[0]; Lsum[1] += L[1]; Lsum[2] += L[2];
    any = true;
  }
  if (!any) return;
  const Jmag = Math.hypot(F[0], F[1], F[2]);
  if (Jmag < 1e-9) return;
  st.J += Jmag;
  pressureCentre(faces, e.dims, F, Lsum, P);
  const f: Vec3 = [F[0] / dt, F[1] / dt, F[2] / dt];
  const fm = Jmag / dt;
  if (fm > st.peakForce) st.peakForce = fm;
  ctx.forces.forceAtPoint('blast', e.body, f, P, e);
  // People: running velocity change along the wave vs the rigid-block toppling threshold.
  if (e.source.type === 'human' && !e.flags.fallen && best > 0) {
    const kh = Math.hypot(kx, kz) || 1;
    const mass = e.source.physics.mass;
    st.dv += (F[0] * kx + F[2] * kz) / kh / mass;
    if (st.dv > st.dvPeak) st.dvPeak = st.dv;
    const h = e.dims[1] / 2, b = FOOT_LEVER;
    const crit = Math.sqrt(2 * GRAVITY * (Math.hypot(h, b) - h)) * e.strength;
    if (st.dvPeak >= crit) {
      e.lastHazard = 'blast';
      knockDown(e, ctx, 'blast', fm, [kx / kh, 0, kz / kh]);
    }
  }
}

// ── Trees: base-moment oscillator ───────────────────────────────

export function respondTree(e: RuntimeEntity, ctx: SystemContext, dt: number) {
  const st = e.blast!;
  if (e.dynamic || e.body === null || e.flags.toppled || e.flags.snapped || e.flags.uprooted) {
    respondBody(e, ctx, dt);
    return;
  }
  const base = e.initialPose.position;
  if (!st.sdof) {
    const H = e.dims[1];
    st.sdof = newSdof(Math.max(0.5, Math.min(3, 0.1 * H)), 1);
    const w = e.source.physics.windResistance * e.strength;
    st.cap = 0.5 * AIR * e.source.physics.dragCoefficient * e.area * e.areaFactor * w * w * Math.max(0.5, e.copLocal[1]);
    if (ctx.interactions) st.cap *= residualStrength(e, 'blast');
  }
  const t0 = ctx.time, t1 = t0 + dt;
  // Base moment about the horizontal axis normal to the strongest wave (sign kept for the N-wave).
  let ax = 0, az = 0, best = -1;
  for (const w of st.waves) for (const c of w.center) if (c.dp > best) { best = c.dp; const kh = Math.hypot(c.k[0], c.k[2]) || 1; ax = c.k[2] / kh; az = -c.k[0] / kh; }
  const moment = (a: number, b: number) => {
    let m = 0;
    for (const w of st.waves) {
      if (!w.faces || b < w.first || a > w.end) continue;
      netImpulse(w.faces, w.loads, a, b, J, L, true);
      const c = w.faces.center;
      const rx = c[0] - base[0], ry = c[1] - base[1], rz = c[2] - base[2];
      // (L_centre + r × J) · axis
      let mx = L[0] + (ry * J[2] - rz * J[1]), mz = L[2] + (rx * J[1] - ry * J[0]);
      // Blast-wind drag at the centre of pressure.
      if (w.cdA > 0) {
        dragImpulse(w.center, w.cdA, ctx.env.airDensity, ZERO, a, b, D);
        const hy = e.copLocal[1];
        mx += hy * D[2];
        mz -= hy * D[0];
      }
      m += mx * ax + mz * az;
    }
    return st.cap > 0 ? m / st.cap : 0;
  };
  const from = Math.min(st.sdofT === -Infinity ? Math.min(...st.waves.map((w) => w.first)) - 1e-3 : st.sdofT, t0);
  st.sdofT = t1;
  advanceSdof(st.sdof, moment, from, t1);
  const ended = st.waves.every((w) => t0 > w.end);
  const peak = ended ? Math.max(st.sdof.peak, freeAmplitude(st.sdof)) : st.sdof.peak;
  st.damage = Math.max(st.damage, Math.min(1, peak / e.source.physics.breakThreshold));
  if (peak >= e.source.physics.breakThreshold) {
    ctx.physics.setBodyKind(e.body, 'dynamic');
    e.dynamic = true;
    e.flags.toppled = true;
    st.damage = 1;
    e.health = 0;
    e.state = DamageState.DESTROYED;
    e.lastHazard = 'blast';
    e.lastCause = 'blast';
    e.rev++;
    ctx.recordDamage(e, { eventType: 'TOPPLED', cause: 'blast', hazard: 'blast', response: peak, force: st.cap * peak / Math.max(0.5, e.copLocal[1]), source: st.source });
    ctx.log(e.id, 'danger', { key: 'log.blast.toppled' });
    const kh = Math.hypot(az, ax) || 1;
    ctx.physics.applyImpulse(e.body, [(-az / kh) * e.source.physics.mass * 0.3, 0, (ax / kh) * e.source.physics.mass * 0.3]);
  } else if (peak >= 0.5 * e.source.physics.breakThreshold && e.state < DamageState.STRESSED) {
    e.state = DamageState.STRESSED;
  }
}

/** Contributions at the centre of a static object (peak / impulse / exposure), for its state. */
export function centreOf(w: WaveLoad): Contribution[] {
  return w.center;
}
