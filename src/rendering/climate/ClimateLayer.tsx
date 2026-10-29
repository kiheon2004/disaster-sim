/**
 * Climate visuals in simulation mode (Phase 30, render-only — they never feed the simulation), all from the run's
 * computed climate state:
 *  - snow / ice cover draped on the terrain (and on water) at its COMPUTED depth (snow white, ice blue, slush grey,
 *    frost a light tint); roof, crown and vehicle snow as slabs / caps sized by the computed store mass
 *  - overlays: air temperature, relative humidity, vapour (5 m air columns); surface temperature, snow depth, SWE,
 *    ice thickness, surface water, soil moisture, absorbed shortwave (2 m cells); roof snow load (roof slab colour)
 *    — fixed SI legends
 *  - falling snow / rain particles: VISUAL only, their density follows the computed precipitation rate and the rain /
 *    snow split, they carry no mass (the mass is the computed cover)
 *  - heat shimmer over hot surfaces and the sun light following the computed sun: visual only
 * Every GPU resource is owned (useDisposable) and released with the component.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { STORE } from '@/climate/ClimateWorld';
import { snowFraction } from '@/climate/surfaceState';
import { wetBulb } from '@/climate/psychro';
import { WATER_MERGE } from '@/thermal/TerrainThermal';
import { useViewStore, type ClimateOverlay } from '../viewStore';
import { useDisposable } from '../useDisposable';
import { columnGridGeometry, paintColumns } from '../atmosphere/columnGrid';
import { climateColor } from './climateColors';

const REFRESH = 20;
const PARTICLES = 6000;
const STORE_MAX = 2048;
const AIR_KEYS = new Set<ClimateOverlay>(['airT', 'rh', 'vapour']);

const m4 = new THREE.Matrix4();
const q0 = new THREE.Quaternion();
const v0 = new THREE.Vector3();
const s0 = new THREE.Vector3();
const c0 = new THREE.Color();
const SNOW = new THREE.Color('#f4f8ff'), ICE = new THREE.Color('#a9dcf2'), SLUSH = new THREE.Color('#c9ccd0'), FROST = new THREE.Color('#dfe9f2');

export function ClimateLayer() {
  const live = useSimStore((s) => s.climate !== null);
  // The Phase 26 heat map colours every cell that left the reference temperature — under a climate that is the whole
  // world; it gives way to the climate's own temperature overlays (the user can turn it back on).
  useEffect(() => {
    if (!live) return;
    const v = useViewStore.getState();
    const prev = v.thermalViz.field;
    if (prev !== 'off') v.setThermalViz({ field: 'off' });
    // The heat map the run switched off comes back afterwards (unless the user chose another field meanwhile).
    return () => { const n = useViewStore.getState(); if (prev !== 'off' && n.thermalViz.field === 'off') n.setThermalViz({ field: prev }); };
  }, [live]);
  if (!live) return null;
  return <ClimateScene />;
}

/** Overlay value of a 2 m patch / 5 m column in its legend unit. */
function cellValue(k: Exclude<ClimateOverlay, 'off'>, c: number): number {
  const env = simulationController.getEnvironment();
  const r = env.climate.rt;
  if (!r) return NaN;
  const cw = r.cw, w = r.trt.world, g = w.terrain, wf = env.flood.field;
  switch (k) {
    case 'surfaceT': return (cw.cM[c] > 0 ? cw.coverT(c) : wf && wf.h[c] > WATER_MERGE ? w.waterT(c) : g.T(c, 0)) - 273.15;
    case 'snowDepth': { const d = cw.snowDepth(c); return d > 0.001 ? d : NaN; }
    case 'swe': { const s = cw.swe(c); return s > 0.1 ? s : NaN; }
    case 'ice': { const i = cw.iceThickness(c); return i > 0.0005 ? i : NaN; }
    case 'water': { const h = wf ? wf.h[c] : 0; return h > 0.001 ? h : NaN; }
    case 'soil': { let s = 0; for (let l = 0; l < 2; l++) s += cw.sW[c * cw.nl + l]; return s / (1000 * 0.08 * cw.cellArea); }
    case 'solar': return cw.surf.solar[c];
    default: return NaN;
  }
}

function airValue(k: Exclude<ClimateOverlay, 'off'>, a: number): number {
  const r = simulationController.getEnvironment().climate.rt;
  if (!r) return NaN;
  const air = r.trt.world.air;
  switch (k) {
    case 'airT': return air.T(a) - 273.15;
    case 'rh': return r.cw.rh(a) * 100;
    case 'vapour': return (r.cw.vap[a] / (air.H * air.cellArea)) * 1000;
    default: return NaN;
  }
}

function ClimateScene() {
  const viz = useViewStore((s) => s.climateViz);
  const env = simulationController.getEnvironment();
  const r = env.climate.rt;
  const t = env.terrain.data;
  const g = r?.trt.world.terrain;
  // Snow / ice cover: a vertex grid on the terrain vertices (one quad per cell).
  const coverGeo = useDisposable(() => {
    const geo = new THREE.BufferGeometry();
    if (!g) return geo;
    const nvx = g.nx + 1, nvz = g.nz + 1;
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nvx * nvz * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nvx * nvz * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const idx = new Uint32Array(g.nx * g.nz * 6);
    for (let iz = 0; iz < g.nz; iz++) for (let ix = 0; ix < g.nx; ix++) {
      const v = iz * nvx + ix, o = (iz * g.nx + ix) * 6;
      idx[o] = v; idx[o + 1] = v + nvx; idx[o + 2] = v + 1; idx[o + 3] = v + 1; idx[o + 4] = v + nvx; idx[o + 5] = v + nvx + 1;
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    return geo;
  }, [g]);
  const coverMat = useDisposable(() => new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.96, polygonOffset: true, polygonOffsetFactor: -2 }));
  // Overlays: 5 m air columns / 2 m surface patches.
  const airGrid = useMemo(() => (r ? { originX: r.trt.world.air.originX, originZ: r.trt.world.air.originZ, nx: r.trt.world.air.nx, nz: r.trt.world.air.nz, dx: 5 } : null), [r]);
  const cellGrid = useMemo(() => (g ? { originX: g.originX, originZ: g.originZ, nx: Math.ceil(g.nx / 2), nz: Math.ceil(g.nz / 2), dx: 2 * g.cell } : null), [g]);
  const airGeo = useDisposable(() => (airGrid ? columnGridGeometry(airGrid, (x, z) => env.terrain.sampleHeight(x, z), 0.45) : new THREE.BufferGeometry()), [airGrid]);
  const cellGeo = useDisposable(() => (cellGrid ? columnGridGeometry(cellGrid, (x, z) => env.terrain.sampleHeight(x, z), 0.5) : new THREE.BufferGeometry()), [cellGrid]);
  const overlayMat = useDisposable(() => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4 }));
  const shimmerMat = useDisposable(() => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.25, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  const shimmerGeo = useDisposable(() => (cellGrid ? columnGridGeometry(cellGrid, (x, z) => env.terrain.sampleHeight(x, z), 0.9) : new THREE.BufferGeometry()), [cellGrid]);
  // Stores: roof slabs, crown caps, vehicle slabs.
  const boxGeo = useDisposable(() => new THREE.BoxGeometry(1, 1, 1));
  const capGeo = useDisposable(() => new THREE.SphereGeometry(1, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2));
  const storeMat = useDisposable(() => new THREE.MeshLambertMaterial({ color: '#f4f8ff' }));
  const capMat = useDisposable(() => new THREE.MeshLambertMaterial({ color: '#f4f8ff', transparent: true, opacity: 0.85 }));
  const slabs = useDisposable(() => { const m = new THREE.InstancedMesh(boxGeo, storeMat, STORE_MAX); m.count = 0; m.frustumCulled = false; m.raycast = () => null; m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(STORE_MAX * 3), 3); return m; }, [boxGeo, storeMat]);
  const caps = useDisposable(() => { const m = new THREE.InstancedMesh(capGeo, capMat, STORE_MAX); m.count = 0; m.frustumCulled = false; m.raycast = () => null; return m; }, [capGeo, capMat]);
  // Particles (visual).
  const partGeo = useDisposable(() => {
    const geo = new THREE.BufferGeometry();
    const p = new Float32Array(PARTICLES * 3);
    for (let i = 0; i < PARTICLES; i++) { p[i * 3] = (Math.random() - 0.5) * 200; p[i * 3 + 1] = Math.random() * 40; p[i * 3 + 2] = (Math.random() - 0.5) * 200; }
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    return geo;
  });
  const partMat = useDisposable(() => new THREE.PointsMaterial({ color: '#ffffff', size: 0.18, transparent: true, opacity: 0.85, depthWrite: false }));
  const particles = useMemo(() => { const p = new THREE.Points(partGeo, partMat); p.frustumCulled = false; p.raycast = () => null; return p; }, [partGeo, partMat]);
  const st = useRef({ frame: 0, snowShare: 1, rate: 0 });
  useEffect(() => { st.current.frame = 0; }, [viz]);
  // Sun light follows the computed sun (visual), restored when the layer goes.
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const sun = scene.getObjectByName('sun') as THREE.DirectionalLight | undefined;
    if (!sun) return;
    const pos = sun.position.clone(), I = sun.intensity;
    return () => { sun.position.copy(pos); sun.intensity = I; };
  }, [scene]);

  useFrame((_, dt) => {
    const e = simulationController.getEnvironment();
    const rt = e.climate.rt;
    if (!rt || !g) return;
    const S = st.current, vs = useViewStore.getState().climateViz, cw = rt.cw;
    S.frame++;
    const wf = e.flood.field;
    if (S.frame % REFRESH === 1) {
      // Cover surface.
      if (vs.snow || vs.ice) {
        const nvx = g.nx + 1;
        const P = coverGeo.getAttribute('position') as THREE.BufferAttribute, C = coverGeo.getAttribute('color') as THREE.BufferAttribute;
        const pa = P.array as Float32Array, ca = C.array as Float32Array;
        for (let iz = 0; iz <= g.nz; iz++) for (let ix = 0; ix <= g.nx; ix++) {
          const v = iz * nvx + ix;
          const x = g.originX + ix * g.cell, z = g.originZ + iz * g.cell;
          const yT = t.heights[Math.min(t.nz - 1, iz) * t.nx + Math.min(t.nx - 1, ix)];
          let top = -Infinity, cr = 0, cg = 0, cb = 0, nc = 0;
          for (let dz = -1; dz <= 0; dz++) for (let dx = -1; dx <= 0; dx++) {
            const cx = ix + dx, cz = iz + dz;
            if (cx < 0 || cz < 0 || cx >= g.nx || cz >= g.nz) continue;
            const c = cz * g.nx + cx;
            if (!(cw.cM[c] > 0)) continue;
            const ice = cw.iceThickness(c), d = cw.snowDepth(c);
            if (!vs.ice && d < 0.001) continue;
            if (!vs.snow && ice < 0.0005) continue;
            const base = wf && wf.h[c] > 0.005 ? wf.bed[c] + wf.h[c] : yT;
            const h = base + (vs.snow ? d : 0) + (vs.ice ? Math.max(0.004, ice * 0.1) : 0) + 0.01;
            if (h > top) top = h;
            const col = d > 0.003 ? (cw.cLiq[c] > 0.02 * cw.cM[c] ? SLUSH : SNOW) : ice > 0.002 ? ICE : FROST;
            cr += col.r; cg += col.g; cb += col.b; nc++;
          }
          pa[v * 3] = x; pa[v * 3 + 2] = z;
          pa[v * 3 + 1] = nc ? top : yT - 0.3;
          if (nc) { ca[v * 3] = cr / nc; ca[v * 3 + 1] = cg / nc; ca[v * 3 + 2] = cb / nc; }
        }
        P.needsUpdate = true; C.needsUpdate = true;
        coverGeo.computeVertexNormals();
        coverGeo.computeBoundingSphere();
      }
      // Overlay.
      const k = vs.overlay;
      if (k !== 'off' && k !== 'roofLoad') {
        if (AIR_KEYS.has(k)) paintColumns(airGeo, airGrid!.nx * airGrid!.nz, (a) => airValue(k, a), (v, out) => climateColor(k, v, out));
        else paintColumns(cellGeo, cellGrid!.nx * cellGrid!.nz, (p) => { const px = p % cellGrid!.nx, pz = (p - px) / cellGrid!.nx; return cellValue(k, Math.min(g.nz - 1, pz * 2) * g.nx + Math.min(g.nx - 1, px * 2)); }, (v, out) => climateColor(k, v, out));
      }
      if (vs.shimmer) paintColumns(shimmerGeo, cellGrid!.nx * cellGrid!.nz, (p) => { const px = p % cellGrid!.nx, pz = (p - px) / cellGrid!.nx; const T = cellValue('surfaceT', Math.min(g.nz - 1, pz * 2) * g.nx + Math.min(g.nx - 1, px * 2)); return T > 40 ? Math.min(1, (T - 40) / 30) : NaN; }, (v, out) => out.setRGB(0.5 * v, 0.25 * v, 0.05 * v));
      // Stores.
      let ns = 0, nc = 0;
      if (vs.snow) for (const s of rt.stores) {
        const M = cw.sM[s.k];
        if (!(M > 0) || cw.sGone[s.k]) continue;
        const stI = cw.stores[s.k], ent = s.e;
        const rho = Math.max(80, cw.sRho[s.k]);
        const depth = M / (rho * stI.area);
        if (depth < 0.002) continue;
        const p = ent.pose.position;
        if (stI.kind === STORE.crown) {
          if (nc >= STORE_MAX) continue;
          const prm = ent.source.params as Record<string, number>;
          const rr = (prm.canopyRadius ?? 2) * Math.min(1.08, 0.7 + 0.04 * (M / stI.area));
          v0.set(p[0], p[1] + (prm.height ?? ent.dims[1]) - (prm.canopyRadius ?? 2) * 0.6, p[2]);
          s0.set(rr, Math.max(0.08, rr * 0.35 * Math.min(1, (M / stI.area) / 10)), rr);
          m4.compose(v0, q0.identity(), s0);
          caps.setMatrixAt(nc++, m4);
        } else {
          if (ns >= STORE_MAX) continue;
          const q = ent.pose.quaternion;
          q0.set(q[0], q[1], q[2], q[3]);
          v0.set(p[0], p[1] + ent.dims[1] + depth / 2, p[2]);
          s0.set(ent.dims[0] * 0.98, depth, ent.dims[2] * 0.98);
          m4.compose(v0, q0, s0);
          slabs.setMatrixAt(ns, m4);
          if (vs.overlay === 'roofLoad' && stI.kind === STORE.roof) climateColor('roofLoad', (M * 9.81) / stI.area / 1000, c0); else c0.set('#f4f8ff');
          slabs.setColorAt(ns, c0);
          ns++;
        }
      }
      slabs.count = ns; caps.count = nc;
      slabs.instanceMatrix.needsUpdate = true; caps.instanceMatrix.needsUpdate = true;
      if (slabs.instanceColor) slabs.instanceColor.needsUpdate = true;
      // Particle rate and phase from the computed precipitation (visual density only).
      const P = cw.forcing.precipRate(cw.time);
      let snowShare = 1;
      if (P > 0) {
        const ph = cw.spec.precipPhase ?? 'auto';
        snowShare = ph === 'snow' ? 1 : ph === 'rain' ? 0 : snowFraction(wetBulb(rt.liveStats().meanAirT, cw.bg.q, cw.p0));
      }
      S.rate = P; S.snowShare = snowShare;
      partMat.color.set(snowShare >= 0.5 ? '#ffffff' : '#9cc8ff');
      partMat.size = snowShare >= 0.5 ? 0.2 : 0.07;
    }
    if (vs.particles && S.rate > 0) {
      const n = Math.min(PARTICLES, Math.round(S.rate * 400));
      partGeo.setDrawRange(0, n);
      const pa = (partGeo.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
      const vfall = S.snowShare >= 0.5 ? 1.0 : 6.5;
      const fl = e.wind.flow(), U = e.wind.baseSpeed;
      const h = Math.min(0.1, dt) * simulationSpeed();
      for (let i = 0; i < n; i++) {
        pa[i * 3] += fl[0] * U * 0.6 * h; pa[i * 3 + 2] += fl[2] * U * 0.6 * h;
        pa[i * 3 + 1] -= vfall * h;
        if (pa[i * 3 + 1] < 0) { pa[i * 3 + 1] += 40; pa[i * 3] = (Math.random() - 0.5) * 200; pa[i * 3 + 2] = (Math.random() - 0.5) * 200; }
        if (pa[i * 3] > 100) pa[i * 3] -= 200; else if (pa[i * 3] < -100) pa[i * 3] += 200;
        if (pa[i * 3 + 2] > 100) pa[i * 3 + 2] -= 200; else if (pa[i * 3 + 2] < -100) pa[i * 3 + 2] += 200;
      }
      (partGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    } else partGeo.setDrawRange(0, 0);
    if (vs.shimmer) shimmerMat.opacity = 0.18 + 0.08 * Math.sin(performance.now() / 180);
    // Sun light direction / intensity from the computed sun.
    const sun = scene.getObjectByName('sun') as THREE.DirectionalLight | undefined;
    if (sun && cw.spec.solar !== 'off' && S.frame % REFRESH === 1) {
      const d = cw.sun.dir;
      if (cw.sun.elevation > 0) { sun.position.set(d[0] * 150, d[1] * 150, d[2] * 150); sun.intensity = 0.4 + 2.2 * Math.min(1, (cw.sun.direct * Math.sin(cw.sun.elevation) + cw.sun.diffuse) / 1000); }
      else sun.intensity = 0.15;
    }
  });

  const k = viz.overlay;
  return (
    <group name="climate-layer">
      <mesh geometry={coverGeo} material={coverMat} visible={viz.snow || viz.ice} raycast={() => null} receiveShadow />
      <mesh geometry={airGeo} material={overlayMat} visible={k !== 'off' && AIR_KEYS.has(k)} renderOrder={3} raycast={() => null} />
      <mesh geometry={cellGeo} material={overlayMat} visible={k !== 'off' && k !== 'roofLoad' && !AIR_KEYS.has(k)} renderOrder={3} raycast={() => null} />
      <mesh geometry={shimmerGeo} material={shimmerMat} visible={viz.shimmer} renderOrder={4} raycast={() => null} />
      <primitive object={slabs} visible={viz.snow} />
      <primitive object={caps} visible={viz.snow} />
      <primitive object={particles} visible={viz.particles} />
    </group>
  );
}

/** Current simulation speed (particles fall at simulated speed). */
function simulationSpeed(): number {
  const s = useSimStore.getState();
  return s.status === 'running' ? s.speed : 0;
}
