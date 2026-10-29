/**
 * Gravity preview in the editor (Phase 31): the experiment's field ALONE (over the project gravity) at the moment of
 * its largest departure from Earth gravity — arrows on the run's grid (same geometry / colours as the run), the local
 * sources' regions. The same GravityField the run uses, so the preview is the field the bodies will feel then.
 */
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { PhenomenonInstance } from '@/phenomena/types';
import type { GravitySpec } from '@/gravity/types';
import { GravityField } from '@/gravity/field';
import { gravityOutlook } from '@/gravity/outlook';
import { GRAVITY } from '@/core/units';
import { samplerFor } from '@/terrain/TerrainSampler';
import { useWorldStore } from '@/world/worldStore';
import { useDisposable } from '../useDisposable';
import { arrow3d, placeArrow } from './GravityLayer';

const SPACING = 9;

/** Local time of the largest departure of the global part from g₀ (the start when only local sources act). */
export function previewTime(spec: GravitySpec): number {
  const o = gravityOutlook(spec);
  let best = 0, t = Math.min(spec.duration * 0.5, spec.ramp ?? 0);
  for (const p of o.path) { const d = Math.hypot(p.gx, p.gy + GRAVITY, p.gz); if (d > best + 1e-9) { best = d; t = p.t; } }
  return spec.global ? t : Math.min(spec.duration - 1e-6, Math.max(t, spec.ramp ?? 0));
}

export function GravityPreview({ inst }: { inst: PhenomenonInstance }) {
  const terrain = useWorldStore((s) => s.doc.terrain);
  const spec = inst.spec as GravitySpec;
  const sampler = useMemo(() => samplerFor(terrain), [terrain]);
  const geo = useDisposable(() => arrow3d());
  const mat = useDisposable(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false }));
  const max = 2 * 23 * 23;
  const mesh = useDisposable(() => { const m = new THREE.InstancedMesh(geo, mat, max); m.count = 0; m.frustumCulled = false; m.raycast = () => null; return m; }, [geo, mat]);
  const srcGeo = useDisposable(() => new THREE.SphereGeometry(1, 24, 12));
  const srcMat = useDisposable(() => new THREE.MeshBasicMaterial({ color: '#ffb35c', wireframe: true, transparent: true, opacity: 0.4, depthWrite: false }));
  useEffect(() => {
    const f = new GravityField(GRAVITY);
    f.add({ id: inst.id, spec, start: 0 });
    f.prepare(previewTime(spec));
    const W = (terrain.nx - 1) * terrain.cellSize, D = (terrain.nz - 1) * terrain.cellSize;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3(), c = new THREE.Color(), g: [number, number, number] = [0, 0, 0];
    let n = 0;
    for (const h of [2, 14]) for (let z = terrain.originZ + SPACING / 2; z < terrain.originZ + D && n < max; z += SPACING) for (let x = terrain.originX + SPACING / 2; x < terrain.originX + W && n < max; x += SPACING) {
      const y = sampler.sampleHeight(x, z) + h;
      f.sample(x, y, z, g);
      placeArrow(mesh, n++, [x, y, z], g, m4, q, v, s, c);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [mesh, spec, terrain, sampler, inst.id]);
  return (
    <group name="gravity-preview">
      <primitive object={mesh} />
      {spec.sources.map((s, i) => (
        <mesh key={i} geometry={srcGeo} material={srcMat} position={[s.center[0], s.kind === 'region' && s.shape === 'column' ? sampler.sampleHeight(s.center[0], s.center[2]) : s.center[1], s.center[2]]} scale={[s.radius, s.kind === 'region' && s.shape === 'column' ? 40 : s.radius, s.radius]} raycast={() => null} />
      ))}
    </group>
  );
}
