/**
 * Water rendering (Phase 14): Simulation State → render-only water surface.
 *
 *  - WaterSurface: one mesh on the water grid's corners (201 × 201 vertices). Each vertex takes
 *    the surface elevation of the wet cells around it, their mean depth and velocity; dry
 *    vertices sink under the ground. The shader colors by depth (shallow / deep), shows a
 *    depth heatmap, flow streaks moving with the water or a flow-speed map, fades out at the
 *    shoreline and adds faceted ripples (low-poly look).
 *  - FlowArrows: instanced arrows on an 8 m lattice, oriented along the flow, sized / colored
 *    by speed (Flow Direction mode, or on demand).
 *  - WaterProbeMarker: the point picked for the flood inspector.
 *
 * Everything here READS the WaterField (refreshed only when the solver advanced, ≤ 15 Hz);
 * the ripple animation lives in the shader and never touches the simulation.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import type { WaterField } from '@/simulation/water/WaterField';
import { useViewStore, type FloodVizMode } from '../../viewStore';
import { DEPTH_STOPS, SPEED_STOPS, stopUniforms } from './waterColors';

const UPDATE_INTERVAL = 1 / 15;
/** Vertices of dry cells are pushed this far under the ground. */
const DRY_DROP = 0.3;
/** Lift above the computed surface against z-fighting with flat ground. */
const LIFT = 0.012;

const MODE_ID: Record<FloodVizMode, number> = { normal: 0, depth: 1, flow: 2, speed: 3 };

/** Render statistics (perf HUD / benchmarks). */
export const waterRenderStats = { updates: 0, ms: 0, vertices: 0 };

const vertexShader = /* glsl */ `
  attribute float aDepth;
  attribute vec2 aVel;
  uniform float uTime;
  varying float vDepth;
  varying vec2 vVel;
  varying vec3 vWorld;
  void main() {
    vec3 p = position;
    // Render-only ripples (never fed back into the simulation).
    float a = smoothstep(0.03, 0.5, aDepth) * 0.03;
    p.y += a * (sin(p.x * 0.9 + uTime * 1.7) * cos(p.z * 0.8 - uTime * 1.3) + 0.5 * sin((p.x + p.z) * 1.7 - uTime * 2.3));
    vDepth = aDepth;
    vVel = aVel;
    vec4 w = modelMatrix * vec4(p, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uMode;
  uniform vec3 uDepthC[6];
  uniform float uDepthV[6];
  uniform vec3 uSpeedC[6];
  uniform float uSpeedV[6];
  uniform vec3 uSun;
  varying float vDepth;
  varying vec2 vVel;
  varying vec3 vWorld;

  vec3 rampDepth(float x) {
    vec3 c = uDepthC[0];
    for (int i = 1; i < 6; i++) c = mix(c, uDepthC[i], clamp((x - uDepthV[i - 1]) / max(1e-4, uDepthV[i] - uDepthV[i - 1]), 0.0, 1.0));
    return c;
  }
  vec3 rampSpeed(float x) {
    vec3 c = uSpeedC[0];
    for (int i = 1; i < 6; i++) c = mix(c, uSpeedC[i], clamp((x - uSpeedV[i - 1]) / max(1e-4, uSpeedV[i] - uSpeedV[i - 1]), 0.0, 1.0));
    return c;
  }

  void main() {
    if (vDepth < 0.003) discard;
    // Faceted normal from screen-space derivatives (low-poly look).
    vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    if (n.y < 0.0) n = -n;
    vec3 view = normalize(cameraPosition - vWorld);
    float diff = 0.62 + 0.38 * max(dot(n, uSun), 0.0);
    float spec = pow(max(dot(reflect(-uSun, n), view), 0.0), 40.0) * 0.35;
    float speed = length(vVel);
    vec3 col;
    float alpha;
    if (uMode > 0.5 && uMode < 1.5) {
      col = rampDepth(vDepth);
      alpha = 0.9;
      spec *= 0.3;
    } else if (uMode > 2.5) {
      col = rampSpeed(speed);
      alpha = 0.9;
      spec *= 0.3;
    } else {
      // Shallow water: light and clear; deep water: dark and opaque.
      float k = smoothstep(0.0, 1.6, vDepth);
      col = mix(vec3(0.16, 0.48, 0.62), vec3(0.015, 0.09, 0.24), k);
      alpha = mix(0.42, 0.88, k);
    }
    // Streaks drifting with the water: show where it goes and how fast.
    float streakAmt = uMode > 1.5 && uMode < 2.5 ? 0.9 : (uMode < 0.5 ? 0.4 : 0.0);
    if (streakAmt > 0.0 && speed > 0.02) {
      vec2 dir = vVel / speed;
      vec2 perp = vec2(-dir.y, dir.x);
      float along = dot(vWorld.xz, dir);
      float across = dot(vWorld.xz, perp);
      float lane = smoothstep(0.82, 0.9, fract(across * 0.42 + floor(along * 0.12) * 0.37));
      float ph = fract(along * 0.22 - uTime * speed * 0.22);
      float dash = smoothstep(0.0, 0.15, ph) * (1.0 - smoothstep(0.45, 0.6, ph));
      col = mix(col, vec3(0.92, 0.98, 1.0), lane * dash * smoothstep(0.03, 0.5, speed) * streakAmt);
      if (uMode > 1.5) alpha = max(alpha, 0.7);
    }
    alpha *= smoothstep(0.003, 0.03, vDepth);
    gl_FragColor = vec4(col * diff + vec3(spec), alpha);
    #include <colorspace_fragment>
  }
`;

function createMaterial() {
  const d = stopUniforms(DEPTH_STOPS);
  const s = stopUniforms(SPEED_STOPS);
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uMode: { value: 0 },
      uDepthC: { value: d.colors },
      uDepthV: { value: d.values },
      uSpeedC: { value: s.colors },
      uSpeedV: { value: s.values },
      uSun: { value: new THREE.Vector3(0.45, 0.85, 0.3).normalize() },
    },
  });
}

/** Corner-vertex mesh over the water grid with dynamic y / depth / velocity. */
class WaterMesh {
  readonly geometry = new THREE.BufferGeometry();
  private readonly nvx: number;
  private readonly pos: Float32Array;
  private readonly depth: Float32Array;
  private readonly vel: Float32Array;
  private readonly eta: Float32Array;
  private readonly cnt: Uint8Array;
  private readonly around: Uint8Array;
  private readonly ground: Float32Array;

  constructor(private readonly f: WaterField) {
    const nvx = (this.nvx = f.nx + 1);
    const nvz = f.nz + 1;
    const n = nvx * nvz;
    this.pos = new Float32Array(n * 3);
    this.depth = new Float32Array(n);
    this.vel = new Float32Array(n * 2);
    this.eta = new Float32Array(n);
    this.cnt = new Uint8Array(n);
    this.around = new Uint8Array(n);
    this.ground = new Float32Array(n);
    const heights = f.terrain.data.heights;
    for (let vz = 0; vz < nvz; vz++) {
      for (let vx = 0; vx < nvx; vx++) {
        const i = vz * nvx + vx;
        this.pos[i * 3] = f.originX + vx * f.cell;
        this.pos[i * 3 + 2] = f.originZ + vz * f.cell;
        this.ground[i] = heights[i] ?? 0;
        this.pos[i * 3 + 1] = this.ground[i] - DRY_DROP;
        this.around[i] = (vx > 0 && vx < nvx - 1 ? 2 : 1) * (vz > 0 && vz < nvz - 1 ? 2 : 1);
      }
    }
    const index = new Uint32Array(f.nx * f.nz * 6);
    let k = 0;
    for (let iz = 0; iz < f.nz; iz++) {
      for (let ix = 0; ix < f.nx; ix++) {
        const a = iz * nvx + ix;
        const b = a + 1;
        const c = a + nvx;
        const d = c + 1;
        // Same diagonal as the terrain: (x1,z0)–(x0,z1).
        index[k++] = a; index[k++] = c; index[k++] = b;
        index[k++] = b; index[k++] = c; index[k++] = d;
      }
    }
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aDepth', new THREE.BufferAttribute(this.depth, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aVel', new THREE.BufferAttribute(this.vel, 2).setUsage(THREE.DynamicDrawUsage));
    const half = (f.nx * f.cell) / 2;
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(f.originX + half, 0, f.originZ + half), half * 1.5 + 50);
    waterRenderStats.vertices = n;
  }

  /** Copy the water field into the vertex buffers. */
  update() {
    const t0 = performance.now();
    const f = this.f;
    const { nvx, eta, cnt, depth, vel, pos, ground, around } = this;
    eta.fill(0);
    cnt.fill(0);
    depth.fill(0);
    vel.fill(0);
    if (f.hasWater()) {
      for (let iz = f.z0; iz <= f.z1; iz++) {
        for (let ix = f.x0; ix <= f.x1; ix++) {
          const i = iz * f.nx + ix;
          const h = f.h[i];
          if (h <= 0) continue;
          const e = f.bed[i] + h;
          const u = f.u[i];
          const v = f.v[i];
          const a = iz * nvx + ix;
          const wet = h > 0.002;
          // The cell's four corners (unrolled: no allocation in this loop).
          for (let k = 0; k < 4; k++) {
            const j = a + (k & 1) + (k >> 1) * nvx;
            depth[j] += h;
            if (!wet) continue;
            eta[j] += e;
            cnt[j]++;
            vel[j * 2] += u;
            vel[j * 2 + 1] += v;
          }
        }
      }
    }
    for (let j = 0; j < cnt.length; j++) {
      const c = cnt[j];
      if (c > 0) {
        pos[j * 3 + 1] = eta[j] / c + LIFT;
        depth[j] /= around[j];
        vel[j * 2] /= c;
        vel[j * 2 + 1] /= c;
      } else {
        pos[j * 3 + 1] = ground[j] - DRY_DROP;
        depth[j] = 0;
      }
    }
    const g = this.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aDepth.needsUpdate = true;
    g.attributes.aVel.needsUpdate = true;
    waterRenderStats.updates++;
    waterRenderStats.ms += performance.now() - t0;
  }

  dispose() {
    this.geometry.dispose();
  }
}

function WaterSurface({ field }: { field: WaterField }) {
  const mesh = useMemo(() => new WaterMesh(field), [field]);
  const material = useMemo(createMaterial, []);
  const lastRev = useRef(-1);
  const since = useRef(Infinity);
  useEffect(() => () => {
    mesh.dispose();
  }, [mesh]);
  useEffect(() => () => material.dispose(), [material]);

  useFrame(({ clock }, dt) => {
    material.uniforms.uTime.value = clock.elapsedTime;
    material.uniforms.uMode.value = MODE_ID[useViewStore.getState().floodViz.mode];
    since.current += dt;
    if (field.rev === lastRev.current || since.current < UPDATE_INTERVAL) return;
    since.current = 0;
    lastRev.current = field.rev;
    mesh.update();
  });

  return <mesh geometry={mesh.geometry} material={material} renderOrder={2} raycast={() => null} frustumCulled={false} />;
}

// ── Flow arrows ───────────────────────────────────────────

const ARROW_SPACING = 8;
const color = new THREE.Color();
const dummy = new THREE.Object3D();
const vel: [number, number] = [0, 0];
const speedColors = SPEED_STOPS.map(([v, c]) => [v, new THREE.Color(c)] as const);

function speedColor(s: number, out: THREE.Color) {
  out.copy(speedColors[0][1]);
  for (let i = 1; i < speedColors.length; i++) {
    const [v0] = speedColors[i - 1];
    const [v1, c1] = speedColors[i];
    out.lerp(c1, Math.min(1, Math.max(0, (s - v0) / (v1 - v0))));
  }
  return out;
}

function arrowGeometry() {
  const shaft = new THREE.BoxGeometry(0.7, 0.05, 0.08).translate(0.35, 0, 0);
  const head = new THREE.ConeGeometry(0.2, 0.3, 6).rotateZ(-Math.PI / 2).translate(0.85, 0, 0);
  const g = mergeGeometries([shaft.toNonIndexed(), head.toNonIndexed()])!;
  shaft.dispose();
  head.dispose();
  return g;
}

function FlowArrows({ field }: { field: WaterField }) {
  const show = useViewStore((s) => s.floodViz.arrows || s.floodViz.mode === 'flow');
  const ref = useRef<THREE.InstancedMesh>(null);
  const geometry = useMemo(arrowGeometry, []);
  const material = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8, depthWrite: false }), []);
  const points = useMemo(() => {
    const out: [number, number][] = [];
    const size = field.nx * field.cell;
    for (let z = ARROW_SPACING / 2; z < size; z += ARROW_SPACING) for (let x = ARROW_SPACING / 2; x < size; x += ARROW_SPACING) out.push([field.originX + x, field.originZ + z]);
    return out;
  }, [field]);
  const lastRev = useRef(-1);
  useEffect(() => () => {
    geometry.dispose();
    material.dispose();
  }, [geometry, material]);

  useFrame(() => {
    const mesh = ref.current;
    if (!mesh) return;
    mesh.visible = show && field.hasWater();
    if (!mesh.visible || field.rev === lastRev.current) return;
    lastRev.current = field.rev;
    for (let i = 0; i < points.length; i++) {
      const [x, z] = points[i];
      const eta = field.sampleSurface(x, z);
      const d = eta === -Infinity ? 0 : eta - field.terrain.sampleHeight(x, z);
      field.sampleVelocity(x, z, vel);
      const s = Math.hypot(vel[0], vel[1]);
      if (d < 0.05 || s < 0.05) {
        dummy.scale.set(0, 0, 0);
      } else {
        const len = Math.min(5, 0.8 + s * 1.5);
        dummy.position.set(x, eta + 0.08, z);
        dummy.rotation.set(0, Math.atan2(-vel[1], vel[0]), 0);
        dummy.scale.set(len, 1, 1 + Math.min(1.5, s * 0.5));
        mesh.setColorAt(i, speedColor(s, color));
      }
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  return <instancedMesh ref={ref} args={[geometry, material, points.length]} frustumCulled={false} raycast={() => null} renderOrder={4} />;
}

// ── Probe marker ──────────────────────────────────────────

function WaterProbeMarker() {
  const probe = useViewStore((s) => s.waterProbe);
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const g = ref.current;
    if (!g || !probe) return;
    const env = simulationController.getEnvironment();
    const ground = env.terrain.sampleHeight(probe.x, probe.z);
    const eta = env.flood.field?.sampleSurface(probe.x, probe.z) ?? -Infinity;
    g.position.set(probe.x, Math.max(ground, eta === -Infinity ? ground : eta) + 0.05, probe.z);
    g.scale.setScalar(1 + 0.08 * Math.sin(clock.elapsedTime * 4));
  });
  if (!probe) return null;
  return (
    <group ref={ref}>
      <mesh rotation-x={-Math.PI / 2} raycast={() => null} renderOrder={5}>
        <ringGeometry args={[0.55, 0.8, 24]} />
        <meshBasicMaterial color="#ffd166" transparent opacity={0.95} depthTest={false} />
      </mesh>
      <mesh position-y={1.2} raycast={() => null} renderOrder={5}>
        <coneGeometry args={[0.28, 0.7, 12]} />
        <meshBasicMaterial color="#ffd166" depthTest={false} />
      </mesh>
    </group>
  );
}

/** Mounted in the simulation scene; draws nothing until the water model is active. */
export function WaterLayer() {
  // Re-render when the water model activates (the field object appears).
  const active = useSimStore((s) => s.flood !== null);
  const version = useSimStore((s) => s.runtimeVersion);
  // Hidden water layers are not mounted at all (no mesh refresh, no draw calls).
  const visible = useViewStore((s) => s.floodViz.visible);
  const field = active && visible ? simulationController.getEnvironment().flood.field : null;
  return (
    <>
      {field && <WaterSurface key={`s${version}`} field={field} />}
      {field && <FlowArrows key={`a${version}`} field={field} />}
      <WaterProbeMarker />
    </>
  );
}
