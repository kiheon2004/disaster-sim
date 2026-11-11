# Phase 36 pre-implementation audit: editor input, tools, camera, pointer, hotkeys, undo, autosave

Scope: read-only audit of the repo at e69dde7 (main). Paths are relative to `src/` unless they start with `node_modules/`.
Legend: **[C]** = confirmed by reading the code; **[S]** = suspected, or the trigger is conditional or not reachable from the UI today. Severity: H / M / L.

## 0. Event order on a left `pointerdown` over the canvas

1. **window, capture phase**: `PlacementLayer` (rendering/placement/PlacementLayer.tsx:227-231), plus `GroundPicker` (rendering/ground/GroundTools.tsx:192-196) and `DeformationPicker` (rendering/deformation/DeformationTools.tsx:93-96) while one of them is armed. Listeners on the same node and phase run in **registration order**. That order is not fixed: PlacementLayer re-registers whenever `running` changes (PlacementLayer.tsx:240). [C]
2. **canvas, capture phase**: `MarqueeSelect` (editor/MarqueeSelect.tsx:95). Only in the select tool, and only with Shift held.
3. **R3F event source, bubble phase**: R3F mesh handlers (GroundCatcher, the batch layer, handles), registered when the Canvas is created. After them come `OrbitControls` and three-stdlib `TransformControls`, which attach their own domElement listeners later.
4. **window, bubble phase**: each tool's `pointerup` / `blur` listener. `keydown` goes to `useEditorHotkeys` (app/hotkeys.ts:371).

`stopImmediatePropagation()` in step 1 hides the gesture from everything after it, including window bubble listeners.

## 1. EditorTool union: arming, input handler, temporary state, cleanup

The union is defined at editor/editorStore.ts:14. The scene picks the tool component at editor/EditorScene.tsx:221-233, and objects are only interactive when `tool === 'select'` (line 177).

| tool | armed by | viewport input | temporary state | when the tool is switched away |
|---|---|---|---|---|
| select | default; `setTool('select')`; V; Esc from place/brush/line/area (`armPlacement(null)`) | R3F `onClick`/`onPointerMove` on `EditorBatchLayer` primitive and `EditorEntity` groups (EditorScene.tsx:54-71,110-132); `GroundDeselect` plane `onClick` (149-163); MarqueeSelect (DOM canvas capture + window move/up); gizmo = drei TransformControls (three-stdlib domElement `pointerdown`, document `pointermove`/`pointerup`) in TransformGizmo / GroupSelection | `hoveredId`, `dragging` (editorStore), marquee closure, `document.body.style.cursor` | marquee box removed and `enabled=true` set (MarqueeSelect.tsx:98-104); gizmo disposed (ManagedTransformControls.tsx:33-36) **without aborting a drag** (§3) |
| place | `armPlacement(id)` from a palette click (editorStore.ts:125-130); P | `GroundCatcher` (editor/tools/shared.tsx:49-70: invisible plane at y=-60, R3F `onPointerMove`/`onClick`), PlaceTool.tsx:135 | local `pos`/`variant`; `useGhostWarnings` singleton (cleared on unmount, line 61) | unmount clears it |
| brush | B / mini tool (`setTool`) | GroundCatcher `onDown`/`onMove`, plus window `pointerup`, `blur` and capture-phase `keydown` (BulkTools.tsx:67-79) | `stroke` ref, plan state | unmount cancels the stroke (`end(false)`) and calls `unlock` |
| line | L | GroundCatcher `onClick`/`onMove`, plus window capture `keydown` for Enter / Backspace (BulkTools.tsx:141-158) | **`buildStore.lineSession.points` (store)** | the points **persist** |
| area | A | GroundCatcher `onDown`/`onMove`, plus window `pointerup` (BulkTools.tsx:264-277,301-319) | **`buildStore.areaSession` (store)**, `drag` ref | the session **persists**; unmount calls `up()` (unlock) |
| paste | Ctrl+V → `startPaste` (app/buildActions.ts:173-179) | GroundCatcher `onClick` (PasteTool.tsx:54-66) | local `at`; clipboard and `pasteYaw` live in buildStore | — |
| terrain | `setTerrainTool(id)` (ObjectPalette Terrain tab, NatureSections) | brush/inspect tools: TerrainTool's own plane (TerrainTool.tsx:170) with `onPointerDown`/`Move`/`Out`, a `useFrame` dab loop, window `pointerup`/`blur` (77-92). Feature tools: NatureTool GroundCatcher, handle meshes `onPointerDown` (166-171), window `pointerup` (46-66) | TerrainTool `held` ref + **module-level `stroke`** (world/worldStore.ts:85); NatureTool forest refs and `drag` state; **`natureStore.draft`/`selected` (store)**; `natureActions.scatter` (module) | TerrainTool unmount **commits** the stroke. NatureTool unmount has **no cleanup** (no commit, no unlock). Store draft **persists** |
| building | `enterBuildingEdit` → `setBuildingEdit` (app/buildingActions.ts:157-161) | BuildingEditor adapter primitive and hidden ground plane, R3F `onClick`/`onPointerMove` (BuildingEditor.tsx:162-166); MemberGizmo (ManagedTransformControls, 263-277) | `memberStore` (selection, adding, preview) | `memberStore.reset()` runs only in enter/exitBuildingEdit (buildingActions.ts:159,165). Leaving through `setTool` / `armPlacement` / V-P-B-L-A **keeps member state** |
| road | `setRoadEdit(true)` (Roads tab, RoadPanel) | GroundCatcher `onMove`/`onClick`/`onDoubleClick`; handle meshes `onPointerDown` (RoadTool.tsx:375-380); window `pointerup` (155-170) | **`roadStore` mode/draft/selection/hood/block (store)**; local `drag` | store state **persists**; unmount mid-drag leaves the lock (§2) |
| blueprint | `setBlueprintTool(true)` from startCapture/startPlacement (app/blueprintActions.ts:175-189,240-249) | CaptureTool GroundCatcher + window `pointerup` (BlueprintTool.tsx:60-109); PlaceTool GroundCatcher + `EnterToConfirm` window `keydown` (232-253,282-295) | **`blueprintStore` mode/capture/place (store)** | only `backToLibrary` (blueprintActions.ts:60-66) clears the session. A tab switch only calls `setBlueprintTool(false)` (ui/ObjectPalette/ObjectPalette.tsx:45), so the session **persists** |

- **[C][L]** The doc comment at editorStore.ts:12 says "Switching tools ends the previous tool's session". In the code, the setters only change `tool`, `placeItemId`, the selection and `buildingId` (editorStore.ts:124-166). Component-local state ends because the component unmounts; state kept in stores does not. `buildStore.clearSessions` runs only in `enterSimulation` (app/actions.ts:329). All window listeners are removed in effect cleanups. Camera locks are not always released (§2).

### How disaster placement (PlacementLayer) coexists with the editor tools

- It is mounted in both scenes: EditorScene.tsx:209 and rendering/sim/SimulationScene.tsx:116.
- **When armed** (`st.type`), it consumes **every** left `pointerdown` whose target is the canvas: `stopImmediatePropagation` + `preventDefault`, then `placeAt` (PlacementLayer.tsx:192-198). There is no drag threshold, so orbiting with a left-drag is impossible while armed.
- **When not armed**, it hit-tests pins: within 14 px of the pin head *or foot* in screen space, ignoring occlusion (153-166). It tests against `placed`, which is non-empty whenever `showPlaced = armed || selected || drag || (rightOpen && tab==='phenomena')` (121).
  - On a hit it calls `select` and `setRightTab('phenomena')`.
  - A running instance stops there: the click goes on to the world (35.5 fix).
  - Otherwise it consumes the event, starts a drag and takes the lock (200-211).
- `consumed` is set on `pointerdown`. It swallows the matching `pointerup`/`click`/`dblclick` on the canvas and is reset only by the next `pointerdown` (189, 222-226).
- `pointermove` is never consumed. The editor tools' hover previews (PlaceTool ghost, brush ring, road snap label, batch hover highlight and body cursor) keep running under the disaster crosshair. **[C][L]**
- **Who wins**: disaster placement beats every editor tool, the gizmo handles and OrbitControls. Against the ground/deform pickers it depends on registration order (§0). `armPlacement` cancels the pickers (app/placementActions.ts:44-45), but arming a picker does **not** disarm placement. **[C][L]**
- **No mutual disarm [C][M]:**
  - Disaster `armPlacement` never touches editorStore.
  - Editor `armPlacement` / `setTool` / `setTerrainTool` / `setRoadEdit` / ... never touch placementStore.
  - Placement is disarmed only by Esc (hotkeys.ts:202), the PlacementBar Done button, or a non-continuous `placeAt` (placementActions.ts:76).
  - Closing the right panel unmounts PlacementBar (ui/Phenomena/RightPanel.tsx:88; app/AppLayout.tsx:28) while placement **stays armed** with no visible bar.
- **Sticky `placementStore.selected` [C][H]:**
  - Set by a pin click, `placeAt` (placementActions.ts:73) and `duplicate`.
  - Cleared only by Esc (hotkeys.ts:203), delete or undo-remove (placementActions.ts:128,166), or the ExperimentPanel toggle (ui/BottomPanel/ExperimentPanel.tsx:90).
  - A click that misses every pin (PlacementLayer.tsx:200-201) or an editor `clickSelect` does not clear it.
  - While it is set, pins stay hit-testable in every tool, and Esc/Delete/Backspace are routed to the disaster (§4).

## 2. Camera control and locks

- There is a single drei `<OrbitControls makeDefault>` (rendering/CameraRig.tsx:63-73): LEFT rotate, MIDDLE dolly, RIGHT pan. No CameraControls. Focus requests animate the target (23-41).
- Nothing reference-counts locks, there is no registry, and nothing resets locks on a mode switch. Every writer of `controls.enabled`:

| writer | lock | release | ownership |
|---|---|---|---|
| `useOrbitLock` (editor/tools/shared.tsx:37-46), used by BrushTool (BulkTools.tsx:105/62), AreaTool (309/268), Road handles (RoadTool.tsx:378/160), Nature forest and handles (NatureTool.tsx:131,169/50,60), Blueprint CaptureTool (BlueprintTool.tsx:87/63) | `enabled=false` | `enabled=true` | **none, unconditional** |
| TerrainTool.tsx:159 / 83 | direct `false` | direct `true` | none |
| MarqueeSelect.tsx:65 / 85 / 103 | any Shift+left press | on pointerup **and on unmount** | none |
| drei TransformControls, `dragging-changed` (node_modules/@react-three/drei/core/TransformControls.js:52); used by TransformGizmo, GroupSelection, MemberGizmo | `!value` | `!value` | **none, unconditional** |
| PlacementLayer.tsx:172-177 | only if currently enabled | only if it took the lock | **owned** (35.5) |

- **Paths where one owner releases another's lock [C][L]:** drei `dragging-changed(false)`, marquee `up`/unmount, and every `useOrbitLock.unlock` force `enabled=true`. Today this is mostly masked, because each locker also swallows the `pointerdown` OrbitControls would need. But nothing guarantees it.
- **Stuck locks: the lock is never released [C]:**
  - (a) **[H]** A gizmo or member gizmo unmounts mid-drag (§3).
    - three-stdlib `detach` does not reset `dragging` (node_modules/three-stdlib/controls/TransformControls.js:85-90).
    - `dispose` removes the pointerup listener (400-405).
    - drei's effect cleanup removes the `dragging-changed` callback (TransformControls.js:54).
    - Result: **OrbitControls stays disabled and `editorStore.dragging` stays `true`.** That flag is only reset in `onMouseUp` (TransformGizmo.tsx:86-90; GroupSelection.tsx:128-131; BuildingEditor.tsx:271-275). While it is true, `EditorScene.tsx:58,114,155` and `BuildingEditor.tsx:128` ignore every click.
    - Recovery: only a completed marquee (Shift+drag) or another gizmo drag. Leaving the select tool re-enables orbit through the marquee unmount, but `dragging` stays stuck. `setMode` does not reset `dragging` (editorStore.ts:124).
  - (b) **[M]** RoadTool, NatureTool or Blueprint CaptureTool unmounts mid-drag. Their effect cleanup only removes the listener (RoadTool.tsx:168-169; NatureTool.tsx:64-65; BlueprintTool.tsx:71-72).
    - Triggers: a second Esc during a road-handle drag (`roadKeys` → `setRoadEdit(false)`, hotkeys.ts:94-98); Esc during forest painting (`natureKeys` returns false, then `setTerrainTool(null)`, hotkeys.ts:330); Esc during a capture-rectangle drag (`backToLibrary`, hotkeys.ts:166-168).
  - (c) **[L]** Area tool: Esc clears the shape (hotkeys.ts:332), but the `drag` ref and the lock live on. The next moves recreate the shape until pointerup.
- **PlacementLayer drops its own drag [C][M]:**
  - The listener effect depends on `[gl, camera, controls, running]` (240).
  - `running` is a new Map every time `simStore.events` changes (122). That happens on each scheduler revision (simulation/SimulationController.ts:711-724).
  - When that happens mid pin-drag (simulation mode, another event changes status):
    - The cleanup calls `lock(false)`, so the camera unlocks mid-drag.
    - The new closure has `dragStart=null`, so pointerup clears the drag and **never calls `moveInstance`** (219).
  - A scene switch has the same effect.

## 3. Pointer lifecycle

Global facts **[C]**:
- **No `pointercancel` listener anywhere in src.** OrbitControls has its own (three-stdlib OrbitControls.js:303).
- `visibilitychange` is handled only in ui/Inspector/VehicleControls.tsx:86.
- `blur` is handled only in TerrainTool.tsx:86 and BulkTools.tsx:72.
- On `pointercancel`, R3F calls `cancelPointer` → `onPointerOut` (@react-three/fiber events, `case 'onPointerCancel'`). That clears the tools' cursor refs, but `held`/`stroke` stay set. Sculpting and scattering resume **with no button pressed** once the pointer is back over the ground, until some pointerup.
- A mouse release outside the browser window still reaches the window/document `pointerup` (implicit capture), so "pointer leaves the window" is covered for every tool that uses window pointerup.
- Simulation start mid-drag: no UI path today. Space starts the simulation only in simulation mode, and buttons need the mouse. If it happened, it would follow the unmount column (EditorScene unmounts, ui/Viewport/ViewportContainer.tsx:54).

Column key: **blur** = window blur or tab switch; **cancel** = `pointercancel`; **deleted** = the dragged target is deleted mid-drag; **panel** = right panel closed.

| interaction | Esc mid-drag | blur | cancel | unmount | deleted | panel |
|---|---|---|---|---|---|---|
| Single gizmo | `clearSelection` (hotkeys.ts:335) unmounts it → **stuck orbit + dragging** (§2a). The doc keeps the partial transform, written with `history:false` on every objectChange (TransformGizmo.tsx:56-64,91); the checkpoint (83) lets Ctrl+Z recover it | not handled; drag continues on the next move without a button | not handled | stuck | Delete → `deleteSelection` → unmount → stuck. Ctrl+Z, Ctrl+A (`selectAll` → multi → unmount) and V/P/B/L/A also work mid-drag | n/a |
| Group gizmo | same stuck flags; doc untouched (commit happens only on mouseUp, GroupSelection.tsx:88-98) | no | no | stuck | same | n/a |
| Member gizmo | `buildingKeys` Esc → `select([])` (hotkeys.ts:46-48) → unmount → stuck | no | no | stuck | Delete → `deleteSelectedMembers` → unmount → stuck | n/a |
| Marquee | **ignored**: the box keeps going and selects on up | no (`start` stays; orbit stays disabled) | no | OK | n/a | n/a |
| Terrain stroke | `setTerrainTool(null)` → unmount → `endStroke` **commits**, does not cancel (TerrainTool.tsx:90) | commits | ghost sculpting (above) | commits | n/a | n/a |
| Brush scatter | own capture handler cancels (BulkTools.tsx:69) **and** the hotkey Esc then exits the brush tool (hotkeys.ts:333) | **commits** (`up` = `end(true)`) | ghost scatter | cancels | n/a | n/a |
| Area | shape cleared, drag and lock live on (§2c) | no | no | OK | n/a | n/a |
| Line / place / paste | click-based; Esc clears points or leaves the tool | — | — | — | — | — |
| Road node/control drag | 1st Esc clears the selection; the drag continues and commits on up. 2nd Esc leaves road mode → **stuck lock, move dropped** | no | no | stuck lock | Delete/Backspace deletes the segments; the pointerup move throws and is swallowed (RoadTool.tsx:161-166) | n/a |
| Nature forest paint | Esc leaves the tool → **stroke silently dropped, lock stuck** | no | no | dropped + stuck | n/a | n/a |
| Nature handle drag | Esc deselects (handles vanish); still commits on up | no | no | stuck lock | n/a | n/a |
| Blueprint capture rect | `backToLibrary` → unmount → stuck lock | no | no | stuck lock | n/a | n/a |
| **Disaster pin drag** | only deselects the pin (hotkeys.ts:203); **no cancel path**, commits on up | **no button check in `onMove` (PlacementLayer.tsx:178-184): the pin follows the cursor until the next pointerup anywhere** | no | lock released, store `drag` orphaned, move dropped (§2) | Delete → `deleteInstance(selected)`; `moveInstance` later returns false (harmless) | drag unaffected; armed mode stays armed but hidden |

Other lifecycle notes:
- **[C][L]** Unmounting while hovered leaves `document.body.style.cursor` as pointer/grab (EditorScene.tsx:64-68; RoadTool.tsx:382-383).
- **[S]** On sim start, `setMode` runs `setLocked(true)` synchronously, and the TerrainTool unmount happens later. `endTerrainStroke` → `commitTerrain` has no `locked` check (worldStore.ts:274-292, 681-685).

## 4. Hotkeys

- There is one global handler, `useEditorHotkeys` (app/hotkeys.ts:232-374): window `keydown` in the bubble phase, mounted in App.tsx:11.
- Other `keydown` listeners:
  - LineTool (capture, BulkTools.tsx:156) and BrushTool Esc (capture, 71).
  - EnterToConfirm (BlueprintTool.tsx:292), GroundPicker (GroundTools.tsx:197), DeformationPicker (DeformationTools.tsx:97).
  - The Blueprint Modal: capture + `stopPropagation` on Esc only (ui/Blueprints/BlueprintDialogs.tsx:37-41).
  - HelpDialog (38), ResultsPanel (84), VehicleControls (83).
- **Focus guard**: `isTyping` (hotkeys.ts:69-74) checks INPUT / TEXTAREA / SELECT / contentEditable on `e.target`, and runs first. `hasTextSelection` keeps Ctrl+C / Ctrl+A for the browser when text is selected.
  - LineTool and EnterToConfirm have their own guard, which misses contentEditable.
  - **The pickers have no guard at all.**

### Key map, in precedence order

1. **`placementKeys`** (both modes, hotkeys.ts:199-221):
   - Esc: disarm if armed, else deselect the pin.
   - Del/Backspace (no modifier, a pin selected, not armed): `deleteInstance`.
   - Ctrl/⌘+Z and Ctrl/⌘+Shift+Z: placement undo/redo **iff** `(armed || rightTab==='phenomena')` and that stack is non-empty.
2. Shift+P: perf HUD. F: focus the selected object (any mode).
3. **Simulation mode**: Space play/pause (`e.code`), Esc deselect, Ctrl+C copy. Nothing else.
4. **Editor mode**: Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y → world undo/redo (266-276). These run before the tool-specific keys, so they also apply mid-drag and inside every tool.
5. `building` (`buildingKeys`, 25-67): Ctrl+D, Ctrl+A, Del/Bksp, Esc (adding → selection → exit), W/E gizmo, R rotate the added member, X x-ray, H load path.
6. Ctrl+D duplicate, Ctrl+C copy, Ctrl+V paste, Ctrl+A select all (also switches to select), Ctrl+G group, Ctrl+Shift+G ungroup.
7. `[` / `]` brush radius (terrain, brush, area-brush); Shift = ±5.
8. terrain `natureKeys`: Enter, Backspace, Esc, Delete. Road `roadKeys`: Enter, Esc chain, Backspace, Delete. Blueprint `blueprintKeys`: capture Enter/Backspace/Esc; place R/T (Shift = reverse), Esc, Enter.
9. `TOOL_KEYS` V/P/B/L/A (224) — everywhere except terrain/road/blueprint, so **also in building and paste**.
10. Remaining keys:
    - Esc: terrain exit / line clear / area clear / disarm the placement tool / paste → select / `clearSelection`.
    - Enter: area apply. Del/Bksp: delete (select tool only).
    - W/E/R: transform mode (R rotates the ghost/paste in place/line/paste). T: fine rotate. G: snap toggle.

### Conflicts and defects

- **[C][M]** Shift+`[` / Shift+`]` never fire. The handler compares `e.key` with `'['`/`']'` (310), but Shift produces `'{'`/`'}'`.
- **[C][H]** The sticky pin selection hijacks Delete, Backspace and Esc. Example: select a pin, then a building, then press Delete — the **disaster** is deleted and the building stays. In road mode, Backspace (meant to pop a draft point) deletes the disaster; Esc only deselects the pin. LineTool's Backspace is safe because it is capture-phase with `stopImmediatePropagation`.
- **[C][M]** Undo is routed by UI tab, not by which edit came last (211-219):
  - On the Disasters tab, Ctrl+Z undoes placements even when the latest edit was to the world.
  - With an empty placement stack it silently falls through to world undo.
  - Ctrl+Y always redoes the world (272), while Ctrl+Shift+Z may redo a placement: the two redo keys disagree.
- **[C][L]** One Esc press acts twice: BrushTool cancel + tool exit; picker cancel + hotkey Esc (clear selection / exit tool / disarm); Help/Results close + hotkey Esc.
- **[C][M]** GroundPicker polygon mode calls `preventDefault` on Backspace with no typing guard (GroundTools.tsx:185-190). While a polygon pick is active, Backspace in any text field is swallowed.
- **[C][L]** Hotkeys stay live under Help, Results and Comparison: Delete, Ctrl+Z and V... act on the world behind the dialog.
- **[C][L]** V/P/B/L/A leaves Building Edit without `memberStore.reset()`.
- **[C][M]** No hotkey is blocked during drags (§3).
- **[S][M]** Letter keys use `e.key` (only Space uses `e.code`) and there is no `isComposing` check. With the Korean IME in Hangul mode, `e.key` can be a jamo or `'Process'`, so the shortcuts may not fire.
- No Ctrl+S binding, so the browser's "Save page" opens.

## 5. Undo / redo and transactions

### World history (world/worldStore.ts)

- **Entry format** (45-57) — patches and references, not whole-document copies:
  - `objects`: a map reference. Edits are immutable and each commit makes one shallow `{...objects}` copy.
  - `roads`: a reference. `landscape`: the features reference and `next`.
  - `terrain`: a `TerrainPatch` covering only the edited rectangle, before and after: heights (f32), ground and soil (u8), settings (terrain/TerrainData.ts:139-155).
  - `LayerPatch` with each layer's rectangle before and after (landscape/apply.ts:106-111).
  - Optional `config` with `{settings, scenario}`, used only by `applyEdit` with settings or scenario.
- **Cap**: `HISTORY_LIMIT = 100` entries (37), counted per entry, not per byte. Full-grid operations (terrain preset, base replace, coast water level → `fullGridRect`) store full-grid patches: roughly 0.5 MB of terrain patch plus layer arrays per entry at 201² **[S estimate]**.
- **Undo/redo** (721-737) swap objects, roads and features, and apply patches in place. They are refused while a stroke is live or the store is locked (724). **Selection is not part of history.**

### Which operations push history

| operation | history |
|---|---|
| create (place / commitPlan brush, line, area; paste per click; forest at stroke end; blueprint confirm) | 1 step each (`applyEdit`) |
| delete, duplicate, group/ungroup, align/distribute | 1 step |
| single gizmo move/rotate/scale | `checkpoint` on mouseDown + `history:false` writes = 1 step. **[C][L]** A click with no movement still pushes an empty step and clears redo |
| group gizmo | 1 step on release (`transformSelection`), skipped when the delta is about 0 |
| inspector numeric fields | scrub pattern: `checkpoint` + live `history:false` (ui/Inspector/ObjectInspector.tsx:67-69,87,97) |
| terrain brush stroke | `beginTerrainStroke` copies the **full** heights, ground and soil arrays (snapshotLayers, TerrainData.ts:166-168); the slope tool copies heights again (TerrainTool.tsx:163). Dabs edit in place. `endTerrainStroke` → `commitTerrain` folds the change into sculpt/paint, recomposes, and pushes **1 rect patch** (274-312). Undo is blocked during the stroke |
| road edits, including handle drag | 1 step on release. **[C][L]** The roads branch always pushes (474-483), so clicking a node handle without moving still adds a step |
| nature features | 1 step (landscape edit) |
| building members | 1 step (`applyEdit` update, app/buildingActions.ts) |
| templates | 1 step with `config` |
| **no history** | `updateSimulationSettings` (settings tab), `setProjectName`, `setExperiment` (all disaster/experiment edits), `setEarthquakeScenario`, `setFloodScenario`. `replaceDocument` / `newDocument` / presets clear past and future |

### Placement history (ui/placement/placementStore.ts:53-54,99; app/placementActions.ts)

- Ops are add / remove / move, holding full instance or spec snapshots. Cap 100 (`slice(-99)`). Cleared only in `runInstance` (97).
- **[C][M]** It is **not cleared on load / new / template**. Instance ids reuse the lowest free `p${n}` (phenomena/schedule.ts:93-98). So after loading a project, Ctrl+Z on the Disasters tab can remove or move *that* project's `p1`.
- **[C][M]** ExperimentPanel edits (`updatePhenomenon`, `removePhenomenon`) are not recorded. Undo/redo then re-applies stale `op.inst` / `op.from` snapshots and discards those later edits (150-171).
- **[C][L]** Undoing a `remove` whose id has been reused returns false without popping the op or showing a toast (181-183). That op stays on top and blocks every older placement undo.
- **[C][M]** World undo or redo of a `config` entry replaces `doc.scenario` wholesale (travel, 320). This adds or removes disaster instances without placementStore knowing.

### Ctrl+Z routing, gizmo granularity, stale selection

- Ctrl+Z routing is covered in §4. A gizmo drag is one entry. A terrain stroke is one entry (begin = full snapshot, end = rect patch).
- **Stale selection [C][L]:**
  - Nothing prunes the selection on undo/redo; the only store subscriptions are app/actions.ts:304 and 314.
  - Undoing a multi-object add/paste leaves `selectedIds` pointing at deleted ids, and `multi` is computed from the id count. GroupSelection then mounts with **zero objects at pivot (0,0,0)** (editor/build/groupTransform.ts:30), giving a phantom gizmo at the origin. Dragging it is a no-op (buildActions.ts:105-106).
  - roadStore, natureStore and memberStore filter missing ids at render time. `placementStore.selected` can point at a removed instance.
- **Gizmo + Ctrl+Z mid-drag [C][L]:** `world.undo` has no drag guard. The object snaps back, the next move overwrites it again with `history:false`, and `future` keeps a mid-drag entry.
- **[C shared state][S trigger]** The module-level `stroke` (worldStore.ts:85) is shared by the app store and every `scratchWorld` store (templates/builtin.ts:90; blueprints/builtin.ts:62).
  - A scratch store's `replaceDocument` / `newDocument` sets `stroke = null` (635, 645).
  - If a template or blueprint is built during a user's stroke, the stroke is never committed: heights are edited in place but never folded into the layers, and no undo step is pushed.
  - Builds are user-initiated today. Any background build added in Phase 36 would hit this.

## 6. Autosave and persistence

- **Location**: `bootstrapWorld` (app/actions.ts:303-319) runs at the import of App.tsx:8, outside React.
  - The world goes to localStorage `ds.autosave`; the manual save slot is `ds.project` (world/serialization.ts:418-449).
  - Only the blueprint library uses IndexedDB (blueprints/library.ts:77).
- **Trigger**: `useWorldStore.subscribe` on any `doc` identity change, debounced 800 ms (trailing `setTimeout`, actions.ts:314-318). Each save serializes the whole document (`toSerializable` also runs `adoptTerrain`, which slices the full arrays).
- **Size and quota**: there is no size check. `safeSet` swallows exceptions (serialization.ts:421-428), and the `storage.autosave` return value is ignored. **Quota failures are silent: no toast, no retry. [C][M]** All `ds.*` keys share the ~5 MB origin limit **[S]**.
- **Reload / tab close**: there is no `beforeunload` / `pagehide` / `visibilitychange` flush. **Up to the last 800 ms of edits is lost on tab close. [C][M]**
- **Migration or parse failure [C][H]:**
  - The schema accepts `schemaVersion` 1–7 only (serialization.ts:122); `SCHEMA_VERSION = 7` (world/WorldDocument.ts:22).
  - If the autosave fails to parse, the app **silently** loads the sample town (actions.ts:307-312). There is no toast and no backup.
  - **The first edit then overwrites `ds.autosave`, so the user's world is lost.** This matters if Phase 36 bumps the schema or ships a parser bug.
  - **[S]** Exceptions thrown after `safeParse` (`parseNetwork`, `rebakeAll`, `composeAll`, `bakeRegion` are not wrapped) would escape `bootstrapWorld` at import time. The app would then fail to boot on every reload.
- **Autosave during a stroke [C path][S impact]:**
  - A timer left over from the previous edit can fire during a terrain stroke, while heights are mutated in place and not yet folded into the layers.
  - `adoptTerrain` then sees natural ≠ terrain and serializes `createLandscape(nat)`, dropping features, sculpt and paint (serialization.ts:252; landscape/apply.ts:128-137).
  - The in-memory doc is fine, and the next save is correct. The bad copy survives only if the tab closes before that next save.
- **Not saved**:
  - editorStore: tool, selection, transform mode, snap, brush radius/strength/falloff/shape/limits, `ghostYaw`, `terrainProbe`.
  - Camera pose and target.
  - roadStore, natureStore, memberStore, blueprintStore sessions.
  - World past/future; placementStore undo/redo, selected and armed state.
- **Saved** (as preferences, not in the world document): `ds.build` (placement/brush/line/area/snapping/recent/favorites, editor/buildStore.ts:166-168); placement prefs, favourites and recents; uiStore panel and tab state; locale; wind form. Runtime simulation state is not saved, by design (actions.ts:96-100).

## 7. Defects and risks

| # | status / sev | finding | evidence |
|---|---|---|---|
| 1 | C / H | Gizmo, group gizmo or member gizmo unmounted mid-drag (Esc, Delete, Ctrl+A, V/P/B/L/A, building Esc) leaves OrbitControls disabled and `editorStore.dragging=true`, so clicks stop selecting | TransformGizmo.tsx:79-91; GroupSelection.tsx:124-131; BuildingEditor.tsx:271-275; drei TransformControls.js:52-54; three-stdlib TransformControls.js:85-90,400-405 |
| 2 | C / H | Sticky `placementStore.selected` takes Delete/Backspace/Esc from the editor, so the wrong item gets deleted | hotkeys.ts:203,206-210; PlacementLayer.tsx:200-201; placementActions.ts:73 |
| 3 | C / H | Unparseable or unmigratable autosave → silent sample town → overwritten on the first edit | actions.ts:307-318; serialization.ts:122 |
| 4 | C / M | No flush on tab close; quota and serialize failures are silent | actions.ts:314-318; serialization.ts:421-428,444 |
| 5 | C / M | Camera locks have no owner or refcount; Road/Nature/Capture unmount mid-drag leaves the lock stuck; Area Esc leaves drag and lock live | shared.tsx:37-46; RoadTool.tsx:155-169; NatureTool.tsx:46-66; BlueprintTool.tsx:60-73; hotkeys.ts:332 |
| 6 | C / M | Pin drag cannot be cancelled with Esc; it follows the pointer after blur; it is dropped and unlocked when PlacementLayer's effect re-runs (`running` dependency) or on a scene switch | PlacementLayer.tsx:178-223,240 |
| 7 | C / M | Disaster placement and an editor tool can both be armed: no mutual disarm; placement stays armed with the panel closed; editor hover previews keep running; pins steal clicks within 14 px even when occluded (including over gizmo handles) whenever the Disasters tab is open or a pin is selected | PlacementLayer.tsx:121,153-166,185-211; RightPanel.tsx:88; placementActions.ts:38-61 |
| 8 | C / M | Placement history survives document replacement; reused ids make undo act across documents; stale snapshots overwrite panel edits; a blocked remove-undo wedges the stack | placementStore.ts:99,111; placementActions.ts:97,150-193; schedule.ts:93-98; worldStore.ts:634-647 |
| 9 | C / M | Ctrl+Z chooses the history by tab, not by which edit came last; Ctrl+Y and Ctrl+Shift+Z disagree; world `config` undo rewrites `scenario` | hotkeys.ts:211-219,266-276; worldStore.ts:315-324 |
| 10 | C / M | No `pointercancel` handling anywhere; after a cancel, terrain or brush strokes resume with no button pressed | grep; TerrainTool.tsx:99-131; BulkTools.tsx:95-98 |
| 11 | C / M | Shift+`[`/`]` dead; picker Backspace swallowed inside inputs | hotkeys.ts:310; GroundTools.tsx:185-190 |
| 12 | C / L | Inconsistent abort semantics: terrain Esc and blur **commit**, brush blur commits but Esc cancels, forest Esc **discards**, pin drag cannot be cancelled | TerrainTool.tsx:77-92; BulkTools.tsx:67-79; NatureTool.tsx:46-66 |
| 13 | C / L | Store-held sessions survive tool switches, contrary to the editorStore.ts:12 doc comment | editorStore.ts:124-166; buildStore.ts:162; roadStore, natureStore, blueprintStore |
| 14 | C / L | Empty undo steps that clear redo: a gizmo click, a road or nature handle click | TransformGizmo.tsx:83; worldStore.ts:474-483; natureActions.ts:142-147 |
| 15 | C / L | Phantom group gizmo at the origin after undoing a multi-object add; selection never pruned | EditorScene.tsx:180-181,233; groupTransform.ts:30 |
| 16 | C / L | World undo allowed mid-gizmo-drag, leaving a mid-drag redo entry | hotkeys.ts:266-271; TransformGizmo.tsx:56-64 |
| 17 | C / L | Double Esc handling (brush, pickers, Help/Results); hotkeys live under non-blueprint modals | §4 |
| 18 | C / L | Body cursor left as pointer/grab after unmount; editor ghosts shown under the disaster crosshair | EditorScene.tsx:64-68; RoadTool.tsx:382-383 |
| 19 | C(shared) / S | Module-level terrain `stroke` shared with scratch stores | worldStore.ts:85,634-647 |
| 20 | S / M | Autosave mid-stroke serializes a rebuilt landscape (features, sculpt and paint lost in the saved copy) | serialization.ts:252; apply.ts:128-137 |
| 21 | S / L | `commitTerrain` has no `locked` check (only reachable through an unmount after `setMode`) | worldStore.ts:274-292,681-685 |
| 22 | S / M | Letter shortcuts with the Korean IME (`e.key`, no `isComposing`) | hotkeys.ts:240,224 |
| 23 | S / M | A parse exception after `safeParse` would break boot permanently | actions.ts:307; serialization.ts:276-415 |

## 8. Implications for Phase 36

- **One input arbiter.** Make an explicit owner (tool, gizmo, pin, picker, disaster placement) per gesture, with a defined priority instead of listener-registration order. Arming disaster placement should suspend the editor tool's input and previews, and vice versa. Closing the panel or switching mode should state what happens.
- **Owned camera locks.** Use a `Set<owner>` and set `enabled = (set.size === 0)`. drei TransformControls writes `defaultControls.enabled` directly (TransformControls.js:52), so route it through a proxy or setter, or have `ManagedTransformControls` take over `dragging-changed`. Release every lock owned by an unmounting component.
- **A shared pointer-session helper**: `begin(owner, {commit, cancel})`.
  - It subscribes to `pointerup`, `pointercancel`, `blur`, `visibilitychange` and Esc, and checks `buttons === 0` on move.
  - It cancels on unmount, simulation start and target deletion.
  - It always resets `dragging` and the lock.
  - Esc means cancel everywhere; pick one rule for blur.
- **Transactions and unified undo.**
  - Record disaster add/move/delete and experiment-panel edits in the world history: the `scenario` already travels in `config`.
  - Clear stale stacks on document replacement.
  - Push no empty steps.
  - Refuse undo mid-drag.
  - Prune or remap the selection after undo/redo.
  - Make `stroke` per store.
- **Hotkeys.**
  - Use `e.code` for letters and brackets, and add an `isComposing` guard.
  - Route Esc, Delete and Ctrl+Z by focus owner, so a sticky pin selection cannot capture them.
  - Use one typing guard everywhere, including the pickers.
  - Suppress hotkeys while a modal is open.
- **Autosave.**
  - Flush on `pagehide` / `visibilitychange` (hidden).
  - Show failures, including quota errors.
  - When the autosave fails to load, keep a backup copy and do not overwrite it.
  - Skip saving while a terrain stroke is in progress.
  - Bumping the schema to v8 requires keeping the v1–7 migration path.
