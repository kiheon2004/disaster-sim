import * as THREE from 'three';
import { createContext, useContext } from 'react';

/**
 * Material cache + "material mode" so the same view components can render
 * normal objects, the placement ghost, or an invalid-placement ghost.
 */
export type MaterialMode = 'normal' | 'ghost' | 'ghostInvalid';
export const MaterialModeContext = createContext<MaterialMode>('normal');

export interface MatOptions {
  roughness?: number;
  metalness?: number;
  emissive?: string;
  emissiveIntensity?: number;
  opacity?: number;
}

const cache = new Map<string, THREE.MeshStandardMaterial>();

export function getMaterial(color: string, o: MatOptions = {}): THREE.MeshStandardMaterial {
  const key = `${color}|${o.roughness ?? 0.85}|${o.metalness ?? 0}|${o.emissive ?? ''}|${o.emissiveIntensity ?? 0}|${o.opacity ?? 1}`;
  let m = cache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      roughness: o.roughness ?? 0.85,
      metalness: o.metalness ?? 0,
      flatShading: true,
      emissive: o.emissive ? new THREE.Color(o.emissive) : undefined,
      emissiveIntensity: o.emissiveIntensity ?? 0,
      transparent: (o.opacity ?? 1) < 1,
      opacity: o.opacity ?? 1,
    });
    cache.set(key, m);
  }
  return m;
}

const ghostValid = new THREE.MeshStandardMaterial({
  color: '#6fa1ff', transparent: true, opacity: 0.45, depthWrite: false, emissive: new THREE.Color('#2b5cc4'), emissiveIntensity: 0.4,
});
const ghostInvalid = new THREE.MeshStandardMaterial({
  color: '#ff6b6b', transparent: true, opacity: 0.45, depthWrite: false, emissive: new THREE.Color('#a32020'), emissiveIntensity: 0.4,
});

/** Hook used by every view: resolves a color to the right material for the current mode. */
export function useMat() {
  const mode = useContext(MaterialModeContext);
  return (color: string, o?: MatOptions): THREE.Material =>
    mode === 'ghost' ? ghostValid : mode === 'ghostInvalid' ? ghostInvalid : getMaterial(color, o);
}

export function useMaterialMode() {
  return useContext(MaterialModeContext);
}

/** Darken/lighten a hex color by a factor (−1..1). */
export function shade(hex: string, amount: number): string {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, Math.min(1, Math.max(0, hsl.l + amount)));
  return `#${c.getHexString()}`;
}
