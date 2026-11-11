# Phase 36 pre-audit: buildings, structural editor, colliders, storey drift, debris, braces, performance

Repo `the repo` @ `e69dde7`. Read-only audit: no repo files were changed and nothing was run except a small node read of `docs/bench-phase35_5*.json`.
Refs are `file:line` (src/ is implied when a path starts with a module dir). **C** = confirmed by reading the code. **S** = suspected; needs a probe.

---

## 1. Building authoring

### 1.1 Data model
- `BuildingDesign` is defined in `buildings/types.ts:139-150` as `{version 1, spec, members[], options, edits, preset?, convertedFrom?}`. It is stored on `WorldObject.building` and is optional: an object without it is a legacy box building.
- `BuildingMember` (`types.ts:46-66`) is a box: `id, type, role, level (-1 foundation … floors = roof), position (building-local), rotation (Euler XYZ; structural members use yaw only, roof panels may pitch), size [len, h, thick], material, host?, facade?, initialDamage?`.
- `MemberType` has 8 values (`types.ts:15`): foundation, column, beam, slab, wall, window, door, roof. **There is no brace type.** `ROLES_BY_TYPE` is at `types.ts:33-42`.
- Local frame (`generate.ts:4-8`, `25-33`): the origin is the footprint centre at ground-floor level, +x is east, +z is south. Storey s spans `[storyBase(s), +storyHeight(s)]`. Each storey owns its columns, walls and openings plus its *ceiling* beams and slabs (all at level s).
- Plan grid (`generate.ts:60-68`): `nx = round(width/bay)` and `nz = round(depth/bay)`. Real bays are `bx = width/nx` and `bz = depth/nz`. **One `bay` value serves both directions.** The grid cannot be irregular and the x and z spacings cannot be set separately.

### 1.2 Spec, constraints, validation
- `BuildingSpec` is at `types.ts:76-112`. `SPEC_LIMITS` (`buildings/spec.ts:13-25`): width/depth 3–60, floors 1–40, floorHeight 2.2–8, groundFloorHeight 2.2–10, bay 2.5–15, total height ≤ 150 m.
- `validateSpec` (`spec.ts:93-140`) reports errors for range, integer and option values and for non-structural primary/slab materials. It warns on masonry > 5 floors, wood > 6, long spans (timber 8 / steel 15 / other 12 m), soft storey (ground > 1.4× typical), weak piers, tall frame without core, and spread footing > 12 floors.
- "Direction" is not a spec field. The building heading is the object transform yaw. The interior bearing-wall direction and the gable ridge follow automatically from `width >= depth` (`generate.ts:292`, `399`), and the user cannot change them. "Length" in the spec is `depth`.
- `SpecForm.tsx:53-91` exposes width, depth, floors, floorHeight, groundFloorHeight, system, structure/slab/cladding material, bay, core, foundation, occupancy, roof, pitch, ceiling, facade, windowDensity, color and sign.
- Commit path (`app/buildingActions.ts:37-63`): `assertValidDesign` (`buildings/schema.ts:50-59`; duplicate ids, finite placement, size within (0.005, 500), at least one member), then a confirm when the number of unsupported members grows, then `applyEdit` as one undo step.
  - Spec changes go through `designForSpec`/`specRegenerates` (`buildingActions.ts:89-111`). A non-appearance change regenerates the design and drops manual edits.
- File load is lenient (`schema.ts:69-107`): invalid members are dropped and counted, and role/material are repaired.

### 1.3 Member editing (Building Edit Mode)
- The viewport is `editor/BuildingEditor.tsx`.
  - Picking uses `SimRenderAdapter.pickMember` (`:135`).
  - Shift toggles the selection.
  - Add mode uses `ghostAt` (`:199-213`) with grid, floor and structure snaps (`buildings/edit.ts:276-321`).
  - The gizmo (`:216-280`) translates, or rotates about yaw only with 90° steps when structure snap is on. One undo step per drag.
- Tool state lives in `editor/memberStore.ts` (selection, adding, gizmo, xray, loadPath, cut, snap, gridStep, removal preview). `editor/buildingDraft.ts` holds the Creator preview draft and the conversion report.
- Pure operations are in `buildings/edit.ts`: addFloor/removeFloor (`55-117`), newMember (`122-153`), add/remove (hosted openings cascade) (`155-168`), move with relevel (`180-191`), rotate (`194-210`), duplicate (`223-239`), setMaterial, setRole, setSize, setInitialDamage (`241-267`).
- `MemberInspector.tsx`: role and material selects, size, and initial damage. Position and level are shown read-only, as is the supports list (`:89`). The panel also shows the removal preview and Duplicate/Delete.
- **Gaps (C):**
  - No member type change (no op in edit.ts or the UI).
  - No numeric position or rotation entry.
  - No manual link or support editing. Links are always derived from AABB contact in `analysis.ts:208-246`, and supports from the type rules at `:248-320`.
  - No re-hosting of openings. The host is set once in `addMemberAt` → `nearestWall` (`buildingActions.ts:213-240`).
  - No validation of member and level consistency beyond the analysis warnings (`analysis.ts:39-41`: unsupported, overloaded, cantilever, noLateral, softStory, noHost, noFoundation, torsion, onSoil).

### 1.4 Structural type (v2)
- `STRUCTURAL_TYPES` (`buildings/structuralType.ts:50-56`) has the ids **steel, rc, masonry, timber, light**. Mapping by member material (`typeOfMaterial`, `:59-61`): structuralSteel→steel, reinforcedConcrete→rc, masonry→masonry, timber→timber, and **glass and lightCladding→light**.
- The type is **not chosen in the UI.** It follows from each member's material: the spec system/material or the per-member material select. The only v2 UI is the global world toggle `ui/Phenomena/RightPanel.tsx:156`. New projects and the default world switch v2 on (`app/actions.ts:138`, `288`).
- No UI imports `STRUCTURAL_TYPES` (C).
  - The `modes`/`joint` fields are documentation only. The comment's "i18n keys structType.mode.*" **do not exist** (C, grep of `src/i18n` is empty).
  - `debrisSize` and `dust` are unused (C).
  - The profiles are applied in `structure/collapse.ts:318-330` (`enableV2`), per member by material, including non-structural members. `memberLaw` skips members that are not structural (`:337`).
- Picker caveat (§34): 'light' is not a valid *primary* system. `lightCladding` and glass are not structural, and `validateSpec:124` raises `notStructural`. A type picker should map rc→`rcFrame`+RC, steel→`steelFrame`+steel, masonry→`masonry`, timber→`wood`, and offer 'light' only for the envelope.

### 1.5 Legacy vs modular
- **Legacy box (L0):**
  - Palette items `building.lowrise/office/house` (`objects/palette.ts:39-44`, params only).
  - `sampleTown()` (tests, golden fixtures).
  - Old files.
  - Definition `objects/definitions/building.ts`: one box collider at `:95-97`, components (windows, sign, roof panels, parapets, units).
- **Modular (L1/L2):**
  - `building.m.*` and `building.custom` (`palette.ts:47-52`, `108`) via `BUILDING_PRESETS` (`spec.ts:55-71`).
    - house: wood bearing walls (timber).
    - apartment: rcFrame + core.
    - office: steelFrame + core, glass curtain.
    - warehouse: steelFrame, lightCladding, spanning roof.
    - industrial: rcFrame.
    - tower: rcFrame + core, 30 floors.
  - The city generator (`roads/city.ts:149`) and the default world `world/defaultTown.ts:61-70` (9 buildings).
  - A legacy building can be converted with `convertToModular` (`buildings/convert.ts`).

---

## 2. Collider after partial collapse (MUST fix)

### 2.1 Where bodies come from (C)
- **Standing building (L0/L1/L2):** `RuntimeBuilder.ts:209` → `createEntityBody` (`:44-128`, fixed branch `:99-127`) creates ONE fixed body.
  - Shape: `buildingDefinition.colliders` = a single box of `width × floors·floorHeight × depth`, offset y = H/2 (`objects/definitions/building.ts:95-97`), plus an optional slope plinth box.
  - Modular params come from `designParams` (`buildings/design.ts:93-106`). Width and depth are `2·max|x|` and `2·max|z|` over above-ground member AABBs (`computeExtent` `:78-91`), so the box is **symmetric about the origin**. Height is the structure height, without roof rise or parapets.
  - The body has `mass = physics.mass`, which Rapier ignores for a fixed body, and `userData {entityId}`.
- **Only rebuild, partial collapse:** `simulation/buildings/modular.ts:380-414` `truncate(e, ctx, s)` removes the body and creates a full-plan box from 0 to `stories[s].base` (+ plinth). It also sets `e.dims[1]`, `windShare`, the wind obstacle height, and calls `model.truncateFrom`.
  - Callers:
    - `collapseFrom` (`modular.ts:525-553`): storey mechanism from the lumped model.
    - `StructuralCollapseSystem.standing` (`systems/StructuralCollapseSystem.ts:278-317`): `sDead = 1 + highest level with ANY alive structural column/wall` (`:283-288`).
  - **Root cause (C):** one surviving column or wall on the top storey keeps the full-height, full-plan box. A collapsed corner or bay across several storeys leaves an invisible solid volume.
- **Total collapse:** the body is removed at `modular.ts:428-429` and `StructuralCollapseSystem.ts:297-298`.
- **Falling blocks:** these are not Rapier bodies. The collapse engine moves them kinematically (`structure/collapse.ts:630-702` formBlocks; `926-946` advance; land/rest/settle `1099-1290`). They interact only with engine "surfaces" (`surfaceUnder` `:729-758`), never with cars or people.
- **Fragments:**
  - A member whose ballistic landing point is outside the plan ± EXIT_MARGIN leaves (`collapse.ts:657-674`; `exit` event). It goes to `spawnFragment` (`simulation/structure/fragments.ts:51-113`): a dynamic box with **exact member mass** and impulse `m·v`. Ledger `structure|resting → bodies`.
  - Over the budget (160 moving / 600 total, `:30`) it is aggregated into rubble (`:116-134`).
  - At rest for 30 steps it becomes a fixed body (`:143-149`, `settleExternal`). The oldest settled fragments merge into rubble (`:152-175`).
  - **Spawn nudge (C, `:58-68`):** a spawn point inside `model.bounds`, the whole plan, is teleported across the nearest plan face because "the standing collider is the whole plan". That jump can be up to half the plan.
- **Rubble piles:** `RubbleField` heaps get a fixed core box (`structure/rubbleEffects.ts:75-111`). It is rebuilt when the height changes by more than 10 cm, and **free bodies inside are lifted onto it.** This is the existing safe-swap precedent.
- **Physics wrapper:** `RapierEngine.createBody/removeBody` (`physics/RapierEngine.ts:230-279`). `removeBody` clears `colliderBody`. Pair bookkeeping (`activePairs`, `touchCount`) is released by the next step's collision-stopped events (`:464-476`).
  - The PhysicsEngine API has no remove/add of a single collider; only whole bodies can be swapped. `wake(h)` and `setBodyKind` exist.
- **Where swaps happen:** `StructuralCollapseSystem` is postPhysics, after `physics.step` (`systems/index.ts:78`; `SimulationController.ts:590-593`). The swap therefore runs between Rapier steps (safe).

### 2.2 Member → physical space
- Design local: `generate.ts`. Scaled AABBs live in `StructuralGraph.box` (6 floats per member, building-local, scaled; `structure/graph.ts:57+`). The graph also has a 2 m plan grid `g.grid` (`:42`, CSR) and `membersInRect`.
- Storey geometry: `mr.initial.stories[s].base/height` (`analysis.ts:82-99`, `412-423`).
- World: `toWorld(e, local)` = `e.pose` rotation + translation (`simulation/structure/state.ts:147-150`).
- Liveness: `model.state[i] <= MS.SEVERE` (`structure/types.ts:17-32`). States only move forward (`canTransition` `:34-49`), so the alive set shrinks monotonically. `model.structRev` bumps on every state change (`collapse.ts:282-290`).

### 2.3 Proposed minimal design (gate: `ctx.runtime.structureV2`)
1. **Derivation** (pure, new `simulation/structure/colliders.ts`), from `g`, `model.state`, `mr.initial.stories` and the spec `planGrid` scaled by `mr.scale`.
   - Cells are storey × bay. The edge cells extend to the member extent.
   - A cell is solid if any of these holds:
     - (a) an alive slab of level s covers the cell centre;
     - (b) the design has no slab there (hall or top storey without ceiling) and an alive structural column/wall of storey s lies within the cell;
     - (c) a member of storey s in the cell is FALLING or RESTING inside the plan (`!external`). The cell stays solid until the engine settles it into a rubble pile, which has its own collider, so cars do not drive under engine-kinematic blocks.
   - **Monotone rule:** `solid_new &= solid_old`. Cells only switch off, so new boxes ⊆ old boxes: no penetration and no ejection.
   - Merge: greedy row runs into rectangles per storey, then stack identical rectangles over consecutive storeys. An intact building gives one box, the same as today's box for symmetric designs and a subset of it for asymmetric ones.
2. **Trigger:** only when `m.structRev` changed. That is already the guard at `StructuralCollapseSystem.ts:89-101`. Inside `standing()`, compute the cell-bitset signature and rebuild only if it differs.
   - Deterministic throttle: at most one rebuild per building per 6 steps. Keep a pending flag on `StructureState` and keep the building in `S.active` until the flag is flushed, otherwise `still` drops it (`:111`).
3. **Swap** (same place and timing as `truncate`, postPhysics):
   - `removeBody(old)`, then `createBody({kind:'fixed', pose:e.pose, shapes: boxes + plinth, userData:{entityId}})`.
   - Wake dynamic entities and debris whose AABB meets the building AABB (+0.5 m).
   - Settled **fixed** fragments resting above removed cells → `setBodyKind('dynamic')` with `settled=false, quiet=0`. The model state stays SETTLED (terminal) and the ledger stays `bodies`. This is a no-op for the ledger.
   - Under v2, `truncate` skips its own body rebuild. It still truncates dims, wind and the model.
4. **Cap:**
   - ≤ 48 boxes per building, plus a global soft cap (e.g. 6000).
   - Over the cap, **drop the smallest boxes**. That keeps a subset. Coarse merging could re-cover removed cells.
   - Rebuild cost is O(members + cells) and happens only on structural change.
5. **Mass / ledgers:**
   - Fixed body: Rapier mass is irrelevant. Nothing reads a fixed building body's mass: `getMass` users are dynamic only (`SeismicForceSystem`, `celestial/runtime.ts:271`, gravity tracker for dynamic bodies).
   - Mass stays in `MassLedger` accounts (`structure/ledger.ts:1-23`). Colliders carry no mass and fragments keep exact member mass, so there is no duplicate mass.
   - Energy and momentum: the swap adds none, because the new boxes are a subset of the old ones and nothing is ejected.
   - Under v2, change the fragment nudge (`fragments.ts:58-68`) to move only out of a **live box**, which removes the teleport.
6. **Secondary strikes** map to members by contact location (`simulation/structure/secondary.ts:90-110`, `membersInRect`), independent of collider shape. Nothing to change.
7. **Tests:**
   - Corner column line removed on all storeys → a car or person passes the corner.
   - One column → no change (cell still solid).
   - Part of a wall or part of a floor.
   - Whole storey → same as truncate.
   - Topple (hinge).
   - Car resting against a removed wall → wakes and moves.
   - Settled fragment on a removed roof → falls.
   - Ledger residual < 1e-9.
   - `bodyCount` bounded.

### 2.4 v1 identity
- In v1 the only rebuild is `truncate`. Applying the derivation to v1 would change every v1 run with partial collapse.
- Even buildings that never collapse could drift in floating point within such runs, because Rapier handle and solver order change after any body swap. **Gate it under v2** (`ctx.runtime.structureV2`, already used at `state.ts:94`).
- v2 runs saved by Phase 35.5 will change after their first cell removal. For strict reproducibility of 35.5 v2 files, add a sub-flag (e.g. `structure:{model:'v2', colliders:'cells'}`) that new projects set, and document it.
- Optional (also v2-only, changes results from t = 0): use the derived box set from the start for **asymmetric edited designs**. The symmetric box from `computeExtent` covers empty space (C).

---

## 3. Storey drift visual (MUST fix)

### 3.1 Simulation side (C)
- Lumped shear chain `simulation/seismic/StructuralModel.ts`, ≤ 5 dofs (`MAX_DOF` `:33`).
- Per-dof arrays `u`, `v` (2 per dof, **unit-local x/z**, relative to the ground), plastic offsets `p`, `cum`, `thMax`, `storyD`, `acc`, dof height `z`, storey height `hs` (`:111-143`).
- Integrated in `stepUnit` (`:383-527`) by `StructuralResponseSystem.update` (`systems/StructuralResponseSystem.ts:62-111`). Outputs copied to `e.seismic`: `top`, `base` (world; `:99-102`).
- Storeys → dofs: `lumpStories` (`buildings/structuralAdapter.ts:44-74`). Floors ≤ 5 get one dof per storey. Taller buildings keep the ground storey alone and split the rest into 4 groups, with `dof[s]`, `first[]`, and `share[2s+ax]` = the flexibility share inside the group.
- Modular per-storey drift: `updateStoryDrifts` (`simulation/buildings/modular.ts:208-224`), `storyDelta·share/h` → `storyDrift/storyPeak/storyPeakAxis`.
- **Stale share (C):** `syncModel` (`modular.ts:350-375`) re-lumps with the current storey stiffness in a local `L` (`:357`) but never writes it back to `mr.unit.lumps`. For buildings with more than 5 floors, the reconstructed storey drift keeps the original flexibility shares after members fail.
- **Ghost dofs (C):** after `truncateFrom` (`StructuralModel.ts:302-328`) the removed dofs keep moving with ε mass and stiffness. `model.top` uses dof `n`, not `nLive` (`:517-519`), and so does `topVelocity` (`:580-586`). So `st.top`, the renderer shear and the fragment kinematics are driven by a ghost dof after any storey collapse.

### 3.2 Render side (C)
- `SimRenderAdapter.updateBuildingQuake` (`rendering/sim/SimRenderAdapter.ts:772-829`) builds one matrix per building: `M = T(pos+ground+base)·R(tilt)·Shear(sx,sz)·R(yaw)·S`.
- `sx = (top-base)·k/H` with `H = e.dims[1]` (`:777`, `798`). That H includes the roof rise, and after truncation it is the truncated height.
- Every member gets the same root (`MemberLayer.writeMatrices`, `rendering/sim/MemberLayer.ts:212-221`). The result is a **uniform linear shear**: a soft storey looks like any other.

### 3.3 Proposal (render-only from computed DOFs; no sim change, so v1 is identical)
- Helper (read-only):
  - `storeyDisp(e, model, out)`: for s < `mr.collapsedFrom`, `U_top(s) = u[j-1] + Σ_{i=first..s} share_i·(u[j]-u[j-1])`, with `j = dof[s]`, per local axis, rotated to world by `model.cos/sin`. `U(-1) = u[0]`, which is the foundation/base dof.
  - Use **current** shares computed render-side from `currentStories(mr)` (cached on `mr.rev`). Do not fix `updateStoryDrifts` in the sim unless gated, because it changes v1 drift results for buildings with more than 5 floors.
  - Use dofs ≤ `nLive` only. Above a collapse, use nothing (those members are fallen and drawn by engine offsets).
- MemberLayer: let `writeMatrices` take `rootOf(i)` (per-storey matrices, about `2·floors+1` cached per frame) instead of one root.
  - Columns, walls, windows and doors of storey s: world-y shear between `U_top(s-1)` and `U_top(s)` over `[base_s, base_s+h_s]`. The shear matrix has `sx_s = ΔU_x·k/h_s` and an offset so that y = base_s maps to `U_top(s-1)·k`.
  - Beams and slabs of level s: translate by `U_top(s)`.
  - Roof and parapets (level = floors): `U_top(top live storey)`.
  - Foundation: base only.
  - Fallen members keep their collapse offsets with the unsheared root. RESTING members use the storey of `restOn`.
  - Rooftop units, sign and cracks: storey lookup by local y.
- Keep `quakeKey` (`:787`), but hash the per-storey `U` values. Keep `ANIM_STRIDE` for far buildings.
- L0 legacy (single shell box): keep the uniform shear.
- **Torsion:** the storey model has no rotational dof (`StructuralModel.ts:15-17`). v2 torsion is only a demand amplifier: `torsionFactors` (`simulation/buildings/structureV2.ts:31-56`) gives `δ = 1 + 0.6·|d|/L` per member and axis, used in `torsionDemand` (`:59-69`) and in `evaluateDrift` (`modular.ts:248-266`).
  - **Do not twist floors.** Showing torsion means colouring members by `torsionDemand/capacity`, a computed quantity, in a structure colour mode.
  - Doc vs code (C, minor): the code uses the unweighted centroid of storey lateral members plus primary beams (`:39-45`), but the header says "stiffness centre". The EC8 §4.3.3.2.4 form uses the centre of mass.
- Damaged storey: use the per-storey `storyD` (`StructuralModel.ts:139`) or `mr.storyPeak` for the existing stress tint, per storey instead of per building.

---

## 4. Debris
- **Physical** (mass-booked): fragments with exact member mass (`fragments.ts:51-113`), aggregated rubble (`:116-134`), rubble piles (`collapse.ts:790-806` addToPile, `structure/rubble.ts`), and the ledger accounts (`structure/ledger.ts:24`). Glass goes to `fines` (`collapse.ts:666`).
- **Visual:**
  - Dust particles are spawned in StructuralCollapseSystem at impact `:161`, ground `:171` and crush `:181`.
  - Particle `kind:'dust'`, "never read by the simulation" (`simulation/SimulationRuntime.ts:159-172`).
  - Counts are capped by `MAX_PARTICLES = 1600` (`simulation/damage/spawn.ts:11`) and the RNG is `ctx.fxRng` (`spawn.ts:92`, effects-only stream; also used by tree leaves).
  - DebrisLayer draws fragment bodies at their box size (`rendering/sim/DebrisLayer.tsx`). RubbleLayer draws mounds (`rendering/sim/RubbleLayer.tsx`).
- Coefficients: only `debrisSize` and `dust` exist (`structuralType.ts:45-47`). **There is no count or shape coefficient** for the §41 "size, count, dust, shape". Neither field is read anywhere (C).
- **Minimal link without ledger or RNG change:**
  - Add an optional visual factor field on `Particle` (e.g. `k`), set at the three spawn sites from `STRUCTURAL_TYPES[typeOfMaterial(material of ev member)].dust`. ParticleLayer scales size and opacity by it. **Keep the count unchanged**: a changed count shifts the `fxRng` stream and the cap.
  - Fragment and rubble "size": render-only sub-division of a fragment's box into `round(1/debrisSize)` visual chunks inside the same body box. DebrisLayer `CAPACITY` (`:14`) needs headroom. Alternatively, use the rubble mound chunk/roughness per dominant type.
  - **Never split bodies:** that changes mass bookkeeping and the 160/600 budget.
  - If "count" and "shape" coefficients are wanted, add them to `STRUCTURAL_TYPES` as render-only fields and document them.

---

## 5. Braces
- **The graph has no joint nodes (C).** Members are the graph nodes. Edges are dependent→support relations built from **AABB contact** (`analysis.ts:208-246`, TOL 6 cm, BEARING_GAP/NEAR_GAP) and type rules (`:248-320`; `graph.ts:9-22` tiers).
  - A diagonal member is a rotated box. `memberBounds` (`buildings/geometry.ts:41`) turns it into a bay-sized AABB that would "touch" the slab, beams, columns and cladding: wrong links. Brace connections need an **endpoint rule**: endpoints are `position ± R·[L/2,0,0]`, and the brace links to members whose box contains an endpoint within TOL.
- **Minimal axial brace model:**
  1. `MemberType 'brace'`. Touches: `MEMBER_TYPES`, `ROLES_BY_TYPE` (primary), schema enum (automatic), `MT_BRACE = 8` (`graph.ts:39-40`), `fillKind`, i18n, `newMember`, memberColor. Editor: a two-click joint→joint tool, because the gizmo rotates yaw only (`BuildingEditor.tsx:234-240`). Generator option `spec.bracing` for steelFrame bays.
  2. Gravity: not a support of anything. Its own weight is hung on its two end members, like a beam with two supports. Mass is split half/half into the storey lumps, like columns (`analysis.ts:401-405`).
  3. Lateral:
     - Stiffness `k_b = E·A·cos²α / L` in its plane, split into kx/kz by yaw. For X-bracing, count the tension diagonal only, or tension plus residual post-buckling compression.
     - Strength `V_b = (f_y·A + 0.3·N_cr)·cos α`, with `N_cr = π²EI/L²`.
     - Add to `lateral()` (`analysis.ts:623`). These become `g.kx/kz/vx/vz`, so `currentStories` → `syncModel` → `scaleStory` works unchanged.
  4. Drift capacity:
     - Buckling at `θ_cr = (N_cr/EA)·L/(h·cos α)`: a v2 stage or damage event.
     - Fracture at `θ_u = ε_u·L/(h·cos α)`.
     - Feed `capacity[i]` in `createModularRuntime` (`modular.ts:160-166`) so `evaluateDrift` damages and fails braces. Optionally apply `memberLaw` for steel on drift `u = θ/θ_y`. Today `memberLaw` applies only to solver gravity utilization.
  5. Connection: a new `CK` kind (gusset, `structure/types.ts:59-78`) with capacity ≈ 1.1·f_y·A. A brace fails by `support` when either end member fails (solver support pass).
  6. Caveats:
     - The period calibration to the code band (`analysis.ts:480`; `kScale` in `structuralAdapter.ts:102`) can scale away the added stiffness. A braced system needs its own period band, e.g. a `steelBraced` entry in `STRUCTURAL_SYSTEMS`, or the brace share must be excluded from calibration.
     - Pinched or tension-only hysteresis is not representable in the bilinear storey spring.
     - `standing()` counts only columns and walls (correct for braces).
     - Falling-block contact uses AABBs, so a falling brace looks oversized.
- GSA dynamic factor `dynamicFactor` (`structure/capacity.ts:68-70`) and alternate tiers (`solver.ts:1-60`): braces as an alternate gravity path (Vierendeel or truss action) would need a new tier. Out of the minimal scope; document it.

---

## 6. Performance

### 6.1 Building-count bench (`bench/ux355.bench.test.ts`)
- Enabled by `BENCH=1`. Env vars: `BCOUNTS` (default 1,10,50,100,500,1000, `:122`), `COUNTS`/`TYPES`/`BUDGET_S` for the instance part, `BENCH_OUT`.
- `town(n, level)` (`:38-56`):
  - L2 sets `structure:{model:'v2'}`.
  - L0 = legacy params `floors 2, 8×7` (`:50`).
  - **L1/L2 = `presetDesign('house', 1)`, a 1-storey house (`:45`). L0 and L1/L2 are not the same building (C).**
  - Spacing `sp = min(14, 188/side)`. 500 buildings → 8.17 m against a house extent of about 8.16 m (touching). **1000 → 5.9 m: buildings overlap (C).**
- `run()` (`:60-86`):
  - Quake `pga 0.5, duration 20, startTime 0.2` for 5 s, or 3 s when n ≥ 500.
  - The envelope peak is at `sMinusP + 0.28·(20 - sMinusP)`, which is ≥ 5.6 s after the start (`seismic/SyntheticWaveform.ts:100-101`, `140-148`). **Both windows end before the strong phase (C).** 3 s and 5 s windows are also not comparable.
  - Measures:
    - `msPerSimS` (wall time).
    - `worstStepMs`, per fixed step (`advance(1/60)`).
    - Sections per simulated second, read from the **private** `simProfiler.sections` by a cast (`:64`).
    - Heap after gc.
  - Each (n, level) cell runs **once**, in the fixed order L0→L1→L2.
  - Data (`docs/bench-phase35_5.json`): load 37–55. `physics` for L1/L2 at 1000 (same code) = 65 vs 311 ms/s. That is noise, as §25 says.
- **Fair repeat:**
  - Idle machine. Kill orphan vitest workers first (memory note). Record `os.loadavg()` per run and reject or flag runs above about 2.
  - The same building in all levels (L0 params = `designParams(design)`, or a 2-storey `presetDesign`).
  - No overlap: spacing ≥ extent + 1 m, or n ≤ 500 on the 200 m map.
  - The same simulated window for all n, covering the peak (e.g. 10 s, or a shorter `duration` so the peak falls inside).
  - A discarded warm-up per level.
  - ≥ 5 repeats, **interleaved** (rotate the L0/L1/L2 order).
  - Report mean, median, IQR and stdev. Also report `process.cpuUsage()` deltas beside wall time.
  - gc between cells. One fork (`--pool=forks`, single fork) so other files do not run concurrently.

### 6.2 Long run, "worst step 9.4 s"
- `LONG=3600 LONG_SCENES=mix` (`:156-256`): the scene is 25 v2 houses (1 storey) + 6 cars + 11 events.
- **The loop calls `c.advance(1)` (`:210`), which runs 60 fixed steps (`SimulationController.ts:512-520`).** `worstStepMs` (9427 in `docs/bench-phase35_5-long.json`; load 5→17.8) is therefore the worst **1-second chunk, not a single step** (C). §25/§27 call it a single step.
- `simProfiler` is **not enabled** in the long run, so there is no breakdown, and the sim time of the worst chunk is not recorded (C).
- Hooks that exist (`simulation/profiling/SimProfiler.ts`):
  - `physics` (`SimulationController.ts:590-592`).
  - `sys.<name>` for every system, plus `dispatch` per phase (`:603-613`).
  - Sub-sections: `struct.create/model/events/ev.{events,piles,sync,standing,spawn,record}/fragments` (`StructuralCollapseSystem.ts`, `structure/state.ts:90-99`), `blast.*`, `fire.*`, `thermal.*`, `vehicle.*`, `physio.*`, `climate.*`, `atmosphere.*`, `volcano.*`, `damage.*`, `gravity.*`/`celestial.*`/`kdk.*` (alias `P`).
  - Wind sampling `windMs`.
  - Only accumulators: **no per-step max, no histogram, no timestamps.** `snapshot()` exposes `sys.*` only, averaged per tick.
  - DeformationSystem times `setTerrain` (heightfield rebuild) locally (`systems/DeformationSystem.ts:70-95`).
- **Instrumentation for §63:**
  - Replace `advance(1)` with 60× `advance(1/60)`; headless `publish` returns early (`SimulationController.ts:672`).
  - Enable `simProfiler`. Diff `sections` per step, which is cheap.
  - Keep the top-5 steps with: sim t, stepIndex, section deltas, entity/body/fragment/heap counts, active instances, blast waves, collapse events, `bodyCount`, heap, `process.resourceUsage().majorPageFault` delta (swap on 8 GB), and GC pauses (PerformanceObserver 'gc', as in `bench/simProfile.bench.test.ts:11`).
  - Candidates, unverified: blast wave tables, `setTerrain` from sinkholes, rubble collider rebuild loops over all entities (`rubbleEffects.ts:88-101`), first `structureOf` graph build, major GC or swap.

---

## 7. Hinge toppling contact and the snow preset text
- **Hinge** (v2): `hingeOf` `structure/collapse.ts:961-1027`, `rotate` `:1029-1083`.
  - During rotation the only checks are the tear angle and the **local ground** `bottom(i) <= 0.02` (`:1063`). There is no check against standing members, resting or settled rubble, other buildings or Rapier bodies, so a rotating block can sweep through the standing part below its hinge (C).
  - `bottom()`, `top()` and `surfaceUnder` (`:710-758`) ignore `rot`. `rot` is written (`:1024`, `1061`) and read only by the renderer (`SimRenderAdapter.ts:539-541`). A tilted member therefore touches the ground or lands with its unrotated AABB (C): a corner of a long member penetrates by up to about `L/2·sin θ`.
  - `hinge`/`release` events are emitted (`:1025`, `1078`), but `StructuralCollapseSystem.events` ignores them (`default: break`, `:184-186`). There is no log, milestone or dust (C).
  - A hinged block's members cannot become fragments (exit is decided before `hingeOf`, `:657-674`), so `spawnFragment` ignoring `rot` (`fragments.ts:78`) is not reached today.
  - Minimal improvement: during `rotate`, query `surfaceUnder` or `membersInRect` for the rotated corners each sub-step and release on contact. Compute the bottom from the rotated box corners.
- **Snow preset:** `climate/presets.ts:126-129` (`snowLoadedBuilding`: warehouse, `initialSnow 0.8`, density 350 → about 2.75 kPa) with assumption keys `roofLoad`, `loadPath`, `snowKept`.
  - Text: `i18n/locales/en.climate.ts:243-244` ("…roof load into the structure"), `:274-276`; `ko.climate.ts:243-244`, `:274-276`.
  - The warehouse roof panels are spanning `lightCladding` (`roofCap`, Phase 31 R1, `structure/graph.ts:24-27`; `capacity.ts` `roofPanelCapacity`), so they fail at once.
  - Fix: change the description to "roof panels fail, snow falls to the ground (mass kept)", or lower `initialSnow` below the panel capacity. Then check the snow ledger after 1 s.

---

## 8. Defects and gaps

### Confirmed (C)
1. The collider shrinks only when the highest storey with any alive column/wall drops (`StructuralCollapseSystem.ts:283-288` → `modular.ts:380-414`). Corner or bay collapse leaves an invisible wall.
2. The modular collider is a box symmetric about the origin (`design.ts:78-106`, `building.ts:95-97`). Asymmetric edited designs get phantom volume.
3. Fragment spawn teleport across the nearest plan face (`fragments.ts:58-68`).
4. Ghost dofs after truncation drive `model.top`/`topVelocity` (`StructuralModel.ts:517-519`, `580-586`), so they reach the renderer shear (`SimRenderAdapter.ts:777-798`) and the fragment kinematics (`state.ts:126-144`).
5. `kinematics()` uses the top velocity × a linear shape `y/H` (`state.ts:136-141`), not the per-dof `v[]`. Fragment velocities ignore soft-storey response (fixing it changes v1, so gate it).
6. Stale `lumps.share` after `syncModel` (`modular.ts:357`) for buildings with more than 5 floors.
7. Uniform linear shear render with `H = dims[1]` including the roof (`SimRenderAdapter.ts:777`).
8. `debrisSize`/`dust` unused. The `modes`/`joint` i18n keys do not exist. There are no count or shape coefficients (`structuralType.ts`).
9. There is no brace type, no member type change, no numeric position or rotation, no link editing, and no structural type picker (§1).
10. Bench: L0 (2 storeys) differs from L1/L2 (1 storey); there is overlap at 1000 (and touching at 500); the windows end before the quake peak; one repeat in a fixed order; private `sections` read by cast (§6.1).
11. The long-run "step" is a 60-step chunk with no profiler and no timestamp (§6.2).
12. Hinge: no contact except the local ground; `rot` ignored by contact; hinge/release events unconsumed (§7).
13. Snow preset text mismatch (§7).
14. Doc/code mismatch: the torsion "stiffness centre" is really an unweighted centroid (`structureV2.ts:39-45`).

### Suspected (S), each needs a probe
- **S1.** Backstop masking after a storey collapse.
  - `seismicDamageIndex(st)` uses `st.damage = max storyD` over **all** dofs, including the truncated one. Its `thMax`/`cum` persist and stay ≥ 1 (`StructuralModel.ts:493-503`).
  - `updateModularQuake` then picks `worstDof` over all dofs (`modular.ts:614-620`) and acts only if `story < collapsedFrom`.
  - A later mechanism in a lower storey may never be triggered by the backstop. Member drift failures still occur.
- **S2.** Settled fragments (fixed bodies) resting on a roof float after `truncate` removes the box under them. Nothing re-dynamizes them (`fragments.ts:143-149`; `truncate` does not touch fragments).
- **S3.** Rapier auto-wakes bodies touching a removed collider, but `PoseSyncSystem` force-sleeps settled bodies (`systems/PoseSyncSystem.ts:35-49`). Wake explicitly after a swap.
- **S4.** Wind obstacle and `windShare` follow only the height (`modular.ts:405-407`). A corner collapse does not reduce the wind face. Minor.
- **S5.** Falling engine blocks never interact with Rapier bodies. Once colliders shrink, cars or people could enter a cell where blocks still fall; this is mitigated by rule 2.3 (c).

## 9. Identity checklist for Phase 36 building work
- Render-only changes (storey drift, debris visual factors): sim unchanged, so v1 and v2 are bit-identical. Keep the particle count and `fxRng` use unchanged.
- Collider derivation, fragment-nudge change, kinematics/share/ghost-dof fixes: they change results. Gate under `runtime.structureV2`, or a sub-flag that new projects set. Golden fixtures in `simulation/__golden__/` are v1 (`golden.test.ts`) and must not move.
- v2 tests and probes that may need re-baselining: `simulation/structure/structureV2.sim.test.ts`, `src/__audit__/p355/*.probe.ts`.
