/**
 * Simplified structural model of a modular building (Phase 17) — an explainable approximation,
 * NOT a finite-element analysis. Pure function of the design (+ object scale) and of the set of
 * members that have already failed (runtime re-analysis after damage).
 *
 *  1. Geometry & connections — members that touch (AABBs within 6 cm) are connected.
 *  2. Load path — who rests on whom (type-specific rules), "supported" grows from the ground
 *     up to a fixed point. A member without a complete path to the ground is UNSUPPORTED.
 *  3. Gravity load distribution — members are visited top-down and pass their own weight plus
 *     what they carry to their supports in equal shares (tributary approximation).
 *     Utilization: columns / walls vs crushing and Euler buckling, beams / slabs vs bending.
 *  4. Story stiffness / strength per direction:
 *     - frame columns: Muto's D-value method — k = a·12EI/h³ with a from the beam / column
 *       stiffness ratio k̄ (a = k̄/(2+k̄); ground story a = (0.5+k̄)/(2+k̄));
 *       shear strength (M_top + M_bottom)/h with joint moments limited by the beams (weak beams
 *       → beam mechanism);
 *     - walls (in-plane): cantilever flexibility of the continuous wall stack shared by its
 *       stories in series + shear flexibility 1.2h/(G·t·L); openings reduce stiffness
 *       (1−r)^1.5 and strength (1−r); strength = min(shear, flexure + gravity rocking);
 *     - cladding, partitions, windows: mass only.
 *  5. Periods — lumped-mass shear chain, inverse iteration; bounded to ×0.6–1.6 of the code-style
 *     period formula of the dominant system (reported as "calibrated").
 */
import type { StructuralSystem } from '@/core/model';
import type { Vec3 } from '@/core/types';
import { GRAVITY } from '@/core/units';
import { STRUCTURAL_SYSTEMS } from '@/simulation/seismic/structuralProps';
import { MATERIALS, material, type FillKind, type MaterialId } from './materials';
import { boxVolume, lengthAxis, memberBounds, scaledSize, type Box3 } from './geometry';
import { isLateralRole, isStructuralRole, OCCUPANCY_MASS, ROOF_SUPERIMPOSED, type BuildingDesign, type BuildingMember } from './types';

const TOL = 0.06;
/** Vertical search window below a column / wall for what it stands on (m). */
const BEARING_GAP = 0.6;
/** Largest gap considered at all (roof panels over beams of halls). */
const NEAR_GAP = 1;

export type WarningCode =
  | 'unsupported' | 'nonStructuralMaterial' | 'overloaded' | 'cantilever' | 'noLateral' | 'softStory' | 'weakStory'
  | 'noHost' | 'noFoundation' | 'periodCalibrated' | 'torsion';

export interface AnalysisWarning {
  code: WarningCode;
  level: 'error' | 'warning' | 'info';
  /** Member ids involved (capped). */
  members?: string[];
  story?: number;
  value?: number;
}

export interface MemberAnalysis {
  index: number;
  id: string;
  box: Box3;
  /** Own dimensions (scaled). */
  size: Vec3;
  /** Own mass + superimposed mass carried as mass (kg). */
  mass: number;
  /** Can carry other members (structural role + load-bearing material, not failed). */
  bearing: boolean;
  /** Indices of the members it rests on / hangs from. */
  supports: number[];
  /** Rests directly on the ground (foundations, slab-on-grade). */
  ground: boolean;
  supported: boolean;
  /** Vertical load carried: own weight + received (N). */
  load: number;
  /** load / capacity (0 for members without a gravity check). */
  utilization: number;
  /** Lateral story stiffness / yield shear contributions along building x / z. */
  kx: number;
  kz: number;
  vx: number;
  vz: number;
  /** Drift ratio at failure (lateral members). */
  driftCapacity: number;
  /** Opening area / wall area (walls). */
  openingRatio: number;
}

export interface StoryAnalysis {
  index: number;
  /** Base elevation and height (m). */
  base: number;
  height: number;
  /** Mass lumped at the top of the story (kg). */
  mass: number;
  kx: number;
  kz: number;
  vx: number;
  vz: number;
  /** Lateral member indices. */
  lateral: number[];
  /** Stiffness-weighted drift capacity of the lateral members. */
  driftU: number;
  /** Weight of everything above the story's base (N). */
  weightAbove: number;
}

export interface BuildingAnalysis {
  members: MemberAnalysis[];
  byId: Map<string, number>;
  stories: StoryAnalysis[];
  /** Superstructure mass incl. superimposed loads (kg) — what shakes. */
  totalMass: number;
  /** Members only (kg). */
  structuralMass: number;
  foundationMass: number;
  centerOfMass: Vec3;
  /** Height of the top slab / wall tops (m) and of the highest point incl. roof (m). */
  height: number;
  top: number;
  /** Above-ground bounds (scaled). */
  bounds: Box3;
  connections: number;
  /** Fundamental periods along x / z (s), the raw member-based values, the code band. */
  periodX: number;
  periodZ: number;
  periodRaw: [number, number];
  periodBand: [number, number];
  /** Stiffness multiplier applied to bring the period into the band (1 = none). */
  calibration: [number, number];
  /** Base-shear coefficient at first yield of the weakest story (× weight) along x / z. */
  cyX: number;
  cyZ: number;
  /** Story with the lowest capacity / demand ratio along x / z. */
  weakStory: [number, number];
  /** Dominant lateral material / system, damping, collapse drift. */
  system: StructuralSystem;
  material: MaterialId;
  damping: number;
  driftU: number;
  hardening: number;
  warnings: AnalysisWarning[];
  unsupported: string[];
}

const fillKind = (t: BuildingMember['type']): FillKind =>
  t === 'window' || t === 'door' ? 'opening' : t === 'foundation' ? 'foundation' : t === 'column' ? 'column' : t === 'beam' ? 'beam' : t === 'slab' ? 'slab' : t === 'roof' ? 'roof' : 'wall';

/** Material → structural system whose damage thresholds / period formula apply. */
export const SYSTEM_OF: Record<MaterialId, StructuralSystem> = {
  reinforcedConcrete: 'rcFrame', structuralSteel: 'steelFrame', masonry: 'masonry', timber: 'wood', glass: 'rcFrame', lightCladding: 'steelFrame',
};

export interface AnalyzeOptions {
  /** Object scale. */
  scale?: Vec3;
  /** Members treated as removed (failed in a simulation). */
  failed?: ReadonlySet<string>;
  /** Number of stories (design spec); default from member levels. */
  floors?: number;
}

/** Story of a member for lateral purposes (columns / walls of story s; beams / slabs at its top). */
const storyOf = (m: BuildingMember) => m.level;

export function analyzeBuilding(design: BuildingDesign, opts: AnalyzeOptions = {}): BuildingAnalysis {
  const k = opts.scale ?? [1, 1, 1];
  // Members that start fully damaged (initialDamage = 1) are treated as failed.
  let failed = opts.failed;
  if (design.members.some((m) => (m.initialDamage ?? 0) >= 0.999)) {
    const f = new Set(failed ?? []);
    for (const m of design.members) if ((m.initialDamage ?? 0) >= 0.999) f.add(m.id);
    failed = f;
  }
  const src = design.members;
  const n = src.length;
  const floors = opts.floors ?? Math.max(1, design.spec.floors);
  const warnings: AnalysisWarning[] = [];
  const byId = new Map<string, number>();
  src.forEach((m, i) => byId.set(m.id, i));

  // ── 1. Members: geometry, mass ─────────────────────────────────────
  const openingArea = new Float64Array(n);
  for (const m of src) {
    if ((m.type === 'window' || m.type === 'door') && m.host !== undefined) {
      const h = byId.get(m.host);
      if (h !== undefined) openingArea[h] += m.size[0] * m.size[1] * k[1] * Math.max(k[0], k[2]);
    }
  }
  let topSlab = -Infinity;
  for (const m of src) if (m.type === 'slab' && m.level >= 0 && !failed?.has(m.id)) topSlab = Math.max(topSlab, m.level);
  const out: MemberAnalysis[] = src.map((m, index) => {
    const mat = material(m.material);
    const size = scaledSize(m, k);
    const box = memberBounds(m, k);
    const isWall = m.type === 'wall';
    const wallArea = isWall ? size[0] * size[1] : 0;
    const openingRatio = isWall && wallArea > 0 ? Math.min(0.95, openingArea[index] / wallArea) : 0;
    let mass = boxVolume(m, k) * mat.density * mat.fill[fillKind(m.type)] * (1 - openingRatio);
    if (m.type === 'slab' && m.level >= 0) {
      const area = size[0] * size[2];
      const roofSlab = m.level >= topSlab;
      mass += area * (roofSlab ? ROOF_SUPERIMPOSED : OCCUPANCY_MASS[design.spec.occupancy]);
    } else if (m.type === 'roof') {
      mass += size[0] * size[2] * 15; // covering / insulation
    }
    const gone = !!failed?.has(m.id);
    return {
      index, id: m.id, box, size, mass: gone ? 0 : mass,
      bearing: !gone && isStructuralRole(m.role) && mat.structural,
      supports: [], ground: false, supported: false, load: 0, utilization: 0,
      kx: 0, kz: 0, vx: 0, vz: 0, driftCapacity: 0, openingRatio,
    };
  });

  // ── 2. Connections (sweep and prune along y) ───────────────────────
  // adj: touching (≤ 6 cm). below: members whose top lies at most NEAR_GAP under a member's
  // bottom and overlap it in plan — what a column / wall / slab / roof can stand on across a
  // slab or joint (a column stands on the column of the story below through the slab).
  const order = out.map((_, i) => i).sort((a, b) => out[a].box.min[1] - out[b].box.min[1] || a - b);
  const adj: number[][] = out.map(() => []);
  const below: number[][] = out.map(() => []);
  let connections = 0;
  // Flat bounds: [minX, minY, minZ, maxX, maxY, maxZ] per member (hot loop).
  const B = new Float64Array(n * 6);
  out.forEach((a, i) => {
    B[i * 6] = a.box.min[0]; B[i * 6 + 1] = a.box.min[1]; B[i * 6 + 2] = a.box.min[2];
    B[i * 6 + 3] = a.box.max[0]; B[i * 6 + 4] = a.box.max[1]; B[i * 6 + 5] = a.box.max[2];
  });
  const active = new Int32Array(n);
  let na = 0;
  for (const i of order) {
    if (failed?.has(src[i].id)) continue;
    const o = i * 6;
    const x0 = B[o], y0 = B[o + 1], z0 = B[o + 2], x1 = B[o + 3], y1 = B[o + 4], z1 = B[o + 5];
    let w = 0;
    for (let q = 0; q < na; q++) {
      const j = active[q];
      if (B[j * 6 + 4] + NEAR_GAP >= y0) active[w++] = j;
    }
    na = w;
    for (let q = 0; q < na; q++) {
      const j = active[q];
      const p = j * 6;
      // Plan rejection first (most active members are elsewhere on the floor).
      if (x0 - TOL > B[p + 3] || B[p] - TOL > x1 || z0 - TOL > B[p + 5] || B[p + 2] - TOL > z1) continue;
      const jy0 = B[p + 1], jy1 = B[p + 4];
      if (y0 - TOL <= jy1 && jy0 - TOL <= y1) {
        adj[i].push(j);
        adj[j].push(i);
        connections++;
      }
      const planOk = Math.min(x1, B[p + 3]) - Math.max(x0, B[p]) + 0.02 > 0 && Math.min(z1, B[p + 5]) - Math.max(z0, B[p + 2]) + 0.02 > 0;
      if (!planOk) continue;
      // j starts lower (sorted): is its top just under i's bottom (or the other way round)?
      if (jy1 <= y0 + TOL && jy1 >= y0 - NEAR_GAP) below[i].push(j);
      else if (y1 <= jy0 + TOL && y1 >= jy0 - NEAR_GAP) below[j].push(i);
    }
    active[na++] = i;
  }

  // ── 3. Support candidates per member (type-specific) ──────────────
  const groundY = 0.02 * k[1];
  for (let i = 0; i < n; i++) {
    const m = src[i];
    const a = out[i];
    if (failed?.has(m.id)) continue;
    if (m.type === 'foundation' || (m.type === 'slab' && a.box.min[1] <= groundY && m.level < 0)) {
      a.ground = true;
      continue;
    }
    if (m.type === 'window' || m.type === 'door') {
      const h = m.host !== undefined ? byId.get(m.host) : undefined;
      if (h !== undefined && !failed?.has(src[h].id) && adj[i].includes(h)) a.supports.push(h);
      else {
        // Lost host: any touching wall still holds it.
        const w = adj[i].find((j) => src[j].type === 'wall');
        if (w !== undefined) a.supports.push(w);
      }
      continue;
    }
    const cand = adj[i].filter((j) => out[j].bearing && j !== i);
    const under = (gap: number, stack = false) =>
      below[i].filter((j) => (out[j].bearing || (stack && src[j].type === 'wall')) && !failed?.has(src[j].id) && out[j].box.max[1] >= a.box.min[1] - gap);
    if (m.type === 'column' || m.type === 'wall') {
      // What it stands on: tops within BEARING_GAP below its bottom, overlapping in plan.
      // Non-load-bearing walls may stack on other walls (infill courses, stepped gables).
      const u = under(BEARING_GAP, m.type === 'wall' && m.role !== 'bearing');
      const vertical = u.filter((j) => src[j].type === 'column' || src[j].type === 'wall' || src[j].type === 'foundation');
      // Prefer continuous vertical members; otherwise it is carried by beams / slabs (transfer).
      const nearest = u.filter((j) => src[j].type !== 'column' && src[j].type !== 'wall');
      a.supports.push(...(vertical.length ? vertical : nearest));
      // Non-structural walls (cladding, partitions) may also hang from the frame beside them.
      if (!a.supports.length && m.role !== 'bearing') a.supports.push(...cand.filter((j) => src[j].type === 'column' || src[j].type === 'beam'));
      continue;
    }
    if (m.type === 'beam') {
      a.supports.push(...cand.filter((j) => {
        const t = src[j].type;
        if (t === 'column' || t === 'wall') return out[j].box.min[1] < a.box.min[1] + TOL;
        if (t === 'beam') return src[j].role === 'primary' && out[j].box.min[1] <= a.box.min[1] + TOL && j !== i;
        return false;
      }));
      continue;
    }
    // Slabs: the beams / walls / columns right under them. Roofs: whatever is under their
    // footprint (slab, wall tops, beams of a hall) — pitched panels touch only along an edge.
    if (m.type === 'slab') {
      a.supports.push(...under(0.15).filter((j) => src[j].type !== 'slab'));
    } else {
      const u = under(NEAR_GAP);
      a.supports.push(...(u.length ? u : cand.filter((j) => out[j].box.min[1] < a.box.min[1])));
    }
  }

  // ── 4. Supported: fixed point from the ground up ────────────────────
  const needsTwoEnds = (i: number) => src[i].type === 'beam';
  let changed = true;
  for (const a of out) a.supported = a.ground;
  for (let pass = 0; changed && pass < 200; pass++) {
    changed = false;
    for (const i of order) {
      const a = out[i];
      if (a.supported || failed?.has(src[i].id)) continue;
      const ok = a.supports.filter((j) => out[j].supported);
      let sup = ok.length > 0;
      if (sup && needsTwoEnds(i)) sup = beamHeld(src[i], out[i], ok.map((j) => out[j]));
      if (sup) {
        a.supported = true;
        changed = true;
      }
    }
  }
  const unsupported = src.filter((m, i) => !out[i].supported && !failed?.has(m.id)).map((m) => m.id);
  if (unsupported.length) warnings.push({ code: 'unsupported', level: 'error', members: unsupported.slice(0, 50), value: unsupported.length });
  const nonStruct = src.filter((m) => isStructuralRole(m.role) && m.role !== 'foundation' && !MATERIALS[m.material].structural).map((m) => m.id);
  if (nonStruct.length) warnings.push({ code: 'nonStructuralMaterial', level: 'warning', members: nonStruct.slice(0, 50), value: nonStruct.length });
  if (!src.some((m) => m.type === 'foundation' && !failed?.has(m.id))) warnings.push({ code: 'noFoundation', level: 'warning' });
  const orphans = src.filter((m) => (m.type === 'window' || m.type === 'door') && (!m.host || !byId.has(m.host))).map((m) => m.id);
  if (orphans.length) warnings.push({ code: 'noHost', level: 'info', members: orphans.slice(0, 50), value: orphans.length });

  // ── 5. Gravity load distribution (top-down) + utilization ─────────
  const down = [...order].reverse();
  for (const a of out) a.load = a.mass * GRAVITY;
  for (const i of down) {
    const a = out[i];
    if (!a.supported || failed?.has(src[i].id)) continue;
    const sup = a.supports.filter((j) => out[j].supported);
    if (!sup.length) continue;
    const share = a.load / sup.length;
    for (const j of sup) out[j].load += share;
  }
  const overloaded: string[] = [];
  const cantilevers: string[] = [];
  let maxUtil = 0;
  for (let i = 0; i < n; i++) {
    const m = src[i];
    const a = out[i];
    if (!a.bearing) continue;
    a.utilization = gravityUtilization(m, a, a.supports.filter((j) => out[j].supported).map((j) => out[j]));
    if (a.utilization > maxUtil) maxUtil = a.utilization;
    if (a.utilization > 1) overloaded.push(m.id);
    if (m.type === 'beam' && a.supported && isCantilever(m, a, a.supports.map((j) => out[j])) && a.size[0] > 3) cantilevers.push(m.id);
  }
  if (overloaded.length) warnings.push({ code: 'overloaded', level: 'warning', members: overloaded.slice(0, 50), value: maxUtil });
  if (cantilevers.length) warnings.push({ code: 'cantilever', level: 'info', members: cantilevers.slice(0, 50), value: cantilevers.length });

  // ── 6. Story geometry, masses ───────────────────────────────────────
  const stories: StoryAnalysis[] = [];
  for (let s = 0; s < floors; s++) stories.push({ index: s, base: Infinity, height: 0, mass: 0, kx: 0, kz: 0, vx: 0, vz: 0, lateral: [], driftU: 0, weightAbove: 0 });
  let structuralMass = 0;
  let foundationMass = 0;
  let totalMass = 0;
  const com: Vec3 = [0, 0, 0];
  const bounds: Box3 = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  let height = 0;
  for (let i = 0; i < n; i++) {
    const m = src[i];
    const a = out[i];
    if (failed?.has(m.id)) continue;
    const own = boxVolume(m, k) * material(m.material).density * material(m.material).fill[fillKind(m.type)] * (1 - a.openingRatio);
    if (m.level < 0) {
      foundationMass += a.mass;
      structuralMass += own;
      continue;
    }
    structuralMass += own;
    totalMass += a.mass;
    const c = [(a.box.min[0] + a.box.max[0]) / 2, (a.box.min[1] + a.box.max[1]) / 2, (a.box.min[2] + a.box.max[2]) / 2];
    for (let d = 0; d < 3; d++) com[d] += a.mass * c[d];
    for (let d = 0; d < 3; d++) {
      bounds.min[d] = Math.min(bounds.min[d], a.box.min[d]);
      bounds.max[d] = Math.max(bounds.max[d], a.box.max[d]);
    }
    if (m.type !== 'roof' && !(m.type === 'wall' && m.level >= floors)) height = Math.max(height, a.box.max[1]);
    // Lumped floor masses: vertical members split half / half between the floors they connect.
    const s = Math.min(floors - 1, storyOf(m));
    if (m.type === 'column' || (m.type === 'wall' && m.level < floors) || m.type === 'window' || m.type === 'door') {
      stories[s].mass += a.mass / 2;
      if (s > 0) stories[s - 1].mass += a.mass / 2;
    } else stories[s].mass += a.mass;
    if (m.type === 'column' || m.type === 'wall') {
      const st = stories[Math.max(0, s)];
      st.base = Math.min(st.base, a.box.min[1]);
    }
  }
  if (totalMass > 0) for (let d = 0; d < 3; d++) com[d] /= totalMass;
  if (!Number.isFinite(bounds.min[0])) {
    bounds.min = [0, 0, 0];
    bounds.max = [0, 0, 0];
  }
  // Story bases / heights from the slab levels (fallback: even split).
  for (let s = 0; s < floors; s++) {
    const st = stories[s];
    if (!Number.isFinite(st.base)) st.base = s === 0 ? 0 : stories[s - 1].base + stories[s - 1].height;
    if (s === 0) st.base = 0;
  }
  for (let s = 0; s < floors; s++) {
    const next = s + 1 < floors ? stories[s + 1].base : height;
    stories[s].height = Math.max(0.5, next - stories[s].base);
  }
  let above = 0;
  for (let s = floors - 1; s >= 0; s--) {
    above += stories[s].mass * GRAVITY;
    stories[s].weightAbove = above;
  }

  // ── 7. Lateral stiffness / strength ─────────────────────────────────
  lateral(src, out, adj, stories, floors, failed);
  for (const st of stories) {
    let kw = 0;
    let du = 0;
    for (const i of st.lateral) {
      const w = out[i].kx + out[i].kz;
      kw += w;
      du += w * out[i].driftCapacity;
    }
    st.driftU = kw > 0 ? du / kw : 0.01;
    if (st.kx <= 0 || st.kz <= 0) warnings.push({ code: 'noLateral', level: 'error', story: st.index });
  }
  for (let s = 0; s + 1 < floors; s++) {
    const a = stories[s];
    const b = stories[s + 1];
    if (Math.min(a.kx / Math.max(1, b.kx), a.kz / Math.max(1, b.kz)) < 0.7) warnings.push({ code: 'softStory', level: 'warning', story: s });
  }

  // Dominant lateral material (by stiffness share) → system thresholds, damping, hardening.
  const share = new Map<MaterialId, number>();
  for (const st of stories) for (const i of st.lateral) share.set(src[i].material, (share.get(src[i].material) ?? 0) + out[i].kx + out[i].kz);
  let dom: MaterialId = design.spec.structureMaterial;
  let best = -1;
  let ksum = 0;
  let damp = 0;
  let hard = 0;
  for (const [mat, w] of share) {
    ksum += w;
    damp += w * MATERIALS[mat].damping;
    hard += w * MATERIALS[mat].hardening;
    if (w > best) { best = w; dom = mat; }
  }
  const system = SYSTEM_OF[dom];
  const damping = ksum > 0 ? damp / ksum : STRUCTURAL_SYSTEMS[system].damping;
  const hardening = ksum > 0 ? hard / ksum : STRUCTURAL_SYSTEMS[system].hardening;

  // ── 8. Periods (shear chain) bounded by the code band ───────────────
  const masses = stories.map((s) => Math.max(1, s.mass));
  const rawX = chainPeriod(masses, stories.map((s) => Math.max(1, s.kx)));
  const rawZ = chainPeriod(masses, stories.map((s) => Math.max(1, s.kz)));
  const sp = STRUCTURAL_SYSTEMS[system];
  const tCode = sp.ct * Math.pow(Math.max(2, height), sp.x);
  // Measured periods are typically 1.2–1.5 × the code formula (which is deliberately short).
  const band: [number, number] = [0.6 * tCode, 1.6 * tCode];
  const fit = (t: number) => (t < band[0] ? band[0] : t > band[1] ? band[1] : t);
  const periodX = fit(rawX);
  const periodZ = fit(rawZ);
  const calibration: [number, number] = [(rawX / periodX) ** 2, (rawZ / periodZ) ** 2];
  if (Math.abs(calibration[0] - 1) > 1e-9 || Math.abs(calibration[1] - 1) > 1e-9) warnings.push({ code: 'periodCalibrated', level: 'info', value: Math.max(rawX / periodX, rawZ / periodZ, periodX / rawX, periodZ / rawZ) });

  // ── 9. Weakest story under a code-like inverted-triangle distribution ───
  const W = Math.max(1, stories.reduce((t, s) => t + s.mass, 0) * GRAVITY);
  const fz: number[] = [];
  let fsum = 0;
  stories.forEach((s) => {
    const f = s.mass * (s.base + s.height);
    fz.push(f);
    fsum += f;
  });
  let cyX = Infinity, cyZ = Infinity;
  const weak: [number, number] = [0, 0];
  let acc = 0;
  for (let s = floors - 1; s >= 0; s--) {
    acc += fz[s];
    const r = fsum > 0 ? acc / fsum : 1; // story shear / base shear
    const cx = stories[s].vx / (r * W);
    const cz = stories[s].vz / (r * W);
    if (cx < cyX) { cyX = cx; weak[0] = s; }
    if (cz < cyZ) { cyZ = cz; weak[1] = s; }
  }
  if (!Number.isFinite(cyX)) cyX = 0;
  if (!Number.isFinite(cyZ)) cyZ = 0;
  if (floors > 1 && (weak[0] > 0 || weak[1] > 0)) warnings.push({ code: 'weakStory', level: 'info', story: weak[0] > 0 ? weak[0] : weak[1] });
  // Torsion: center of stiffness of the ground story far from the center of mass.
  const g0 = stories[0];
  if (g0 && g0.kx > 0 && g0.kz > 0) {
    let ex = 0, ez = 0;
    for (const i of g0.lateral) {
      const c = out[i].box;
      ex += out[i].kz * ((c.min[0] + c.max[0]) / 2);
      ez += out[i].kx * ((c.min[2] + c.max[2]) / 2);
    }
    const dx = Math.abs(ex / g0.kz - com[0]) / Math.max(1, bounds.max[0] - bounds.min[0]);
    const dz = Math.abs(ez / g0.kx - com[2]) / Math.max(1, bounds.max[2] - bounds.min[2]);
    if (Math.max(dx, dz) > 0.15) warnings.push({ code: 'torsion', level: 'info', value: Math.max(dx, dz) });
  }

  const top = Math.max(height, bounds.max[1]);
  const driftU = stories[0]?.driftU ?? 0.02;
  return {
    members: out, byId, stories, totalMass, structuralMass, foundationMass, centerOfMass: com, height, top, bounds, connections,
    periodX, periodZ, periodRaw: [rawX, rawZ], periodBand: band, calibration, cyX, cyZ, weakStory: weak,
    system, material: dom, damping, driftU, hardening, warnings, unsupported,
  };
}

/** Position of a member center along a beam's axis, relative to the beam center (m). */
function along(beam: MemberAnalysis, axis: [number, number], o: MemberAnalysis): number {
  const bc = [(beam.box.min[0] + beam.box.max[0]) / 2, (beam.box.min[2] + beam.box.max[2]) / 2];
  const oc = [(o.box.min[0] + o.box.max[0]) / 2, (o.box.min[2] + o.box.max[2]) / 2];
  return (oc[0] - bc[0]) * axis[0] + (oc[1] - bc[1]) * axis[1];
}

/** A beam is held when it has supports on both sides of its center, or one support near the middle third (cantilever allowed). */
function beamHeld(m: BuildingMember, a: MemberAnalysis, sup: MemberAnalysis[]): boolean {
  if (!sup.length) return false;
  const ax = lengthAxis(m);
  const L = a.size[0];
  let neg = false, pos = false;
  for (const s of sup) {
    const t = along(a, ax, s);
    if (t <= L * 0.25) neg = true;
    if (t >= -L * 0.25) pos = true;
  }
  return neg || pos;
}

function isCantilever(m: BuildingMember, a: MemberAnalysis, sup: MemberAnalysis[]): boolean {
  const ax = lengthAxis(m);
  const L = a.size[0];
  let neg = false, pos = false;
  for (const s of sup) {
    const t = along(a, ax, s);
    if (t < -L * 0.25) neg = true;
    if (t > L * 0.25) pos = true;
  }
  return !(neg && pos);
}

/** Gravity utilization (≥ 1 = over capacity) of a load-bearing member. */
function gravityUtilization(m: BuildingMember, a: MemberAnalysis, sup: MemberAnalysis[]): number {
  const mat = material(m.material);
  const [sx, sy, sz] = a.size;
  const sf = mat.stiffnessFactor;
  switch (m.type) {
    case 'column': {
      const A = sx * sz * mat.fill.column;
      const I = (Math.min(sx, sz) ** 3 * Math.max(sx, sz)) / 12 * mat.inertiaFill;
      const crush = mat.compressive * A;
      const buckle = (Math.PI ** 2 * mat.E * sf * I) / (sy * sy);
      return a.load / Math.max(1, Math.min(crush, buckle));
    }
    case 'wall': {
      if (m.role !== 'bearing') return 0;
      const t = sz;
      const slender = Math.max(0.3, 1 - (sy / Math.max(0.05, t) / 40) ** 2);
      const cap = mat.compressive * t * sx * mat.fill.wall * (1 - a.openingRatio) * slender;
      return a.load / Math.max(1, cap);
    }
    case 'beam': {
      // Simply supported (or cantilever) under its total load as uniform load.
      const S = (sz * sy * sy) / 6 * mat.inertiaFill;
      const cap = mat.flexural * S;
      const W = a.load;
      const M = isCantilever(m, a, sup) && sup.length ? (W * sx) / 2 : (W * sx) / 8;
      return M / Math.max(1, cap);
    }
    case 'slab': {
      // One-way plate across the shorter span, per meter of width.
      const span = Math.min(sx, sz);
      const width = Math.max(sx, sz);
      const t = sy;
      const w = a.load / Math.max(0.01, sx * sz);
      const M = (w * span * span) / 8;
      const cap = mat.flexural * (t * t) / 6 * mat.fill.slab;
      return (M * width) / Math.max(1, cap * width);
    }
    default:
      return 0;
  }
}

/**
 * Lateral stiffness / strength of every story (see the header for the formulas).
 * Writes kx, kz, vx, vz, driftCapacity on members and sums them per story.
 */
function lateral(src: readonly BuildingMember[], out: MemberAnalysis[], adj: number[][], stories: StoryAnalysis[], floors: number, failed?: ReadonlySet<string>) {
  // Wall stacks (continuous walls over several stories) for the cantilever flexibility.
  const stackOf = wallStacks(src, out, failed);
  // Primary beams framing into each column's top joint.
  const topBeams: number[][] = src.map((m, i) => (m.type !== 'column' ? [] : adj[i].filter((j) => {
    const b = src[j];
    return b.type === 'beam' && b.role === 'primary' && out[j].supported && !failed?.has(b.id) && out[j].box.max[1] >= out[i].box.max[1] - 0.1;
  })));
  for (let i = 0; i < src.length; i++) {
    const m = src[i];
    const a = out[i];
    if (failed?.has(m.id) || !a.bearing || !a.supported || !isLateralRole(m.role)) continue;
    if (m.level < 0 || m.level >= floors) continue;
    const mat = material(m.material);
    const s = m.level;
    const [sx, sy, sz] = a.size;
    const h = Math.max(0.5, sy);
    if (m.type === 'column') {
      const E = mat.E * mat.stiffnessFactor;
      // Plan extents along building x / z (yaw-aware); bending with drift along x uses ex as depth.
      const yaw = m.rotation[1];
      const cs = Math.abs(Math.cos(yaw)), sn = Math.abs(Math.sin(yaw));
      const ex = sx * cs + sz * sn;
      const ez = sx * sn + sz * cs;
      const Ix = (ez * ex ** 3) / 12 * mat.inertiaFill;
      const Iz = (ex * ez ** 3) / 12 * mat.inertiaFill;
      const Sx = Ix / (ex / 2);
      const Sz = Iz / (ez / 2);
      const kcX = Ix / h;
      const kcZ = Iz / h;
      // Beams framing into the top joint (this story) and the bottom joint (the top joint of the
      // column it stands on).
      const top = topBeams[i];
      const bottom = out[i].supports.filter((j) => src[j].type === 'column').flatMap((j) => topBeams[j]);
      const beamK = (js: number[], dirX: boolean) => {
        let kb = 0, mb = 0;
        for (const j of js) {
          const ax = lengthAxis(src[j]);
          const w = dirX ? ax[0] * ax[0] : ax[1] * ax[1];
          if (w < 0.25) continue;
          const bm = material(src[j].material);
          const [bl, bh, bw] = out[j].size;
          const Ib = (bw * bh ** 3) / 12 * bm.inertiaFill;
          kb += (Ib * (bm.E * bm.stiffnessFactor) / E) / Math.max(0.5, bl) * w;
          mb += bm.flexural * (bw * bh * bh) / 6 * bm.inertiaFill * w;
        }
        return { kb, mb };
      };
      const ground = s === 0;
      const semiRigid = m.material === 'timber' ? 0.3 : 1;
      for (const dirX of [true, false]) {
        const kc = dirX ? kcX : kcZ;
        const I = dirX ? Ix : Iz;
        const Mc = mat.flexural * (dirX ? Sx : Sz);
        const t = beamK(top, dirX);
        const b = beamK(bottom, dirX);
        let aD: number;
        if (ground) {
          const kbar = t.kb / Math.max(1e-12, kc);
          aD = t.kb > 0 ? (0.5 + kbar) / (2 + kbar) : 0.25;
        } else {
          const kbar = (t.kb + b.kb) / Math.max(1e-12, 2 * kc);
          aD = t.kb + b.kb > 0 ? kbar / (2 + kbar) : 0.08;
        }
        aD *= semiRigid;
        const kk = (aD * 12 * E * I) / (h * h * h);
        // Joint moments: the column or the beams framing in, whichever is weaker.
        const mTop = t.mb > 0 ? Math.min(Mc, t.mb) : 0;
        const mBot = ground ? Mc : b.mb > 0 ? Math.min(Mc, b.mb) : 0;
        let v = (mTop + mBot) / h;
        if (v <= 0) v = (0.25 * Mc) / h; // pinned-pinned: practically none (slab action only)
        if (dirX) { a.kx = kk; a.vx = v; } else { a.kz = kk; a.vz = v; }
      }
      a.driftCapacity = mat.driftCapacity.column * axialPenalty(a.utilization);
    } else if (m.type === 'wall') {
      const L = sx;
      const t = sz;
      const open = a.openingRatio;
      const st = stackOf.get(i) ?? { height: h, stories: 1 };
      const E = mat.E * mat.stiffnessFactor;
      const I = (t * L ** 3) / 12 * mat.fill.wall;
      const fFlex = st.height ** 3 / (3 * E * I * st.stories);
      const fShear = (1.2 * h) / Math.max(1, mat.wallG * t * L);
      const kk = ((1 / (fFlex + fShear)) * (1 - open) ** 1.5);
      const vShear = mat.shear * t * L * (1 - open);
      const Mflex = mat.flexural * (t * L * L) / 6 * mat.fill.wall * (1 - open);
      const N = a.load;
      // Reinforcement / tension capacity (fixed–fixed pier) + gravity rocking 0.9·N·L/(2h).
      const vFlex = (2 * Mflex) / h + (0.9 * N * L) / (2 * h);
      const v = Math.max(0, Math.min(vShear, vFlex));
      const ax = lengthAxis(m);
      a.kx = kk * ax[0] * ax[0];
      a.kz = kk * ax[1] * ax[1];
      a.vx = v * Math.abs(ax[0]);
      a.vz = v * Math.abs(ax[1]);
      a.driftCapacity = mat.driftCapacity.wall * axialPenalty(a.utilization);
    } else continue;
    // Pre-existing damage degrades the member like the structural model does (k·(1−0.4D), F·(1−0.3D)).
    const d0 = m.initialDamage ?? 0;
    if (d0 > 0) {
      a.kx *= 1 - 0.4 * d0; a.kz *= 1 - 0.4 * d0;
      a.vx *= 1 - 0.3 * d0; a.vz *= 1 - 0.3 * d0;
      a.driftCapacity *= 1 - 0.5 * d0;
    }
    const st = stories[s];
    st.kx += a.kx;
    st.kz += a.kz;
    st.vx += a.vx;
    st.vz += a.vz;
    st.lateral.push(i);
  }
}

/** High axial load makes columns / walls less ductile. */
function axialPenalty(util: number): number {
  return util > 0.3 ? Math.max(0.4, 1 - 0.8 * (util - 0.3)) : 1;
}

/** Continuous wall stacks: walls overlapping in plan over consecutive stories (bearing walls only). */
function wallStacks(src: readonly BuildingMember[], out: MemberAnalysis[], failed?: ReadonlySet<string>) {
  const walls = src.map((_, i) => i).filter((i) => src[i].type === 'wall' && src[i].role === 'bearing' && !failed?.has(src[i].id));
  const parent = new Map<number, number>();
  const find = (i: number): number => {
    let r = i;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  for (const i of walls) parent.set(i, i);
  const bySlot = new Map<string, number[]>();
  for (const i of walls) {
    const b = out[i].box;
    const key = `${Math.round((b.min[0] + b.max[0]) * 5)}:${Math.round((b.min[2] + b.max[2]) * 5)}:${Math.round(Math.abs(Math.sin(src[i].rotation[1])))}`;
    (bySlot.get(key) ?? bySlot.set(key, []).get(key)!).push(i);
  }
  for (const list of bySlot.values()) {
    list.sort((a, b) => out[a].box.min[1] - out[b].box.min[1]);
    for (let q = 1; q < list.length; q++) {
      const lo = out[list[q - 1]].box;
      const hi = out[list[q]].box;
      if (hi.min[1] - lo.max[1] < 1) parent.set(find(list[q]), find(list[q - 1]));
    }
  }
  const groups = new Map<number, { lo: number; hi: number; n: number }>();
  for (const i of walls) {
    const r = find(i);
    const g = groups.get(r) ?? { lo: Infinity, hi: -Infinity, n: 0 };
    g.lo = Math.min(g.lo, out[i].box.min[1]);
    g.hi = Math.max(g.hi, out[i].box.max[1]);
    g.n++;
    groups.set(r, g);
  }
  const res = new Map<number, { height: number; stories: number }>();
  for (const i of walls) {
    const g = groups.get(find(i))!;
    res.set(i, { height: Math.max(0.5, g.hi - g.lo), stories: g.n });
  }
  return res;
}

/** Fundamental period of a fixed-base shear chain (inverse iteration, Thomas algorithm). */
export function chainPeriod(m: readonly number[], k: readonly number[]): number {
  const n = m.length;
  if (!n) return 0.1;
  let x = new Float64Array(n).fill(1);
  const a = new Float64Array(n), b = new Float64Array(n), c = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    b[i] = k[i] + (i + 1 < n ? k[i + 1] : 0);
    a[i] = i > 0 ? -k[i] : 0;
    c[i] = i + 1 < n ? -k[i + 1] : 0;
  }
  let lambda = 0;
  const cp = new Float64Array(n), dp = new Float64Array(n);
  for (let it = 0; it < 80; it++) {
    // Solve K y = M x.
    for (let i = 0; i < n; i++) {
      const d = m[i] * x[i];
      const den = b[i] - (i > 0 ? a[i] * cp[i - 1] : 0);
      cp[i] = c[i] / den;
      dp[i] = (d - (i > 0 ? a[i] * dp[i - 1] : 0)) / den;
    }
    const y = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) y[i] = dp[i] - (i + 1 < n ? cp[i] * y[i + 1] : 0);
    // Rayleigh quotient: λ = (yᵀ M x) / (yᵀ M y)
    let num = 0, den = 0, norm = 0;
    for (let i = 0; i < n; i++) {
      num += y[i] * m[i] * x[i];
      den += y[i] * m[i] * y[i];
      norm = Math.max(norm, Math.abs(y[i]));
    }
    const next = num / den;
    for (let i = 0; i < n; i++) y[i] /= norm;
    x = y;
    if (Math.abs(next - lambda) < 1e-12 * next) { lambda = next; break; }
    lambda = next;
  }
  return lambda > 0 ? 2 * Math.PI / Math.sqrt(lambda) : 0.1;
}
