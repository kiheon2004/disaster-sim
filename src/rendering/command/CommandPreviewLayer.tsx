/**
 * Phase 37 — the command bar's preview in the 3D view (§9): what the typed command WOULD do, drawn from the plan's
 * document difference (`session.plan.preview.diff`) without touching the document.
 *
 *   added objects      ghosts (the editor's batched ghost renderer `PlanPreview`; warned ones orange)
 *   rejected items     a red cross marker, no ghost
 *   moved objects      a ghost at the new place + the old footprint and an arrow to it
 *   removed objects    a red box with a cross        changed objects   a teal plate + dashed box
 *   terrain            the Phase 36 height heat map (HeightPreviewMesh) over the changed rectangle
 *   roads              new: ribbon + lines, removed: crossed-out lines
 *   disasters          ghost pins (the pin layer's own Pin / Ring / Label) — real pins the plan removes or points at
 *                      are marked by the pin layer itself (PlacementLayer, `commandPins`)
 *   snap markers       the Phase 36 marker at every snapped item
 *   highlights         what the plan's lines, or the option under the pointer in a question, point at
 *
 * A draft (while typing) is drawn fainter than the open plan (after Enter). GPU objects are rebuilt only when the
 * plan's identity changes (`previewKey`: plan hash + document) — not per keystroke, not on Enter. When the plan goes
 * away (Esc, confirm, mode switch, document replaced, a tool or a disaster placement armed) the layer renders nothing:
 * every object leaves the scene and its geometry / material / texture is disposed. Nothing here is picked, and
 * nothing here writes a store other than its own report for `__ds.command.preview()`.
 *
 * `scope="pins"` (the simulation scene): only disaster pins and ground highlights — objects, terrain and roads are
 * not edited while a simulation runs.
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { OpenPlan } from '@/ui/Command/commandSession';
import { useCommandSession } from '@/ui/Command/commandSession';
import { useWorldStore } from '@/world/worldStore';
import { samplerFor } from '@/terrain/TerrainSampler';
import { groundMaterial } from '@/terrain/GroundMaterials';
import { PlanPreview } from '@/editor/tools/shared';
import { SnapMarkers } from '@/editor/snap/SnapMarker';
import { phenomena } from '@/phenomena/registry';
import { useT } from '@/i18n/i18n';
import { COLORS as PIN_COLORS, Label, Pin, PIN_H, Ring } from '../placement/PlacementLayer';
import { HeightPreviewMesh } from '../terrain/HeightPreviewMesh';
import { liveGround } from '../terrain/liveGround';
import { useDisposable } from '../useDisposable';
import { useDeformationEngine } from '../terrain/runtimeGround';
import { changedMarks, DRAFT_STRENGTH, highlightSet, movedMarks, pinLinks, rejectedMarks, removedMarks, roadMarks, type HeightAt, type MarkSet } from './marks';
import { buildPreviewModel, countsOf, drawsAnything, highlightMarks, previewKey, type HighlightMarks, type PinMark, type PreviewModel, type TerrainMark } from './previewModel';
import { forgetLayer, reportLayer } from './previewStats';

type Scope = 'all' | 'pins';

/** One kind of marking: built when its inputs change, freed when they change again or the layer goes. */
function Marks({ make, deps, strength }: { make: () => MarkSet; deps: readonly unknown[]; strength: number }) {
  const set = useDisposable(make, deps);
  useLayoutEffect(() => set.setStrength(strength), [set, strength]);
  if (set.empty) return null;
  return (
    <>
      {set.objects.map((o, k) => <primitive key={k} object={o} />)}
    </>
  );
}

function TerrainHeat({ mark }: { mark: TerrainMark }) {
  const terrain = useWorldStore((s) => s.doc.terrain);
  const mesh = useDisposable(() => new HeightPreviewMesh(), []);
  useLayoutEffect(() => {
    const colors = new Map<number, THREE.Color>();
    mesh.showEdit(mark, terrain, (k) => {
      const id = mark.paint[k];
      if (id < 0) return null;
      let c = colors.get(id);
      if (!c) colors.set(id, (c = new THREE.Color(groundMaterial(id).color)));
      return c;
    });
  }, [mesh, mark, terrain]);
  return <primitive object={mesh.mesh} />;
}

/** Everything of a plan that is about objects, the ground and roads (the editor scene only). */
function WorldMarks({ model, armed }: { model: PreviewModel; armed: boolean }) {
  const terrain = useWorldStore((s) => s.doc.terrain);
  const y = useMemo<HeightAt>(() => {
    const s = samplerFor(terrain);
    return (x, z) => s.sampleHeight(x, z);
  }, [terrain]);
  const strength = armed ? 1 : DRAFT_STRENGTH;
  return (
    <>
      <PlanPreview plan={model.ghosts} faint={!armed} />
      <Marks make={() => rejectedMarks(model.rejected, y)} deps={[model, y]} strength={strength} />
      <Marks make={() => removedMarks(model.removed)} deps={[model]} strength={strength} />
      <Marks make={() => changedMarks(model.changed)} deps={[model]} strength={strength} />
      <Marks make={() => movedMarks(model.moved)} deps={[model]} strength={strength} />
      <Marks make={() => roadMarks(model.roads.added, model.roads.removed, y)} deps={[model, y]} strength={strength} />
      {model.terrain && <TerrainHeat mark={model.terrain} />}
      {model.snaps.length > 0 && <SnapMarkers items={model.snaps} />}
    </>
  );
}

/** A ground-height function of the ground as it is drawn now (the simulation's deformed terrain while one runs). */
function useLiveHeight(): HeightAt {
  const terrain = useWorldStore((s) => s.doc.terrain);
  const engine = useDeformationEngine();
  return useMemo<HeightAt>(() => {
    const s = liveGround();
    return (x, z) => s.sampleHeight(x, z);
  }, [terrain, engine]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Ghost pins of the disasters a plan adds (+) or moves (→), with the footprint ring and a label. */
function GhostPins({ pins, armed }: { pins: readonly PinMark[]; armed: boolean }) {
  const t = useT();
  const y = useLiveHeight();
  const ghosts = pins.filter((p) => p.state === 'added' || p.state === 'changed');
  return (
    <>
      {ghosts.map((p) => {
        const def = phenomena.get(p.type);
        const color = PIN_COLORS[p.category] ?? '#ffffff';
        const fp = p.footprint;
        const text = `${p.state === 'added' ? '+' : '→'} ${p.id} · ${def ? t(def.labelKey) : p.type}${fp ? ` · ${fp.radius.toFixed(0)} m${fp.reference ? ` (${t('lib.reference')})` : ''}` : ''}`;
        return (
          <group key={`${p.state}:${p.id}`}>
            <Pin x={p.at[0]} z={p.at[1]} color={color} selected={false} />
            {fp && <Ring x={p.at[0]} z={p.at[1]} fp={fp} color={color} />}
            <Label strong={armed} position={[p.at[0], y(p.at[0], p.at[1]) + PIN_H + 1.4, p.at[1]]} text={text} />
          </group>
        );
      })}
      <Marks make={() => pinLinks(pins, y)} deps={[pins, y]} strength={armed ? 1 : DRAFT_STRENGTH} />
    </>
  );
}

/** Boxes (editor scene only), road lines and ground rings a highlight points at. */
function Highlights({ marks, scope, strength }: { marks: HighlightMarks; scope: Scope; strength: number }) {
  const y = useLiveHeight();
  const shown = useMemo(() => (scope === 'all' ? marks : { ...marks, boxes: [] }), [marks, scope]);
  return <Marks make={() => highlightSet(shown, y)} deps={[shown, y]} strength={strength} />;
}

/** The model of the plan, rebuilt only when the plan's identity changes. */
function useModel(plan: OpenPlan | null): { model: PreviewModel | null; key: string | null; builds: number } {
  const cache = useRef<{ key: string; model: PreviewModel } | null>(null);
  const builds = useRef(0);
  if (!plan || !plan.preview.diff) {
    cache.current = null;
    return { model: null, key: null, builds: builds.current };
  }
  const key = previewKey(plan.preview);
  if (cache.current?.key !== key) {
    cache.current = { key, model: buildPreviewModel(plan.preview) };
    builds.current++;
  }
  return { model: cache.current.model, key, builds: builds.current };
}

export function CommandPreviewLayer({ scope = 'all' }: { scope?: Scope }) {
  const plan = useCommandSession((s) => s.plan);
  const hover = useCommandSession((s) => s.hover);
  const { model, key, builds } = useModel(plan);
  const armed = plan ? plan.armed : null;
  // What the option under the pointer points at, in the document as it is (a question has no plan).
  const hovered = useMemo(() => (hover ? highlightMarks([hover], { doc: useWorldStore.getState().doc }) : null), [hover]);
  const counts = useMemo(() => countsOf(model, hovered, scope), [model, hovered, scope]);
  const root = useRef<THREE.Group>(null);
  const owner = useRef({}).current;

  // The report `__ds.command.preview()` reads: what this layer was given to draw, and its root in the scene.
  useLayoutEffect(() => {
    reportLayer(owner, { counts, armed, key, builds, root: () => root.current });
  });
  useEffect(() => () => forgetLayer(owner), [owner]);

  if (!drawsAnything(counts)) return null;
  const strength = armed === false ? DRAFT_STRENGTH : 1;
  return (
    <group ref={root} name="command-preview">
      {model && scope === 'all' && <WorldMarks model={model} armed={armed !== false} />}
      {model && model.pins.length > 0 && <GhostPins pins={model.pins} armed={armed !== false} />}
      {model && <Highlights marks={model.highlight} scope={scope} strength={strength} />}
      {hovered && <Highlights marks={hovered} scope={scope} strength={1} />}
    </group>
  );
}
