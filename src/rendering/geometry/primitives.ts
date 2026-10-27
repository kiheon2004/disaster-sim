import * as THREE from 'three';

/** Shared unit geometries. Meshes scale these instead of allocating new geometry. */
export const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
export const UNIT_CYLINDER = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
