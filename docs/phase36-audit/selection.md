# Phase 36 audit — selection / transform / numeric / snap / align / groups / outliner / placement / blueprints / people+vehicles / property copy / presets / render scale

Base e69dde7, read-only. Refs are `file:line` under `src/`. **C** = confirmed by reading the code, **S** = suspected (needs a Chrome/runtime check).
World = 200 m square (`core/units.ts:12-13` WORLD_SIZE 200, WORLD_HALF 100); terrain 201×201 @ 1 m (`terrain/TerrainData.ts:11,22-37`), elevation −40…80 (`TerrainData.ts:13-14`).

---

## 1. Selection

**Storage** (`editor/editorStore.ts`): `selectedIds: EntityId[]` (every selected object) and `selectedId` (the primary: inspector, gizmo, F focus), `hoveredId` (36-40). `select(id)` sets one or none (136). `setSelection(ids, primary?)` dedupes; primary = the given one if it's in the list, otherwise the last id (137-141). Selection isn't in the undo history and isn't persisted.
Other, independent selection stores: building members `memberStore.selected` (`app/hotkeys.ts:26-48`), road segments/nodes `roadStore.selection` (`hotkeys.ts:96`), nature feature `natureStore.selected` (`editor/natureStore.ts:62`), disaster pins `placementStore.selected` (`hotkeys.ts:203`), blueprint library `blueprintStore.selectedId` (`blueprintStore.ts:67`).

| Feature | Status | Where |
|---|---|---|
| Single click | yes. Plain click selects the object **and its whole group** | `app/buildActions.ts:47-56`, `expandGroups` 34-41 |
| Shift+click | **toggle** (adds, or removes when the whole unit is already selected) | `buildActions.ts:50-54` |
| Alt+click | this member only, ignoring its group | `buildActions.ts:49` |
| Ctrl/Cmd+click toggle | **missing**: viewport mods are Shift/Alt only | `editor/EditorScene.tsx:34` |
| Marquee | Shift+left-drag only, **always adds** (no replace or subtract). The test point is the object's origin + half height projected to NDC. No occlusion or partial-overlap test | `editor/MarqueeSelect.tsx:17-32,60-66,90`, `boxSelect` `buildActions.ts:59-63` |
| Group select | via `expandGroups` (click / marquee) | above |
| Select all | Ctrl/⌘+A (also switches to the select tool) | `hotkeys.ts:294-300`, `selectAll` `buildActions.ts:65-68` |
| Select by category | Outliner chips (`ObjectCategory`, not exact type) | `ui/ObjectPalette/ObjectPalette.tsx:222-229` |
| Select same type as current | **missing** | — |
| Deselect | Esc (`hotkeys.ts:335`), click on empty ground unless Shift is held (`EditorScene.tsx:148-163`), Outliner "clear" chip | |

**Picking**: R3F events. Batched objects resolve through `EditorBatches.pick(object, batchId ?? instanceId)` (`EditorScene.tsx:110-130`); roads and the single selected object are React groups with their own handlers (54-71). The nearest intersection wins because `stopPropagation` runs on the first hit. **No cycling through overlapping objects** (Alt means "ignore group", not "next under cursor"). Hover is the nearest hit on every pointer move (118-123).
Only `tool === 'select'` is interactive (`EditorScene.tsx:177`). Arming a placement preset clears the selection (`editorStore.ts:128,132`).

**C**: objects already in a **multi**-selection can't be picked. `GroupSelection` turns off raycast on its adapter (`editor/GroupSelection.tsx:74`), and the batches hide those ids (`EditorScene.tsx:186-189`). Shift+click can't remove one object from a multi-selection in the viewport; a plain click on a selected object passes through to the ground and clears everything.
**C**: F focus calls `focusObject` → `select(id)` and collapses any multi-selection or group to the primary (`hotkeys.ts:252-255` → `app/actions.ts:43-52`). Outliner double-click does the same (`ObjectPalette.tsx:237`).
**C**: the selection isn't pruned after undo/redo/delete (no subscriber; `world/worldStore.ts:721-737`). Stale ids stay in `selectedIds`. Consumers filter them out (`buildActions.ts:28-31`, `GroupSelection.tsx:61`), but `selectedIds.length` drives inspector routing (`ui/Inspector/InspectorPanel.tsx:67`).

## 2. Transform gizmo

There is one gizmo implementation, drei `TransformControls`, wrapped by **`ManagedTransformControls`** (`editor/ManagedTransformControls.tsx:17-38`). The wrapper only disposes on unmount (the Phase 17 leak fix). `gizmoLifecycle.test.ts:26-38` fails if any file imports drei `TransformControls` directly. Three consumers:

| | `TransformGizmo` (single) | `GroupSelection` (multi) | `BuildingEditor` (members) |
|---|---|---|---|
| target | the selected object's scene node by name (`TransformGizmo.tsx:29-31`) | a proxy group at the pivot containing its own `SimRenderAdapter` of the selection (`GroupSelection.tsx:69-77,102-112`) | proxy (`BuildingEditor.tsx:263-276`) |
| space | translate = world, rotate/scale = local (`:72`) | always world (`:118`) | local |
| axes | rotate mode shows only the Y ring (`:73-74`); translate/scale use drei handles and planes | same (`:119-120`) | |
| snap | `translationSnap = gridStep(grid, 0)`. With grid 'auto' that's **always 0.5 m** (`:75`), while PlaceTool's auto is 1 m for objects ≥ 3 m. `rotationSnap = rotationStep` (5/15/45/90°), scale snap 0.1 (`:75-77`) | same (`:121-123`) | |
| commit | `checkpoint()` on mouse-down (always, **even without movement → empty undo step**, `:83`). Then `updateTransform(..., {history:false})` on **every** `objectChange` (`:56-64,91`): the doc is rewritten per pointer move. One undo step overall | nothing until mouse-up, then one `transformSelection` → `applyEdit` (`:88-98`, `buildActions.ts:103-109`) = one undo step | commit on mouse-up |
| ground | grounded objects are re-seated (height + tilt) unless the drag axis contains 'Y' (`:41-49`). **C**: the rotate ring's axis is 'Y', so rotating never re-tilts on slopes. Never below the seat height. Scale ≥ 0.1 (`:51-55`) | grounded objects re-seated per object (see §6) | |
| pivot | object origin | `selectionPivot` = x/z centre of the origins' bounds, y = lowest origin (`build/groupTransform.ts:29-39`) | |
| scale | free per axis, including modular buildings | uniform only: the axis furthest from 1, clamped 0.2–5 (`GroupSelection.tsx:90-92`). Modular buildings keep their size (`groupTransform.ts:57`) | |

Esc / restore: **none**. Esc while dragging runs `clearSelection` (`hotkeys.ts:335`) and unmounts the gizmo. The single gizmo keeps the partial move in the doc (undoable through the checkpoint). The group drag drops it.
**S**: `setDragging(true)` is set on mouse-down (`TransformGizmo.tsx:84`, `GroupSelection.tsx:126`) and only cleared in `onMouseUp`. If the gizmo unmounts mid-drag (Esc, Delete, tool switch), `dragging` probably stays true. Every click-select path checks `dragging` (`EditorScene.tsx:58,114,155`), so viewport click selection would stop working until a marquee or another gizmo drag. The same applies to window blur.
**C BUG**: `GroupSelection.commit` takes `dyaw = pivotObj.rotation.y` (`:94`). For a pure Y rotation of more than 90°, three's XYZ Euler gives (π, 180°−θ, π). Rotating a multi-selection by 120° commits 60°. Rotating by 180° commits 0, so nothing is committed (`:96`) while the proxy stays visually turned. The fix is to take the yaw from the quaternion (`terrain/groundPlacement.ts:118-121` `yawOf`).
**C**: the single gizmo stores the full Euler, so a 120° turn is saved as rotation (180°, 60°, 180°). The inspector then shows that triple (`ObjectInspector.tsx:66`). `core/math.ts:106-118` `eulerFromQuat` (used by `yawRotate` and `groundPose`) gives the same form. Code that reads `rotation[1]` as the yaw is wrong for such objects: `fire/outlook.ts:67`, `rendering/thermal/ThermalPreview.tsx:44`, `rendering/fire/FirePreview.tsx:34` (cross-area).

## 3. Numeric editing (Inspector)

`ui/Inspector/ObjectInspector.tsx:63-80` `TransformSection` (single object only):
- Position: `Vec3Field`, step 0.1, 2 decimals. **y is clamped to ≥ 0** (`:73`, **C bug** on terrain below 0, which goes down to −40). Typed x/z don't re-seat the object on the terrain (`worldStore.updateTransform` = patch + `releasePlinth`, `worldStore.ts:530-531`). **No world-bounds check.**
- Rotation: XYZ Euler in degrees, 1 decimal (`:66,74-75`). The label "Rotation (°)" is the only unit (`i18n/locales/en.ts:174`).
- Scale: 0.1–10 (`:76`). `Vec3Field` has **no unit prop** (`ui/common/fields.tsx:138-174`).
- Name: rename on blur (`:30-39`). Params and physics use `NumberField` with units and min/max (`:95-98,124-137`).
- **Missing**: height above ground, terrain align (`terrainAlign` has no UI anywhere; grep finds no `.tsx` reference), multi-object numeric edit (`MultiInspector.tsx` only has align, distribute and ±90° rotate, `:32-96`), units on position and scale.

Validation (`fields.tsx:60-107`): `parseFloat` (lenient: "1.5abc" → 1.5). Non-finite values are rejected and the text reverts (`:68-75`). min/max are clamped. Esc reverts the text (`:95-98`). ↑/↓ = ±step (×10 with Shift), one undo step per press (`:99-103`). Label scrub: `onScrubStart` → `checkpoint` on pointer-down **even without movement → empty undo step** (`:41-46`, `ObjectInspector.tsx:69`), then live writes with `history:false`.
Load path: the `vec3` schema is a tuple of `z.number()` (zod 4 rejects ±Inf/NaN) (`world/serialization.ts:27`); x/z aren't bounded on load.
Bounds checks: `isInsideWorld` (`editor/placement.ts:12-18`, OBB vs ±WORLD_HALF) is used only by PlaceTool, the bulk planner and blueprint placement. Blueprint placement also checks the anchor against the **terrain** extents (`blueprints/place.ts:181-182`). Not checked by: gizmo, group transform, inspector, paste, duplicate, align/distribute.

## 4. Snapping

Global toggle `snap` (default on, G key; `editorStore.ts:42,107,144`, `hotkeys.ts:366-368`, toolbar `ui/Viewport/ViewportToolbar.tsx:85`). `SnapSettings` (`editor/buildStore.ts:29-31,57-66`): grid auto|0.25|0.5|1|2|5, `rotationStep` 5/15/45/90, `surface`, `collisionWarning`. These settings persist in localStorage `ds.build`, not in the world file (`:165-168`). `gridStep` (`:187-190`).

| Snap | Exists | Where / notes |
|---|---|---|
| grid | yes, x/z | Place: `gridStep(grid, footprint)` (`tools/PlaceTool.tsx:82-83,106`). Paste: `gridStep(grid,3)` (`tools/PasteTool.tsx:26,50`). Line/Area: `gridStep(grid,1)` (`tools/BulkTools.tsx:161,280`); brush-mask areas aren't snapped (`:288`). Blueprint: ≥ 1 m (`app/blueprintActions.ts:260-264`). Gizmos: see §2 (0.5 m auto) |
| rotation step | yes | gizmo `rotationSnap`; T / Shift+T step for place, line and paste (`hotkeys.ts:359-364`); R = 90° (`:354-357`); bulk random-heading snap (`build/placementPlan.ts:121-124`) |
| ground / surface | yes | `groundPose` category rules (`terrain/groundPlacement.ts:37-73`); PlaceTool `surface` toggle (`PlaceTool.tsx:87-88`); gizmo re-seat; group re-seat |
| road node / centreline | Road tool only | `RoadTool.tsx:28-36`: node within 3 m > segment within 2 m (and ≤ half width + 0.5) > grid (`roads/network.ts:12-13`). Palette road pieces join ends (`PlaceTool.tsx:117-121` → `placeRoadPiece`). Blueprint road policy `snap`/`connect` plus connection hints (`blueprints/place.ts:287-366`). `alignToRoad` yaw within 60 m (`blueprintActions.ts:315-334`). City builder places along lanes and curbs (`roads/city.ts:425-465`) |
| building structural grid | Building Edit Mode only | `buildings/edit.ts:290-309` `snapToStructure` (1.5 m radius) |
| object centre / bounds / edge | **missing** | (blueprint `alignToObjects` = nearest object's yaw in 90° steps within 80 m, `blueprintActions.ts:337-354`) |
| building outline | **missing** | |
| priority / tolerance | only inside the Road tool (node > road > grid) | |
| visual indicator | ghost tint ghost/ghostWarn/ghostInvalid (`PlaceTool.tsx:137`), BuildHint warnings (`ui/Viewport/BuildOverlays.tsx:31-35`), road hover label (`RoadTool.tsx:344`), blueprint status colours. **No snap-target marker** | |
| hysteresis | **none** (only render LOD has hysteresis, `rendering/sim/SimRenderAdapter.ts:62,68`) | |

Dead code: `editor/placement.ts:5-9` `snapPoint` has no importers. Name clashes: `snapPoint` ×3 (`placement.ts`, `blueprintActions.ts:260`, `RoadTool.tsx:29`), `planPlacement` ×2 (`editor/build/placementPlan.ts:104` bulk, `blueprints/place.ts:173` blueprint), `footprintOf` ×2 (`build/footprint.ts:33`, `blueprints/place.ts:168`).

## 5. Alignment / distribution

These exist: `alignObjects` / `distributeObjects` (`build/groupTransform.ts:76-111`), actions `buildActions.ts:111-123` (one undo step each), UI `ui/Inspector/MultiInspector.tsx:32-39,79-89` (X/Z min/centre/max, distribute X/Z for ≥ 3 objects), and rotate ±90° about the pivot (`:90-96`).
Semantics: they work on **origins**, not bounds edges. Distribute spaces origins evenly between the first and last, not the gaps. Grounded objects are re-seated (`:103-111`).
Missing: bounds-edge align, align to primary or last-selected, Y/height align, "same rotation/height/size", gap distribution, snap during align. There are no constraints for road-linked objects (see §13, stale `roadLink`).

## 6. Groups

Data: `WorldObject.group?: string`, a plain id (`core/model.ts:88-92`); serialized as `z.string().min(1).max(80)` (`world/serialization.ts:53-54`). There is **no group table**: no name, nesting, pivot or lock.

| Op | Status | Where |
|---|---|---|
| create | Ctrl+G, new `grp_` id; members leave their old groups | `buildActions.ts:126-133`, `hotkeys.ts:301-306` |
| ungroup | Ctrl+Shift+G, only on the selected members | `buildActions.ts:135-146` |
| rename | **missing** | — |
| select | whole group on click / marquee; Alt selects one member | §1 |
| move / rotate / scale | `GroupSelection` → `transformObjects` | `GroupSelection.tsx`, `groupTransform.ts:52-74` |
| duplicate | multi or grouped → blueprint v1 round trip, fresh group ids, +2 m SE | `buildActions.ts:85-100`, `build/blueprint.ts:160-163` |
| delete | `applyEdit({remove})` | `buildActions.ts:76-82` |
| copy / paste | groups kept as new groups | `blueprint.ts:96-100,160-163` |

Child transforms are **not exact**. `transformObjects` (`groupTransform.ts:52-74`):
- Grounded objects (`dy === 0 && isGrounded`) are re-seated per object. On non-flat terrain their rotation is replaced by the ground pose (manual tilt is lost) and their height is resampled (`:64-70`).
- Lifted objects keep absolute y + dy, so stacked objects separate on slopes (**C**, by design).
- No floor clamp for dy < 0 (`:71`).
- Group scale scales the offsets but not modular-building size (`:57`).
- Rotation goes Euler → quaternion → Euler (`yawRotate`, `:42-46`), which adds float noise.

Also **C**: duplicating a single grouped member (Alt-select) goes through the blueprint path and creates a one-member group (`buildActions.ts:89`).

## 7. Outliner (ObjectPalette "Scene" tab)

`ObjectPalette.tsx:207-249`: a flat list of `<button>` rows sorted by type then serial. "select all" and per-category select chips, clear, Shift/Alt click (Shift = toggle, not range), double-click = focus (collapses the selection), group icon, sim-state dot (`useEntityStates`).
**Missing**: search, type **filter** (the chips select rather than filter), hierarchy (groups aren't nodes), rename (only in the Inspector), visibility, lock, range select, keyboard navigation, frame-selection-bounds, virtualization (all N rows render; the list re-sorts on every doc change, including each gizmo frame, `:214-217`).
Frame camera: `focusObject` sets distance to the max dimension × 2.6 (`actions.ts:43-52`). Multi-selection focus = pivot at a fixed 18 m (`MultiInspector.tsx:50` → `actions.ts:55-59`). No fit-to-bounds.
Schema: **no hidden or locked metadata** on objects (`core/model.ts:69-110`). The only `locked` is world-level, during simulation (`worldStore.ts:134-139`). `objectSchema` is a plain `z.object`, which strips unknown keys (`serialization.ts:41-60`; schema v7, `world/WorldDocument.ts:22`). New fields need schema entries, and older builds drop them, as `group` did (`serialization.ts:53` comment).
Reusable for editor-only hide: `SimRenderAdapter.setHidden` (`SimRenderAdapter.ts:1046-1060`) and the `EditorBatches.sync(objects, hide)` hide set (`rendering/editor/EditorBatches.ts:99-154`). That set is currently used for "selected → drawn elsewhere".

## 8. Placement tools

**Place** (`tools/PlaceTool.tsx`):
- Ghost = `StaticObjectView` in material mode ghost/warn/invalid (`:133-143`). Rotation via `ghostYaw` (R 90°, T step). Ground contact via `groundPose` or the cursor height (`:87-88`).
- Validity: outside the world is refused (`:84,113`). slope/floating/buried/overlap are **warnings only**, shown as a tint and in BuildHint (`:91-98`; `BuildOverlays.tsx:31-35`; reason keys `warn.*`).
- The bulk `align` option is ignored; no `terrainAlign` is written.
- Road connection only for palette road items (`:117-121`). Other objects get no `roadLink`. Each click is one undo step via `addObject`.
- Checks: `build/placementCheck.ts:29-61` (slope at the centre, corner gap/bury, FLOAT_TOLERANCE 0.3 m; **vehicles skipped** at `:38`); footprints `build/footprint.ts:25-31` (2D OBB, trees use 45 % of the crown, ground-layer roads ignored); `FootprintIndex` with 8 m cells (`:72-129`).

**Paste** (`tools/PasteTool.tsx`, `buildActions.ts:173-212`):
- Ctrl+V arms the clipboard (blueprint **v1**, `build/blueprint.ts`) as a ghost anchored at its bounds centre. R/T rotate, grid snap, road policy connect/isolate. Stays armed for repeated stamping.
- **C**: no collision or outside-world validation (`PasteTool.tsx:30` always `ok:true`; `pasteAt` `buildActions.ts:183-192`).
- **C perf**: the whole ghost is rebuilt on every grid-step move (`:28-31` + `tools/shared.tsx:97-121,73-91`). Blueprint mode avoids this with a rigid ghost (`tools/BlueprintTool.tsx:7-12`).

**Bulk** (`tools/BulkTools.tsx`). Each commit is one undo step through `commitPlan` (`buildActions.ts:217-236`).
- Brush: drag stamps, `BrushScatter` with min spacing, Esc cancels the stroke (`:48-118`; `build/distribution.ts:68`, max 400 draws per stamp).
- Line: click points, spacing, orient along/across/fixed, offset, both sides; Enter or re-click finishes, Backspace pops (`:122-203`).
- Area: rect, circle or painted mask, grid (spacing + jitter) or random (density + min spacing), preview then Apply/Enter (`:219-325`; `distribution.ts:282-324`, capped at 5000 points).
- Planner (`build/placementPlan.ts:104-156`): seeded per point, scale 0.5–2, align auto/upright/surface (writes `terrainAlign`, `:134`), slope limit, avoidCollisions. Reject reasons outside/slope/collision are summarized in `lastResult` (`ui/ObjectPalette/ToolOptions.tsx` LastResult).
- Bulk settings live in localStorage, not the doc.
- "Continuous click" = PlaceTool stays armed.

**Nature** (Terrain mode; `tools/NatureTool.tsx`, `app/natureActions.ts:220-281`). Feature params, including their seeds, are saved in `doc.landscape.features`. The forest brush (`planForest`) supports: conifer share, elevation band, slope limit, avoidance of filled lakes, rivers and sea, exclusion of the road footprint (0.2 m margin) and of other objects, density, spacing, seed.
**Missing**: ground-type/surface and soil filters, a road-distance parameter, water-distance as a parameter.
**C**: forest settings live in a non-persisted `natureStore` and are not saved (`natureStore.ts:54,71-82`). The RNG also mixes in a module-level `strokeIndex` (`natureActions.ts:224,229,259`), so the same stroke isn't reproducible across sessions.

**City builder** (Road panel → `app/roadActions.ts:179-240`, `roads/city.ts`): `buildingsAlong`, `infrastructureAlong`, `vehiclesAlong` (lane- or curb-aligned heading, parked or lanes, `city.ts:425-465`), `fillBlock`, `neighborhood`. All of them create a `roadLink` (default policy `follow`, `editor/roadStore.ts:65`).

**People / vehicles** (no dedicated tool; palette items + PlaceTool/Bulk/vehiclesAlong):
- Human: level and centred (`objects/definitions/human.ts:18`), height param 1–2.1 m (`:21`), footprint 0.5×0.3.
- Car: `terrainFit {align:1, base:'mean'}` (`definitions/car.ts:20`) → plane fit through the 4 footprint corners (`groundPlacement.ts:58-72`). There's no wheel-contact check and the slope/float check is skipped for vehicles (`placementCheck.ts:38`). Collision is 2D footprint only.
- Heading: `ghostYaw`, line orient, or the `vehiclesAlong` lane direction. There's no "align to road" for single placement.
- Sim spawn rules (keep as is), `simulation/RuntimeBuilder.ts:126-212`:
  - initial pose = doc transform verbatim (`:131,146`), no re-seat;
  - dynamic unless `physics.anchored` (`:135`); ground friction sampled at spawn (`:136`);
  - extended human only with `settings.simulation.humans` + `validateBody` (`human/anthropometry.ts:72-78`, 1.0–2.3 m, 20–250 kg), otherwise legacy, silently (`:191-197`);
  - vehicle dynamics only with `settings.simulation.vehicles` and a dynamic car (`:204-208`);
  - per-car config `vehicles.cars[objectId]` (`simulation/vehicle/state.ts:111`); a car without controls is parked in P with the handbrake on (`:113,123`);
  - occupants reference human ids; invalid ones → 'outside' (`RuntimeBuilder.ts:233-243`).
- There is no editor-mode UI for per-car config; the vehicle and human sections show only in sim (`InspectorPanel.tsx:72-74`).

## 9. Blueprints (Phase 20 unified, v2)

Files: `blueprints/{capture,place,library,schema,selection,types,builtin}.ts`, `app/blueprintActions.ts`, `tools/BlueprintTool.tsx`, `ui/Blueprints/BlueprintPanel.tsx`, session store `editor/blueprintStore.ts`.
- **Capture** (`blueprintActions.ts:177-237`): rect / polygon / current selection; include filters; road and nature boundary policies whole/inside/clip; name, description, category, tags; thumbnail. **Save** to the library (IndexedDB, `blueprints/library.ts`).
- **Place** (`blueprintActions.ts:241-384`, `place.ts:173-497`):
  - rigid ghost while hovering, exact ghosts when pinned (≤ 600 objects; colliding ones red, `BlueprintTool.tsx:37,215-227`);
  - R 90°, T step, `setPlacementYaw`, `alignToRoad`, `alignToObjects`; grid snap ≥ 1 m;
  - terrain policy preserve/offset/apply/blend, `terrainSnap` datum + `heightOffset` + `preserveRelative`, `addSeat` (seated after terrain and road changes, `world/worldStore.ts:219-238`);
  - road policy separate/connect/snap;
  - collisions are a **warning**, not an error (`place.ts:416,424`); blocking errors include outside, roadInvalid and roadRemoved;
  - confirm = one undo step; pinned is reset afterwards, so repeat placement works (`blueprintActions.ts:357-384`).
- **Rename / duplicate / delete / export / import** entries: `blueprintActions.ts:68-172`.
- **References after a copy**: groups get fresh ids per placement (`place.ts:405-408`); road links are re-measured on the placed network (`:409-414`); building designs are shared by key (`:400`; `capture.ts:268-299`); external road links are detached with a dependency warning (`capture.ts:341-345`); partial groups are warned (`capture.ts:321-322`). **Not captured**: `settings.simulation.vehicles.cars[id]` or occupants (no reference in capture/place).
- Duplication to resolve: clipboard/duplicate use blueprint **v1** (`build/blueprint.ts`, `BLUEPRINT_VERSION 1`) and the library uses **v2** (`blueprints/types.ts:36-38`). They share the format string. Only v2 has validation, terrain policy and a rigid ghost.

## 10. Property copy

**None** (no grep hits for copy/paste properties, match size, apply-to-selection). MultiInspector has no param or physics fields. The closest thing is member-level `setSelectedMaterial` / `setSelectedRole` inside Building Edit Mode (`app/buildingActions.ts:242-262`).
Building blocks to reuse: `applyParams` (keeps user-customized physics, `world/WorldDocument.ts:109-120`), `updatePhysics`, `updateSeismic`, `commitDesign` / `applySpec` (`buildingActions.ts:37,82`), and `applyEdit({update})` for one undo step.

## 11. World presets / new-world builders

| Builder | Where | UI |
|---|---|---|
| empty flat (+ structure v2) | `actions.ts:133-140` `newProject` → `createEmptyDocument` (`WorldDocument.ts:28-41`) | TopBar ⋯ "New" (`ui/TopBar/TopBar.tsx:96`) |
| default town (35.5: network roads + modular buildings) | `world/defaultTown.ts:48-105` via `loadSampleTown` (`actions.ts:280-291`); also the first-launch default (`:303-313`) | TopBar "Sample" (`TopBar.tsx:97`) |
| classic `sampleTown()` (goldens; don't touch) | `world/sampleScene.ts:23-77`, `loadClassicSampleTown` (`actions.ts:294-300`) | not in the UI |
| stress N | `world/stressScene.ts:23-63` | TopBar 100/500/1000 only (`TopBar.tsx:98-100`); devtools `buildLib.stressScene` (`app/devtools.ts:119`) |
| 8 world templates: emptyFlat, smallTown, denseCity, coastalCity, mountainVillage, riverValley, industrialDistrict, forestLake (seeded, deterministic ids) | `templates/builtin.ts:26-27`; `applyTemplate` new/replace (`blueprintActions.ts:414-446`) | Blueprints tab library, "world" filter (`BlueprintPanel.tsx:191`) |
| 6 environments: mountainValley, riverBasin, coastalPlain, forestedHills, lakeDistrict, mixedUrbanNatural (replace world, one undo step) | `landscape/presets.ts:27-28`, `natureActions.ts:286-308` | Terrain tab (`ui/Terrain/NatureSections.tsx`) |
| 5 terrain presets: flat, gentleHills, valley, coastal, lowland (base only) | `core/model.ts:307`, `worldStore.ts:687-692` | Terrain tab (`ui/Terrain/TerrainPanel.tsx:45`) |
| fire presets / celestial demos | `actions.ts` `loadFirePreset`, `loadCelestialDemo` | bottom panel tools |
| human / vehicle presets | `human/presets.ts`, `vehicle/presets.ts` | devtools only |
| **structure lab** | **none** | — |

**C**: `applyTemplate` 'replace' re-adds objects without ids, so they get fresh ids (`blueprintActions.ts:434` → `WorldDocument.ts:75,87`), while `settings` is copied verbatim (`:435`). Per-car `vehicles.cars[id]` and occupants then point at ids that no longer exist. 'new' mode keeps the ids.

## 12. Rendering at scale

- **Batching**: `EditorBatches` (`rendering/editor/EditorBatches.ts`) splits the world into hash chunks: 1→2→4→**8 max**, ~300 objects per chunk target (`:53-60`). Each chunk is a `SimRenderAdapter`: a BatchedMesh per material variant, facade InstancedMeshes, a crack mesh, and a `MemberLayer` for modular buildings (`SimRenderAdapter.ts:1-24,142-225`). An edit rebuilds only the stale chunks (`:99-149`). Selected ids are hidden in the batches.
- **Per-object React**: only legacy road objects and the single selected object (`EditorEntity`, `EditorScene.tsx:40-82,190-219`), plus `HoverBox` (`:136-146`). Multi-selection draws through `GroupSelection`'s own adapter.
- **Handlers**: one handler set on the batch root (`EditorScene.tsx:110-132`) plus per-road `EditorEntity` handlers. No per-mesh handlers.
- **Labels**: no per-object labels; the disaster pins use canvas sprites (`rendering/placement/PlacementLayer.tsx:37`).
- **Disposal**: adapters disposed (`SimRenderAdapter.ts:1114-1120`); `SelectionBox` geometry disposed (`rendering/SelectionBox.tsx:15-18`); `GroupSelection` edges disposed (`:66`); `DrapedLine` / `BrushRing` disposed (`shared.tsx:164-167,225-228`); gizmo disposed (§2).

Likely bottlenecks at 1000–5000 objects:
1. **C** Any terrain, road, landscape or water-level commit creates a new `doc.terrain` object (`worldStore.ts:307,478`). `samplerFor` is a WeakMap keyed by identity (`terrain/TerrainSampler.ts:283-293`), so `EditorBatches.setTerrain` sees a new sampler and **disposes every chunk** → full rebuild of all objects (`EditorScene.tsx:103-107`, `EditorBatches.ts:88-92`).
2. **C** A single-gizmo drag writes the doc on every pointer move (`TransformGizmo.tsx:56-64,91`). Each move costs: `EditorScene.live` O(N) (`:190-198`), `EditorBatches.sync` O(N) hashing and stale scans (`EditorBatches.ts:99-129`), the Outliner re-sort if open, and ~25 components subscribed to `doc.objects`, plus autosave debounce churn (`actions.ts:314-318`).
3. **C** Dragging a **modular building** (every default-town building) with the single gizmo rebuilds its whole `SimRenderAdapter` + `MemberLayer` per pointer move: the `ModularBuildingView` effect depends on `obj` identity (`rendering/views/ModularBuildingView.tsx:25-35`; `BuildingView.tsx:73`).
4. **C** Hover runs `onPointerMove` on the batch root (`EditorScene.tsx:118-123`) → R3F raycast → three `BatchedMesh.raycast` loops over **every instance** (`node_modules/three/src/objects/BatchedMesh.js:1389-1405`). Cost is O(all parts) per mouse move. `MemberLayer` culls by building bounds (`MemberLayer.ts:12-13,261-276`).
5. **C** Every multi-selection change and every group commit builds a second adapter of the selection, plus edges that allocate 8 `Vector3` per object (`GroupSelection.tsx:28-46,69-77`). Select-all at 5000 = a duplicate full build.
6. **C** The Outliner renders all N rows unvirtualized (`ObjectPalette.tsx:232-245`).
7. **C** Paste rebuilds its ghost per move (§8). Line re-plans per cursor move (`BulkTools.tsx:135-139`). The Area plan is computed twice (`BulkTools.tsx:259-262` and `BuildOverlays.tsx:49-55`), and each pass rebuilds `FootprintIndex.fromObjects` (`BulkTools.tsx:227`).
8. At 5000 objects each of the 8 chunks holds ~625 objects, so deselecting an edited object rebuilds a 625-object chunk (`EditorBatches.ts:121-149`).
9. `updateLodOnly` walks all views every frame (`SimRenderAdapter.ts:1062-1069`).

Existing benches to reuse: `scripts/bench-build.mjs` (place, select, group move, undo, save/load at 100–2000), `scripts/bench-selection-memory.mjs`, `scripts/bench-browser.mjs`.

## 13. Defects / gaps

Confirmed by reading (C):
1. Group rotation > 90° commits the wrong yaw; 180° commits nothing while the proxy stays turned (`GroupSelection.tsx:94-96`).
2. Moving a road-linked object (gizmo, inspector, group, align, distribute) keeps a **stale `roadLink`**. The next edit of that road with policy `follow` teleports the object back (`roads/links.ts:101-119`; no re-measure in `TransformGizmo`, `transformObjects` or `updateTransform`). `worldStore.duplicate` copies `roadLink` to the copy (`worldStore.ts:556`), so the copy jumps onto the original's spot on the next road edit.
3. Inspector clamps position y ≥ 0 even though terrain goes to −40 (`ObjectInspector.tsx:73`).
4. Inspector x/z, gizmo, group transform, paste, duplicate and align have no world-bounds check (§3).
5. Paste: no collision or outside checks; ghost rebuilt per move (§8).
6. Multi-selected objects can't be picked in the viewport (`GroupSelection.tsx:74`), so they can't be Shift-removed there.
7. F and Outliner double-click collapse a multi-selection or group (`actions.ts:46`).
8. Empty undo steps: gizmo mouse-down without movement (`TransformGizmo.tsx:83`) and label scrub without movement (`fields.tsx:45`).
9. The single-gizmo rotate never re-tilts grounded objects on slopes, because the rotate axis 'Y' is treated as a lift (`TransformGizmo.tsx:44-45`).
10. Gizmo 'auto' grid = 0.5 m vs Place 1 m for large objects (`TransformGizmo.tsx:75`, `GroupSelection.tsx:121`).
11. Scale policy is inconsistent: the single gizmo and inspector scale modular buildings; group scale doesn't (`groupTransform.ts:57`).
12. Rotation is stored as Euler with x = z = π for headings > 90°. The inspector shows (180, θ', 180), and `rotation[1]`-as-yaw consumers are wrong (`fire/outlook.ts:67`, `thermal/ThermalPreview.tsx:44`, `fire/FirePreview.tsx:34`).
13. Selection isn't pruned after undo/redo.
14. Per-object sim config keyed by id (`vehicles.cars`, occupants) is lost on duplicate, paste, blueprint and template-replace.
15. Forest settings aren't saved and the seed isn't reproducible (`natureActions.ts:224-259`).
16. PlaceTool ignores the `align` option and never sets `terrainAlign`; `terrainAlign` has no UI.
17. Full editor-batch rebuild on every terrain or road commit (§12.1).
18. Modular-building drag rebuilds its adapter per frame (§12.3).
19. Dead `editor/placement.ts` `snapPoint`; two blueprint formats (v1 clipboard vs v2 library).
20. Single duplicate of an Alt-selected group member creates a one-member group (`buildActions.ts:89`).

Suspected (S):
- `dragging` stuck true after the gizmo unmounts mid-drag (Esc, Delete, tool switch, blur), blocking click selection (§2).
- The group scale preview scales y about the pivot but the commit doesn't scale lifted y offsets (`GroupSelection.tsx:91-97` vs `groupTransform.ts:59-71`): preview and result differ for stacked objects.
- Human height × scale outside 1.0–2.3 m silently drops to the legacy human in extended-model runs (`RuntimeBuilder.ts:191-197`; no UI check).
- BatchedMesh hover raycast cost at 5000 objects (measure with bench-build).

Not present (must be built, reusing the pieces above):
- Ctrl/Cmd toggle; select same type; marquee replace/subtract; overlap cycling.
- Esc-cancel for the gizmo; world/local toggle; keyboard axis lock.
- Numeric multi-edit, height-above-ground and terrain-align fields with units.
- Object, bounds and outline snapping with markers and hysteresis.
- Bounds-based align and same-size/rotation tools.
- Group names / hierarchy / rename.
- Outliner search / filter / rename / hide / lock (+ schema).
- Property copy.
- Structure-lab preset.
- Per-car editor config.
