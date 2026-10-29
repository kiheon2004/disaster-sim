/**
 * Atmosphere visuals in simulation mode (Phase 29, render-only — they never feed the simulation), all
 * from the run's computed atmosphere state:
 *  - overlay: one computed field on the 5 m air columns (pressure, its change, density, temperature,
 *    flow speed, air mass, O₂, smoke, volcanic gas, airborne ash, updraft) with a fixed SI legend;
 *  - arrows: the layer flow that transports heat / smoke / gas (background wind + computed column and
 *    convergence flows) at every other column, length ∝ speed (capped, labelled);
 *  - streamlines: lines traced through that same flow (a visual integration of computed velocities).
 * Nothing darkens the scene for thin air (the remaining-air badge is in the HUD). Every GPU resource is
 * owned (useDisposable) and released with the component; colors refresh every REFRESH frames.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { Y_O2_AIR } from '@/atmosphere/reference';
import { velocityAt } from '@/atmosphere/grid';
import { useViewStore, type AtmosOverlay } from '../viewStore';
import { useDisposable } from '../useDisposable';
import { columnGridGeometry, paintColumns } from './columnGrid';
import { atmosColor } from './atmosColors';

const REFRESH = 10;
const LINE_REFRESH = 30;
const SEEDS = 10;
const LINE_STEPS = 40;
const ARROW_MAX = 900;
/** Arrow length per m/s (m), capped at 6 m. */
export const ARROW_SCALE = 0.6;

const m4 = new THREE.Matrix4();
const q0 = new THREE.Quaternion();
const v0 = new THREE.Vector3();
const s0 = new THREE.Vector3();
const c0 = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
const uv: [number, number] = [0, 0];

export function AtmosphereLayer() {
  const live = useSimStore((s) => s.atmosphere !== null);
  if (!live) return null;
  return <AtmosphereScene />;
}

/** Value of an overlay at a column (display units of its legend). */
export function overlayValue(k: Exclude<AtmosOverlay, 'off'>, a: number, ash: Float64Array | null): number {
  const env = simulationController.getEnvironment();
  const ar = env.atmosphere.rt;
  if (!ar) return NaN;
  const f = ar.field, air = ar.trt.world.air, A = f.area, H = f.H;
  switch (k) {
    case 'pressure': return f.surfacePressure(a) / 1000;
    case 'pressureChange': return f.sigma[a] * f.g - f.sigma0[a] * 9.81; // weight now (Phase 31: under the acting g) − the start state
    case 'density': return f.densityAt(a, 0.5 * H, air.T(a));
    case 'temperature': return air.T(a) - 273.15;
    case 'speed': {
      const ix = a % f.nx, iz = (a - ix) / f.nx, fw = iz * (f.nx + 1) + ix;
      const u = 0.5 * (ar.faces.fx[fw] + ar.faces.fx[fw + 1]), w = 0.5 * (ar.faces.fz[a] + ar.faces.fz[a + f.nx]);
      return Math.hypot(u, w);
    }
    case 'mass': return f.sigma[a];
    case 'oxygen': { const fire = env.fire.rt; return (Y_O2_AIR * f.layerMass(a) - (fire ? fire.fw.o2def[a] : 0)) / (H * A); }
    case 'smoke': { const fire = env.fire.rt; return fire ? (fire.fw.soot[a] / (H * A)) * 1e6 : 0; }
    case 'gas': return (f.gas[a] / (H * A)) * 1e3;
    case 'ash': return ash ? ash[a] : 0;
    case 'updraft': return air.updraft(a);
  }
}

/** Airborne ash per area over each column (g/m²) from the computed puffs. */
function ashColumns(out: Float64Array): Float64Array {
  out.fill(0);
  const env = simulationController.getEnvironment();
  const ar = env.atmosphere.rt, vr = env.volcano.rt;
  if (!ar || !vr) return out;
  for (const p of vr.world.puffs) {
    const a = ar.field.index(p.x, p.z);
    if (a >= 0) out[a] += (p.mass * 1000) / ar.field.area;
  }
  return out;
}

function arrowGeometry(): THREE.BufferGeometry {
  // A flat arrow along +x (unit length), lying in the xz plane.
  const g = new THREE.BufferGeometry();
  const v = new Float32Array([0, 0, -0.06, 0.7, 0, -0.06, 0.7, 0, 0.06, 0, 0, 0.06, 0.7, 0, -0.2, 1, 0, 0, 0.7, 0, 0.2]);
  g.setAttribute('position', new THREE.BufferAttribute(v, 3));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6]);
  g.computeVertexNormals();
  return g;
}

function AtmosphereScene() {
  const viz = useViewStore((s) => s.atmosViz);
  const env = simulationController.getEnvironment();
  const ar = env.atmosphere.rt;
  const grid = useMemo(() => (ar ? { originX: ar.field.originX, originZ: ar.field.originZ, nx: ar.field.nx, nz: ar.field.nz, dx: ar.field.dx } : null), [ar]);
  const geo = useDisposable(() => (grid ? columnGridGeometry(grid, (x, z) => env.terrain.sampleHeight(x, z)) : new THREE.BufferGeometry()), [grid]);
  const mat = useDisposable(() => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3 }));
  const arrowGeo = useDisposable(() => arrowGeometry());
  const arrowMat = useDisposable(() => new THREE.MeshBasicMaterial({ color: '#e8f4ff', side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }));
  const arrows = useDisposable(() => { const m = new THREE.InstancedMesh(arrowGeo, arrowMat, ARROW_MAX); m.count = 0; m.frustumCulled = false; m.raycast = () => null; return m; }, [arrowGeo, arrowMat]);
  const lineGeo = useDisposable(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SEEDS * SEEDS * LINE_STEPS * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(SEEDS * SEEDS * LINE_STEPS * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    return g;
  });
  const lineMat = useDisposable(() => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false }));
  // (The line object owns nothing: its geometry and material are disposed above.)
  const lines = useMemo(() => { const l = new THREE.LineSegments(lineGeo, lineMat); l.frustumCulled = false; l.raycast = () => null; return l; }, [lineGeo, lineMat]);
  const st = useRef({ frame: 0, ash: null as Float64Array | null });
  useEffect(() => { st.current.frame = 0; }, [viz]);

  useFrame(() => {
    const e = simulationController.getEnvironment();
    const rt = e.atmosphere.rt;
    if (!rt || !grid) return;
    const S = st.current, vs = useViewStore.getState().atmosViz, f = rt.field;
    S.frame++;
    if (S.frame % REFRESH === 1 && vs.overlay !== 'off') {
      const k = vs.overlay;
      if (k === 'ash') S.ash = ashColumns(S.ash && S.ash.length === f.count ? S.ash : new Float64Array(f.count));
      paintColumns(geo, f.count, (a) => overlayValue(k, a, S.ash), (v, out) => atmosColor(k, v, out));
    }
    if (S.frame % REFRESH === 1) {
      // Arrows: every other column, the transport velocity at its centre.
      let n = 0;
      if (vs.arrows) for (let iz = 0; iz < f.nz; iz += 2) for (let ix = 0; ix < f.nx; ix += 2) {
        if (n >= ARROW_MAX) break;
        velocityAt(f, rt.faces.fx, rt.faces.fz, ix + 0.5, iz + 0.5, uv);
        const sp = Math.hypot(uv[0], uv[1]);
        if (sp < 0.05) continue;
        const x = f.originX + (ix + 0.5) * f.dx, z = f.originZ + (iz + 0.5) * f.dx;
        const L = Math.min(6, sp * ARROW_SCALE + 0.4);
        q0.setFromAxisAngle(UP, -Math.atan2(uv[1], uv[0]));
        v0.set(x - (L / 2) * (uv[0] / sp), e.terrain.sampleHeight(x, z) + 1.2, z - (L / 2) * (uv[1] / sp));
        s0.set(L, 1, Math.max(1, L * 0.4));
        m4.compose(v0, q0, s0);
        arrows.setMatrixAt(n++, m4);
      }
      arrows.count = n;
      arrows.instanceMatrix.needsUpdate = true;
    }
    if (vs.streamlines && S.frame % LINE_REFRESH === 1) {
      const pos = lineGeo.getAttribute('position') as THREE.BufferAttribute, col = lineGeo.getAttribute('color') as THREE.BufferAttribute;
      const P = pos.array as Float32Array, C = col.array as Float32Array;
      let k = 0;
      const W = f.nx * f.dx, D = f.nz * f.dx;
      for (let i = 0; i < SEEDS; i++) for (let j = 0; j < SEEDS; j++) {
        let x = f.originX + ((i + 0.5) / SEEDS) * W, z = f.originZ + ((j + 0.5) / SEEDS) * D;
        for (let s = 0; s < LINE_STEPS; s++) {
          velocityAt(f, rt.faces.fx, rt.faces.fz, (x - f.originX) / f.dx, (z - f.originZ) / f.dx, uv);
          const sp = Math.hypot(uv[0], uv[1]);
          if (sp < 0.02) break;
          const x2 = x + (uv[0] / sp) * 2, z2 = z + (uv[1] / sp) * 2;
          if (x2 < f.originX || z2 < f.originZ || x2 > f.originX + W || z2 > f.originZ + D) break;
          atmosColor('speed', sp, c0);
          const y1 = e.terrain.sampleHeight(x, z) + 1.6, y2 = e.terrain.sampleHeight(x2, z2) + 1.6;
          P.set([x, y1, z, x2, y2, z2], k * 3);
          C.set([c0.r, c0.g, c0.b, c0.r, c0.g, c0.b], k * 3);
          k += 2;
          x = x2; z = z2;
        }
      }
      lineGeo.setDrawRange(0, k);
      pos.needsUpdate = true;
      col.needsUpdate = true;
    }
  });

  return (
    <group name="atmosphere-layer">
      <mesh geometry={geo} material={mat} visible={viz.overlay !== 'off'} renderOrder={3} raycast={() => null} />
      <primitive object={arrows} visible={viz.arrows} />
      <primitive object={lines} visible={viz.streamlines} />
    </group>
  );
}
