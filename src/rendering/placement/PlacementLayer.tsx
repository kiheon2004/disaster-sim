/**
 * Disaster placement in the 3D view (Phase 35.5), mounted in the editor and the simulation scene:
 *
 *  - armed (a library card was chosen): the pointer's ground point gets a marker and the phenomenon's footprint ring
 *    (dashed + "reference range" when it is only a guide size); a click places an instance there (continuous placement
 *    stays armed). The clicks are captured before the editor tools and the camera see them.
 *  - placed instances: a pin + ring + label per enabled, positioned instance (shown while placing, on the disasters tab or
 *    with one selected). A click on a pin selects it; dragging moves it (camera locked meanwhile). Instances that are part
 *    of the running simulation cannot be moved (their pin turns orange).
 *
 * Render-only + UI state: the document changes only through the placement actions.
 *
 * Phase 37: commands show pins too (rendering/command/previewModel.ts `commandPins`) — every pin while a plan with
 * disasters is open (the ones it removes marked), and the pins of the disaster a command has just placed / a plan or a
 * question points at, whatever tab is open. Nothing is selected for that (the object selection stays as it is).
 */
import { useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { Vec3 } from '@/core/types';
import { useWorldStore } from '@/world/worldStore';
import { samplerFor } from '@/terrain/TerrainSampler';
import { currentDeformation } from '../terrain/runtimeGround';
import { GroundLine, circlePts } from '../ground/GroundTools';
import { usePlacementStore } from '@/ui/placement/placementStore';
import { useUiStore } from '@/ui/uiStore';
import { useSimStore } from '@/simulation/simStore';
import { catalogOf, nearestEdge, placeable, type Footprint } from '@/phenomena/catalog';
import { phenomena } from '@/phenomena/registry';
import { mapHalf, moveInstance, placeAt } from '@/app/placementActions';
import { beginGesture, type Gesture } from '@/editor/input/gesture';
import { useT } from '@/i18n/i18n';
import type { EventSpec } from '@/events/specs';
import type { PhenomenonInstance } from '@/phenomena/types';
import { useCommandPins } from '../command/useCommandPins';

const round1 = (v: number) => Math.round(v * 10) / 10;
const ground = () => samplerFor(currentDeformation()?.terrain ?? useWorldStore.getState().doc.terrain);
export const PIN_H = 7;
export const COLORS: Record<string, string> = { weather: '#5aa9ff', geology: '#c08a4a', hydrology: '#3fc6d8', fireHeat: '#ff6a3d', impactBlast: '#ffb238', spaceGravity: '#b48cff', atmosphere: '#9fd36b' };

/**
 * A text label drawn as a screen-sized sprite (canvas texture) — no extra React roots (drei <Html> roots unmounted during a
 * scene switch log React warnings). Disposed with the component.
 */
export function Label({ text, position, strong = false }: { text: string; position: [number, number, number]; strong?: boolean }) {
  const sprite = useMemo(() => {
    const px = 2, font = `600 ${12 * px}px system-ui, -apple-system, 'Apple SD Gothic Neo', sans-serif`;
    const c = document.createElement('canvas');
    const g = c.getContext('2d')!;
    g.font = font;
    const w = Math.ceil(g.measureText(text).width) + 16 * px, h = 22 * px;
    c.width = w; c.height = h;
    g.font = font;
    g.fillStyle = strong ? 'rgba(12,16,22,0.92)' : 'rgba(12,16,22,0.8)';
    g.beginPath(); g.roundRect(0, 0, w, h, 6 * px); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.22)'; g.lineWidth = px; g.stroke();
    g.fillStyle = '#ffffff'; g.textBaseline = 'middle'; g.fillText(text, 8 * px, h / 2 + px);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false });
    const sp = new THREE.Sprite(mat);
    const H = 0.034;
    sp.scale.set((H * w) / h, H, 1);
    sp.center.set(0.5, 0);
    sp.renderOrder = 20;
    sp.raycast = () => {};
    return sp;
  }, [text, strong]);
  useEffect(() => () => {
    sprite.material.map?.dispose();
    sprite.material.dispose();
  }, [sprite]);
  return <primitive object={sprite} position={position} />;
}

export function Ring({ x, z, fp, color }: { x: number; z: number; fp: Footprint; color: string }) {
  const pts = useMemo(() => circlePts(x, z, fp.radius, 96), [x, z, fp.radius]);
  return <GroundLine pts={pts} color={color} dashed={fp.reference} />;
}

export function Pin({ x, z, color, selected }: { x: number; z: number; color: string; selected: boolean }) {
  // Phase 36: x / z are the user's (never moved by a terrain edit); y is drawn on the ground as it is now — subscribing
  // to the terrain object re-renders the pin after a brush commit / undo (it kept the old height before).
  useWorldStore((s) => s.doc.terrain);
  const y = ground().sampleHeight(x, z);
  return (
    <group position={[x, y, z]} raycast={() => null}>
      <mesh position={[0, PIN_H / 2, 0]} renderOrder={8} raycast={() => null}>
        <cylinderGeometry args={[0.12, 0.12, PIN_H, 6]} />
        <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.9} />
      </mesh>
      <mesh position={[0, PIN_H, 0]} renderOrder={8} raycast={() => null}>
        <sphereGeometry args={[selected ? 0.9 : 0.6, 14, 10]} />
        <meshBasicMaterial color={selected ? '#ffffff' : color} depthTest={false} />
      </mesh>
    </group>
  );
}

/** Highlighted map edge (rising water) — the side nearest to the pointer. */
function EdgeLine({ side, color }: { side: 'N' | 'S' | 'E' | 'W'; color: string }) {
  const h = mapHalf() - 0.5;
  const pts: [number, number][] = side === 'N' ? [[-h, -h], [h, -h]] : side === 'S' ? [[-h, h], [h, h]] : side === 'E' ? [[h, -h], [h, h]] : [[-h, -h], [-h, h]];
  return <GroundLine pts={pts} closed={false} color={color} />;
}

interface Placed {
  inst: PhenomenonInstance;
  at: [number, number];
  fp: Footprint | null;
  color: string;
  label: string;
}

export function PlacementLayer() {
  const t = useT();
  const type = usePlacementStore((s) => s.type);
  const template = usePlacementStore((s) => s.template);
  const hover = usePlacementStore((s) => s.hover);
  const selected = usePlacementStore((s) => s.selected);
  const drag = usePlacementStore((s) => s.drag);
  const tab = useUiStore((s) => s.rightTab);
  const rightOpen = useUiStore((s) => s.rightOpen);
  const instances = useWorldStore((s) => s.doc.scenario.experiment?.instances);
  const events = useSimStore((s) => s.events);
  const { gl, camera } = useThree();
  const ray = useRef(new THREE.Raycaster());

  // Phase 37: an open command plan with disasters shows every pin; the pins a command placed / points at show alone.
  const cmd = useCommandPins();
  const showPlaced = type !== null || selected !== null || drag !== null || (rightOpen && tab === 'phenomena') || cmd.all;
  const running = useMemo(() => new Map(events.map((e) => [e.key, e.status])), [events]);
  // Read through a ref: the pointer listeners must not be re-registered on every scheduler change
  // (that dropped a pin drag in progress and released its camera lock mid-drag — Phase 36).
  const runningRef = useRef(running);
  runningRef.current = running;
  const placed = useMemo<Placed[]>(() => {
    if (!showPlaced && !cmd.show.length) return [];
    const out: Placed[] = [];
    for (const inst of instances ?? []) {
      if (!showPlaced && !cmd.show.includes(inst.id)) continue;
      const c = catalogOf(inst.type);
      if (!inst.enabled || !c) continue;
      const at = c.placement.get(inst.spec);
      if (!at || !placeable(inst.type, inst.spec)) continue;
      const def = phenomena.get(inst.type);
      out.push({ inst, at, fp: c.placement.footprint(inst.spec), color: COLORS[c.category] ?? '#fff', label: `${inst.id} · ${def ? t(def.labelKey) : inst.type}` });
    }
    return out;
  }, [instances, showPlaced, cmd.show, t]);
  const placedRef = useRef(placed);
  placedRef.current = placed;

  useEffect(() => {
    const el = gl.domElement;
    const hit: Vec3 = [0, 0, 0];
    const v = new THREE.Vector3();
    const pointAt = (ev: MouseEvent): [number, number] | null => {
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      ray.current.setFromCamera(ndc, camera);
      const o = ray.current.ray.origin, d = ray.current.ray.direction;
      if (!ground().raycast([o.x, o.y, o.z], [d.x, d.y, d.z], 4000, hit)) return null;
      const h = mapHalf();
      return Math.abs(hit[0]) <= h && Math.abs(hit[2]) <= h ? [round1(hit[0]), round1(hit[2])] : null;
    };
    /** Pin under the pointer (screen distance ≤ 14 px to its head or foot). */
    const pinAt = (ev: MouseEvent): Placed | null => {
      const r = el.getBoundingClientRect();
      let best: Placed | null = null, bd = 14;
      for (const p of placedRef.current) {
        const y = ground().sampleHeight(p.at[0], p.at[1]);
        for (const hy of [y + PIN_H, y]) {
          v.set(p.at[0], hy, p.at[1]).project(camera);
          if (v.z > 1) continue;
          const sx = r.left + ((v.x + 1) / 2) * r.width, sy = r.top + ((1 - v.y) / 2) * r.height;
          const d = Math.hypot(sx - ev.clientX, sy - ev.clientY);
          if (d < bd) { bd = d; best = p; }
        }
      }
      return best;
    };
    let consumed = false;
    let gesture: Gesture | null = null;
    const onMove = (ev: PointerEvent) => {
      const st = usePlacementStore.getState();
      if (st.drag) return; // the drag gesture moves the pin
      if (st.type && ev.target === el) st.setHover(pointAt(ev));
      else if (st.type) st.setHover(null);
    };
    const onDown = (ev: PointerEvent) => {
      consumed = false;
      if (ev.target !== el || ev.button !== 0) return;
      const st = usePlacementStore.getState();
      if (st.type) {
        consumed = true;
        ev.stopImmediatePropagation();
        ev.preventDefault();
        const p = pointAt(ev);
        if (p) placeAt(p);
        return;
      }
      const pin = pinAt(ev);
      if (!pin) return;
      st.select(pin.inst.id);
      useUiStore.getState().setRightTab('phenomena');
      // A running instance cannot be dragged: its pin only selects, and the click goes on to the world (ground probe, objects, camera).
      if (runningRef.current.has(pin.inst.id)) return;
      consumed = true;
      ev.stopImmediatePropagation();
      ev.preventDefault();
      const id = pin.inst.id;
      const from = pin.at;
      st.setDrag({ id, p: from });
      // Phase 36: the pin drag is a gesture — release / window blur move the instance (one undo
      // step), Esc / pointercancel / unmount put the pin back (before: no Esc, and after a blur the
      // pin followed the cursor with no button pressed). Owned camera lock.
      gesture = beginGesture('pin', {
        move: (e) => {
          const p = pointAt(e);
          if (p) usePlacementStore.getState().setDrag({ id, p });
        },
        end: (commit) => {
          gesture = null;
          const s = usePlacementStore.getState();
          const p = s.drag?.id === id ? s.drag.p : from;
          s.setDrag(null);
          if (commit && Math.hypot(p[0] - from[0], p[1] - from[1]) > 0.2) moveInstance(id, p);
        },
      }, { lockCamera: true });
    };
    const onUp = (ev: PointerEvent) => {
      // End the drag here: the swallow below stops the event before the gesture's own (bubble) listener.
      gesture?.finish(true, 'up');
      if (consumed && ev.target === el) ev.stopImmediatePropagation();
    };
    const swallow = (ev: MouseEvent) => {
      if (consumed && ev.target === el) ev.stopImmediatePropagation();
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('click', swallow, true);
    window.addEventListener('dblclick', swallow, true);
    return () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('click', swallow, true);
      window.removeEventListener('dblclick', swallow, true);
      gesture?.finish(false, 'abort');
    };
  }, [gl, camera]);

  useEffect(() => {
    gl.domElement.style.cursor = type ? 'crosshair' : '';
    return () => { gl.domElement.style.cursor = ''; };
  }, [gl, type]);

  // Preview of the armed phenomenon under the pointer.
  let preview: React.ReactNode = null;
  if (type && template && hover) {
    const c = catalogOf(type)!;
    const spec: EventSpec = c.placement.set(template, hover, mapHalf());
    const fp = c.placement.footprint(spec);
    const color = COLORS[c.category] ?? '#fff';
    const y = ground().sampleHeight(hover[0], hover[1]);
    preview = (
      <group>
        {c.placement.kind === 'edge' ? <EdgeLine side={nearestEdge(hover, mapHalf())} color={color} /> : (
          <>
            <Pin x={hover[0]} z={hover[1]} color={color} selected={false} />
            {fp && <Ring x={hover[0]} z={hover[1]} fp={fp} color={color} />}
          </>
        )}
        <Label strong position={[hover[0], y + PIN_H + 1.6, hover[1]]} text={previewText(t, type, spec, hover, fp, c.placement.kind)} />
      </group>
    );
  }

  return (
    <group>
      {preview}
      {placed.map((p) => {
        const at = drag && drag.id === p.inst.id ? drag.p : p.at;
        const st = running.get(p.inst.id);
        // Phase 37: a pin the open command plan removes is red with a × before its label (a mark, not only a colour).
        const gone = cmd.removing.includes(p.inst.id);
        const color = gone ? '#ff5a5a' : st === 'active' || st === 'paused' ? '#ff8a2a' : st === 'done' || st === 'stopped' ? '#7c8794' : p.color;
        const sel = selected === p.inst.id;
        // A pin a command placed or points at: its ring and full label like a selected one — but it is NOT selected.
        const told = sel || cmd.show.includes(p.inst.id);
        const y = ground().sampleHeight(at[0], at[1]);
        const fp = p.fp;
        return (
          <group key={p.inst.id}>
            <Pin x={at[0]} z={at[1]} color={color} selected={sel} />
            {fp && (told || type) && <Ring x={at[0]} z={at[1]} fp={fp} color={color} />}
            <Label position={[at[0], y + PIN_H + 1.4, at[1]]} strong={told} text={`${gone ? '× ' : ''}${p.label}${told && fp ? ` · ${fp.radius.toFixed(0)} m${fp.reference ? ` (${t('lib.reference')})` : ''}` : ''}`} />
          </group>
        );
      })}
    </group>
  );
}

/** One-line description of the armed phenomenon at a map point (the 3D label and the placement bar show the same text). */
export function previewText(t: ReturnType<typeof useT>, type: string, _spec: EventSpec, p: [number, number], fp: Footprint | null, kind: string): string {
  const def = phenomena.get(type);
  let s = `${def ? t(def.labelKey) : type} (${p[0].toFixed(0)}, ${p[1].toFixed(0)})`;
  if (kind === 'edge') s += ` · ${t('place.edge', { side: t(`place.side.${nearestEdge(p, mapHalf())}` as never) })}`;
  if (fp) s += ` · ${t(fp.labelKey)} ${fp.radius.toFixed(0)} m${fp.reference ? ` (${t('lib.reference')})` : ''}`;
  return s;
}

/** The armed phenomenon's own one-line description (intensity, size …) — shown under the preview in the placement bar. */
export function previewDescription(t: ReturnType<typeof useT>, type: string, spec: EventSpec): string {
  const def = phenomena.implemented(type);
  if (!def) return '';
  const m = def.describe(spec, { seed: 1, terrain: null });
  return t(m.key as never, m.params as never);
}
