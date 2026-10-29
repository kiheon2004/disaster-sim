import type * as THREE from 'three';

/**
 * Phase 33: the visual lean of a standing extended person — its balance lean θ (rad, along the body's local x and z;
 * the COM is offset by h_c·θ) applied as a rotation about the soles on top of the physics pose (the physics body of a
 * standing person stays upright; rendering only). θ₁ > 0 moves the head towards local +x, θ₂ > 0 towards local +z.
 */
export function leanQuaternion(base: readonly number[], th: readonly number[], out: THREE.Quaternion, tmp: THREE.Quaternion, euler: THREE.Euler): THREE.Quaternion {
  out.set(base[0], base[1], base[2], base[3]);
  return out.multiply(tmp.setFromEuler(euler.set(th[1], 0, -th[0], 'XYZ')));
}
