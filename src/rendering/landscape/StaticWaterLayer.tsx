import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useWorldStore } from '@/world/worldStore';
import { initialWater } from '@/landscape/hydrology';

/**
 * Edit-mode preview of the water the natural features START with (filled lakes, rivers with an
 * initial depth): one merged mesh of the wet water-grid cells at their surface. It is a picture
 * of the initial state only — in a simulation the Phase 14 solver's water is shown instead.
 */
export function StaticWaterLayer() {
  const land = useWorldStore((s) => s.doc.landscape);
  const terrain = useWorldStore((s) => s.doc.terrain);
  const mesh = useMemo(() => {
    const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: '#3f86b8', transparent: true, opacity: 0.6, roughness: 0.15, metalness: 0.1, depthWrite: false }));
    m.renderOrder = 2;
    m.raycast = () => {};
    m.name = 'staticWater';
    return m;
  }, []);
  useEffect(() => () => {
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }, [mesh]);
  useEffect(() => {
    const depth = initialWater(land, terrain);
    const pos: number[] = [];
    if (depth) {
      const nx = terrain.nx - 1, cs = terrain.cellSize, h = terrain.heights, vx = terrain.nx;
      for (let i = 0; i < depth.length; i++) {
        if (depth[i] <= 0.01) continue;
        const ix = i % nx, iz = (i - ix) / nx, v = iz * vx + ix;
        const y = (h[v] + 2 * h[v + 1] + 2 * h[v + vx] + h[v + vx + 1]) / 6 + depth[i];
        const x0 = terrain.originX + ix * cs, z0 = terrain.originZ + iz * cs, x1 = x0 + cs, z1 = z0 + cs;
        pos.push(x0, y, z0, x0, y, z1, x1, y, z1, x0, y, z0, x1, y, z1, x1, y, z0);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    mesh.geometry.dispose();
    mesh.geometry = g;
    mesh.visible = pos.length > 0;
  }, [land, terrain, mesh]);
  return <primitive object={mesh} />;
}
