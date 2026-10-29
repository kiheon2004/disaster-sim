/**
 * Celestial sources in the simulation (Phase 32, render-only — reads env.gravity, never writes):
 *  - cores: a black sphere at each source (radius = its capture radius, or ε/3 for a compact mass) with an emissive
 *    rim — a picture of where the source is, not a computed horizon or photon ring
 *  - bounds: capture sphere (red, a model parameter), softening sphere ε (cyan: inside it the field is the Plummer
 *    core), influence radius (grey, when set), and the radius inside which the integrator would exceed its substep
 *    cap (magenta, when outside the capture sphere)
 *  - slice: a horizontal plane through the first source coloured by the computed |g|, |Φ|, tidal stretch λ₁ or
 *    escape speed (fixed log legends), or the model zones
 *  - disc / lens: the visual accretion disc and lens halo — ILLUSTRATIVE (no fluid, radiation or ray tracing)
 *  - particles: the physical test particles (computed orbits); probes and their trails (computed)
 *  - tidal: principal stretch axes of the computed gradient tensor on the slice
 */
import { useMemo } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { useViewStore } from '../viewStore';
import { useDisposable } from '../useDisposable';
import { celestialColor, speedColor, ZONE_COLORS } from './celestialColors';
import { symEigenvalues, symEigenvector } from '@/celestial/tidal';
import { CELESTIAL_LIMITS } from '@/celestial/types';
import { TRAIL } from '@/simulation/celestial/runtime';

const SLICE = 96;
const SLICE_SIZE = 240;
const AXES = 17;
const REFRESH = 0.2;
const MAX_PROBES = 16;

/** Radius inside which a 1/60 s step would need more than the substep cap (m; 0 when none). */
export function limitRadius(mu: number, eps: number): number {
  const L = CELESTIAL_LIMITS;
  const q = ((Math.sqrt(mu) * (1 / 60)) / (L.eta * L.substeps)) ** (4 / 3);
  return Math.sqrt(Math.max(0, q - eps * eps));
}

const rimVert = `varying vec3 vN; varying vec3 vV;
void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`;
const rimFrag = `varying vec3 vN; varying vec3 vV; uniform vec3 uColor;
void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 3.0); gl_FragColor = vec4(uColor * f * 1.6, f); }`;
const discVert = `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;
const discFrag = `varying vec2 vP; uniform float uIn; uniform float uOut; uniform float uTime;
void main(){ float r = length(vP); float x = clamp((r - uIn)/(uOut - uIn), 0.0, 1.0); float a = atan(vP.y, vP.x);
  float swirl = 0.55 + 0.45*sin(10.0*a + 14.0*log(r + 1.0) - uTime*2.5);
  float glow = pow(1.0 - x, 2.2) * smoothstep(0.0, 0.06, x);
  vec3 c = mix(vec3(1.0,0.95,0.8), vec3(0.9,0.35,0.08), x);
  gl_FragColor = vec4(c * glow * swirl * 1.4, glow * swirl * 0.9); }`;

export function CelestialLayer() {
  const live = useSimStore((s) => s.celestial !== null);
  return live ? <CelestialScene /> : null;
}

function CelestialScene() {
  const viz = useViewStore((s) => s.celestialViz);
  const env = simulationController.getEnvironment();
  const sliceGeo = useDisposable(() => {
    const g = new THREE.PlaneGeometry(SLICE_SIZE, SLICE_SIZE, SLICE - 1, SLICE - 1).rotateX(-Math.PI / 2);
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(SLICE * SLICE * 3), 3));
    return g;
  });
  const sliceMat = useDisposable(() => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide }));
  const ball = useDisposable(() => new THREE.SphereGeometry(1, 40, 24));
  const coreMat = useDisposable(() => new THREE.MeshBasicMaterial({ color: '#000000' }));
  const rimMat = useDisposable(() => new THREE.ShaderMaterial({ vertexShader: rimVert, fragmentShader: rimFrag, uniforms: { uColor: { value: new THREE.Color('#ffb070') } }, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  const wire = (c: string, o: number) => new THREE.MeshBasicMaterial({ color: c, wireframe: true, transparent: true, opacity: o, depthWrite: false });
  const capMat = useDisposable(() => wire('#ff4a4a', 0.55));
  const epsMat = useDisposable(() => wire('#5fd0ff', 0.35));
  const infMat = useDisposable(() => wire('#9a9a9a', 0.12));
  const limMat = useDisposable(() => wire('#d24bd8', 0.4));
  const discGeo = useDisposable(() => new THREE.RingGeometry(0.02, 1, 160, 8));
  const discMat = useDisposable(() => new THREE.ShaderMaterial({ vertexShader: discVert, fragmentShader: discFrag, uniforms: { uIn: { value: 1 }, uOut: { value: 2 }, uTime: { value: 0 } }, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  const lensMat = useDisposable(() => new THREE.MeshPhysicalMaterial({ transmission: 1, roughness: 0, ior: 1.5, thickness: 6, transparent: true, opacity: 1, metalness: 0, attenuationColor: new THREE.Color('#ffffff') }));
  const ptsGeo = useDisposable(() => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * CELESTIAL_LIMITS.particles * 4), 3)); g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(3 * CELESTIAL_LIMITS.particles * 4), 3)); g.setDrawRange(0, 0); return g; });
  const ptsMat = useDisposable(() => new THREE.PointsMaterial({ size: 0.45, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false }));
  const probeMat = useDisposable(() => new THREE.MeshBasicMaterial({ color: '#ffffff' }));
  const probes = useDisposable(() => { const m = new THREE.InstancedMesh(ball, probeMat, MAX_PROBES); m.count = 0; m.frustumCulled = false; m.raycast = () => null; return m; }, [ball, probeMat]);
  const trailGeo = useDisposable(() => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PROBES * TRAIL * 2 * 3), 3)); g.setDrawRange(0, 0); return g; });
  const trailMat = useDisposable(() => new THREE.LineBasicMaterial({ color: '#7ff0c0', transparent: true, opacity: 0.6 }));
  const axisGeo = useDisposable(() => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(AXES * AXES * 6), 3)); g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(AXES * AXES * 6), 3)); g.setDrawRange(0, 0); return g; });
  const axisMat = useDisposable(() => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }));
  const tmp = useMemo(() => ({ c: new THREE.Color(), g: [0, 0, 0] as [number, number, number], T: new Float64Array(9), n: [0, 0, 0] as [number, number, number], m4: new THREE.Matrix4(), q: new THREE.Quaternion(), v: new THREE.Vector3(), s: new THREE.Vector3(), last: -1, viz: null as unknown, flash: 0, count: 0 }), []);
  const group = useMemo(() => new THREE.Group(), []);
  const slice = useMemo(() => { const m = new THREE.Mesh(sliceGeo, sliceMat); m.raycast = () => null; m.renderOrder = 3; return m; }, [sliceGeo, sliceMat]);
  const points = useMemo(() => { const p = new THREE.Points(ptsGeo, ptsMat); p.frustumCulled = false; p.raycast = () => null; return p; }, [ptsGeo, ptsMat]);
  const trails = useMemo(() => { const l = new THREE.LineSegments(trailGeo, trailMat); l.frustumCulled = false; l.raycast = () => null; return l; }, [trailGeo, trailMat]);
  const axes = useMemo(() => { const l = new THREE.LineSegments(axisGeo, axisMat); l.frustumCulled = false; l.raycast = () => null; return l; }, [axisGeo, axisMat]);

  useFrame((_, delta) => {
    const f = env.gravity.field, cel = env.gravity.rt?.celestial;
    const vs = useViewStore.getState().celestialViz;
    if (!f || !cel) return;
    (discMat.uniforms.uTime.value as number) += delta;
    const time = simulationController.getTime();
    // Probes and particles every frame (they move fast); the rest every REFRESH s of simulated time.
    let np = 0, nt = 0;
    const tp = trailGeo.getAttribute('position') as THREE.BufferAttribute, ta = tp.array as Float32Array;
    const speed = vs.overlay === 'speed';
    const vRatio = (x: number, y: number, z: number, vx: number, vy: number, vz: number) => Math.hypot(vx, vy, vz) / Math.max(1e-9, Math.sqrt(2 * Math.abs(f.points.potential(x, y, z))));
    for (const p of cel.probes) {
      if (p.body === null || np >= MAX_PROBES) continue;
      tmp.m4.compose(tmp.v.set(p.pos[0], p.pos[1], p.pos[2]), tmp.q.identity(), tmp.s.setScalar(p.radius));
      if (speed) speedColor(vRatio(p.pos[0], p.pos[1], p.pos[2], p.vel[0], p.vel[1], p.vel[2]), tmp.c); else tmp.c.set('#7ff0c0');
      probes.setColorAt(np, tmp.c);
      probes.setMatrixAt(np++, tmp.m4);
      if (vs.trails) for (let k = 1; k < p.trailN; k++) {
        const a = (p.trailHead - k + TRAIL) % TRAIL, b = (p.trailHead - k - 1 + TRAIL) % TRAIL;
        if (k + 1 > p.trailN) break;
        for (let i = 0; i < 3; i++) { ta[6 * nt + i] = p.trail[3 * a + i]; ta[6 * nt + 3 + i] = p.trail[3 * b + i]; }
        nt++;
      }
    }
    probes.count = np;
    probes.instanceMatrix.needsUpdate = true;
    if (probes.instanceColor) probes.instanceColor.needsUpdate = true;
    trailGeo.setDrawRange(0, 2 * nt);
    tp.needsUpdate = true;
    const N = cel.pstate.length;
    const pa = ptsGeo.getAttribute('position') as THREE.BufferAttribute, pc = ptsGeo.getAttribute('color') as THREE.BufferAttribute;
    const P = pa.array as Float32Array, C = pc.array as Float32Array;
    let n = 0;
    if (vs.particles) for (let i = 0; i < N && n < P.length / 3; i++) {
      const st = cel.pstate[i];
      if (st !== 1 && st !== 2) continue;
      P[3 * n] = cel.px[3 * i]; P[3 * n + 1] = cel.px[3 * i + 1]; P[3 * n + 2] = cel.px[3 * i + 2];
      if (st === 1 && speed) { speedColor(vRatio(cel.px[3 * i], cel.px[3 * i + 1], cel.px[3 * i + 2], cel.pv[3 * i], cel.pv[3 * i + 1], cel.pv[3 * i + 2]), tmp.c); C[3 * n] = tmp.c.r; C[3 * n + 1] = tmp.c.g; C[3 * n + 2] = tmp.c.b; }
      else if (st === 1) { C[3 * n] = 1; C[3 * n + 1] = 0.78; C[3 * n + 2] = 0.45; } else { C[3 * n] = 0.5; C[3 * n + 1] = 0.48; C[3 * n + 2] = 0.45; }
      n++;
    }
    ptsGeo.setDrawRange(0, n);
    pa.needsUpdate = true; pc.needsUpdate = true;
    // Capture flash: the rim brightens for a moment after each capture.
    if (cel.ledger.count !== tmp.count) { tmp.count = cel.ledger.count; tmp.flash = 1; }
    tmp.flash = Math.max(0, tmp.flash - delta * 1.5);
    (rimMat.uniforms.uColor.value as THREE.Color).setRGB(1, 0.69 + 0.31 * tmp.flash, 0.44 + 0.56 * tmp.flash);
    if (Math.abs(time - tmp.last) < REFRESH && tmp.last >= 0 && tmp.viz === vs) return;
    tmp.last = time;
    tmp.viz = vs;
    group.clear();
    const lens = cel.experiments.some((e) => e.spec.lensing);
    for (const l of f.points.live) {
      const eps = Math.sqrt(l.eps2), cap = Math.sqrt(l.cap2);
      const r = cap > 0 ? cap : Math.max(0.3, eps / 3);
      const add = (geo: THREE.BufferGeometry, mat: THREE.Material, s: number, show: boolean) => {
        if (!show || !(s > 0)) return;
        const m = new THREE.Mesh(geo, mat);
        m.position.set(l.x, l.y, l.z);
        m.scale.setScalar(s);
        m.raycast = () => null;
        group.add(m);
      };
      add(ball, coreMat, r, vs.cores);
      add(ball, rimMat, r * 1.35, vs.cores);
      add(ball, capMat, cap, vs.bounds && cap > 0);
      add(ball, epsMat, eps, vs.bounds);
      add(ball, infMat, l.R, vs.bounds && l.R < Infinity);
      const rl = limitRadius(l.mu, eps);
      add(ball, limMat, rl, vs.bounds && rl > cap);
      add(ball, lensMat, Math.max(3 * r, 2 * eps), vs.lens && lens);
      const exp = cel.experiments[l.owner]?.spec;
      if (vs.disc && exp?.accretion.visual && (exp.accretion.source ?? 0) === l.index) {
        const inner = Math.max(1.6 * r, 0.8 * eps), outer = Math.max(inner * 2.5, exp.accretion.outer);
        const d = new THREE.Mesh(discGeo, discMat);
        // Unit ring scaled to the outer radius; the shader fades it in from inner / outer.
        d.position.set(l.x, l.y, l.z);
        d.rotation.x = -Math.PI / 2;
        d.scale.setScalar(outer);
        discMat.uniforms.uIn.value = inner / outer;
        discMat.uniforms.uOut.value = 1;
        d.raycast = () => null;
        group.add(d);
      }
    }
    const first = f.points.live[0];
    const o = vs.overlay;
    if (o !== 'off' && o !== 'speed' && first) {
      slice.position.set(first.x, first.y, first.z);
      const col = sliceGeo.getAttribute('color') as THREE.BufferAttribute, ca = col.array as Float32Array;
      const h = SLICE_SIZE / (SLICE - 1);
      for (let iz = 0; iz < SLICE; iz++) for (let ix = 0; ix < SLICE; ix++) {
        const x = first.x - SLICE_SIZE / 2 + ix * h, z = first.z - SLICE_SIZE / 2 + iz * h, y = first.y;
        const k = iz * SLICE + ix;
        if (o === 'zones') {
          const near = f.points.nearest(x, y, z);
          const l = f.points.live[near.k];
          const e2 = Math.sqrt(l.eps2), cap = Math.sqrt(l.cap2);
          const zi = near.d <= cap ? 2 : near.d < limitRadius(l.mu, e2) ? 3 : near.d < 3 * e2 ? 1 : 0;
          tmp.c.set(ZONE_COLORS[zi]);
        } else if (o === 'accel') celestialColor('accel', Math.hypot(...f.sample(x, y, z, tmp.g)), tmp.c);
        else if (o === 'potential') celestialColor('potential', Math.abs(f.points.potential(x, y, z)), tmp.c);
        else if (o === 'escape') celestialColor('escape', Math.sqrt(2 * Math.abs(f.points.potential(x, y, z))), tmp.c);
        else celestialColor('tidal', symEigenvalues(f.gradient(x, y, z, tmp.T))[0], tmp.c);
        ca[3 * k] = tmp.c.r; ca[3 * k + 1] = tmp.c.g; ca[3 * k + 2] = tmp.c.b;
      }
      col.needsUpdate = true;
    }
    // Principal stretch axes on the slice.
    let na = 0;
    if (vs.tidal && first) {
      const ap = axisGeo.getAttribute('position') as THREE.BufferAttribute, ac = axisGeo.getAttribute('color') as THREE.BufferAttribute;
      const A = ap.array as Float32Array, AC = ac.array as Float32Array;
      const h = SLICE_SIZE / (AXES - 1);
      for (let iz = 0; iz < AXES; iz++) for (let ix = 0; ix < AXES; ix++) {
        const x = first.x - SLICE_SIZE / 2 + ix * h, z = first.z - SLICE_SIZE / 2 + iz * h, y = first.y;
        const T = f.gradient(x, y, z, tmp.T);
        const l1 = symEigenvalues(T)[0];
        if (!(l1 > 1e-5)) continue;
        symEigenvector(T, l1, tmp.n);
        const L = Math.min(6, 1 + Math.log10(l1 / 1e-5));
        for (let i = 0; i < 3; i++) { A[6 * na + i] = [x, y, z][i] - tmp.n[i] * L; A[6 * na + 3 + i] = [x, y, z][i] + tmp.n[i] * L; }
        celestialColor('tidal', l1, tmp.c);
        for (let j = 0; j < 2; j++) { AC[6 * na + 3 * j] = tmp.c.r; AC[6 * na + 3 * j + 1] = tmp.c.g; AC[6 * na + 3 * j + 2] = tmp.c.b; }
        na++;
      }
      ap.needsUpdate = true; ac.needsUpdate = true;
    }
    axisGeo.setDrawRange(0, 2 * na);
  });

  return (
    <group name="celestial-layer">
      <primitive object={group} />
      <primitive object={slice} visible={viz.overlay !== 'off' && viz.overlay !== 'speed'} />
      <primitive object={points} visible={viz.particles} />
      <primitive object={probes} />
      <primitive object={trails} visible={viz.trails} />
      <primitive object={axes} visible={viz.tidal} />
    </group>
  );
}
