# Phase 36 audit — TERRAIN EDITING + ROADS (read-only, base e69dde7)

Legend: **C** = confirmed by reading the code (not run), **S** = suspected / needs a test. Paths are `src/…`.
Grid: WORLD_SIZE 200 m (`core/units.ts:12`), cell 1 m → 201×201 = 40 401 vertices (`terrain/TerrainData.ts:10-11`).

---

## 1. Terrain tools (Phase 12 / 19 / 20)

Tool ids: `editor/editorStore.ts:19-24` (`TerrainToolId`). UI grid: `ui/Terrain/NatureSections.tsx:20-32`. Viewport: `editor/tools/TerrainTool.tsx` (brushes) and `editor/tools/NatureTool.tsx` (features).

| Tool | Kind | Implementation |
|---|---|---|
| raise / lower | brush, ±8 m/s × strength × falloff | `terrain/TerrainEditor.ts:154-186` (`MAX_RAISE_RATE` :31) |
| flatten | brush, relaxes toward height at press | `TerrainEditor.ts:172-183`; target = `hit[1]` at pointer-down `TerrainTool.tsx:163` |
| smooth | brush, 3×3 box blur (scratch copy) | `TerrainEditor.ts:116-150` |
| paint (ground) | brush, hard core 0.35+0.6·strength of the radius | `TerrainEditor.ts:97-114` |
| soil (`paintSoil`) | brush, soil profile layer | same block |
| plateau | brush, cuts only what is above the press height | `TerrainEditor.ts:181` |
| ridge / valley (brush) | raise/lower with 'sharp' falloff | `TerrainEditor.ts:155-167` |
| slope | brush, ramp A(press)→B(cursor), heights of the stroke start | `TerrainEditor.ts:174-179`; full heights copy at press `TerrainTool.tsx:163` |
| noise | brush, seeded fBm | `TerrainEditor.ts:184-185` |
| erode | brush, one thermal-erosion step (talus 0.65), mass-conserving | `TerrainEditor.ts:204-234` |
| inspect | point probe | `TerrainTool.tsx:154-157`, `ProbeMarker` :180-195 |
| mountain / hill | feature, click → `PeakFeature` | `NatureTool.tsx:142` → `app/natureActions.ts:79-84` |
| ridgeLine / valleyLine / canyon | feature, click points + dbl-click → `LineLandformFeature` | `natureActions.ts:90-131` |
| river | feature, path; width/depth/bank/meander/grading/crossing (culvert default)/water | `landscape/types.ts:81-99`, default crossing `editor/natureStore.ts:47` |
| lake | feature, polygon; surface = rim low − freeboard | `natureActions.ts:108-116` |
| coast | feature, line + sea side, beach/offshore | `landscape/types.ts:117-131` |
| forest | scatter brush → tree OBJECTS | `NatureTool.tsx:105-136`, `natureActions.ts:275` commitForest |
| feature | select / drag handles of a feature (commit on release) | `NatureTool.tsx:154-176`, `moveFeaturePoint` |
| (presets) | base terrain / environment presets, water level | `TerrainPanel.tsx:32-79`, `worldStore.ts:687-711` |

Composition (non-destructive layers): Base + Sculpt + Σlandforms → min(water carves) → paint = Natural; ⊕ road bake = Final (`landscape/types.ts:1-19`, `landscape/compose.ts:112-148`, `landscape/apply.ts:59-66`).

**Brush parameters**: radius 1–40 m (`editorStore.ts:26`, default 8), strength 0.05–1 (default 0.5), falloff smooth/linear/sharp/flat (`TerrainEditor.ts:36-45`), shape circle/square (max-norm, `:89`), seed (noise), height limits min/max (`:91,188-189`). dt per dab capped at 1/20 s (`TerrainTool.tsx:113`).

**Overlay / preview (what exists)**
- Brush: ONE draped ring at `brushRadius`, colour per tool, depthTest off (`TerrainTool.tsx:53-63,132-142`). Nothing else.
- Live numbers: max raise / max lowering / changed area of the current stroke, ~6 Hz, in the panel (`TerrainTool.tsx:125-130`, `worldStore.ts:665-679`, `NatureSections.tsx:128-130`). Only DURING / after a stroke, not before.
- Features: draft polyline + width offsets, rings for peaks (radius, 0.35·radius), forest ring, coast sea/beach lines (`NatureTool.tsx:72-103`). No predicted terrain.

Gaps vs §22 (all **C**):
- No predicted height change / affected-area preview before applying (§22 asks for it).
- Square shape still draws a circle ring (`TerrainTool.tsx:136-141` ignores `brushShape`).
- Paint/soil core (0.35–0.95 r) differs from the ring (full r) (`TerrainEditor.ts:101`).
- Falloff curve, flatten target plane, slope A→B line, height limits: not visualised.
- One dab per frame at the current cursor, no interpolation between frames → fast drags leave gaps (`TerrainTool.tsx:105-124`).

---

## 2. Stroke transaction, undo, memory

Flow: `onDown` → `beginTerrainStroke` (`worldStore.ts:649-652`) → every frame `terrainDab` → `applyDab` IN PLACE on `doc.terrain` arrays, rect unioned (`:654-663`) → `pointerup`/`blur`/unmount → `endTerrainStroke` (`:681-685`) → `commitTerrain` (`:274-291`) → `finishLayered` (`:294-312`).
- Commit folds Δh into `landscape.sculpt`, Δground into `landscape.paint`, `recompose` (natural in rect grown by rivers, re-bake in rect grown by whole road segments + junctions: `apply.ts:30-66`), objects follow, ONE history entry. **One drag = one undo step: C.** Undo/redo refused while a stroke is open (`worldStore.ts:724,733`).
- Undo = `travel` (`:315-324`): LayerPatch + TerrainPatch side swap, roads/objects references swapped.

Copies:
- Stroke start: `snapshotLayers` full heights F32 + ground + soil (`TerrainData.ts:166-168`) = 242 KB @200 m. Slope tool +162 KB (`TerrainTool.tsx:163`).
- Per frame: no copy for most ops; smooth reuses a scratch; **erode allocates two Float64Array of (2r+3)² per dab** (r=40 → ~110 KB/frame) (`TerrainEditor.ts:209-211`). Each dab bumps `revision` → next `samplerFor().sync()` does 4 full-grid passes (isFlat, isDefaultGround, isDefaultSoil, heightRange) (`TerrainSampler.ts:49-62`). `strokeDelta` scans the stroke rect every 160 ms.
- Commit: `snapshotLandscape` 6 full layers (sculpt, paint, natural h/g/culvert/roadBase) = 606 KB @200 m (`apply.ts:88-92`); `RoadBatches.sync` full-grid compare + `heights.slice()` (`RoadBatches.ts:109-123`); EditorBatches rebuild ALL object chunks because the sampler identity changes on every commit (`EditorScene.tsx:103-106`, `EditorBatches.ts:88-92`, `doc.terrain = {...t}` `worldStore.ts:307`) — **C**, perf.
- History entry: TerrainPatch 12 B/vertex of `finalRect` + LayerPatch 30 B/vertex of natural rect (`TerrainData.ts:139-155`, `apply.ts:106-111`). A dab touching a road grows `finalRect` to the WHOLE segment box + reach (e.g. default main street s6: ~112×33 m → ~45 KB). Full-map entry (preset, coast sea level) ≈ 1.7 MB; `HISTORY_LIMIT = 100` is a COUNT, not bytes (`worldStore.ts:37`) → worst ≈ 170 MB @200 m. **Not memory-bounded (§23) — C.** At 1 km/1 m (1 M vertices): stroke start 6 MB, commit 15 MB transient, full entry 42 MB, 4 M ops/frame for sampler sync.
- Module-level `let stroke` shared by the app store AND `scratchWorld` stores; `replaceDocument` of a scratch store clears the app's open stroke → in-place edits never committed (layers not folded, roads not re-baked) (`worldStore.ts:85,636,645,744-748`) — **S** (only if a template/blueprint scratch build runs mid-stroke).
- `roads/sync.ts:34-79 rebakeAfterTerrainEdit` is dead code (Phase 18 path, superseded by layers) — **C**.

---

## 3. What is rebuilt after a terrain edit, and when

| Data | Editor (during stroke) | Editor (commit / undo) | Simulation |
|---|---|---|---|
| Final heightfield `doc.terrain` | edited in place per dab | recomposed + road re-bake (`apply.ts:59-66`) | copied at load `runtimeTerrain` (`SimulationController.ts:1161`) |
| TerrainSampler | lazy `sync()` by revision | new sampler per new TerrainData object | own sampler on the copy (`:149`) |
| Render mesh | dab rect each frame (`TerrainLayer.tsx:125-143`, `terrainDirty.ts`) | `terrainRect` (`TerrainLayer.tsx:101-122`) | deformation rects ≤10 Hz (`:127-137`) |
| Rapier heightfield | — (no physics in editor) | — | built once per load/reset (`SimulationController.ts:146`, null if flat `TerrainPhysicsAdapter.ts:23-24`); deformation `setTerrain` (`DeformationSystem.ts:92`) |
| Road bake (heights + ground) | NOT re-applied (brush edits the baked surface) | `recompose` → `bakeRegion` | never re-baked (already in the snapshot) |
| Road mesh | NOT updated (deps = doc.roads/doc.terrain identity, `RoadLayer.tsx:34-38`) | `RoadBatches.sync` (chunks over changed heights) | re-drape ≤5 Hz on deformation (`RoadLayer.tsx:39-43`) |
| Hydro / flood grid | — | StaticWaterLayer recomputed (`rendering/landscape/StaticWaterLayer.tsx:12-26`) | built at load from the copy (`SimulationController.ts:156-186,212`); bed change on deformation (`DeformationSystem.ts:94`) |
| Soil / seismic site | soil array painted in place | patch only (soil is NOT a landscape layer; `applyTerrainPreset` overwrites soil paint, `worldStore.ts:377`) | read live: `GroundMotionField.ts:192`, `GeoField.ts:141` |
| Disaster picking (PlacementLayer) | live `samplerFor(doc.terrain).raycast` (`PlacementLayer.tsx:32,148`) | same | deformation terrain (`:32`) |
| Objects | NOT moved | `followTerrain` (§4) | — |

Render ≠ physics paths:
- **C** During a stroke: terrain mesh moves, road mesh / objects / pins do not (until pointer-up). On release a graded road under the brush snaps back to its re-graded profile (the brush preview lied).
- **C** Curbs: mesh has vertical curb faces at the exact edge; the 1 m heightfield ramps 0.15 m over a cell, carriageway claim margin 0.35 m (`bake.ts:27,225-227`). For an edge between vertices the ramp starts up to 0.5 m inside the visual curb. Example default town side street s8 (x = −23, edges at x = −26.5 / −19.5): vertex x=−20 (d=3) carriageway h=−0.06, x=−19 (d=4) sidewalk h=+0.08 → terrain at d=3.5 = +0.01 while the road mesh edge is at −0.07+0.03 = −0.04 → **terrain pokes 5 cm through the asphalt for d≈3.19–3.5** (arithmetic from `mesh.ts:109-132`, `bake.ts:224-227`; not visually verified). Wheels climb the curb 0.5 m early.
- **C** Junction caps: intersection polygon is FLAT at the node elevation (`mesh.ts:213-216`, `bake.ts:265-266,278`), segment ends have the crown (−crossFall·w) and the graded profile at s = trim. Step at cap edges = crossFall·w (asphalt 10 m road: 0.10 m) + grade·trim (6 % × 4.5 m ≈ 0.27 m) in mesh AND heightfield (within one 1 m cell).
- **C** Deformation run: graded road segments do NOT drape — `segmentProfile(terrain, naturalOf(terrain, n))` reads `network.underlay` = pre-run natural heights (`mesh.ts:106`, `bake.ts:42-56`), only follow roads and junction patches (`sampler.sampleHeight`) move → graded segments float over subsidence while junctions sink.
- **C** Embankment river crossing: bake grades on `natural.roadBase` (`apply.ts:19-22`, `bake.ts:65`), mesh grades on the underlay natural (with the channel) → mesh profile dips below the baked fill.
- **C** Culvert crossing: channel vertices stay natural (`bake.ts:315`) but the mesh draws a continuous deck → visual bridge, physical hole (cars fall in).

---

## 4. Ground-follow of objects on terrain edits

`followTerrain` (`worldStore.ts:190-215`), called from `finishLayered` (`:304`) and `bakeRoads` (`:349-351`), area = changed rect + 40 m:
- Only objects **grounded on the BEFORE terrain** (origin within 5 cm of the seated pose, `groundPlacement.ts:30,129-145`) are re-seated with `reseat` (heading kept). Lifted objects stay. Rules per type (`groundPlacement.ts:1-14`): building = level on footprint max + plinth; wall/pole/sign = min corner; person = centre, level; tree = trunk, 30 % tilt; vehicle = plane through 4 corners.
- Buildings with `foundationPolicy: 'preserve'` keep their transform, plinth frozen (`worldStore.ts:200-206`, `buildings/foundation.ts`).
- Network roads: re-graded by the re-bake (no objects). Road-linked objects: only `followTerrain` on terrain edits; `followRoads` (policy follow/preserve/detach) only on road edits whose centreline changed (`roads/links.ts:76-121`); a WIDTH change does not move linked objects (`lineChanged` :60-67) — **C** (lights can end up on the carriageway after widening).
- Legacy road objects: reseated (fit centre, `objects/definitions/road.ts:18`) + draped at render (`rendering/terrain/drapeRoad.ts`).
- Disaster pins: store x/z only; y = `ground().sampleHeight` at render (`PlacementLayer.tsx:76-77,254,276`) → follow implicitly BUT the layer does not subscribe to `doc.terrain` and `GroundLine` rings are memoised on points only (`rendering/ground/GroundTools.tsx:86-96`) → stale pin / ring height after an edit until something re-renders — **C** (render-only).
- No per-object policy UI beyond building foundation policy and road-link policy; behaviour is the blanket "grounded follows" (§24 asks for explicit per-object policy).
- Nothing follows live during a stroke (only at release) — **C**.

---

## 5. Phase 35.5 cross-section model

`roads/crossSection.ts`:
- `crossSectionOf(p)` :28-40 — laneWidth = (width − 2·shoulder − median)/lanes; totalWidth = width + sides·sidewalkWidth.
- `laneCenter(p, i)` :43-49 — no shoulder/median: −w/2 + (w/lanes)(i+½) (exact pre-35.5 rule); else lanes between shoulders, +median for i ≥ lanes/2 when two-way.
- `CROSS_SECTIONS` :54-59 — narrow2 (6/2), normal2 (7/2 = 'street'), wide2 (10/2 + 1.5 shoulders, sidewalk 2.5), avenue4 (14/4); mirrored in `PROFILE_PRESETS` (`roads/types.ts:118-127`). `presetOf` :62-68.
- `placeRoadPiece(preset, center, yaw, length)` `app/roadActions.ts:76-87` — straight network road through `drawRoad` (ends snap to nodes/segments).

Call sites (complete grep):
- `crossSectionOf`: `ui/Roads/RoadPanel.tsx:119` (display line only) + test `structureV2.sim.test.ts:125-127`. **Mesh, bake, junctions, RoadRuntime do NOT call it** — they re-derive from `profile.width/2`, `sidewalkWidth`, `shoulderWidth`: `mesh.ts:107,148,156,174-187`, `bake.ts:197-199`, `intersections.ts:102-104`, `RoadRuntime.ts:114,128`, `RoadTool.tsx:95`.
- `laneCenter`: only `roads/city.ts:450` (vehiclesAlong 'lanes'). Parked lateral is a separate rule `city.ts:445` (shoulder > 1.6 ? centre of shoulder : w/2 − 1.1). Mesh markings re-derive lane lines (`mesh.ts:174-206`). Vehicles in the sim never read lanes.
- `CROSS_SECTIONS`: no runtime caller (presets come from `PROFILE_PRESETS`); `presetOf` only in a test.
- `placeRoadPiece`: `editor/tools/PlaceTool.tsx:116-120` (palette `env.road` → 'street', `env.road4` → 'avenue', length 20 default).
- Default world: `world/defaultTown.ts:48-53` via `PROFILE_PRESETS` ('wide', 'street'); applied in `app/actions.ts:286`.

Note: "single source" is nominal — widths are consistent, but each consumer has its own formula (risk when tapers are added: every consumer must switch).

---

## 6. Network data model and drawing

Model `roads/types.ts:29-111`: nodes {x,z,y|null}, segments {a,b,control[],profile,condition?}, zones, underlay, next. Width/profile is CONSTANT per segment. Centreline: centripetal Catmull–Rom through a, controls, b; mirrored end tangents; resampled at ~1 m (`roads/curve.ts:1-91`). Straight segments exact.
Road tool (`editor/roadStore.ts:6-17`, `editor/tools/RoadTool.tsx`):
- draw: click points (polyline legs = one segment each), dbl-click/Enter finishes (`RoadTool.tsx:273-283,319-324` → `roadActions.ts:50-68`). curve: one segment, interior clicks = control points. edit: drag node/control handles, commit on release (`:154-171`). split / delete / zone modes. Grid snap optional.
- Snap priority node (3 m) > segment (≤ w/2+0.5 in the tool) > grid > free (`RoadTool.tsx:29-36`); `drawRoad` itself snaps node ≤ 3 m, else segment ≤ 2 m + w/2 → split (T) (`network.ts:159-173,78-93`). Splits closer than 2 m to an end reuse the end node (`network.ts:121-127`). Crossings split both roads → 4-way (`network.ts:185-193,216-235`).
- Extend: start/end on a free end node → new segment sharing it (degree-2 node).
- Curved connection: tangent at each node is the spline's own mirrored tangent, NOT the neighbour's → G0 only, kink at joins (**C**, `curve.ts:52-54`).
- Preview: `drawRoad` on every hover (`RoadTool.tsx:181-192`), outline = edges ±width/2 + centreline; length / grade / Δh / crossings / min radius label.
Defects:
- **C** Hover snap label says 'free' for distance w/2+0.5 … w/2+2 from a road but the commit splits the road there (`RoadTool.tsx:33` vs `network.ts:167`).
- **C** `sameProfile` compares only the keys of the first profile (`network.ts:260`): a profile without `shoulderWidth` "equals" one with shoulders → `mergeAtNode` can silently drop the shoulders (order-dependent).
- **C** No warning for width/profile mismatch at a node (`networkWarnings` `network.ts:407-426`).
- **C** Claims sort by id string (`bake.ts:188`): 's10' < 's6' — deterministic but not numeric (harmless, note for tests).

---

## 7. Junction geometry

`roads/intersections.ts:85-167` (cached per network object):
- Built for nodes with ≥ 3 roads, and 2-road bends only when the turn ≥ ~9.9° (`dot < −0.985` → null, :90-94).
- Roads sorted by angle; carriageway corner = intersection of facing edges (`lineHit` :116-125), trims = max corner distance + 1 m (junction) / +0.25 m (bend), clamped to L/2 − 0.5 with 'trimTooLong' warning (:129-137).
- Surface = polygon of trimmed end caps + carriageway corners; sidewalk corners = bands between caps and outer corners (:141-155); material of the widest road; crosswalks just outside each trim (junctions with markings) (:159-165).
Mesh (`roads/mesh.ts:209-248`): fan from the node centre; corner tops = fan from centroid at yAt + curb; crosswalk stripes. Bake (`bake.ts:263-287`): point-in-polygon, rank 0 at node elevation, corners rank 1 + curb.
Defects:
- **C** Missing curb faces on junction corners (only top triangles, `mesh.ts:225-233`) → open 0.15 m slit around every corner; segments' sidewalk ends also have no end faces (`mesh.ts:143-155`), nor do free road ends.
- **C** Height step at caps (see §3: crossFall·w + grade·trim); junction surface flat (no drainage crown).
- **C** Near-collinear 2-road nodes (turn < 9.9°): no patch, trims 0 → outer wedge gap up to (w+sidewalk)·tan(θ/2) ≈ 0.65 m for wide2, inner wedge overlap of two coplanar surface meshes with identical polygonOffset → z-fighting; bake leaves the outer wedge vertices natural (`endBeyond` `bake.ts:218-219,248-252`).
- **S** Fan triangulation assumes the polygon is star-shaped from the node; acute (< 20°, warned) junctions may produce overlapping fan triangles.
- No lane markings / stop lines inside junctions (only crosswalks). Colliders at junctions = heightfield (1 m), no separate collider.

---

## 8. WIDTH TRANSITION BUG (10 m → 7 m stair) — root cause and fix

**Repro (default world)**: `defaultTownRoads()` (`defaultTown.ts:48-53`) → nodes n1(−56,0), n2(56,0), n4(−23,0), n7(−23,46); segments s5 (n1→n4, wide), s6 (n4→n2, wide, L=79), s8 (n4→n7, street; T at n4). The default world itself has NO straight width joint. The stair appears when the user places the palette 2-lane road (`PlaceTool.tsx:116-120`) e.g. centre (66,0), yaw 0, length 20 → `placeRoadPiece('street')` → ends (56,0) snaps to n2, (76,0) → n9; new s10 (n2→n9, 7 m). Same with the road tool 'street' preset extending from n2.

**Where the joint is produced and why there is no taper (all C)**
1. `intersections.ts:90-94` — n2 has 2 collinear roads (dot = −1) → no intersection → `trim = 0` for both.
2. Mesh `mesh.ts:97-157` — each segment is extruded with CONSTANT offsets: carriageway `±p.width/2` (:107,129), sidewalk `w + p.sidewalkWidth` (:148), crown `fall·w` (:111), markings constant (:156-207). s6 ends at x=56 with |z|≤5 asphalt, sidewalks 5–7.5; s10 starts at x=56 with |z|≤3.5, sidewalks 3.5–5.5. No transverse faces → band 3.5<|z|<5 jumps from carriageway (y≈−0.07…−0.10) to sidewalk top (+0.08) with an open slit; band 5.5–7.5 (s6 sidewalk) ends in the air. Edge line jumps |z| 3.5 (shoulder rule `tw = w − shoulder`, :185-186) → 3.25 (no-shoulder rule `w − 0.25`, :203-206). Lane centres ±1.75 on both (continuous for wide2↔normal2; NOT for avenue4→normal2 (lane drop ±5.25) or →narrow2 (±1.5)).
3. Bake / collider `bake.ts:182-240` — constant `w`, `swL/swR` per segment (:197-199); each segment's claim is cut exactly at its end plane (`endBeyond` :218-219). Heightfield on flat ground: (56,±4) = −0.08, (56,±5) = −0.10 (s6 rank 0 beats s10 sidewalk rank 1), (57,±4/±5) = +0.08 (s10 sidewalk) → 0.16–0.18 m rise in one cell = the physical "stair"; ground type switches asphalt→concrete at x=57. Collider = this heightfield (`SimulationController.ts:146`).
4. Lane centres `crossSection.ts:43-49`, `city.ts:445,450`, `RoadRuntime.ts:114,128` — functions of ONE segment's profile only.
5. Root cause: width is a per-segment constant (`types.ts:29-48`); the node logic handles angle (bend patch) but never width; nothing reads the neighbour's profile at a degree-2 node; no warning.

**Proposed minimal design (derived at build time, no schema change)**
- New pure module (extend `roads/crossSection.ts`): `transitionsOf(net)` cached per network (WeakMap like `intersectionsOf`): for every degree-2 node WITHOUT an intersection whose two segments' sections differ (width, shoulder, median, per-side sidewalk width, curbHeight, lanes), one `Transition {node, host: segId (the wider), atStart, len, from: Section(narrow), to: Section(wide)}`.
- `sectionAt(net, seg, s)` → per-station section {wL, wR (carriageway half-widths), outerL/outerR (sidewalk outer), shoulderL/R, median, curb, laneCenters[], edgeLine offsets}. Outside a transition = today's values (bit-identical for every road without a width joint).
- Taper on the WIDER segment only (the narrow road keeps its nominal section; matches a shoulder/lane drop). Linear taper (straight edges, standard practice), each lateral offset interpolated independently (asymmetric sidewalks OK). Length rule: `len = clamp(max(6 m, 10·|Δcarriageway half-width|, 5·|Δouter edge|), …, 0.45·(L_host − trim at its other end))`; wide2→normal2: Δ=1.5 → 15 m (x 41…56). If clamped below the rule → warning `road.issue.shortTransition` (§29 "warn if too short"); if the host is shorter, split the taper over both segments (mean section at the node).
- Edge continuity: at the node the host's section == the neighbour's → curbs, sidewalk edges, crown (fall·w(s)) and sidewalk top (gutter + curb(s)) are C0; elevation already C0 (both profiles corrected to the node elevation, `bake.ts:96-100`).
- Lane centres: equal lane counts → interpolate `laneCenter` over the taper (continuous); lane drop (e.g. 4→2) → outer lanes end at the taper start (markings stop there, lane-centre list shrinks); centre/edge lines interpolate (3.5 → 3.25).
- Consumers to switch to `sectionAt`: `mesh.ts` (edge offsets per section; add sections at the taper start/end in `sections()` :90-95; markings), `bake.ts` claims (w, side widths from `hit.s`; reach R keeps the max width), `RoadRuntime` gutters/inlets, `city.ts` lanes/parking/frontage, `RoadTool` outlines (`edges()` :57-64, used :95), `RoadPanel` (show transition length).
- Dirty tracking (must, else stale meshes / bake): `RoadBatches` segment signature must include the neighbour section at transition ends (`RoadBatches.ts:98`); `dirtyRect` (`bake.ts:359-392`) and `roadInfluence` (`apply.ts:30-52`) must add the neighbour's taper zone across degree-2 transition nodes (today only intersection areas are added; a changed segment's own reach ≈14.5 m does not cover a 15–20 m taper).
- Collider: nothing new — the heightfield follows the bake (1 m grid precision).
- Save compatibility: no new fields, SCHEMA_VERSION stays 7. v7 files: load recomposes + re-bakes the whole map (`serialization.ts:400-409`) → taper appears; `recomposedVertices` > 0 for files with transitions (reported, harmless). **v6 files (no landscape)** keep the saved terrain (`serialization.ts:388-399`) → mesh would taper but heightfield keep the stair → re-bake transition rects on load for v6. Built-in templates/presets have no straight width joints (`templates/builtin.ts:95-141`, `landscape/presets.ts:77-143`, `roads/city.ts:578-584`) → golden worlds unchanged; only user networks change.
- Objects linked inside the taper zone keep their lateral (links do not move on width change) — default town objects are clear of a 15 m taper at x 41–56 (lights z −6.2, sign (42, 6.8), trees z ±8.6, cars x ≤ 32) — verified by arithmetic.
- Rejected alternative: explicit transition segment / profile `from→to` field — needs schema + migration, extra nodes, breaks `mergeAtNode` and links.

---

## 9. Vehicles on roads (Phase 35)

`simulation/vehicle/VehicleSystem.ts`:
- Contact: one ray per wheel against the Rapier world (`:124-153`, `castRay` :128) → hits the terrain HEIGHTFIELD (roads exist only there; legacy road objects have no collider `objects/definitions/road.ts:39`). Slope/normal = heightfield triangle normal from the hit.
- Friction: `tireMu(sampleGroundType(hit))` (`:138-142`, `vehicle/surface.ts:24-32`) — nearest-vertex ground type of the RUNTIME terrain (baked asphalt = id 3 → μ 0.9, concrete sidewalk 0.85, `vehicle/params.ts:82`); climate cover / water film modify it. Rapier contact friction is a uniform 0.9 (`TerrainPhysicsAdapter.ts:15`), modulated for bodies by `GroundContactSystem.ts:47`.
- Lane centre / heading: NOT read in the sim. Heading = body pose; autopilot = pure pursuit on a user point list (`VehicleSystem.ts:224-270`, `simulation/vehicle/control.ts:74-91`). No road-network query, RoadRuntime status (impassable/inundated) is not consulted.
- Placement: `vehiclesAlong` uses `laneCenter`/parking rule (`city.ts:425-465`); initial seat = 4-corner plane fit (`groundPlacement.ts:12,58-72`).
Defects: **C** curb ramps 0.5 m inside the visual curb on off-grid edges (§3); culvert openings are holes under a drawn deck (§3); **C** default-town truck at z = 4.3, width 2.5 overhangs the 5.0 m curb by 0.55 m (sedans by 0.1 m) (`defaultTown.ts:92-97`).

---

## 10. Defect list and save/migration risks

Confirmed (C):
1. Width-transition stair (mesh + heightfield + markings), no warning — §8.
2. Junction cap height step = crossFall·w + grade·trim (mesh and bake) — `mesh.ts:213-216`, `bake.ts:265-266`.
3. Missing curb faces at junction corners, sidewalk ends, free road ends — `mesh.ts:143-155,225-233`.
4. Near-collinear (<9.9°) 2-road joints: wedge gap (≤0.65 m) + coplanar overlap z-fight — `intersections.ts:90-94`.
5. Terrain pokes through the carriageway near curbs whose edge is between grid vertices (default side street s8) — §3.
6. Graded road segments do not drape on runtime deformation — `mesh.ts:106` + underlay.
7. Embankment river crossing: mesh profile ≠ baked profile; culvert: deck drawn over the physical hole.
8. During a stroke road mesh, objects, pins are stale; graded roads under the brush snap back on release (WYSIWYG gap).
9. No predicted-height / affected-area preview; square ring drawn as circle; paint core ≠ ring.
10. History bounded by count (100), not bytes; per-commit full-layer snapshots; EditorBatches full rebuild per terrain commit.
11. `sameProfile` asymmetric key compare → shoulders lost on merge (`network.ts:260`).
12. Hover snap label vs commit split mismatch (`RoadTool.tsx:33` vs `network.ts:167`).
13. Width change does not move road-linked objects (`links.ts:60-67`).
14. Placement pins / rings not re-draped after terrain edits (`PlacementLayer.tsx`, `GroundTools.tsx:86-96`).
15. `decodeUnderlay` rejects ground ids > 5 (`roads/schema.ts:87`) but ids go to 8 (rock 6, mud 7, riverbed 8, `GroundMaterials.ts:52-54`) → a road over rock/mud/riverbed (embankment crossing, painted rock) saves an underlay that reloads as `underlayLost`. v7 recomputes from layers (impact small); v6-style paths lose the natural ground under roads.
16. `rebakeAfterTerrainEdit` dead code (`roads/sync.ts:34`).
17. Curved connections are G0 only (kink at nodes).

Suspected (S): module-level `stroke` shared with scratch stores (§2); fan triangulation of non-star junction polygons (§7).

Save / migration (`world/serialization.ts`, SCHEMA_VERSION 7 `world/WorldDocument.ts:22`):
- Road profile/segment/node parsing STRIPS unknown keys (zod objects, `roads/schema.ts:16-40`) → any new road field (lanes, transition overrides, per-node width) must be added to the schema or it is lost on reload; old builds will drop it (forward compat). Ids must match `/^[ns]\d{1,9}$/` (`schema.ts:31`) — new entity kinds need the regex extended.
- v7 load = full recompose + re-bake with CURRENT code (`serialization.ts:400-409`) → any bake change silently changes the terrain of old saves (count in `recomposedVertices`); keep bake changes opt-in by geometry (transitions only) to keep golden/determinism tests stable.
- v6 (no landscape) load keeps the saved baked terrain; only dropped segments trigger `rebakeAll` (`serialization.ts:390-393`) → derived geometry changes need an explicit re-bake there.
- Migration chain v1–v5 → empty network; legacy road objects only converted on request (`roadActions.ts:257-291`).
- Underlay ground-id limit (#15) must be fixed before relying on underlays for new features.
