# Phase 31 — 중력 사용처 전수 감사 (부록)

> `docs/VARIABLE_GRAVITY.md` §3의 근거 자료입니다. 파일:줄은 **구현 전 기준 커밋 `4d8da10`** 기준이며, 각 항목의 Phase 31 조치는 본문 §3·§8–§27에 있습니다(A: 런타임 표본·단계 범위, B: 지구 기준 유지, C: 스케일링 규칙 + 적용 범위 표시, D: 정지·제한 표시, E: 무관).

Scope: non-test source `src/**/*.ts(x)` excluding `*.test.ts`, `src/__audit__`, `src/bench`, `src/i18n/locales` (556 files).
Read-only audit; nothing in the repo was modified.

Classes:
- **A**: replace with a runtime gravity sample. The model depends directly on g and stays valid when g changes.
- **B**: keep as the Earth reference constant `G0` (unit conversion, PGA in g, design basis, reference data).
- **C**: Earth-calibrated empirical relation. Needs a scaling rule or a "limited" flag.
- **D**: not supported this phase. The model is invalid for non-vertical or zero g and needs a limited mode.
- **E**: unrelated (naming collision, visual-only, metadata).

Tags: **HOT** = runs per step inside a per-cell, per-face, per-body or per-member loop. **CAP** = the g value is captured once (module load, constructor, cache, body creation or plan time) and must be refreshed when g changes.

## 0. The global picture

- One constant: `src/core/units.ts:9 export const GRAVITY = 9.81`. About 45 files import it.
- Re-exported or duplicated as separate constants:
  - `atmosphere/reference.ts:18 G = GRAVITY`
  - `simulation/water/WaterSolver.ts:41 G = GRAVITY`
  - `ground/materials.ts:91-92 GAMMA_W = 9.81, G = 9.81` (independent literals)
  - `ground/granular.ts:43 G = 9.81` (independent literal)
- About 25 more sites write a bare `9.81` literal (listed below).
- **Rapier does not use `GRAVITY`.** It takes `snapshot.settings.gravity`, a document field: `core/model.ts:267`, defaulted to `GRAVITY` at `world/WorldDocument.ts:34`, and validated only as `z.number()` at `world/serialization.ts:124`. A loaded document with `settings.gravity ≠ 9.81` would already put Rapier out of step with every other subsystem today. Nothing reconciles the two.
- The future contract exists but has no callers:
  - `phenomena/channels.ts:117-136` defines `GravityField { sample(p,t,out); uniform }` and `UniformGravity`.
  - `ForceLedger` reserves the source `'gravityField'` (`ForceLedger.ts:20-23`), but nothing writes it.
  - `channels.ts:64-66` lists gravity as `status: 'uniform'` with owner "Rapier world gravity (project setting, constant)". This metadata must be updated in Phase 31.
- `SystemContext` (`simulation/systems/SimulationSystem.ts:11-27`) carries `env`, `runtime`, `physics`, `forces`, `time` and `step`. The natural owner of the sample is a new `EnvironmentState.gravity: GravityField`, next to `airDensity`, `terrain` and the other fields at `simulation/environment/EnvironmentState.ts:34-58`. Add a `G0 = 9.81` reference constant (rename the current `GRAVITY` to it) so that each site has to choose between `G0` (class B) and `ctx.env.gravity` (class A).
- Two different concepts need separate names:
  - **local g(x,t)**: the sandbox field.
  - **planetary g**: the atmosphere column above the world, meteor entry, ISA.

  A local anomaly should not change the meteor-entry atmosphere. A planet-wide change should.

---

## 1. Rapier / rigid bodies

| # | file:line | expression | computes | class | tags | recommendation |
|---|---|---|---|---|---|---|
| R1 | physics/RapierEngine.ts:83-85 | `new RAPIER.World({x:0, y:-gravity, z:0})` | world gravity vector | A | CAP (init only) | Add `PhysicsEngine.setGravity(v: Vec3)` → `world.gravity = {x,y,z}` and wake every dynamic body. Call it from SimulationController when the uniform part of the field changes. Keep this as the uniform baseline and apply the non-uniform residual through the ForceLedger `'gravityField'`. |
| R2 | simulation/SimulationController.ts:132 | `physics.init(this.snapshot.settings.gravity, …)` | source of Rapier g | A | CAP | Build the `GravityField` from `settings.gravity` (or the scenario) and pass its uniform value here, so both read one source. |
| R3 | physics/RapierEngine.ts:30 | `new RAPIER.World({x:0,y:-9.81,z:0})` | throw-away JIT warm-up world | E | — | Leave. |
| R4 | physics/RapierEngine.ts:157-175 | `setMass(...)`, no `gravityScale` | bodies | — | — | No `setGravityScale` anywhere. All bodies get uniform world g. A per-body scale is not a substitute for a field. |
| R5 | simulation/RuntimeBuilder.ts:34,57 | `impactThreshold = max(800, mass*9.81*2.5)` | contact-force event threshold (ignore resting contact) | A | CAP (collider creation) | Uses `g_local` at creation. On a g change, re-set `setContactForceEventThreshold`, or set it from `max(g)` of the scenario. Otherwise resting contact fires "impacts" at 3 g. |
| R6 | simulation/damage/spawn.ts:56 | `max(600, mass*9.81*4)` | debris contact threshold | A | CAP | Same as R5. |
| R7 | simulation/structure/fragments.ts:85 | `max(600, mass*GRAVITY*4)` | fragment contact threshold | A | CAP | Same as R5. |
| R8 | simulation/systems/PoseSyncSystem.ts:28-49 | `physics.sleep(e.body)` after REST_STEPS quiet steps | explicit sleeping (only on non-flat terrain without shaking) | — | — | A g change must wake all bodies. A sleeping body does not feel a new world gravity until woken. |
| R9 | simulation/structure/fragments.ts:139-145 | `if (isSleeping) setBodyKind(d.body,'fixed')` | settled fragments frozen | D | — | Fixed bodies ignore later g changes (zero g will not lift rubble). Either re-dynamicize on a g change or document it as "settled = frozen". Same pattern at structure/rubbleEffects.ts:56 and volcano/objects.ts:318 (buried objects). |
| R10 | simulation/systems/WaterForceSystem.ts:128-136 | sleeping body in still water: static buoyancy with `wake=false` | — | — | — | Applies buoyancy without waking. Fine for constant g, but the g change must wake explicitly. |

## 2. ForceLedger and per-body forces

| # | file:line | expression | computes | class | tags | recommendation |
|---|---|---|---|---|---|---|
| F1 | simulation/forces/ForceLedger.ts:20-23,99 | `'gravityField'` source slot | reserved, no writer | A | HOT (per body) | Phase 31 writer: a new prePhysics `GravityFieldSystem` applies `m·(g(x,t) − g_uniform)` through `ledger.force('gravityField', …)`, center of mass only (no torque from a uniform residual). The ledger already de-duplicates per step. |
| F2 | simulation/systems/SeismicForceSystem.ts:66-77 | `force = −m·a_g` incl. `force[1] = −m·g.a[1]` | d'Alembert ground-frame force; the vertical part "modulates effective gravity" (comment at :20) | E (not real g) | HOT | Independent of g. Keep it on the `'groundMotion'` source. Note: the frame argument assumes a vertical g. |
| F3 | simulation/systems/WaterForceSystem.ts:120,124 | `buoy = ρw·GRAVITY·V·frac` → `force[1] = buoy` | buoyancy, +y only | A (magnitude) / D (direction) | HOT (per body per step) | `g = ctx.env.gravity.sample(center)`. Force = `−ρ·V·frac·g⃗` (direction opposite to g). `buoyancyRatio = buoy/(m·g)` needs the same g. The submerged fraction from `eta − bottom` assumes a vertical g → D for tilted g. |
| F4 | simulation/systems/SeismicForceSystem.ts:10 | `SHAKE_FULL = 0.35*GRAVITY` | visual shake saturation | B | — | Keep G0. |

## 3. Structure (modular buildings, collapse engine, seismic model)

| # | file:line | expression | computes | class | tags | recommendation |
|---|---|---|---|---|---|---|
| S1 | structure/graph.ts:151 | `weight[i] = a.mass * GRAVITY` | member dead load (N) | A | CAP (graph cached across runs: `WeakMap<BuildingDesign,…>` graph.ts:115-118) | Remove `weight` from the cached graph, or treat it as a G0 reference. The solver should compute `g.mass[i] * gNow` (or `* gAt(member centroid)`) in `collect()`. Never re-key the cache on g. |
| S2 | structure/solver.ts:385 | `L = g.weight[i] + this.extra[i] + Σ share` | top-down load collection | A | HOT (per marked member) | `L = g.mass[i]*gM[i] + extra`. Here `gM` is a per-member Float64Array that the system refreshes when the field changes, and every member gets marked for the load pass. |
| S3 | structure/solver.ts:570 | `push(-h, h, g.weight[i] + this.extra[i])` | beam self-weight in the bending demand | A | HOT | Same `gM`. |
| S4 | structure/solver.ts:221-227 `addExtra`; collapse.ts:370-373 `addLoad` | surcharge stored **in N** | snow / ash / rubble surcharges | A | CAP (N baked with the g at application time) | Store surcharges as **mass (kg)** and multiply by `gM` in `collect`. Otherwise every surcharge needs re-application on a g change. |
| S5 | structure/collapse.ts:387 | `step(dt,time,kin, g = GRAVITY)` | collapse engine; g already threaded | A | HOT (falling blocks) | Already a parameter. Pass `ctx.env.gravity` (vertical magnitude at the building) from StructuralCollapseSystem.ts:75. |
| S6 | structure/collapse.ts:487 | `tf = sqrt(2·bottom/g)` | block formation fall time | A | — | Uses param g. OK. g→0 gives ∞: guard it. |
| S7 | structure/collapse.ts:746-757 | `d = v·dt + ½g·dt²`, `v += g·dt`, `released += m·g·d` | falling-block kinematics and energy ledger | A | HOT | Uses param g. Exact only for constant g during the fall (comment falling.ts:81). |
| S8 | structure/collapse.ts:808 | `mR += G.mass[r] + this.s.extra[r] / g` | converts N surcharge back to kg | A | — | Wrong if `extra` was built with a different g (see S4). Mass-based extras remove this. |
| S9 | structure/collapse.ts:813,817 + falling.ts:57-85 | `impactOutcome({…, g})`: `W = Mt·g`, `fallTime(h,v,g)` | arrest / failure of a floor hit by a falling block | A | — | g param. OK. |
| S10 | simulation/systems/StructuralCollapseSystem.ts:75 | `m.step(dt, ctx.time, kinematics(e,ctx), GRAVITY)` | driver | A | HOT | `ctx.env.gravity.sample(buildingBase).y` (or the scalar g). This one-line change is where the runtime sample enters the collapse engine. |
| S11 | simulation/systems/StructuralCollapseSystem.ts:243 | `sr.model.addMass(ui, j, d, GRAVITY)` | P-Δ term of the seismic MDOF when rubble rests on floors | A | — | Pass g_now. |
| S12 | structure/preview.ts:39 | `m.step(dt, t, undefined, GRAVITY)` | editor collapse preview | B | — | Preview at G0, or take an optional g. |
| S13 | structure/graph.ts:145,156-160 | `structural[i] = isStructuralRole(role) && mat.structural`; `if (!structural[i]) continue` (no capN/capM) | roof coverings (`role:'roofing'`, buildings/types.ts:29,161) get no capacity | — | — | **R1 defect site** (see Q3). |
| S14 | structure/solver.ts:457-458 | `else if (!g.structural[i] && !g.ground[i]) res = 0` | non-structural members have no reserve | — | — | R1. |
| S15 | structure/solver.ts:525-528 | `if (g.structural[i] && alive) { column/wall axial; beam M,V; slab M }` | utilization only for structural members | — | — | R1. Roofs never get a utilization. |
| S16 | buildings/analysis.ts:348 | `a.load = a.mass * GRAVITY` | design-time gravity distribution and member utilization | B | CAP (`analysisOf` WeakMap design.ts:29-36) | Design basis at G0 ("the building was designed on Earth"). The runtime check is S1-S3. |
| S17 | buildings/analysis.ts:428 | `above += stories[s].mass * GRAVITY` → `weightAbove` | story weight above | B | CAP | Design basis. |
| S18 | buildings/analysis.ts:484 | `W = Σ mass · GRAVITY` | weakest-story base shear (inverted triangle) | B | CAP | Design basis (capacity ∝ W₀). |
| S19 | buildings/analysis.ts:717-718 | `vFlex = 2Mflex/h + 0.9·N·L/(2h)`, N from `a.load` | wall-pier lateral strength incl. gravity rocking | B (design) / A (runtime fidelity) | CAP | The rocking term really scales with g (lighter walls rock earlier). Phase 31 accepts G0. Flag it as "lateral capacities at design g". |
| S20 | buildings/design.ts:116 | `W = a.totalMass * GRAVITY` | wind resistance speed from base-shear capacity | B | CAP | Design capacity in N. Keep G0 so that capacities do **not** shrink with g. |
| S21 | buildings/generate.ts:74 | `(t·ρ·fill + occupancy + 150) * 9.81` | floor pressure for column sizing | B | — | Generator design basis. Keep G0. |
| S22 | buildings/foundation.ts:110 | `pressure = mass*GRAVITY/area/1000` | static bearing pressure / allowable (design ratio) | B | CAP | Design ratio. The solver's `bearingUtil` scales it by the member load change, so g enters through S2. |
| S23 | simulation/seismic/StructuralModel.ts:186,198-199 | `W = init.mass*init.gravity`; `fy = cy·W·share` | story yield strength | B | CAP (built once in `buildSeismicRuntime`) | Yield strength is a design capacity. Use G0, **not** runtime g. |
| S24 | simulation/seismic/StructuralModel.ts:201,253,305,324 | `pdel = (mass above · gravity)/h` | P-Δ geometric stiffness | A | CAP | Runtime g. Add `setGravity(g)` that recomputes `pdel` (the `truncateFrom` / `addMass` code paths already take a `gravity` arg). |
| S25 | simulation/seismic/SeismicState.ts:167-168, 239-240 | `W = (M+mf)·gravity`; `slip = anchorage·W·contact` | foundation sliding (friction) capacity | A | CAP | Friction is truly ∝ g. Split `init.gravity` into `gDesign` (S23) and `gNow` (S24/S25). |
| S26 | SeismicState.ts:203,304,318; callers SimulationController.ts:296, SeismicForceSystem.ts:43, BlastSystem.ts:198 | `buildSeismicRuntime(…, GRAVITY)` | single g for the whole seismic runtime (lazily built once, `??=`) | A/B | CAP | Pass both g0 and the env gravity. Add a refresh hook. |
| S27 | simulation/systems/StructuralResponseSystem.ts:115 | `W = mass * GRAVITY` | foundation overturning / uplift vs weight | A | HOT (per building per step during quakes) | `ctx.env.gravity` at the base. |
| S28 | simulation/buildings/modular.ts:403 | `sr.model.truncateFrom(ui, dof, GRAVITY)` | P-Δ after a story collapse | A | — | Pass g_now. |
| S29 | simulation/buildings/modular.ts:634 | `accelAt(…)/GRAVITY` | member response in g units | B | — | Keep G0. |
| S30 | simulation/blast/responses.ts:193-196 | `N = solver.load[i]/L`; `cap += 4·N·t/h²` | blast wall capacity incl. gravity pre-compression | A (inherits) | — | Inherits g through the solver load (S2). No change needed. |
| S31 | simulation/structure/fragments.ts:120-122 | `t = (vy + sqrt(vy² + 2·GRAVITY·h))/GRAVITY` | fragment landing estimate at spawn | A | CAP (spawn) | Use g at the spawn point. Handle g→0 (no landing). |
| S32 | simulation/structure/secondary.ts:216; rubbleEffects.ts:110 | `void GRAVITY` | unused import guard | E | — | Remove. |

## 4. Roof snow / ash loads (climate, volcano)

| # | file:line | expression | computes | class | tags | recommendation |
|---|---|---|---|---|---|---|
| L1 | simulation/climate/runtime.ts:537 | `kPa = M*GRAVITY/area/1000` | roof snow pressure (report, screen) | A | every LOAD_EVERY | g at the roof centroid. |
| L2 | simulation/climate/runtime.ts:553-554 | `N = M·GRAVITY·a/A`; quantum `capN ∨ mass·GRAVITY` | snow weight distributed onto MT_ROOF members → `model.addLoad(i, N−applied)` | A | per roof per LOAD_EVERY | Use g_now. The `applied[]` re-sync logic then re-applies automatically on a g change. Better: mass-based surcharge (S4). |
| L3 | simulation/climate/runtime.ts:483 + climate/constants.ts:67 | `load (kg/m²) >= CROWN_BREAK (20)` | tree crown breaks on snow **mass** | C | — | Compare weight: `load·g/G0 >= CROWN_BREAK`. |
| L4 | simulation/climate/runtime.ts:492 | `force: sM*GRAVITY` | damage record force | A | — | g_now. |
| L5 | simulation/climate/runtime.ts:691 | `(sM*GRAVITY)/area/1000` vs `ROOF_SCREEN_KPA` | max-roof-load stats | A | — | g_now. |
| L6 | climate/ClimateWorld.ts:629 | `storeLoad(k, g = 9.81)` | store load helper | A | — | Default to G0 and pass g. |
| L7 | simulation/volcano/objects.ts:376 | `ashLoad = ash*GRAVITY/roofA/1000` | roof ash kPa | A | — | g_now. |
| L8 | simulation/volcano/objects.ts:416-417 | `N = ash·GRAVITY·a/A`; quantum `capN ∨ mass·GRAVITY` | ash weight onto MT_ROOF members | A | — | Same as L2. |

## 5. Vehicles, people, small objects, debris (damage behaviours)

| # | file:line | expression | computes | class | tags | recommendation |
|---|---|---|---|---|---|---|
| P1 | simulation/damage/windLoad.ts:69,72 | `sliding = sqrt(μ·m·GRAVITY/k)`, `tipping = sqrt(m·GRAVITY·b/(copY·k))` | wind threshold estimates (Inspector / WindForm) | A | — | g at the object (estimate only). |
| P2 | simulation/damage/behaviors/flood.ts:172 | `fh = ½ρ·GRAVITY·(d²−di²)·B` | hydrostatic push on a building | A | HOT-ish (per building per step) | g at the base. Assumes a vertical g → D if tilted. |
| P3 | simulation/damage/behaviors/flood.ts:179 | `base = cy·m·GRAVITY·…` | building lateral capacity (base-shear coefficient) | B | — | Design capacity. Keep **G0**. |
| P4 | simulation/damage/behaviors/flood.ts:214 | `p = ρ·GRAVITY·(head−back) + dyn` | window hydrostatic pressure | A | — | g_now. |
| P5 | simulation/damage/behaviors/flood.ts:276-278 | `net = m·GRAVITY − buoyancy`; slide `fd/(μ·net)`, tip `fd·d/2/(net·lever)` | person stability in flow | A | per person per step | g_now. Must be the same g as F3's buoyancy. |
| P6 | simulation/damage/behaviors/flood.ts:326 | `hydro = ρ·GRAVITY·(dHi³−dLo³)·L/6` | wall hydrostatic moment | A | — | g_now. |
| P7 | simulation/ground/objects.ts:82 | `cy·m·GRAVITY·…` | object lateral capacity vs debris | B | — | Design capacity. G0. |
| P8 | simulation/ground/objects.ts:128-129 | `W = m·GRAVITY`; `max(fd/(μW), fd·d/2/(W·lever))` | person in debris flow | A | — | g_now. |
| P9 | simulation/ground/objects.ts:140 | `0.5·k0·ρ·GRAVITY·dep²·w·dep/3` | earth-pressure moment on poles / walls | A | — | g_now. |
| P10 | simulation/ground/objects.ts:176 | `0.5(1−sinφ)ρ·GRAVITY·dep² + α·ρ·u²·h` | debris load on buildings | A | — | g_now. |
| P11 | simulation/systems/ImpactSystem.ts:267 | `dvCrit = sqrt(2·GRAVITY·(hypot(h,b)−h))` | person knock-down by ejecta (energy to tip over) | A | — | g_now. g→0 gives 0 (any push topples). That is correct physics, but flag it. |
| P12 | simulation/blast/responses.ts:451 | `crit = sqrt(2·GRAVITY·(hypot(h,b)−h))·strength` | person knock-down by blast | A | — | Same as P11. |
| P13 | simulation/systems/DamageSystem.ts:118 | `dmg = force/(m·9.81·30)` | car crash damage normalized by weight | C | per contact event | Crash damage should depend on impulse, not weight. Use G0 (keeps calibration), not g_now. |
| P14 | damage/behaviors/human.ts:23-24; tree.ts:98-99; structure.ts:160-170 | scripted torque / impulse kicks `m·0.55`, `m·1.4` | knock-over impulses tuned for Earth g | C | — | Keep. Flag "scripted topple tuned at 1 g". |
| P15 | simulation/damage/behaviors/structure.ts:102; seismic.ts:117 | `mass·response·9.81` / `·GRAVITY` | force reported from a response in g units | B | — | G0 (response is in g units). |
| P16 | simulation/systems/ParticleSystem.ts:44 | `v.y −= (leaf ? 2.2 : 9.81)·dt` | visual particles | E (visual) | HOT | Optional: scale by `g/G0` for consistency. |

## 6. Flood (shallow-water solver)

| # | file:line | expression | computes | class | tags | recommendation |
|---|---|---|---|---|---|---|
| W1 | simulation/water/WaterSolver.ts:35,41 | `const G = GRAVITY` (module) | solver g | A | CAP (module const) | Make it `this.g`, set per `step(dt, g)` from `ctx.env.gravity` (uniform). A spatial g needs a per-face `gF` Float32Array (like `n2`). |
| W2 | WaterSolver.ts:104,134,138-139 | `sqrt(G·hmax)`, ghost `sqrt(G·boundaryDepth)`, `limit = CFL·dx/speed` | CFL substep bound | A | per call | Wave speed ∝ √g. Higher g means more substeps; MAX_SUBSTEPS = 400 is the safety net. Use `max(g)` over the grid for a spatial field. |
| W3 | WaterSolver.ts:292,296,392 / 418,422,520 | `gdt = G·dt`, `slopeK = gdt/dx`, `fr2 = FROUDE_MAX²·G`, `speed = sqrt(G·hfMax)+uMax` | x / z sweeps of the local-inertial momentum update | A | HOT (per face per substep) | Hoisted scalars, so a uniform g costs nothing. Spatial g: per-face multiply. |
| W4 | WaterSolver.ts:562,573,575,580 | `(q + G·hf·dt·slope)/(1 + G·dt·n²·|q|/hf^{7/3})`; `qmax = Fr·hf·sqrt(G·hf)` | open / fixed-level boundary faces, Froude limit | A | per boundary face | Same as W3. |
| W5 | WaterSolver.ts:739 | `lim2 = FROUDE_MAX²·G·he` | reconstructed cell-velocity Froude clamp | A | HOT (per cell) | Same as W3. |
| W6 | (implicit) Manning `n2` in W3/W4 | `G·dt·n²·|q|/hf^{7/3}` | bed friction | C | HOT | Manning n has an implicit √g: `C = h^{1/6}/n = √(8g/f)`. For a fixed Darcy f, `n ∝ √(g0/g)`. Flag as limited, or rescale n. |
| W7 | simulation/water/WaterField.ts:365 | `work += 1000·9.81·h·A·d` | bed-motion work diagnostic | A | — | g_now. |
| W8 | simulation/systems/WaterSolverSystem.ts:45 | `P = af.sigma·af.red·9.81` | air-pressure forcing on water, from the atmosphere column mass | A | per wet cell | Must use the **same g as the AtmosphereField** (`af.surfacePressure()`-style accessor). |
| W9 | simulation/systems/WaterForceSystem.ts:120,124 | buoyancy | see F3 | A/D | HOT | Same as F3. |
| W10 | (all) bed slope `(eta−bed)/dx` | horizontal heightfield | D | — | Tilted g changes "downhill". Not supported: limit to vertical g. |

## 7. Ground (slope stability, sinkholes, granular runout)

| # | file:line | expression | computes | class | tags | recommendation |
|---|---|---|---|---|---|---|
| G1 | ground/materials.ts:91-92,95 | `GAMMA_W = 9.81`, `G = 9.81`, `unitWeight = ρ·G/1000` | unit weights (kN/m³) | A | CAP (module consts) | Make them functions `unitWeight(p, g)`, `gammaW(g)`. γ and γw scale together, so pore ratios cancel. |
| G2 | ground/stability.ts:55-56 | `resist = c + (γ − m·γw)·z·cos²β·tanφ`; `drive = γ·z·sinβ·cosβ` | infinite-slope FS | A | per vertex per check | FS rises as g falls (cohesion does not scale). Physically right. |
| G3 | ground/stability.ts:62 | `ac = (FS−1)·G·sinβ` | Newmark critical acceleration | A | — | g_now. Same g as G2. |
| G4 | ground/stability.ts:91,95-103 | `sv = (γ − mγw)·H/2`; plug FS `load = πa²(γH + q)` | sinkhole roof plug | A | — | Pass γ(g). |
| G5 | ground/stability.ts:106-110 | Culmann `Hc = 4c/γ·…` | cut / pit wall stability | A | — | γ(g). |
| G6 | ground/stability.ts:132 | `fallTime = sqrt(2d/G)` | sinkhole column fall time | A | — | g_now. g→0 gives ∞: guard it. |
| G7 | ground/landslide.ts:86,180,186 | `infiniteSlopeFS({…gamma: unitWeight(p)…})`; result `g: G` | landslide scan / trigger | A | per vertex | Thread g into `unitWeight`. |
| G8 | ground/sinkhole.ts:129,212-213,223 | plugFS with `unitWeight`, `GAMMA_W`; `g: G` | sinkhole | A | — | Same as G7. |
| G9 | ground/common.ts:111,127 | `poreRatio = mγw/γ`; wall failure γ | restart friction, pit walls | A | — | g cancels in the pore ratio. γ for Culmann. |
| G10 | ground/granular.ts:43 | `const G = 9.81` (module) | runout solver g | A | CAP | `this.g` per step, like W1. |
| G11 | ground/granular.ts:92 | `v = u + sqrt(G·h)` | CFL wave speed | A | HOT (per cell) | Hoisted. |
| G12 | ground/granular.ts:211 | `drive = G·h·grad`, `fric = μ·G·h` | edge outflow | A | per edge cell | Same as G11. |
| G13 | ground/granular.ts:233-234 | `q − G·hf·slope·cos²β·dt`; Coulomb `μ·G·hf·cos²β·dt` | face momentum (gravity + basal friction) | A / D | HOT (per face per substep) | g scalar is easy. cos²β assumes a vertical g → D if tilted. |
| G14 | ground/granular.ts:237 | `q /= 1 + G·|q|·dt/(ξ·hf²)` | Voellmy turbulent friction | C | HOT | ξ (m/s²) is Earth-calibrated (RAMMS / DAN3D back-analyses). Flag as limited. |
| G15 | simulation/systems/GroundFailureSystem.ts:120 | `GAMMA_W·h_water + (loose+mass)/A·9.81/1000` | surcharge kPa on the ground model | A | per vertex per sample | g_now. |
| G16 | simulation/systems/GroundFailureSystem.ts:133 | `p = m·9.81/(4hx·hz)/1000` | building footprint pressure | A | — | g_now. |
| G17 | terrain/SoilProfiles (`soil.bearingCapacity`, kPa) used in foundation.ts:109 and SeismicState.ts:241 | tabulated bearing capacity | C | — | Terzaghi `q_ult = cNc + γDNq + ½γBNγ`: the frictional part ∝ g. Flag it, or split it into c and γ parts later. |

## 8. Atmosphere

| # | file:line | expression | computes | class | tags | recommendation |
|---|---|---|---|---|---|---|
| T1 | atmosphere/reference.ts:18 | `G = GRAVITY` | atmosphere g | A (planetary) | CAP | Planetary-g parameter. |
| T2 | atmosphere/reference.ts:36 | `scaleHeight = R·T/G` | H_s | A | — | `scaleHeight(T, g)`. |
| T3 | atmosphere/reference.ts:41-46 | `isa(h)`: `p = p0·(T/T0)^(G/(R·L))` | ISA default state for an altitude | B | — | ISA is Earth reference data. Keep G0. |
| T4 | atmosphere/reference.ts:49,52 | `hydrostatic = ps·exp(−dz/Hs)`; `layerMassPerArea = ps/G·(1−e^{−H/Hs})` | profile, layer mass | A | — | Pass g. |
| T5 | atmosphere/AtmosphereField.ts:245-246 | `Href = scaleHeight(T0)`; `ell = 1 − exp(−H/Href)` | reference scale height, resolved-layer share | A | CAP (constructor, `readonly`) | Make them mutable and add `setGravity(g)` to recompute Href, ell and `red` (:286). |
| T6 | AtmosphereField.ts:271 | `sigma = p0/G/red` | initial column mass from pressure (hydrostatic rest) | A | CAP (init) | Mass is the state. On a g change keep σ (mass conserved), and the pressure follows. |
| T7 | AtmosphereField.ts:286 | `red = exp(ground/Href)` | reduction to datum | A | CAP | Recompute in `setGravity`. |
| T8 | AtmosphereField.ts:302,317-320,344 | `surfacePressure = σ·G`; `pressureAt` | column mass → pressure | A | per query | Field member `this.g`. |
| T9 | AtmosphereField.ts:541,556-557,581 | `sg = bgShare·p0/G`; `c = β·dt²·Hs·G/dx²`; `kp = β·dt·Hs·G/dx` | semi-implicit redistribution (PCG) | A | per solve | Note `Hs·G = R·T`: **g cancels** in c and kp. Only `sg` (boundary column mass) and `red` carry g. |
| T10 | atmosphere/outlook.ts:51,59,67 | `Hs`, `M += p/G·…`, `sigma0 = p0/G` | planning outlook | A | — | Pass g. |
| T11 | simulation/atmosphere/runtime.ts:518 | `p = σ·red·9.81` | blast ambient pressure | A | — | Literal 9.81 duplicates G. Use `f.surfacePressure`-style with field g. |
| T12 | simulation/atmosphere/runtime.ts:658,670 | `exp(alt/((287.05·T)/9.81))` | meteor-entry ρ0 and ground density from scale height | A (planetary) | — | `scaleHeight(T, gPlanet)`. |
| T13 | simulation/atmosphere/runtime.ts:496-506 | `settling()` → `settlingVelocity()` cached in `settleCache` | ash terminal velocity in local air | A | CAP (cache keyed by ρ, T only) | Add g to the key, or clear the cache on a g change. |
| T14 | blast/source.ts:48,68 | `SCALE_HEIGHT = 8000`; `ambientAt = p·exp(−z/8000)` | blast ambient vs height | C | — | Hard-coded Earth H (= R·T/g). Replace with `scaleHeight(T, g)`. |
| T15 | rendering/atmosphere/AtmosphereLayer.tsx:54; ui/Inspector/AtmosphereInspector.tsx:42; rendering/atmosphere/AtmospherePreview.tsx:29 | `(σ−σ0)·9.81`; `scaleHeight(T)` | display of pressure change | A (display) | — | Use the field's g. |

## 9. Thermal (convection, air layer)

| # | file:line | expression | computes | class | tags | recommendation |
|---|---|---|---|---|---|---|
| H1 | thermal/convection.ts:56-58 | `Ra = GRAVITY·|ΔT|·L³/(T_f·ν·α)` | Rayleigh number for natural convection | A (+C) | per body per step | Ra ∝ g is exact. The Nu(Ra) correlations (Churchill–Chu, 0.54/0.15/0.52 Ra^n, Churchill sphere) are dimensionless and stay valid inside their Ra ranges. g→0 gives the conduction limit (vertical: Nu → 0.68; horizontal: Nu → 0, under-estimated). Pass a `gr = g/G0` factor like the existing `pr` argument (Ra ∝ pr², so Ra ∝ gr·pr²). |
| H2 | thermal/convection.ts:118-123 | `TAB_RA[i] = GRAVITY/(T·ν·α)` | precomputed table for ground cells | A | CAP (module load), HOT (`hGround` per cell) | Multiply in `hGround`: `Ra = TAB_RA·gr·…`. Do not rebuild the table. |
| H3 | thermal/convection.ts:168 | `0.15·0.6·cbrt(GRAVITY·β·ΔT/(ν·α))` | water-side natural convection | A | per wet cell | Same as H1. |
| H4 | thermal/convection.ts:142-145 | `WIND_SLOPE = 3.0` (h = 3·U₂) | outdoor wind function (Watmuff 1977) | C | HOT | Measured at Earth g (forced, weak g dependence). Flag it, no scaling. |
| H5 | thermal/AirLayer.ts:117,139 | `gH = GRAVITY·H/Tref`; `w = sqrt(gH·ΔT)` | buoyant venting velocity of the air layer | A (+C coefficient 1) | HOT (per column per step) | `gH` is hoisted, so pass g. |
| H6 | thermal/AirLayer.ts:161 | `updraft = sqrt(GRAVITY·H·ΔT/Tref)` | updraft used by the atmosphere | A | per column | Same as H5. |
| H7 | (all orientation logic) `up` / `down` faces in hBox, hNaturalHorizontal | "heated face up = unstable" | D | — | Defined relative to world +y. Tilted g is not supported. |

## 10. Fire

| # | file:line | expression | computes | class | tags | recommendation |
|---|---|---|---|---|---|---|
| X1 | fire/relations.ts:18 (called FireWorld.ts:386) | `ṁ = ⅔·Cd·ρ∞·A·√H·√(2g(1−T∞/Tg))/…` | vent inflow (Rockett) | A | per room per step | Physics-based. Pass g. |
| X2 | fire/relations.ts:21-24 (runtime.ts:713,745) | `L = 0.235·Q^{2/5} − 1.02·D` (Heskestad) | flame height | C | per fire group | Dimensional form hides `g^{-1/5}` (from `Q* = Q/(ρ c_p T √g D^{5/2})`). Scaling rule `L ∝ (g/G0)^{-1/5}`, flagged "empirical". g→0: no buoyant flame. **D**. |
| X3 | fire/relations.ts:35 | `uc = cbrt(GRAVITY·ṁ″·D/ρa)` (Thomas tilt) | flame tilt | A (+C) | per fire group | Pass g. |
| X4 | fire/relations.ts:62 (FireWorld.ts:429,753; simulation/fire/runtime.ts:534) | `buoyantVelocity = sqrt(GRAVITY·h·ΔT/T)` | room-to-room exchange, smoke venting | A | HOT (per cell / room) | Pass g. |
| X5 | simulation/fire/runtime.ts:747-748 | `P = base + cos(tilt)·half` along +y | flame axis vertical | D | — | Flames point along −g. Not supported when tilted. |
| X6 | fire burning rates / ignition (fire/materials.ts, Rothermel / Babrauskas data) | fuel-controlled rates | C | — | Earth-measured, implicit through natural-convection heat feedback. Flag only. |

## 11. Climate (snow, saltation)

| # | file:line | expression | computes | class | tags | recommendation |
|---|---|---|---|---|---|---|
| C1 | climate/ClimateWorld.ts:1644-1648 | `Ut = 9.43 + 0.18T + 0.0033T²` (Li & Pomeroy); `Q = 0.68·1.2·ut·(us²−ut²)/(9.81·us)` (Pomeroy & Gray) | blowing-snow threshold and saltation flux | C | per snow cell per step | The `1/g` in Q is explicit, but the coefficients and Ut were fitted at 1 g. Threshold friction velocity scales `∝ √g` (Bagnold). Use `Q ∝ 1/g` with `Ut·√(g/G0)`, flagged limited. |
| C2 | climate/snow.ts:42-50 (called ClimateWorld.ts:1183,1409) | `cr2 = −(0.5·W)/η`, W = mass per area (kg/m²) | overburden compaction (Anderson 1976 / CLM) | C | per cell / store | Overburden stress is `g·W`. η was fitted with W in kg/m² at 1 g. Scale `W·g/G0`. |
| C3 | climate/snow.ts:93 | `interceptionMax = 6.6·(0.27+46/ρ)·LAI` | crown interception capacity (Hedstrom & Pomeroy) | C | — | Earth-fitted mass capacity (branches bend under weight). Optional `·G0/g`. Flag it. |
| C4 | climate/constants.ts:39 | liquid holding 5 % | snowpack liquid retention against gravity | C | — | Flag only. |
| C5 | climate/constants.ts:67 | `CROWN_BREAK = 20` kg/m² | — | C | — | See L3. |

## 12. Volcano

| # | file:line | expression | computes | class | tags | recommendation |
|---|---|---|---|---|---|---|
| V1 | volcano/rheology.ts:15 | `drive = ρ·GRAVITY·sinθ` | Bingham lava flux (q ∝ ρ g sinθ h³/3η) | A | HOT (per face per step, LavaField.ts:398-399) | Add a `g` arg to `binghamFlux`. `sinT` comes from the heightfield slope (LavaField.ts:398), so a tilted g is **D**. |
| V2 | volcano/rheology.ts:25 (outlook.ts:96) | `h_cr = τ/(ρ·GRAVITY·sinθ)` | critical depth | A | — | Add a `g` arg. |
| V3 | volcano/VolcanoWorld.ts:186,190,340 | `m·GRAVITY·bed`, `m·GRAVITY·(bed + ½depth)` | potential-energy ledger | A | per step | Must use the same g as V1, or the energy ledger will not close. |
| V4 | volcano/VolcanoWorld.ts:272 | `min(at.settling(…), GRAVITY·age)` | ash fall velocity, age-limited by free fall | A | per puff | g_now. Falls along −y → D if tilted. |
| V5 | volcano/VolcanoWorld.ts:273 + volcano/ash.ts:52 | `VS = ASH_CLASSES.map(settlingVelocity)` | precomputed terminal velocity (no atmosphere) | A | **CAP (module load)** | Recompute on a g change, or compute as `VS0·f(g)`. Not linear (Stokes ∝ g, Newton ∝ √g), so call `settlingVelocity(d, …, g)`. |
| V6 | volcano/ash.ts:41,45 | Stokes `(ρp−ρa)·g·d²/18μ`; Newton `sqrt(4(ρp−ρa)g d/(3Cd ρa))` | terminal velocity | A | — | Add a `g` arg. The Cd(Re) correlation is g-independent. |
| V7 | volcano/bombs.ts:49-50 → impact/ejecta.ts:140-150 `fly()` | `vy = (vy − GRAVITY·FLIGHT_DT)·damp` | bomb / ejecta ballistic integration (dt 0.01) | A | CAP (whole flight integrated at launch), HOT (inner loop) | Integrate with the sampled `g⃗(x)` (vector) inside `fly()`. A mid-flight g(t) change makes stored paths stale, so either re-fly or accept a launch-time g. |
| V8 | simulation/volcano/objects.ts:330 | `½ρ·GRAVITY·h²·w·h/3 + ρu²hw·h/2` | lava base moment on poles / walls | A | — | g_now. |
| V9 | simulation/volcano/objects.ts:364 | `½ρ·GRAVITY·h² + ρu²h` | lava load on buildings | A | — | g_now. |
| V10 | rendering/volcano/VolcanoLayer.tsx:226 | `E.v[1] −= 9.81·dtv` | visual spatter | E | HOT (render) | Optional: scale by g. |
| V11 | volcano/runtime.ts:410, volcano/crust.ts:37 | `G = 16` grid, `G = k/δ` conductance | — | E | — | Naming collision. |

## 13. Meteor / impact

| # | file:line | expression | computes | class | tags | recommendation |
|---|---|---|---|---|---|---|
| M1 | impact/entry.ts:95-96 | `dv/dt = −drag + GRAVITY·sinγ`; `dγ/dt = GRAVITY·cosγ/v` | atmospheric entry above the world | B (planetary) | — | Entry happens far above the sandbox. Use **planetary g**, not the local field. |
| M2 | impact/entry.ts:31,38,78,109 | `SCALE_HEIGHT = 8000`, `ρ0·exp(−z/8000)` | entry atmosphere | C | — | Implicit g. Use `scaleHeight(T, gPlanet)`. |
| M3 | impact/trajectory.ts:53,57,74 | `tLevel = (−vs + sqrt(vs² + 2g·handover))/g`; `y − ½g t²`; `vy − g t` | in-world ballistic arc (closed form, uniform vertical g) | A / D | CAP (plan time) | g at the plan. A non-uniform or tilted field needs numerical integration (D). g→0: `tLevel` divides by 0. |
| M4 | impact/plan.ts:96 | `computeCrater({…, g: GRAVITY})` | crater plan | A | CAP (plan time) | Pass g at the impact point. Plans are recomputed for the preview, so g must be part of the plan inputs. |
| M5 | impact/crater.ts:119-125,149-152 | `π2 = g·a/U²`, gravity-regime radius; `R = min(Rg, Rs)` | Holsapple–Housen π-group crater scaling | A | — | g explicit, and validated across g (centrifuge data). **g→0: π2 → 0, Rg → ∞, and the sand target (crater.ts:78, no strength set) returns R = ∞.** Needs a zero-g guard. |
| M6 | impact/crater.ts:134-137 `launchSpeed` | `C1·U·(x/a·…)^{−1/μ}` | ejecta launch speed | A (g-free) | — | Fine. |
| M7 | impact/ejecta.ts:150 | see V7 | ejecta flight | A | CAP / HOT | See V7. |
| M8 | impact/shock.ts:95; simulation/systems/ImpactSystem.ts:116-117; phenomena/impactDefinitions.ts:86; rendering/impact/ImpactPreview.tsx:27; ui GroundInspector.tsx:86,150 | `a/GRAVITY` | PGA in g | B | — | G0. |
| M9 | rendering/impact/ImpactPreview.tsx:76; ImpactLayer.tsx:56,107 | `y0 + vy·t − ½·GRAVITY·t²` | rendered arc / body | A (visual consistency) | per frame | Must use the same g as M3 (plan g), or the drawn arc and the simulated landing will differ. |

## 14. Blast

| # | file:line | expression | computes | class | tags | recommendation |
|---|---|---|---|---|---|---|
| B1 | blast/source.ts:48,68 | `SCALE_HEIGHT = 8000` | ambient vs height | C | — | See T14. |
| B2 | simulation/blast/responses.ts:451 | `crit = sqrt(2g·Δh)` | person topple | A | — | See P12. |
| B3 | simulation/blast/responses.ts:193-196 | wall pre-compression | — | A (inherits) | — | See S30. |
| B4 | ui/Inspector/BlastInspector.tsx:126 | `aEq/9.81` g | display | B | — | G0. |

## 15. Seismic quantities in g units (class B: keep G0)

These sites convert between g units and m/s²: `simulation/seismic/SyntheticWaveform.ts:116-117` (`pga·GRAVITY`, PGA input in g), `GroundMotionField.ts:210` toG, `analysis/SeismicRecorder.ts:78,92-93,105`, `events/earthquake/EarthquakeEvent.ts:59`, `SimulationController.ts:639-640` (seismogram), `response/exposure.ts:74`, `damage/behaviors/seismic.ts:117,210,236`, `damage/behaviors/structure.ts:102`, `buildings/modular.ts:634`, `commands/RuleBasedParser.ts:92-94` (mpss and gal → g), `rendering/sim/seismic/GroundMotionLayer.tsx:65,118`, `ui/Inspector/SeismicInspector.tsx:77`, `ui/Results/ResultsPanel.tsx:105,255`.

A PGA "in g" is a unit (9.80665 by definition; the code uses 9.81). It must **not** follow the field. Recommendation: one `G0` constant. A renamed `GRAVITY` keeps these unchanged.

## 16. Roads

No gravity-dependent physics. Road damage uses deformation, grade and surface grip (`climate/surfaceState` `frictionFactor`, which is a grip factor and not μ·g). `ui/Roads/RoadSimSection.tsx:52` `g0` is the original grade (E). Vehicles are passive Rapier bodies, so there is no traction or braking model.

## 17. UI / display (A for consistency, cheap)

These display physics values and must show the same g as the model:
- `ui/Inspector/ClimateInspector.tsx:69` (`M·9.81` kPa / kN)
- `ui/BottomPanel/ClimateTools.tsx:64` (initial snow kPa)
- `ui/Results/ResultsPanel.tsx:675` (`load_kPa` CSV)
- `rendering/climate/ClimateLayer.tsx:218` (roofLoad overlay)
- `ui/Inspector/FloodInspector.tsx:101` (`m·GRAVITY` weight beside buoyancy)
- `ui/Inspector/AtmosphereInspector.tsx:42`
- `rendering/atmosphere/AtmosphereLayer.tsx:54`
- `ui/Viewport/ImpactHud.tsx:42`, `ui/BottomPanel/ImpactTools.tsx:43` (regime label only, E)

`ui/Building/BuildingInspector.tsx:176` prints the design g (B).

## 18. Class E (naming collisions)

- Thermal conductances: `thermal/ThermalBodies.ts:293,305,333`, `thermal/TerrainThermal.ts:263,271,393,401`, `simulation/fire/runtime.ts:652`, `volcano/crust.ts:37`
- Climate irradiance and psychrometrics: `climate/forcing.ts:82`, `climate/solar.ts:62`, `climate/psychro.ts:45`
- Grids, maps and loop variables: `rendering/climate/climateColors.ts:24`, `structure/collapse.ts:459…944` (`const G = this.g` graph), `structure/graph.ts:339`, `buildings/analysis.ts:507-516` (`g0 = stories[0]`), `volcano/runtime.ts:410`
- Shear modulus: `terrain/SoilProfiles.ts:54`
- Terrain contribution: `simulation/ground/GroundFailureChannel.ts:31,73`
- Model-registry and phenomena metadata (update the text only): `phenomena/channels.ts:64-66`, `phenomena/definitions.ts:236-241`, `phenomena/models.ts:96,183`, `phenomena/types.ts:37`
- `DamageEvent.ts:43` cause `'gravity'` (a failure cause label)

---

## Specific answers

### Q1. How Rapier gets its gravity
- `world.gravity` is set **only once**, in the constructor: `RapierEngine.init(gravity)` → `new RAPIER.World({x:0, y:-gravity, z:0})` (physics/RapierEngine.ts:83-85). `init` is called per run from `SimulationController.ts:132` with `this.snapshot.settings.gravity` (the document field, default `GRAVITY` = 9.81, WorldDocument.ts:34).
- **It is never changed.** There is no `world.gravity =` assignment, no `setGravity` on `PhysicsEngine` (interface PhysicsEngine.ts:65 has `init(gravity, terrain)` only), and no gravity in `step()` (RapierEngine.ts:284-288).
- **No `gravityScale` anywhere.** `createBody` (RapierEngine.ts:157-185) sets translation, rotation, damping, CCD, per-collider mass, friction, restitution and contact-force thresholds only.
- **Sleep.**
  - Rapier's own auto-sleep is on by default; `canSleep` is never set.
  - `PoseSyncSystem.ts:28-49` also forces `physics.sleep()` after REST_STEPS quiet steps, on non-flat terrain while the ground is not shaking.
  - `WaterForceSystem.ts:128-136` applies static buoyancy to sleeping bodies with `wake=false`.
  - Bodies are also **converted to `fixed`**: settled fragments (fragments.ts:140-142), rubble (rubbleEffects.ts:56) and buried objects (volcano/objects.ts:318).
- **Consequence.** A g change needs (a) `world.gravity = …`, (b) waking every dynamic body, and (c) a policy for fixed rubble and fragments. Contact-force thresholds baked from `mass·9.81` at collider creation (R5-R7) also go stale.
- **Latent bug today.** Rapier follows `settings.gravity` but every other subsystem follows the `GRAVITY` constant.

### Q2. Does the ForceLedger record gravity itself? Double-application risk
- **No.** The ledger (ForceLedger.ts) forwards `force` / `forceAtPoint` per source and step, de-duplicates (body, source, step), and stores |F| per source. It never computes or records weight. Weight is applied implicitly by the Rapier world gravity and is invisible to the ledger. The source `'gravityField'` exists (ForceLedger.ts:20-23) but has **no writer**. `GravityField` / `UniformGravity` (phenomena/channels.ts:121-136) are unused.
- The intended design (channels.ts:117-120) is that Rapier keeps the uniform baseline and a non-uniform field adds per-body forces through `'gravityField'`.
- **Double-application risks:**
  1. If a GravityFieldSystem applies the **full** `m·g(x)` while Rapier still has `world.gravity = −9.81·ŷ`, weight is counted twice. It must apply only the residual `m·(g(x) − g_world)`. Alternatively, set `world.gravity = 0` and apply all of it, but that loses Rapier's sleep/contact behaviour and costs a per-body force every step. Recommendation: residual only, with `g_world` = the field's uniform or mean value.
  2. Systems that add weight-like forces by hand: none apply `m·g` directly today. WaterForceSystem applies only buoyancy (+ρVg). SeismicForceSystem's vertical `−m·a_y` is ground acceleration (not g). No double weight exists today.
  3. The ledger stamp is per source. Splitting gravity across two sources (for example `'gravityField'` plus a second "tidal" source) would bypass the de-duplication. Keep one source.
  4. Buoyancy (F3) and person stability (P5) each compute `m·g` / `ρVg` with `GRAVITY`. They must use the same g sample as the Rapier / residual weight, or `buoyancyRatio` (float threshold = 1) misfires.

### Q3. Structural engine: dead loads, roofs (R1), where the g factor goes
- **Dead loads.**
  - Runtime engine: `structure/graph.ts:151 weight[i] = a.mass*GRAVITY`, captured in the **cached** graph (WeakMap per design + scale, graph.ts:115-118).
  - The solver sums `g.weight[i] + extra[i] + Σ dependents' shares` in `collect()` (solver.ts:385). Beams use `g.weight + extra` as the uniform load for M and V (solver.ts:570).
  - Surcharges (snow, ash, rubble) enter as Newtons through `CollapseModel.addLoad` → `solver.addExtra` (collapse.ts:371-373, solver.ts:222-227).
  - Design-time analysis: `buildings/analysis.ts:348` (`load = mass·GRAVITY`, top-down distribution, `gravityUtilization` :580-610), story `weightAbove` :428, base shear W :484, wall rocking :717-718. All cached by `analysisOf` (design.ts:29-36).
  - Seismic MDOF: `StructuralModel.ts:186` W → yield `fy` (:198-199), P-Δ `pdel` (:201, :253, :305, :324). Foundation `slip` from W: SeismicState.ts:167-168, 239-240. Runtime overturning W: StructuralResponseSystem.ts:115.
  - Falling blocks: `collapse.step(…, g)` (collapse.ts:387) with `g` threaded through formBlocks / advance / land / impactOutcome. **This is the only part already parameterised.** It is called with `GRAVITY` at StructuralCollapseSystem.ts:75.
- **Roof members (R1).**
  - Roof coverings are `type:'roof', role:'roofing'` (generate.ts:383, 418, 446).
  - `isStructuralRole` returns true only for primary, secondary, bearing and foundation (buildings/types.ts:161). So `structural[i] = 0` for every roof member (graph.ts:145), and capacity assignment is skipped (`if (!structural[i]) continue`, graph.ts:156). Roof members have capN = capM = capV = 0.
  - `solver.evaluate()` computes utilizations only `if (g.structural[i] && alive)` (solver.ts:525-528). A roof member's utilization is always 0, with no bending check.
  - `reserve()` gives non-structural members `res = 0` (solver.ts:457-458).
  - capacity.ts:26-28 states it explicitly: "roof coverings … fail through their own facade models (wind / blast / earthquake), not under gravity".
  - Roof edges are `CK.ROOF` tier 0 (anything under the footprint) and tier 1 (lower touching members) (graph.ts:227-229).
  - Snow (climate/runtime.ts:546-560) and ash (volcano/objects.ts:414-420) are applied **only to MT_ROOF members** via `addLoad`. The surcharge is passed down unchecked to the top slab / beams / walls. For pitched-roof halls (`noCeiling`, generate.ts:269) there is no ceiling slab, so the panels have no structural member of their own to fail. **A roof member never fails from snow.** Collapse needs the supporting slab, beam or wall to exceed capacity on its own.
  - Fix belongs outside Phase 31: give `roofing` panels a plate or beam bending check (capM from `slabMomentPerM` / `beamCapacity` for the covering material) or add rafters as `secondary` beams.
- **Where the g factor goes.**
  1. Keep `graph.mass` and drop or ignore `graph.weight`. In `StructuralSolver` add `gM: Float64Array` (per member; scalar for uniform) set by `CollapseModel.setGravity(gM)`, which marks all members for the load pass (`loadHeap`). Use it in `collect` (solver.ts:385) and `beamDemand` (solver.ts:570).
  2. Convert `extra` to kg (multiply by `gM` in `collect`). Otherwise snow, ash and rubble N go stale, and collapse.ts:808 `extra/g` is inconsistent.
  3. StructuralCollapseSystem.ts:75: pass `ctx.env.gravity` (magnitude at the building) instead of `GRAVITY`. Re-sample per step (cheap: one sample per building).
  4. Capacities (capN, capM, capV, design `fy`, `cy·W`) stay at **G0** (design basis): S18-S23, P3, P7.
  5. Seismic: split `init.gravity` into `gDesign` (fy) and `gNow` (pdel, slip). Add `StructuralModel.setGravity()` to recompute `pdel`.
- **Hot path.** `collect`, `distribute` and `evaluate` run only for marked members (heap-driven), so a g change triggers one full load pass per building, then nothing. Falling-block advance is per active block per step.

### Q4. Flood shallow-water solver
- `simulation/water/WaterSolver.ts:41 const G = GRAVITY`: a module constant used in every sweep.
  - Hoisted per substep: `gdt = G·dt`, `slopeK`, `fr2 = FROUDE_MAX²·G` (:292-296, :418-422).
  - Per face: Manning friction `G·dt·n²·|q|/hf^{7/3}` and boundary faces (:562-580).
  - Per cell: velocity Froude clamp `FROUDE_MAX²·G·he` (:739).
- **CFL.** `step(dt)` (:127-152) splits into substeps with `limit = CFL·dx/speed` (CFL = 0.7, waterParams.ts:21). `speed = max(waveSpeed of last substep, √(G·maxDepth), √(G·ghost boundary depth))` (:134-139). Each sweep returns `√(G·hfMax) + uMax` (:392, :520). MAX_SUBSTEPS = 400 is the safety net.
  - Wave speed ∝ √g, so the substep count ∝ √(g/G0). 4 g doubles flood cost. Near-zero g gives huge dt limited by advection only, but the solver then has almost no restoring force: water stays put.
- **Threading.** Turn `G` into `this.g`, set from `step(dt, g)` (uniform). A spatial g needs a per-face `gF` and `max(g)` in the CFL bound.
- **Manning.** n hides `√g` (`n ∝ √(g0/g)` for fixed roughness). Class C.
- **Buoyancy** is not in the solver. It is in `WaterForceSystem.ts:120` (`ρw·GRAVITY·V·frac`, +y, HOT per body), with `buoyancyRatio = buoy/(m·GRAVITY)` (:124) driving the car / object FLOATED threshold (flood.ts:252-260). Also `personStability` (flood.ts:276) and the hydrostatic building / window / wall loads (flood.ts:172, 214, 326).
- **Air-pressure forcing.** WaterSolverSystem.ts:45 uses `σ·red·9.81` (its own literal) and must use the atmosphere's g.
- Bed slope and surface are a heightfield along y, so a tilted g is **D**.

### Q5. Atmosphere: column mass → pressure, scale height
- **State.** Column mass per area `sigma` (kg/m²). Surface pressure `p_s = σ·G` (AtmosphereField.ts:302). `pressureAt` (:316-321) uses `σ·G·exp(−h/H_s(T))` and above the layer `exp(−(h−H)/H_s(Tcol))`. Mean reduced pressure `Σσ·red·G` (:343-344).
- **Init.** `sigma = p0/G/red` (:271), `red = exp(ground/Href)` (:286), `Href = scaleHeight(T0) = R·T0/G` (:245, reference.ts:36), `ell = 1 − exp(−H/Href)` (:246). All are `readonly` or constructor-captured.
- **Redistribution.** The PCG coefficients are `c = β·dt²·Hs·G/dx²` (:557) and `kp = β·dt·Hs·G/dx` (:581). With `Hs = R·T/G` the **g cancels** (c ∝ R·T). g enters the dynamics only through `red` (datum reduction), `ell` and the open-boundary column `sg = bgShare·p0/G` (:541).
- **Other copies.**
  - Outlook: `Hs`, `M += p/G`, `sigma0 = p0/G` (outlook.ts:51, 59, 67).
  - ISA exponent `G/(R·L)` (reference.ts:46). Keep this at G0 as reference data.
  - `hydrostatic` and `layerMassPerArea` (reference.ts:49, 52).
  - Literal `9.81` duplicates in simulation/atmosphere/runtime.ts:518 (blast ambient), :658 and :670 (entry ρ0 via `R·T/9.81`), WaterSolverSystem.ts:45, AtmosphereLayer.tsx:54 and AtmosphereInspector.tsx:42.
  - Hard-coded `SCALE_HEIGHT = 8000` in blast/source.ts:48 and impact/entry.ts:31.
- **Buoyancy coupling.** AirLayer `w = √(g·H·ΔT/T)` (AirLayer.ts:117, 139, 161) supplies the atmosphere updraft and fire venting.
- **Recommendation.** Add `AtmosphereField.setGravity(g)`: recompute `Href`, `ell` and `red`, and keep `sigma` (mass conserved, so p_s jumps by g/g_old, which is physical). Replace every literal with the field accessor. Decide whether the atmosphere uses **local** or **planetary** g. Recommendation: planetary or uniform only in Phase 31, with a non-uniform field flagged D for the atmosphere.

---

## Top risks for introducing variable gravity

1. **Double weight in Rapier.** A `'gravityField'` writer that applies `m·g(x)` on top of `world.gravity` doubles weight. Apply only `m·(g(x) − g_world)`, or zero the world gravity and own all of it (costly, and it changes sleep behaviour). The ledger de-duplicates per source only. It cannot detect "Rapier + ledger".
2. **Two sources of truth already.** Rapier uses `settings.gravity` while about 70 sites use `GRAVITY` or `9.81`. Introduce one `GravityField` in `EnvironmentState`, feed Rapier from it, and rename `GRAVITY` to `G0` so every site is forced to choose.
3. **Naive search-and-replace weakens buildings.** Design capacities are expressed through Earth weight: `fy = cy·W` (StructuralModel.ts:198-199), `cy·m·GRAVITY` (flood.ts:179, ground/objects.ts:82), wind resistance (design.ts:116), analysis base shear (analysis.ts:484), generator column sizing (generate.ts:74). If they follow runtime g, a 0.3 g world makes every building 70 % weaker laterally. They must stay at G0 (class B). The same applies to every PGA-in-g conversion (§15).
4. **Captured constants.**
   - Rapier world gravity (init) and collider contact thresholds (creation).
   - `graph.weight` in a cross-run WeakMap cache, and surcharges stored in N (`extra`) with collapse.ts:808 `extra/g`.
   - Seismic `pdel` / `slip` (lazy `??=` build).
   - Atmosphere `Href`, `ell`, `red`, `sigma` init.
   - `VS` (ash.ts:52, module load), `TAB_RA` (convection.ts:118-123, module load), `settleCache` keys without g.
   - Water and granular `G` module constants.
   - Impact plan and crater (plan time). Ejecta and bomb flights integrated whole at launch. Fragment landing estimate at spawn.
   - Sleeping and fixed bodies (fragments, rubble, buried objects).

   Each needs a refresh hook (`setGravity`) or a mass-based representation.
5. **Earth-calibrated correlations (C)** that silently become wrong:
   - Heskestad flame height (hidden g^{-1/5}).
   - Pomeroy–Gray saltation threshold and flux.
   - CLM / Anderson overburden compaction (W in kg/m²).
   - Hedstrom–Pomeroy interception and CROWN_BREAK in kg/m².
   - Voellmy ξ, Manning n (hidden √g), the outdoor wind function h = 3U.
   - Tabulated soil bearing capacity.
   - Hard-coded scale height 8000 m (blast, entry).
   - Car crash damage normalized by `m·9.81`, and scripted knock-down impulses.

   Give each a scaling rule or a "limited at g ≠ g0" flag in the model registry (`phenomena/models.ts`).
6. **Zero and near-zero g singularities.**
   - `sqrt(2h/g)` fall times (collapse.ts:487, stability.ts:132, fragments.ts:122, trajectory.ts:53) divide by g.
   - Sand crater radius → ∞ (crater.ts:78, :122-125, with no strength set).
   - Lava `h_cr` → ∞ (no flow).
   - Natural-convection horizontal Nu → 0 (under-estimates heat loss).
   - Flood solver has no restoring force.
   - Buoyancy ratio 0/0 (WaterForceSystem.ts:124 `buoy/(m·g)`).

   Guard g ≥ g_min, or a "limited" mode.
7. **Non-vertical g (D everywhere except Rapier).** Water, granular and lava heightfields; atmosphere columns; buoyancy +y; ash fall −y; flame axis +y; convection up/down faces; roof snow and structural load paths (all vertical by construction); deformation tilt thresholds. Phase 31 should support |g| varying in x and t with the direction fixed to −ŷ. Reject or flag a tilted g as "Rapier-only".
8. **Performance.** The hot loops that need g are the water sweeps (per face per substep), the granular faces, `hGround` (per ground cell), AirLayer venting (per column), fire `buoyantVelocity`, WaterForce (per body), ejecta `fly` (dt 0.01 inner loop) and lava faces. For uniform g every one of them hoists a scalar, so the cost is zero. A spatial field needs per-cell or per-face g arrays sampled once per change (not per substep) and `max(g)` in CFL bounds. Water substeps grow by √(g/G0).
