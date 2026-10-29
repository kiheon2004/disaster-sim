/**
 * Phase 17: modular buildings in the renderer, the editor stores and the locales; the per-story
 * structural model; terrain policy and the Phase 16 slope-alignment fix.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Vec3 } from '@/core/types';
import { createEmptyDocument, createWorldObject } from '@/world/WorldDocument';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { useBuildStore } from '@/editor/buildStore';
import { copySelection, pasteAt } from '@/app/buildActions';
import { SimRenderAdapter } from '@/rendering/sim/SimRenderAdapter';
import { staticRuntime } from '@/rendering/editor/EditorBatches';
import { flatSampler, samplerFor } from '@/terrain/TerrainSampler';
import { generateTerrain } from '@/terrain/TerrainPresets';
import { groundPose, isGrounded } from '@/terrain/groundPlacement';
import { stressScene } from '@/world/stressScene';
import { DEFAULT_PLACEMENT, planPlacement } from '@/editor/build/placementPlan';
import { StructuralModel } from '@/simulation/seismic/StructuralModel';
import { ko } from '@/i18n/locales/ko';
import { en } from '@/i18n/locales/en';
import { createDesign } from './design';
import { BUILDING_PRESETS, presetSpec, validateSpec, defaultSpec } from './spec';
import { analyzeBuilding } from './analysis';
import { convertLegacy } from './convert';
import { MATERIAL_IDS } from './materials';
import { MEMBER_TYPES, STRUCTURAL_ROLES, ROOF_TYPES, FACADE_STYLES, OCCUPANCIES } from './types';
import { removeMembers } from './edit';

const T = (x = 0, z = 0, y = 0) => ({ position: [x, y, z] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
const modular = (preset: string, x = 0, z = 0) => createWorldObject({ type: 'building', building: createDesign(presetSpec(preset)!, preset), seed: 3, transform: T(x, z) }, 1);
const cam = () => {
  const c = new THREE.PerspectiveCamera();
  c.position.set(0, 60, 80);
  c.updateMatrixWorld();
  return c;
};

describe('rendering (member layer)', () => {
  it('all modular buildings share six member meshes; legacy-only scenes create none', () => {
    const objs = [modular('house'), modular('apartment', 40), modular('office', -40), modular('tower', 0, -60)];
    const a = new SimRenderAdapter(staticRuntime(objs), flatSampler());
    a.update(cam(), 0, 0);
    const members = a.root.children.filter((o) => o.name.startsWith('members:'));
    expect(members).toHaveLength(6);
    const total = (members as THREE.InstancedMesh[]).reduce((t, m) => t + m.count, 0);
    expect(total).toBe(objs.reduce((t, o) => t + o.building!.members.length, 0));
    a.dispose();
    const legacy = new SimRenderAdapter(staticRuntime(stressScene(60).map((i, k) => createWorldObject(i, k + 1))), flatSampler());
    expect(legacy.root.children.some((o) => o.name.startsWith('members:'))).toBe(false);
    legacy.dispose();
  });

  it('interior members are culled until revealed; picking maps an instance back to building + member', () => {
    const o = modular('apartment');
    const a = new SimRenderAdapter(staticRuntime([o]), flatSampler());
    a.update(cam(), 0, 0);
    const meshes = a.root.children.filter((c) => c.name.startsWith('members:')) as THREE.InstancedMesh[];
    const m = new THREE.Matrix4();
    const hiddenCount = () => meshes.reduce((t, mesh) => {
      let h = 0;
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m);
        if (m.elements[0] === 0 && m.elements[5] === 0) h++;
      }
      return t + h;
    }, 0);
    const culled = hiddenCount();
    expect(culled).toBeGreaterThan(20); // interior columns / beams / slabs and the foundation
    a.setRevealed(o.id, true);
    expect(hiddenCount()).toBe(0);
    // Picking: every instance resolves to this building and a valid member.
    for (const mesh of meshes) {
      for (let i = 0; i < mesh.count; i += 17) {
        const hit = a.pickMember(mesh, i)!;
        expect(hit.owner).toBe(o.id);
        expect(o.building!.members[hit.member]).toBeDefined();
        expect(a.pick(mesh, i)).toBe(o.id);
      }
    }
    // A ray through the building hits it (bounds-first custom raycast).
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 8, 60), new THREE.Vector3(0, 0, -1));
    const hits = ray.intersectObject(a.root, true);
    expect(hits.length).toBeGreaterThan(0);
    expect(a.pick(hits[0].object, hits[0].instanceId)).toBe(o.id);
    a.dispose();
  });
});

describe('render LOD of modular buildings', () => {
  it('far away: windows / doors are not drawn; close again: back (hysteresis)', () => {
    const o = modular('apartment');
    const a = new SimRenderAdapter(staticRuntime([o]), flatSampler());
    const glass = () => a.root.children.find((c) => c.name === 'members:glass') as THREE.InstancedMesh;
    const visibleGlass = () => {
      const m = new THREE.Matrix4();
      let n = 0;
      for (let i = 0; i < glass().count; i++) { glass().getMatrixAt(i, m); if (m.elements[0] !== 0) n++; }
      return n;
    };
    const near = cam();
    a.update(near, 0, 0);
    const before = visibleGlass();
    expect(before).toBeGreaterThan(50);
    const far = new THREE.PerspectiveCamera();
    far.position.set(0, 50, 400);
    far.updateMatrixWorld();
    a.updateLodOnly(far);
    expect(visibleGlass()).toBe(0);
    a.updateLodOnly(near);
    expect(visibleGlass()).toBe(before);
    a.dispose();
  });
});

describe('per-story structural model', () => {
  it('per-story input equal to a uniform chain behaves like the uniform chain', () => {
    const mk = (stories: boolean) => {
      const sm = new StructuralModel();
      const n = 4, mass = 4e6, height = 14, period = 0.6;
      // Uniform chain stiffness that gives `period` (same formula as the model).
      const mf = mass / n, w1 = (2 * Math.PI) / period;
      const k = mf * (w1 / (2 * Math.sin(Math.PI / (2 * (2 * n + 1))))) ** 2;
      sm.add({
        ndof: n, mass, height, period, dampingRatio: 0.05, cyX: 0.3, cyZ: 0.3, hardening: 0.05, driftU: 0.04, yaw: 0, gravity: 9.81, foundation: null,
        stories: stories ? { mass: Array(n).fill(mf), height: Array(n).fill(height / n), kx: Array(n).fill(k), kz: Array(n).fill(k), fyX: Array(n).fill(1e12), fyZ: Array(n).fill(1e12) } : undefined,
      });
      sm.finalize();
      return sm;
    };
    const u = mk(false);
    const s = mk(true);
    expect(s.frequency(0)).toBeCloseTo(u.frequency(0), 6);
    // Elastic response to the same pulse (strengths not reached): close.
    for (const sm of [u, s]) for (let j = 1; j <= 4; j++) for (const ax of [0, 1]) sm.fy[2 * j + ax] = 1e12;
    let pu = 0, ps = 0;
    for (let i = 0; i < 300; i++) {
      const ag = i < 30 ? 3 * Math.sin((i / 30) * Math.PI) : 0;
      for (const sm of [u, s]) { sm.agx[0] = ag; sm.agz[0] = 0; sm.step(1 / 60); }
      pu = Math.max(pu, Math.abs(u.top[0]));
      ps = Math.max(ps, Math.abs(s.top[0]));
    }
    expect(ps / pu).toBeGreaterThan(0.97);
    expect(ps / pu).toBeLessThan(1.03);
  });

  it('scaleStory lowers one story along one axis; truncateFrom removes the stories above', () => {
    const sm = new StructuralModel();
    sm.add({ ndof: 3, mass: 3e6, height: 9, period: 0.4, dampingRatio: 0.05, cyX: 0.3, cyZ: 0.3, hardening: 0.05, driftU: 0.04, yaw: 0, gravity: 9.81, foundation: null,
      stories: { mass: [1e6, 1e6, 1e6], height: [3, 3, 3], kx: [5e8, 5e8, 5e8], kz: [4e8, 4e8, 4e8], fyX: [3e6, 2e6, 1e6], fyZ: [3e6, 2e6, 1e6] } });
    sm.finalize();
    const f0 = sm.frequency(0);
    sm.scaleStory(0, 1, 0, 0.5, 0.5);
    expect(sm.k[2 * 1]).toBeCloseTo(2.5e8);
    expect(sm.k[2 * 1 + 1]).toBeCloseTo(4e8);
    expect(sm.frequency(0)).toBeLessThanOrEqual(f0);
    sm.truncateFrom(0, 2, 9.81);
    expect(sm.m[2]).toBeLessThan(1e3);
    expect(sm.pdel[1]).toBeCloseTo((1e6 * 9.81) / 3, 0);
  });
});

describe('locales (KO / EN) cover every dynamic key', () => {
  it('materials, roles, member types, roof / facade / occupancy, issues, warnings, conversion, presets', () => {
    const keys: string[] = [];
    for (const m of MATERIAL_IDS) keys.push(`material.${m}`);
    for (const r of STRUCTURAL_ROLES) keys.push(`role.${r}`, `role.${r}.hint`);
    for (const t of MEMBER_TYPES) keys.push(`member.type.${t}`);
    for (const r of ROOF_TYPES) keys.push(`building.roof.${r}`);
    for (const f of FACADE_STYLES) keys.push(`building.facade.${f}`);
    for (const o of OCCUPANCIES) keys.push(`building.occupancy.${o}`);
    for (const p of BUILDING_PRESETS) keys.push(`building.preset.${p.id}`);
    for (const f of ['ductile', 'semiDuctile', 'brittle']) keys.push(`building.failure.${f}`);
    for (const p of ['refit', 'preserve']) keys.push(`building.policy.${p}`, `building.policy.${p}.hint`);
    // Every issue / warning code the model can produce.
    const issueCodes = ['notNumber', 'nonPositive', 'range', 'integer', 'tooTall', 'material', 'option', 'notStructural', 'masonryTall', 'timberTall', 'longSpan', 'softStory', 'weakPiers', 'coreIgnored', 'systemMaterial', 'tallNoCore', 'spreadTall'];
    for (const c of issueCodes) keys.push(`building.issue.${c}`);
    const produced = new Set(validateSpec({ ...defaultSpec(), width: -1 }).map((i) => i.code));
    for (const c of produced) expect(issueCodes).toContain(c);
    for (const c of ['unsupported', 'nonStructuralMaterial', 'overloaded', 'cantilever', 'noLateral', 'softStory', 'weakStory', 'noHost', 'noFoundation', 'periodCalibrated', 'torsion', 'onSoil']) keys.push(`building.warn.${c}`);
    const legacy = createWorldObject({ type: 'building', params: { floors: 3 }, transform: T() }, 1);
    for (const n of convertLegacy(legacy).notes) keys.push(`building.convert.${n.field}`, `building.convert.level.${n.level}`);
    for (const f of ['durability', 'breakThreshold', 'dragCoefficient', 'friction', 'shopWindow', 'scale', 'damping', 'foundationParams', 'seismicFactors']) keys.push(`building.convert.${f}`);
    for (const k of ['model', 'loadPath', 'stiffness', 'period', 'materials', 'damage', 'limits']) keys.push(`building.assumptions.${k}`);
    for (const k of keys) {
      expect(ko[k as keyof typeof ko], `ko ${k}`).toBeTruthy();
      expect(en[k as keyof typeof en], `en ${k}`).toBeTruthy();
    }
    // Every warning the presets produce has a message.
    for (const p of BUILDING_PRESETS) for (const w of analyzeBuilding(createDesign(p.spec)).warnings) expect(ko[`building.warn.${w.code}` as keyof typeof ko]).toBeTruthy();
  });
});

describe('editor: copy / paste, terrain policy and slope alignment', () => {
  function fresh(terrain = false) {
    useWorldStore.setState({ locked: false });
    const doc = createEmptyDocument('t');
    if (terrain) doc.terrain = generateTerrain('gentleHills', 5);
    useWorldStore.getState().replaceDocument(doc);
    useEditorStore.setState({ mode: 'editor', tool: 'select' });
  }

  it('copy / paste of a modular building: same design, new object id, references intact', () => {
    fresh();
    const [id] = useWorldStore.getState().applyEdit({ add: [{ type: 'building', building: removeMembers(createDesign(presetSpec('house')!), ['win0-s-0-0']).design, transform: T(), seed: 5 }] });
    useEditorStore.getState().select(id);
    expect(copySelection()).toBe(true);
    expect(useBuildStore.getState().clipboard).not.toBeNull();
    const [copy] = pasteAt(30, 0);
    const objs = useWorldStore.getState().doc.objects;
    expect(copy).not.toBe(id);
    expect(objs[copy].building).toEqual(objs[id].building);
    for (const m of objs[copy].building!.members) if (m.host) expect(objs[copy].building!.members.some((w) => w.id === m.host)).toBe(true);
    expect(objs[copy].transform.position[0]).toBeCloseTo(30);
  });

  it('terrain edit under a building: refit follows the ground; preserve keeps the world transform and freezes the foundation', () => {
    fresh(true);
    const w = useWorldStore.getState;
    const s = samplerFor(w().doc.terrain);
    const pose = groundPose({ type: 'building', params: createWorldObject({ type: 'building', building: createDesign(presetSpec('house')!), transform: T() }, 1).params, transform: T(20, 20) }, 20, 20, 0, s);
    const d = createDesign(presetSpec('house')!);
    const [refit, keep] = w().applyEdit({
      add: [
        { type: 'building', building: d, transform: { ...T(), position: pose.position, rotation: pose.rotation } },
        { type: 'building', building: { ...d, options: { ...d.options, foundationPolicy: 'preserve' } }, transform: { ...T(), position: pose.position, rotation: pose.rotation } },
      ],
    });
    const before = { refit: w().doc.objects[refit].transform.position[1], keep: w().doc.objects[keep].transform.position[1] };
    // Lower the ground under both.
    w().beginTerrainStroke();
    for (let i = 0; i < 8; i++) w().terrainDab({ op: 'lower', x: 20, z: 20, brush: { radius: 14, strength: 1 }, dt: 0.5 } as never);
    w().endTerrainStroke();
    const after = w().doc.objects;
    expect(after[refit].transform.position[1]).toBeLessThan(before.refit);
    expect(after[keep].transform.position[1]).toBe(before.keep);
    expect(after[keep].building!.options.plinthDepth).not.toBeNull();
    // Undo restores both the terrain and the buildings in one step.
    w().undo();
    expect(w().doc.objects[refit].transform.position[1]).toBe(before.refit);
    expect(w().doc.objects[keep].building!.options.plinthDepth).toBeNull();
  });

  it('Phase 16 known issue fixed: an object placed "along the slope" keeps that tilt when re-seated', () => {
    fresh(true);
    const s = samplerFor(useWorldStore.getState().doc.terrain);
    const plan = planPlacement({ type: 'wall' }, [{ x: 30, z: -25 }], { ...DEFAULT_PLACEMENT, align: 'surface', randomRotation: false, slopeLimit: 90, avoidCollisions: false }, { terrain: s, existing: null });
    expect(plan[0].input.terrainAlign).toBe(1);
    const o = createWorldObject(plan[0].input, 1);
    expect(isGrounded(o, s)).toBe(true);
    const re = groundPose(o, o.transform.position[0], o.transform.position[2], 0, s);
    expect(re.rotation[0]).toBeCloseTo(o.transform.rotation[0], 9);
    expect(re.rotation[2]).toBeCloseTo(o.transform.rotation[2], 9);
    // A default placement stays level (type rule).
    const level = createWorldObject(planPlacement({ type: 'wall' }, [{ x: 30, z: -25 }], { ...DEFAULT_PLACEMENT, randomRotation: false, slopeLimit: 90 }, { terrain: s, existing: null })[0].input, 2);
    expect(level.terrainAlign).toBeUndefined();
  });
});
