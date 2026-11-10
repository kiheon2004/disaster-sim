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
 */
import { useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
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
import { useT } from '@/i18n/i18n';
import type { EventSpec } from '@/events/specs';
import type { PhenomenonInstance } from '@/phenomena/types';

const round1 = (v: number) => Math.round(v * 10) / 10;
const ground = () => samplerFor(currentDeformation()?.terrain ?? useWorldStore.getState().doc.terrain);
const PIN_H = 7;
const COLORS: Record<string, string> = { weather: '#5aa9ff', geology: '#c08a4a', hydrology: '#3fc6d8', fireHeat: '#ff6a3d', impactBlast: '#ffb238', spaceGravity: '#b48cff', atmosphere: '#9fd36b' };

const labelStyle: React.CSSProperties = {
  pointerEvents: 'none', whiteSpace: 'nowrap', font: '600 11px/1.3 system-ui, sans-serif', color: '#fff', padding: '2px 7px',
  borderRadius: 6, background: 'rgba(12,16,22,0.82)', border: '1px solid rgba(255,255,255,0.18)', transform: 'translateY(-4px)',
};

function Ring({ x, z, fp, color }: { x: number; z: number; fp: Footprint; color: string }) {
  const pts = useMemo(() => circlePts(x, z, fp.radius, 96), [x, z, fp.radius]);
  return <GroundLine pts={pts} color={color} dashed={fp.reference} />;
}

function Pin({ x, z, color, selected }: { x: number; z: number; color: string; selected: boolean }) {
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
  const { gl, camera, controls } = useThree();
  const ray = useRef(new THREE.Raycaster());

  const showPlaced = type !== null || selected !== null || drag !== null || (rightOpen && tab === 'phenomena');
  const running = useMemo(() => new Map(events.map((e) => [e.key, e.status])), [events]);
  const placed = useMemo<Placed[]>(() => {
    if (!showPlaced) return [];
    const out: Placed[] = [];
    for (const inst of instances ?? []) {
      const c = catalogOf(inst.type);
      if (!inst.enabled || !c) continue;
      const at = c.placement.get(inst.spec);
      if (!at || !placeable(inst.type, inst.spec)) continue;
      const def = phenomena.get(inst.type);
      out.push({ inst, at, fp: c.placement.footprint(inst.spec), color: COLORS[c.category] ?? '#fff', label: `${inst.id} · ${def ? t(def.labelKey) : inst.type}` });
    }
    return out;
  }, [instances, showPlaced, t]);
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
    let dragStart: [number, number] | null = null;
    const orbit = controls as unknown as { enabled: boolean } | null;
    const onMove = (ev: PointerEvent) => {
      const st = usePlacementStore.getState();
      if (st.drag) {
        const p = pointAt(ev);
        if (p) st.setDrag({ id: st.drag.id, p });
        return;
      }
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
      consumed = true;
      ev.stopImmediatePropagation();
      ev.preventDefault();
      st.select(pin.inst.id);
      useUiStore.getState().setRightTab('phenomena');
      if (running.has(pin.inst.id)) return;
      dragStart = pin.at;
      st.setDrag({ id: pin.inst.id, p: pin.at });
      if (orbit) orbit.enabled = false;
    };
    const onUp = (ev: PointerEvent) => {
      const st = usePlacementStore.getState();
      if (st.drag) {
        const { id, p } = st.drag;
        st.setDrag(null);
        if (orbit) orbit.enabled = true;
        if (dragStart && Math.hypot(p[0] - dragStart[0], p[1] - dragStart[1]) > 0.2) moveInstance(id, p);
        dragStart = null;
      }
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
      if (orbit) orbit.enabled = true;
    };
  }, [gl, camera, controls, running]);

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
    const def = phenomena.get(type);
    const y = ground().sampleHeight(hover[0], hover[1]);
    const desc = def && def.status === 'implemented' ? def.describe(spec, { seed: 1, terrain: null }) : null;
    preview = (
      <group>
        {c.placement.kind === 'edge' ? <EdgeLine side={nearestEdge(hover, mapHalf())} color={color} /> : (
          <>
            <Pin x={hover[0]} z={hover[1]} color={color} selected={false} />
            {fp && <Ring x={hover[0]} z={hover[1]} fp={fp} color={color} />}
          </>
        )}
        <Html position={[hover[0], y + PIN_H + 2.2, hover[1]]} center style={labelStyle} zIndexRange={[20, 10]}>
          <div data-testid="placement-preview">
            <b>{def ? t(def.labelKey) : type}</b> ({hover[0].toFixed(0)}, {hover[1].toFixed(0)})
            {c.placement.kind === 'edge' && <> · {t('place.edge', { side: t(`place.side.${nearestEdge(hover, mapHalf())}` as never) })}</>}
            {fp && <> · {t(fp.labelKey)} {fp.radius.toFixed(0)} m{fp.reference ? ` (${t('lib.reference')})` : ''}</>}
            {desc && <div style={{ fontWeight: 400, opacity: 0.85 }}>{t(desc.key as never, desc.params as never)}</div>}
          </div>
        </Html>
      </group>
    );
  }

  return (
    <group>
      {preview}
      {placed.map((p) => {
        const at = drag && drag.id === p.inst.id ? drag.p : p.at;
        const st = running.get(p.inst.id);
        const color = st === 'active' || st === 'paused' ? '#ff8a2a' : st === 'done' || st === 'stopped' ? '#7c8794' : p.color;
        const sel = selected === p.inst.id;
        const y = ground().sampleHeight(at[0], at[1]);
        const fp = p.fp;
        return (
          <group key={p.inst.id}>
            <Pin x={at[0]} z={at[1]} color={color} selected={sel} />
            {fp && (sel || type) && <Ring x={at[0]} z={at[1]} fp={fp} color={color} />}
            <Html position={[at[0], y + PIN_H + 1.6, at[1]]} center style={{ ...labelStyle, opacity: sel ? 1 : 0.85 }} zIndexRange={[19, 10]}>
              <span data-testid={`placed-${p.inst.id}`}>{p.label}{sel && fp ? ` · ${fp.radius.toFixed(0)} m${fp.reference ? ` (${t('lib.reference')})` : ''}` : ''}</span>
            </Html>
          </group>
        );
      })}
    </group>
  );
}
