# Phase 18 — Road Network & City Builder

> Status: plan (replaced by the report as work lands).

## 1. Existing roads and world structure

| Piece | Today |
|---|---|
| Road | `WorldObject` of type `road`: inert (no body, no wind, no damage except flood), rectangle `length × width`, `lanes`, drawn as a React mesh draped on the terrain (render only), never batched |
| Flood | `floodFeatures` rasterizes each road rectangle into the 1 m water grid as paved cells (asphalt infiltration, Manning, storm drains). Bed = terrain heights — the road never changes it |
| Terrain | 201×201 vertex heightfield + ground type + soil layers; ONE source for the Rapier heightfield, water bed, renderer, placement, friction (current contact position, Phase 14) |
| Editing | atomic `applyEdit`, history = objects + terrain patch; Blueprint v1 (objects only); schema v5 |
| Infrastructure | streetLight, sign, wall (+fence preset) — wind / quake / flood behaviors exist |

Roads have no connectivity, no curves, no intersections, no sidewalks, no materials and no effect on the terrain or the water bed.

## 2. Decisions

1. **Road network = new document layer** `doc.roads` (nodes, segments with control points, profiles, attachments, block zones). Legacy road objects stay what they are (no automatic conversion); an explicit per-road conversion exists.
2. **Roads are baked into the terrain layers** (heights for graded / fixed roads, ground type = road / sidewalk material). The heightfield stays the single source for collider, water bed, renderer, placement and friction → a road can never be "raised in the mesh only". The natural values under road-covered vertices are kept in the network (`underlay`) so moving / deleting a road restores the ground exactly.
3. **One edit = one undo step**: network + terrain patch + linked objects committed together (history entries gain the network).
4. **Geometry is derived** (pure functions, cached per segment / intersection, chunked batched meshes; only dirty chunks rebuild).
5. **Schema v6** (top-level `roads`, design table, derived components omitted); v1–v5 load unchanged.

## 3. Plan (commits)

1. Phase 17 residuals A/B analysis.
2. Road model: types, validation, network ops (add / extend / connect / split / merge / delete / move), splines, profiles.
3. Geometry: centerline sampling, offsets without fold-over, intersections, sidewalks, curbs, markings, crosswalks; terrain bake (follow / graded / fixed, cut-fill blend), underlay.
4. Store, undo, save v6, blueprint, original world.
5. Rendering (chunked, dirty), tools + UI (KO/EN), inspector.
6. Blocks, zoning fill, along-road placement, neighborhoods, vehicle alignment, infrastructure (traffic signal, guardrail, drainage inlets).
7. Simulation: road runtime (flood inundation / scour, drains as subgrid sinks, quake cracking), wind on infrastructure.
8. Tests, browser verification, benchmarks, documentation.
