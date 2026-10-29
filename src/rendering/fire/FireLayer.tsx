/**
 * Fire visuals in simulation mode (Phase 27, render-only — they never feed the simulation), all
 * placed and sized from the run's computed fire state:
 *  - flames: one per computed flame (burning object / story side / room opening external flame) —
 *    height from Heskestad, diameter from the burning area, tilt from the wind (Thomas); the flicker
 *    is a visual animation only;
 *  - glow: a visual light pool on the ground under flames above 200 kW;
 *  - smoke: puffs over the air-layer columns and at the openings of smoky rooms, darker the denser
 *    the computed soot (visibility below 30 m); never drawn where there is none;
 *  - embers: visual-only sparks rising from large flames (no firebrand ignition is computed);
 *  - overlays: fire state / remaining fuel of every fuel item, heat release bars, smoke visibility map
 *    of the air layer, fire state of the building rooms.
 * Counts are bounded; every GPU resource is owned (useDisposable) and released with the component;
 * only built-in materials are used (no shader compilation at fire start).
 */
import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { IK, isBurning } from '@/fire/FireWorld';
import { visibility } from '@/fire/relations';
import { useViewStore } from '../viewStore';
import { useDisposable } from '../useDisposable';
import { fuelColor, hrrColor, ROOM_COLORS, stateColor, visibilityColor } from './fireColors';

const MAX_FLAMES = 400;
const MAX_GLOW = 200;
const MAX_SMOKE = 1600;
const MAX_EMBERS = 600;
const MAX_MARKS = 3000;
const MAX_ROOMS = 600;

const m4 = new THREE.Matrix4();
const v0 = new THREE.Vector3();
const v1 = new THREE.Vector3();
const s0 = new THREE.Vector3();
const q0 = new THREE.Quaternion();
const q1 = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const FLAT = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const c0 = new THREE.Color();

export function FireLayer() {
  const live = useSimStore((s) => s.fire !== null);
  if (!live) return null;
  return <FireScene />;
}

/** Cone with its base at y = 0 and apex at y = 1, vertex alpha fading to the tip. */
function flameGeometry(): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(1, 1, 14, 4, true);
  g.translate(0, 0.5, 0);
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    // Yellow base → orange → transparent red tip (normal blending: stays orange against a bright sky).
    const r = 1, gg = 0.78 - 0.58 * y, b = 0.22 - 0.2 * y, a = 0.92 * (1 - y) ** 1.2;
    col.set([r, gg, b, a], 4 * i);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  return g;
}

/** Soft round sprite (radial alpha) for smoke puffs and the glow pool. */
function puffTexture(): THREE.Texture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
    const a = r >= 1 ? 0 : (1 - r * r) ** 1.6;
    data.set([255, 255, 255, Math.round(255 * a)], 4 * (y * size + x));
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, n: number, colors: boolean): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(geo, mat, n);
  m.count = 0;
  m.frustumCulled = false;
  m.raycast = () => null;
  if (colors) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
  return m;
}

function FireScene() {
  const viz = useViewStore((s) => s.fireViz);
  const env = simulationController.getEnvironment();
  const flameGeo = useDisposable(() => flameGeometry());
  const flameMat = useDisposable(() => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
  const quadGeo = useDisposable(() => new THREE.PlaneGeometry(1, 1));
  const puffTex = useDisposable(() => puffTexture());
  const glowMat = useDisposable(() => new THREE.MeshBasicMaterial({ map: puffTex, color: '#ff5a1a', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0.2 }), [puffTex]);
  // Smoke in three density bins (per-instance alpha is not available on instanced meshes).
  const smokeMat0 = useDisposable(() => new THREE.MeshBasicMaterial({ map: puffTex, transparent: true, depthWrite: false, opacity: 0.12 }), [puffTex]);
  const smokeMat1 = useDisposable(() => new THREE.MeshBasicMaterial({ map: puffTex, transparent: true, depthWrite: false, opacity: 0.28 }), [puffTex]);
  const smokeMat2 = useDisposable(() => new THREE.MeshBasicMaterial({ map: puffTex, transparent: true, depthWrite: false, opacity: 0.4 }), [puffTex]);
  const emberGeo = useDisposable(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_EMBERS * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    return g;
  });
  const emberMat = useDisposable(() => new THREE.PointsMaterial({ color: '#ffb347', size: 0.22, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  const ringGeo = useDisposable(() => new THREE.RingGeometry(0.45, 0.7, 20));
  const ringMat = useDisposable(() => new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }));
  const barGeo = useDisposable(() => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
  const barMat = useDisposable(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85 }));
  const roomMat = useDisposable(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.28, depthWrite: false }));
  const boxGeo = useDisposable(() => new THREE.BoxGeometry(1, 1, 1));
  const gridGeo = useDisposable(() => new THREE.PlaneGeometry(1, 1));
  const gridMat = useDisposable(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }));

  const nCells = env.fire.rt?.trt.world.air.count ?? 1600;
  const flames = useDisposable(() => instanced(flameGeo, flameMat, MAX_FLAMES * 2, false), [flameGeo, flameMat]);
  const glows = useDisposable(() => instanced(quadGeo, glowMat, MAX_GLOW, false), [quadGeo, glowMat]);
  const smoke0 = useDisposable(() => instanced(quadGeo, smokeMat0, MAX_SMOKE, true), [quadGeo, smokeMat0]);
  const smoke1 = useDisposable(() => instanced(quadGeo, smokeMat1, MAX_SMOKE, true), [quadGeo, smokeMat1]);
  const smoke2 = useDisposable(() => instanced(quadGeo, smokeMat2, MAX_SMOKE, true), [quadGeo, smokeMat2]);
  const puffs = useRef<{ x: number; y: number; z: number; size: number; bin: number; c: number; phase: number }[]>([]);
  const marks = useDisposable(() => instanced(ringGeo, ringMat, MAX_MARKS, true), [ringGeo, ringMat]);
  const bars = useDisposable(() => instanced(barGeo, barMat, MAX_MARKS, true), [barGeo, barMat]);
  const rooms = useDisposable(() => instanced(boxGeo, roomMat, MAX_ROOMS, true), [boxGeo, roomMat]);
  const cells = useDisposable(() => instanced(gridGeo, gridMat, nCells, true), [gridGeo, gridMat, nCells]);
  const embers = useRef({ x: new Float32Array(MAX_EMBERS * 3), v: new Float32Array(MAX_EMBERS * 3), life: new Float32Array(MAX_EMBERS), n: 0, seed: 12345 });
  const last = useRef(-1);
  const flameData = useRef<{ x: number; y: number; z: number; L: number; D: number; Q: number; tx: number; tz: number; soot: number }[]>([]);

  useFrame(({ clock, camera }, delta) => {
    const fr = env.fire.rt;
    if (!fr) return;
    const vs = useViewStore.getState().fireViz;
    const t = clock.elapsedTime;
    const w = fr.trt.world, tr = env.terrain;
    // ── Data refresh at 4 Hz (state only changes with the simulation).
    if (t - last.current >= 0.25) {
      last.current = t;
      flameData.current = fr.flames.slice(0, MAX_FLAMES);
      // Glow pools.
      let ng = 0;
      if (vs.glow) for (const f of flameData.current) {
        if (f.Q < 1e6 || ng >= MAX_GLOW) continue;
        const R = 1.6 * f.D + 0.4 * f.L;
        m4.compose(v0.set(f.x, tr.sampleHeight(f.x, f.z) + 0.15, f.z), FLAT, s0.set(R, R, 1));
        glows.setMatrixAt(ng++, m4);
      }
      glows.count = ng;
      glows.instanceMatrix.needsUpdate = true;
      // Smoke puffs: air-layer columns and the openings of smoky rooms (computed soot); the bin
      // (opacity) and shade follow the visibility through it, the rise is a visual animation.
      const air = w.air;
      const list: typeof puffs.current = [];
      const puff = (x: number, y: number, z: number, Cs: number, size: number, n: number) => {
        const S = visibility(Cs);
        if (S > (size >= 6 ? 15 : 30)) return;
        const dark = Math.max(0, Math.min(1, 1 - Math.log10(Math.max(1, S)) / Math.log10(30)));
        // Haze stays in the faint bins; room smoke out of the openings may be dense.
        const bin = size >= 6 ? (dark > 0.75 ? 1 : 0) : dark > 0.66 ? 2 : dark > 0.4 ? 1 : 0;
        for (let k = 0; k < n && list.length < MAX_SMOKE * 3; k++) list.push({ x: x + ((k * 1.7) % 3) - 1.5, y: y + k * size * 0.45, z: z + ((k * 2.3) % 3) - 1.5, size, bin, c: 0.55 - 0.4 * dark, phase: (x * 0.37 + z * 0.61 + k) % 1 });
      };
      if (vs.smoke) {
        // Plumes above the flames: darkness and length from the soot each flame produces (kg/s).
        for (const f of flameData.current) {
          if (f.soot <= 0) continue;
          const n = Math.min(12, 3 + Math.round(3 * Math.log10(1 + f.soot * 1000)));
          const dark = Math.min(1, 0.25 + 0.25 * Math.log10(1 + f.soot * 1000));
          const bin = dark > 0.66 ? 2 : dark > 0.4 ? 1 : 0;
          for (let k = 0; k < n && list.length < MAX_SMOKE * 3; k++) {
            const size = Math.max(1.4, 0.7 * f.D) * (1 + 0.45 * k);
            list.push({ x: f.x + f.tx * k * 1.5 + 0.3 * Math.sin(k * 2.1), y: f.y + f.L + k * (0.45 * size), z: f.z + f.tz * k * 1.5 + 0.3 * Math.cos(k * 1.7), size, bin, c: 0.48 - 0.28 * dark, phase: (k * 0.37 + f.x * 0.11) % 1 });
          }
        }
        // Haze: the soot held in the air-layer columns (faint, low).
        for (let a = 0; a < air.count; a++) {
          const sk = fr.fw.soot[a];
          if (sk <= 0) continue;
          const x = air.originX + ((a % air.nx) + 0.5) * 5, z = air.originZ + (((a / air.nx) | 0) + 0.5) * 5;
          puff(x, tr.sampleHeight(x, z) + air.H / 2, z, sk / (air.H * air.cellArea), 7, 1);
        }
        for (const R of fr.rooms) {
          const FR = fr.fw.rooms[R.r];
          if (FR.soot <= 0 || FR.Ao <= 0) continue;
          for (const g of R.sideGeom) if (g) puff(g.P[0], g.P[1] + 0.8, g.P[2], FR.soot / FR.V, 2.2, 3);
        }
      }
      puffs.current = list;
      // Overlays.
      let nm = 0, nb = 0, nr = 0, nc = 0;
      const fw = fr.fw;
      if (vs.overlay === 'state' || vs.overlay === 'fuel' || vs.overlay === 'hrr') {
        for (let i = 0; i < fw.n && nm < MAX_MARKS; i++) {
          if (fw.gone[i] || fw.m0[i] <= 0) continue;
          const p = fw.pos(i);
          const size = Math.max(0.6, Math.min(4, fw.size[i] * 0.4));
          if (vs.overlay === 'hrr') {
            if (fw.hrr[i] <= 1e3) continue;
            const h = Math.max(0.3, 2.5 * (Math.log10(fw.hrr[i]) - 3));
            m4.compose(v0.set(p[0], p[1] + 1, p[2]), q1.identity(), s0.set(0.4, h, 0.4));
            bars.setMatrixAt(nb, m4);
            bars.setColorAt(nb, hrrColor(fw.hrr[i], c0));
            nb++;
            continue;
          }
          m4.compose(v0.set(p[0], p[1] + (fw.kind[i] === IK.contents ? 0.2 : 0.5), p[2]), FLAT, s0.set(size, size, size));
          marks.setMatrixAt(nm, m4);
          marks.setColorAt(nm, vs.overlay === 'state' ? stateColor(fw.state[i], c0) : fuelColor(fw.m[i] / fw.m0[i], c0));
          nm++;
        }
      }
      if (vs.overlay === 'rooms') {
        for (const R of fr.rooms) {
          if (nr >= MAX_ROOMS) break;
          const FR = fw.rooms[R.r];
          const cp = w.comps[FR.tc];
          const b = R.bt.bounds;
          const c = fr.trt.toWorld(R.bt.e, [(b.x0 + b.x1) / 2, R.y0 + R.h / 2, (b.z0 + b.z1) / 2]);
          const state = !cp.alive ? 'open' : !Number.isNaN(FR.flashover) ? (FR.ventLimited ? 'limited' : 'flashover') : FR.burning > 0 ? 'burning' : w.compT(FR.tc) - w.Tref > 20 ? 'warm' : 'cold';
          q0.set(R.bt.e.pose.quaternion[0], R.bt.e.pose.quaternion[1], R.bt.e.pose.quaternion[2], R.bt.e.pose.quaternion[3]);
          m4.compose(v0.set(c[0], c[1], c[2]), q0, s0.set(b.x1 - b.x0 + 0.3, R.h * 0.96, b.z1 - b.z0 + 0.3));
          rooms.setMatrixAt(nr, m4);
          rooms.setColorAt(nr, c0.set(ROOM_COLORS[state]));
          nr++;
        }
      }
      if (vs.overlay === 'smoke') {
        for (let a = 0; a < air.count && nc < nCells; a++) {
          const sk = fw.soot[a];
          if (sk <= 0) continue;
          const S = visibility(sk / (air.H * air.cellArea));
          if (S > 30) continue;
          const x = air.originX + ((a % air.nx) + 0.5) * 5, z = air.originZ + (((a / air.nx) | 0) + 0.5) * 5;
          m4.compose(v0.set(x, tr.sampleHeight(x, z) + 0.2, z), FLAT, s0.set(5, 5, 1));
          cells.setMatrixAt(nc, m4);
          cells.setColorAt(nc, visibilityColor(S, c0));
          nc++;
        }
      }
      for (const [m, n] of [[marks, nm], [bars, nb], [rooms, nr], [cells, nc]] as const) {
        m.count = n;
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    }
    // ── Smoke every frame: puffs rise and swell slowly over 4 s (visual), then start again.
    const bins = [smoke0, smoke1, smoke2], counts = [0, 0, 0];
    for (const p of puffs.current) {
      const m = bins[p.bin];
      const k = counts[p.bin];
      if (k >= MAX_SMOKE) continue;
      const u = (t * 0.25 + p.phase) % 1;
      const sz = p.size * (0.8 + 0.6 * u);
      m4.compose(v0.set(p.x, p.y + u * 3, p.z), camera.quaternion, s0.set(sz, sz, 1));
      m.setMatrixAt(k, m4);
      m.setColorAt(k, c0.setRGB(p.c, p.c, p.c + 0.01, THREE.SRGBColorSpace));
      counts[p.bin]++;
    }
    bins.forEach((m, b) => { m.count = counts[b]; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; });
    // ── Flames every frame (visual flicker around the computed height).
    let nf = 0;
    if (vs.flames) for (let k = 0; k < flameData.current.length; k++) {
      const f = flameData.current[k];
      // A flame is never drawn wider than it is tall (a wide opening with a short flame is a row of short flames).
      const L = Math.max(0.3, f.L), R = Math.max(0.15, Math.min(0.45 * f.D, 0.5 * L));
      const flick = 1 + 0.12 * Math.sin(t * 9.1 + k * 1.7) + 0.06 * Math.sin(t * 17.3 + k * 0.9);
      v1.set(f.tx, 1, f.tz).normalize();
      q0.setFromUnitVectors(UP, v1);
      m4.compose(v0.set(f.x, f.y, f.z), q0, s0.set(R, L * flick, R));
      flames.setMatrixAt(nf++, m4);
      m4.compose(v0.set(f.x, f.y, f.z), q0, s0.set(R * 0.55, L * 0.6 * flick, R * 0.55));
      flames.setMatrixAt(nf++, m4);
    }
    flames.count = nf;
    flames.instanceMatrix.needsUpdate = true;
    // ── Embers (visual only): spawn from large flames, rise and drift with the wind, fade.
    const E = embers.current;
    const dtv = Math.min(0.05, delta);
    if (vs.embers) {
      const rnd = () => { E.seed = (E.seed * 1664525 + 1013904223) >>> 0; return E.seed / 4294967296; };
      for (const f of flameData.current) {
        if (f.Q < 3e5) continue;
        const rate = Math.min(40, f.Q / 1e6 * 8);
        let spawn = rate * dtv;
        while (spawn > 0 && E.n < MAX_EMBERS) {
          if (spawn < 1 && rnd() > spawn) break;
          spawn -= 1;
          const i = E.n++;
          E.x.set([f.x + (rnd() - 0.5) * f.D, f.y + f.L * (0.3 + 0.5 * rnd()), f.z + (rnd() - 0.5) * f.D], 3 * i);
          E.v.set([w.u10 * w.flowX * 0.6 + (rnd() - 0.5) * 1.5, 2 + 3 * rnd(), w.u10 * w.flowZ * 0.6 + (rnd() - 0.5) * 1.5], 3 * i);
          E.life[i] = 1.5 + 2.5 * rnd();
        }
      }
    }
    let k = 0;
    for (let i = 0; i < E.n; i++) {
      E.life[i] -= dtv;
      if (E.life[i] <= 0 || !vs.embers) continue;
      for (let a = 0; a < 3; a++) E.x[3 * i + a] += E.v[3 * i + a] * dtv;
      E.v[3 * i + 1] -= 0.4 * dtv;
      if (k !== i) { E.x.copyWithin(3 * k, 3 * i, 3 * i + 3); E.v.copyWithin(3 * k, 3 * i, 3 * i + 3); E.life[k] = E.life[i]; }
      k++;
    }
    E.n = k;
    (emberGeo.attributes.position.array as Float32Array).set(E.x.subarray(0, 3 * k));
    emberGeo.attributes.position.needsUpdate = true;
    emberGeo.setDrawRange(0, k);
    void isBurning;
  });

  return (
    <group name="fire-layer">
      <primitive object={glows} />
      <primitive object={flames} />
      <primitive object={smoke0} />
      <primitive object={smoke1} />
      <primitive object={smoke2} />
      <points geometry={emberGeo} material={emberMat} frustumCulled={false} raycast={() => null} />
      {viz.overlay !== 'off' && <primitive object={marks} />}
      {viz.overlay === 'hrr' && <primitive object={bars} />}
      {viz.overlay === 'rooms' && <primitive object={rooms} />}
      {viz.overlay === 'smoke' && <primitive object={cells} />}
    </group>
  );
}
