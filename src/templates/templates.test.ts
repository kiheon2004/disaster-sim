/**
 * Phase 20: world templates (built-ins, determinism, round trip, application) and the
 * blueprint library (CRUD, favorites, recent, duplicates, import / export, built-in examples).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { worldFingerprint } from '@/world/fingerprint';
import { BUILTIN_TEMPLATES, buildTemplate } from './builtin';
import { createTemplate, parseTemplate, serializeTemplate, templateDocument } from './template';
import { MemoryBackend, useLibraryStore, recentEntries } from '@/blueprints/library';
import { BUILTIN_BLUEPRINTS, buildBuiltinBlueprint } from '@/blueprints/builtin';
import { serializeBlueprint } from '@/blueprints/schema';
import { defaultPlacement, planPlacement } from '@/blueprints/place';

const NOW = '2026-10-11T00:00:00.000Z';
const S = () => useWorldStore.getState();
const L = () => useLibraryStore.getState();

describe('built-in world templates', { timeout: 300_000 }, () => {
  it('every template builds a valid, editable world; same kind + seed → identical world', () => {
    const counts: Record<string, number> = {};
    for (const kind of BUILTIN_TEMPLATES) {
      const a = buildTemplate(kind, 3, { now: NOW });
      const b = buildTemplate(kind, 3, { now: NOW });
      expect(worldFingerprint(b)).toBe(worldFingerprint(a));
      expect(serializeDocument(b)).toBe(serializeDocument(a));
      const r = parseDocument(serializeDocument(a));
      expect(r.ok).toBe(true);
      if (r.ok) expect(serializeDocument(r.doc)).toBe(serializeDocument(a));
      counts[kind] = Object.keys(a.objects).length;
    }
    expect(counts.emptyFlat).toBe(0);
    for (const k of BUILTIN_TEMPLATES.filter((k) => k !== 'emptyFlat')) expect(counts[k]).toBeGreaterThan(10);
    expect(counts.denseCity).toBeGreaterThan(counts.smallTown);
  });

  it('different seeds give different worlds', () => {
    expect(worldFingerprint(buildTemplate('smallTown', 1, { now: NOW }))).not.toBe(worldFingerprint(buildTemplate('smallTown', 2, { now: NOW })));
  });

  it('templates with an experiment setup carry their scenario; without it the scenario is reset', () => {
    const doc = buildTemplate('riverValley', 5, { now: NOW });
    expect(doc.scenario.flood.rain?.intensity).toBe(80);
    const withExp = createTemplate(doc, { name: 'rv' }, true, { now: NOW, id: 'tpl_a' });
    const without = createTemplate(doc, { name: 'rv' }, false, { now: NOW, id: 'tpl_b' });
    expect(templateDocument(withExp).scenario.flood.rain?.intensity).toBe(80);
    expect(templateDocument(without).scenario.flood.rain).toBeNull();
  });
});

describe('world template files', () => {
  it('template round trip: serialize → parse → serialize is identical; the world is the same', () => {
    const doc = buildTemplate('mountainVillage', 2, { now: NOW });
    const t = createTemplate(doc, { name: '산골 마을', description: 'd', tags: ['mountain'] }, false, { now: NOW, id: 'tpl_x' });
    const text = serializeTemplate(t);
    const r = parseTemplate(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(serializeTemplate(r.template)).toBe(text);
    expect(worldFingerprint({ ...r.doc, meta: doc.meta })).toBe(worldFingerprint(doc));
  });

  it('rejects broken template files', () => {
    expect(parseTemplate('{').ok).toBe(false);
    expect(parseTemplate(JSON.stringify({ format: 'nope' })).ok).toBe(false);
    const t = JSON.parse(serializeTemplate(createTemplate(buildTemplate('emptyFlat', 1, { now: NOW }), { name: 'e' }, false, { now: NOW, id: 'tpl_e' })));
    const bad = parseTemplate(JSON.stringify({ ...t, world: { ...t.world, schemaVersion: 99 } }));
    expect(bad.ok || bad.code).toBe('world');
    const evil = parseTemplate(`{"format":"disaster-sim/world-template","constructor":{"prototype":{}}}`);
    expect(evil.ok || evil.code).toBe('unsafe');
  });

  it('applying a template as a new world or over the current world (one undo step)', () => {
    S().setLocked(false);
    S().newDocument();
    S().applyEdit({ add: [{ type: 'car', seed: 1, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }] });
    const tdoc = buildTemplate('smallTown', 4, { now: NOW });
    const steps = S().past.length;
    // Over the current world: content replaced in ONE undo step.
    const t = createTemplate(tdoc, { name: 'town' }, false, { now: NOW, id: 'tpl_t' });
    const d = templateDocument(t);
    S().applyEdit({ remove: Object.keys(S().doc.objects), roads: d.roads, landscape: { base: { heights: d.landscape.base.heights, ground: d.landscape.base.ground, soil: d.terrain.soil, settings: d.terrain.settings }, features: d.landscape.features, next: d.landscape.next }, add: Object.values(d.objects).map((o) => ({ type: o.type, name: o.name, seed: o.seed, params: o.params, physics: o.physics, building: o.building, transform: o.transform, roadLink: o.roadLink, group: o.group })) });
    expect(S().past.length).toBe(steps + 1);
    expect(Object.keys(S().doc.objects).length).toBe(Object.keys(tdoc.objects).length);
    S().undo();
    expect(Object.keys(S().doc.objects).length).toBe(1);
    // As a new world.
    S().replaceDocument(templateDocument(t, 'New'));
    expect(S().doc.meta.name).toBe('New');
    expect(S().past.length).toBe(0);
  });
});

describe('blueprint library', { timeout: 300_000 }, () => {
  beforeEach(async () => {
    try { localStorage.clear(); } catch { /* node */ }
    await L().init(new MemoryBackend());
  });

  it('built-in examples are listed, generated on demand, valid and placeable', async () => {
    const all = L().all();
    expect(all.filter((e) => e.builtin && e.kind === 'blueprint')).toHaveLength(BUILTIN_BLUEPRINTS.length);
    expect(all.filter((e) => e.builtin && e.kind === 'world')).toHaveLength(BUILTIN_TEMPLATES.length);
    S().setLocked(false);
    S().newDocument();
    for (const b of BUILTIN_BLUEPRINTS) {
      const bp = buildBuiltinBlueprint(b.id);
      expect(serializeBlueprint(buildBuiltinBlueprint(b.id))).toBe(serializeBlueprint(bp)); // deterministic
      const c = bp.preview.counts;
      expect(c.objects + c.vegetation + c.roads + c.features).toBeGreaterThan(0);
      const plan = planPlacement(S().doc, bp, { ...defaultPlacement(), x: 0, z: 0 });
      expect(plan.report.errors.filter((e) => e.code !== 'empty')).toEqual([]);
    }
    expect((await L().loadBlueprint('builtin-riverBasin'))!.dependencies.some((d) => d.kind === 'riverInflowOutside' || d.kind === 'riverOutletOutside')).toBe(true);
  });

  it('create, rename, duplicate, favorite, recent, delete; built-ins are read-only', async () => {
    const bp = buildBuiltinBlueprint('house');
    const mine = { ...bp, id: 'bp_mine', meta: { ...bp.meta, name: '우리 집' } };
    await L().saveBlueprint(mine);
    expect(L().entries.map((e) => e.name)).toEqual(['우리 집']);
    await L().update('bp_mine', { name: 'Our house', tags: ['home'] });
    expect(L().entries[0].name).toBe('Our house');
    expect((await L().loadBlueprint('bp_mine'))!.meta.tags).toEqual(['home']);
    const copy = await L().duplicate('bp_mine', 'Copy');
    expect(copy!.id).not.toBe('bp_mine');
    expect(L().entries).toHaveLength(2);
    await L().toggleFavorite('bp_mine');
    await L().toggleFavorite('builtin-forest');
    expect(L().all().filter((e) => e.favorite).map((e) => e.id).sort()).toEqual(['bp_mine', 'builtin-forest']);
    await L().markUsed('builtin-crossroads');
    await new Promise((r) => setTimeout(r, 5));
    await L().markUsed('bp_mine');
    expect(recentEntries(L().all()).map((e) => e.id)).toEqual(['bp_mine', 'builtin-crossroads']);
    await L().remove('builtin-forest');
    await L().update('builtin-forest', { name: 'x' });
    expect(L().all().some((e) => e.id === 'builtin-forest' && e.name === 'forest')).toBe(true);
    await L().remove(copy!.id);
    expect(L().entries).toHaveLength(1);
  });

  it('export → import: validation, preview data, duplicate handling (same content / id clash → copy or replace)', async () => {
    const bp = buildBuiltinBlueprint('apartments');
    const mine = { ...bp, id: 'bp_apt', meta: { ...bp.meta, name: 'Apartments' } };
    await L().saveBlueprint(mine);
    const text = (await L().exportText('bp_apt'))!;
    const check = L().checkImport(text);
    expect(check.ok).toBe(true);
    if (!check.ok || check.kind !== 'blueprint') return;
    expect(check.duplicate?.sameContent).toBe(true);
    const copied = await L().commitImport(check, 'copy');
    expect(copied.id).not.toBe('bp_apt');
    const renamed = JSON.parse(text);
    renamed.meta.name = 'Apartments v2';
    const c2 = L().checkImport(JSON.stringify(renamed));
    if (!c2.ok || c2.kind !== 'blueprint') throw new Error('expected ok');
    expect(c2.duplicate?.sameContent).toBe(false);
    await L().commitImport(c2, 'replace');
    expect(L().entries.find((e) => e.id === 'bp_apt')!.name).toBe('Apartments v2');
    expect(L().checkImport('{"format":"disaster-sim/blueprint","version":2}').ok).toBe(false);
    // World templates import through the same dialog.
    const tpl = (await L().loadTemplate('builtin-tpl-emptyFlat'))!;
    const tc = L().checkImport(serializeTemplate({ ...tpl, id: 'tpl_flat' }));
    expect(tc.ok && tc.kind).toBe('world');
  });
});
