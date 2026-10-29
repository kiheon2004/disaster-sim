/**
 * Regression guards for the Phase 15–16 selection memory growth (Phase 17 §2).
 *
 * Root cause (measured with scripts/bench-selection-memory.mjs): drei mounts TransformControls as
 * an R3F <primitive>, which R3F never disposes; the controls keep document / canvas pointer
 * listeners until dispose(), so each selection change retained the whole gizmo (~330 KB).
 * The browser benchmark is the end-to-end check (`ASSERT=1`); these tests keep the fix in place.
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { selectionBoxEdges } from '@/rendering/SelectionBox';

const SRC = path.resolve(__dirname, '..');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return sources(p);
    return /\.(tsx?|jsx?)$/.test(d.name) && !d.name.endsWith('.test.ts') ? [p] : [];
  });
}

describe('gizmo lifecycle', () => {
  it('every TransformControls goes through the disposing wrapper', () => {
    const offenders = sources(SRC).filter((f) => {
      if (f.endsWith('ManagedTransformControls.tsx')) return false;
      const text = fs.readFileSync(f, 'utf8');
      return /import\s*{[^}]*\bTransformControls\b[^}]*}\s*from\s*'@react-three\/drei'/.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it('the wrapper disposes the controls on unmount', () => {
    const text = fs.readFileSync(path.join(SRC, 'editor/ManagedTransformControls.tsx'), 'utf8');
    expect(text).toMatch(/useEffect\(\(\) => \(\) => {\s*instance\.current\?\.dispose\(\)/);
  });

  it('selection outline geometry frees its temporary box and is disposable', () => {
    const spy = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const g = selectionBoxEdges([2, 3, 4]);
    expect(spy).toHaveBeenCalledTimes(1); // the temporary BoxGeometry
    expect(g.getAttribute('position').count).toBe(24); // 12 edges
    g.dispose();
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
