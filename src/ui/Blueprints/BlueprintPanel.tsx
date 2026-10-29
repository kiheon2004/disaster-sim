/**
 * Blueprint tab (Phase 20): library browser (search, categories, favorites, recent, cards with
 * map pictures, details and actions), capture form and placement form. Everything works with
 * the mouse; no command needs to be typed.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { translate, useLocale, useT, type MessageKey } from '@/i18n/i18n';
import { useEditorStore } from '@/editor/editorStore';
import { useBlueprintStore, type LibraryFilter } from '@/editor/blueprintStore';
import { LIBRARY_CATEGORIES, recentEntries, useLibraryStore, type LibraryEntry } from '@/blueprints/library';
import { BLUEPRINT_CATEGORIES, type BlueprintDependency, type BoundaryPolicy, type CaptureInclude } from '@/blueprints/types';
import { ROAD_POLICIES, TERRAIN_POLICIES, type PlacementIssue } from '@/blueprints/place';
import {
  alignToObjects, alignToRoad, applyTemplate, backToLibrary, confirmPlacement, deleteEntry, duplicateEntry, ensureThumbnail, entryName, exportEntry,
  importFile, initLibrary, pinPlacement, recomputeCapture, renameEntry, rotatePlacement, saveCapture, schedulePlan, setPlacementYaw, startCapture, startPlacement,
} from '@/app/blueprintActions';
import { Icon } from '@/ui/common/Icon';
import { NumberField, SliderField } from '@/ui/common/fields';
import { Segmented } from '@/ui/common/Segmented';
import panel from '@/ui/Terrain/TerrainPanel.module.css';
import palette from '@/ui/ObjectPalette/ObjectPalette.module.css';
import styles from './Blueprints.module.css';

const fmt = (v: number, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toString();

export function BlueprintPanel() {
  const mode = useBlueprintStore((s) => s.mode);
  const ready = useLibraryStore((s) => s.ready);
  useEffect(() => { void initLibrary(); }, []);
  // Leaving the tab ends a capture / placement (the viewport tool goes back to select).
  useEffect(() => () => { if (useBlueprintStore.getState().mode !== 'library') backToLibrary(); }, []);
  return (
    <div className={styles.root} data-testid="blueprint-panel">
      {mode === 'capture' ? <CaptureForm /> : mode === 'place' ? <PlaceForm /> : ready ? <Library /> : <div className={palette.empty}>…</div>}
    </div>
  );
}

// ── Library ─────────────────────────────────────────────────────────────────

function Header() {
  const t = useT();
  const editing = useEditorStore((s) => s.mode) === 'editor';
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const go = (k: 'rect' | 'polygon' | 'selection') => { setOpen(false); startCapture(k); };
  return (
    <div className={styles.head}>
      <div className={styles.menuWrap} ref={ref}>
        <button className={`${styles.headBtn} ${styles.primary}`} disabled={!editing} data-testid="bp-new" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
          <Icon name="plus" size={13} /> {t('bp.act.newCapture')}
        </button>
        {open && (
          <div className={styles.menu} role="menu">
            <button role="menuitem" data-testid="bp-capture-rect" onClick={() => go('rect')}><Icon name="area" size={13} /> {t('bp.act.captureRect')}</button>
            <button role="menuitem" data-testid="bp-capture-polygon" onClick={() => go('polygon')}><Icon name="line" size={13} /> {t('bp.act.capturePolygon')}</button>
            <button role="menuitem" data-testid="bp-capture-selection" onClick={() => go('selection')}><Icon name="cursor" size={13} /> {t('bp.act.captureSelection')}</button>
          </div>
        )}
      </div>
      <button className={styles.headBtn} data-testid="bp-import" onClick={() => void importFile()}><Icon name="folder" size={13} /> {t('bp.act.import')}</button>
      <button className={styles.headBtn} disabled={!editing} data-testid="bp-save-template" onClick={() => useBlueprintStore.getState().setTemplateDialog(true)}><Icon name="save" size={13} /> {t('bp.act.saveTemplate')}</button>
      <button className={styles.headBtn} disabled={!editing} data-testid="bp-new-world" onClick={() => useBlueprintStore.getState().setWizardOpen(true)}><Icon name="globe" size={13} /> {t('bp.act.newWorld')}</button>
    </div>
  );
}

function matches(e: LibraryEntry, q: string): boolean {
  if (!q) return true;
  const name = e.builtinKey ? `${translate('ko', `${e.builtinKey}.name` as MessageKey)} ${translate('en', `${e.builtinKey}.name` as MessageKey)} ${translate('ko', `${e.builtinKey}.desc` as MessageKey)} ${translate('en', `${e.builtinKey}.desc` as MessageKey)}` : `${e.name} ${e.description}`;
  const cat = `${translate('ko', `bp.cat.${e.category}` as MessageKey)} ${translate('en', `bp.cat.${e.category}` as MessageKey)}`;
  return [name, cat, ...e.tags].join(' ').toLowerCase().includes(q);
}

function Library() {
  const t = useT();
  useLocale();
  const entries = useLibraryStore((s) => s.entries);
  const builtinState = useLibraryStore((s) => s.builtinState);
  const thumbs = useLibraryStore((s) => s.builtinThumbs);
  const cache = useLibraryStore((s) => s.cache);
  const all = useMemo(() => useLibraryStore.getState().all(), [entries, builtinState, thumbs, cache]); // eslint-disable-line react-hooks/exhaustive-deps
  const query = useBlueprintStore((s) => s.query);
  const filter = useBlueprintStore((s) => s.filter);
  const selectedId = useBlueprintStore((s) => s.selectedId);
  const q = query.trim().toLowerCase();
  const visible = all.filter((e) => (filter === 'all' || (filter === 'favorites' ? e.favorite : e.category === filter)) && matches(e, q));
  const recent = recentEntries(all, 8);
  const cats = LIBRARY_CATEGORIES.filter((c) => all.some((e) => e.category === c));
  const selected = all.find((e) => e.id === selectedId) ?? null;
  const userCount = entries.length;
  return (
    <>
      <Header />
      <div className={palette.searchBox}>
        <Icon name="search" size={13} />
        <input value={query} placeholder={t('bp.lib.search')} aria-label={t('bp.lib.search')} data-testid="bp-search" onChange={(e) => useBlueprintStore.getState().setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && useBlueprintStore.getState().setQuery('')} />
      </div>
      <div className={palette.chips} role="radiogroup" aria-label={t('bp.lib.filter.all')}>
        {(['all', 'favorites', ...cats] as LibraryFilter[]).map((f) => (
          <button key={f} role="radio" aria-checked={filter === f} data-filter={f} className={`${palette.chip} ${filter === f ? palette.chipOn : ''}`} onClick={() => useBlueprintStore.getState().setFilter(f)}>
            {f === 'all' ? t('bp.lib.filter.all') : f === 'favorites' ? <>★ {t('bp.lib.filter.favorites')}</> : t(`bp.cat.${f}`)}
          </button>
        ))}
      </div>
      <div className={palette.scroll} data-testid="bp-library">
        {!q && filter === 'all' && recent.length > 0 && (
          <div className={palette.cat}>
            <div className={palette.catTitle}>{t('bp.lib.recent')}</div>
            <div className={styles.recent}>
              {recent.map((e) => (
                <button key={e.id} className={styles.recentItem} title={entryName(e)} onClick={() => useBlueprintStore.getState().select(e.id)}>
                  {e.thumbnail ? <img src={e.thumbnail} alt="" /> : <div className={styles.ph} />}
                  <span>{entryName(e)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {!userCount && !q && filter === 'all' && <div className={palette.empty}>{t('bp.lib.empty')}</div>}
        {visible.length === 0 && <div className={palette.empty}>{t('bp.lib.noResults')}</div>}
        {LIBRARY_CATEGORIES.map((cat) => {
          const items = visible.filter((e) => e.category === cat);
          if (!items.length) return null;
          return (
            <div key={cat} className={palette.cat}>
              <div className={palette.catTitle}>{t(`bp.cat.${cat}`)}</div>
              <div className={styles.grid}>{items.map((e) => <Card key={e.id} e={e} selected={e.id === selectedId} />)}</div>
            </div>
          );
        })}
        <div className={palette.empty} style={{ padding: '8px 12px' }}>{t('bp.lib.local')}</div>
      </div>
      {selected && <Detail e={selected} />}
    </>
  );
}

function Card({ e, selected }: { e: LibraryEntry; selected: boolean }) {
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  // Thumbnails are rendered when the card first becomes visible (built-ins are generated then).
  useEffect(() => {
    if (e.thumbnail || !ref.current) return;
    const el = ref.current;
    const io = new IntersectionObserver((list) => {
      if (list.some((x) => x.isIntersecting)) { io.disconnect(); setTimeout(() => void ensureThumbnail(e.id), 30); }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [e.id, e.thumbnail]);
  const c = e.counts;
  return (
    <div style={{ position: 'relative' }}>
      <button ref={ref} className={`${styles.card} ${selected ? styles.sel : ''}`} data-entry={e.id} aria-pressed={selected} onClick={() => useBlueprintStore.getState().select(selected ? null : e.id)} onDoubleClick={() => e.kind === 'blueprint' && void startPlacement(e.id)} style={{ width: '100%' }}>
        {e.thumbnail ? <img className={styles.thumb} src={e.thumbnail} alt="" draggable={false} /> : <div className={styles.thumb}><Icon name={e.kind === 'world' ? 'globe' : 'copy'} size={20} /></div>}
        <span className={styles.cardName}>{entryName(e)}</span>
        <span className={styles.cardMeta}>{c.objects === undefined ? t('bp.lib.notGenerated') : e.kind === 'world' ? t('bp.lib.cardWorld', { objects: c.objects ?? 0, roads: c.roads ?? 0 }) : t('bp.lib.card', { buildings: c.buildings ?? 0, vegetation: c.vegetation ?? 0, roads: c.roads ?? 0 })}</span>
      </button>
      {e.builtin && <span className={styles.badge}>{t('bp.lib.builtin')}</span>}
      <button className={`${styles.star} ${e.favorite ? styles.starOn : ''}`} aria-pressed={e.favorite} title={t(e.favorite ? 'bp.act.unfavorite' : 'bp.act.favorite')} data-star={e.id} onClick={() => void useLibraryStore.getState().toggleFavorite(e.id)}>★</button>
    </div>
  );
}

function Detail({ e }: { e: LibraryEntry }) {
  const t = useT();
  const editing = useEditorStore((s) => s.mode) === 'editor';
  const [seed, setSeed] = useState(1);
  const [deps, setDeps] = useState<BlueprintDependency[]>([]);
  useEffect(() => {
    let live = true;
    if (e.kind === 'blueprint') void useLibraryStore.getState().loadBlueprint(e.id).then((bp) => live && setDeps(bp?.dependencies ?? []));
    else setDeps([]);
    return () => { live = false; };
  }, [e.id, e.kind, e.updatedAt]);
  const c = e.counts;
  const rename = () => {
    const name = window.prompt(t('bp.renamePrompt'), entryName(e));
    if (name && name.trim()) void renameEntry(e.id, name);
  };
  const name = entryName(e);
  const openWorld = async (mode: 'new' | 'replace') => {
    if (!window.confirm(t(mode === 'new' ? 'bp.tpl.applyNew.confirm' : 'bp.tpl.applyReplace.confirm', { name }))) return;
    if (await applyTemplate(e.id, seed, mode, name) && mode === 'new') useEditorStore.getState().setTool('select');
  };
  return (
    <div className={styles.detail} data-testid="bp-detail">
      <div className={styles.detailTop}>
        {e.thumbnail ? <img src={e.thumbnail} alt="" /> : <div className={styles.ph} />}
        <div className={styles.stack}>
          <span className={styles.detailName}>{name}</span>
          <span className={styles.label}>{t(`bp.cat.${e.category}`)}{e.builtin ? ` · ${t('bp.lib.builtin')}` : ''}{e.bytes ? ` · ${t('bp.lib.bytes', { kb: Math.max(1, Math.round(e.bytes / 1024)) })}` : ''}</span>
          {c.objects !== undefined && <span className={styles.label}>{e.kind === 'world' ? t('bp.lib.worldCounts', { objects: c.objects ?? 0, buildings: c.buildings ?? 0, trees: c.trees ?? 0, roads: c.roads ?? 0, features: c.features ?? 0 }) : t('bp.lib.counts', { buildings: c.buildings ?? 0, objects: (c.objects ?? 0) - (c.buildings ?? 0), vegetation: c.vegetation ?? 0, roads: c.roads ?? 0, features: c.features ?? 0 })}</span>}
          {e.experiment && <span className={styles.label}>⚗ {t('bp.lib.experiment')}</span>}
        </div>
      </div>
      {(e.builtinKey || e.description) && <div className={styles.desc}>{e.builtinKey ? t(`${e.builtinKey}.desc` as MessageKey) : e.description}</div>}
      {e.tags.length > 0 && <div className={styles.tags}>{e.tags.map((g) => <span key={g} className={styles.tag}>#{g}</span>)}</div>}
      {deps.length > 0 && <DependencyList deps={deps} />}
      {e.builtin && <div className={styles.label}>{t('bp.lib.readOnly')}</div>}
      {e.kind === 'world' && e.builtin && (
        <NumberField label={t('bp.tpl.seed')} value={seed} min={0} max={999999} step={1} precision={0} onChange={(v, live) => !live && setSeed(Math.max(0, Math.round(v)))} />
      )}
      <div className={styles.actions}>
        {e.kind === 'blueprint' ? (
          <button className={styles.primary} disabled={!editing} data-testid="bp-place" onClick={() => void startPlacement(e.id)}><Icon name="place" size={12} /> {t('bp.act.place')}</button>
        ) : (
          <>
            <button className={styles.primary} disabled={!editing} data-testid="bp-open-world" onClick={() => void openWorld('new')}><Icon name="globe" size={12} /> {t('bp.act.openWorld')}</button>
            <button disabled={!editing} data-testid="bp-apply-world" onClick={() => void openWorld('replace')}>{t('bp.act.applyWorld')}</button>
          </>
        )}
        <button disabled={e.builtin} onClick={rename} data-testid="bp-rename"><Icon name="list" size={12} /> {t('bp.act.rename')}</button>
        <button onClick={() => void duplicateEntry(e.id)} data-testid="bp-duplicate"><Icon name="copy" size={12} /> {t('bp.act.duplicate')}</button>
        <button onClick={() => void exportEntry(e.id)} data-testid="bp-export"><Icon name="save" size={12} /> {t('bp.act.export')}</button>
        <button disabled={e.builtin} onClick={() => void deleteEntry(e.id)} data-testid="bp-delete"><Icon name="trash" size={12} /> {t('bp.act.delete')}</button>
      </div>
    </div>
  );
}

function DependencyList({ deps }: { deps: readonly BlueprintDependency[] }) {
  const t = useT();
  // One line per kind (counts summed).
  const rows = new Map<string, { d: BlueprintDependency; n: number }>();
  for (const d of deps) {
    const k = `${d.kind}:${d.resolution}`;
    const r = rows.get(k);
    if (r) r.n += d.value ?? Math.max(1, d.refs.length);
    else rows.set(k, { d, n: d.value ?? Math.max(1, d.refs.length) });
  }
  const tone = (d: BlueprintDependency) => (d.resolution === 'dropped' || d.resolution === 'detached' || d.kind === 'riverInflowOutside' || d.kind === 'riverOutletOutside' || d.kind === 'roadExternal' ? styles.warn : styles.info);
  return (
    <ul className={styles.issues} data-testid="bp-deps">
      {[...rows.values()].map(({ d, n }) => (
        <li key={`${d.kind}:${d.resolution}`} className={`${styles.issue} ${tone(d)}`}>
          <span className={styles.dot} />
          <span>{t(`bp.dep.${d.kind}`, { n: d.kind === 'seaLevel' ? fmt(d.value ?? 0, 2) : n })} · <i>{t(`bp.res.${d.resolution}`)}</i></span>
        </li>
      ))}
    </ul>
  );
}

// ── Capture ─────────────────────────────────────────────────────────────────

const INCLUDE_KEYS: (keyof CaptureInclude)[] = ['buildings', 'objects', 'vegetation', 'roads', 'landforms', 'water', 'waterState', 'terrain'];

function CaptureForm() {
  const t = useT();
  const c = useBlueprintStore((s) => s.capture);
  const set = useBlueprintStore.getState().setCapture;
  const setRe = (patch: Parameters<typeof set>[0]) => { set(patch); recomputeCapture(); };
  const r = c.result;
  const [busy, setBusy] = useState(false);
  const counts = r?.report.counts;
  const excluded = r ? (Object.entries(r.report.excluded) as [keyof typeof r.report.excluded, number][]).filter(([, n]) => n > 0) : [];
  return (
    <>
      <div className={panel.scroll} data-testid="bp-capture">
        <div className={panel.section}>
          <div className={panel.title}>{t('bp.capture.title')}</div>
          <Segmented size="small" value={c.kind} ariaLabel={t('bp.capture.mode')}
            options={(['rect', 'polygon', 'selection'] as const).map((k) => ({ value: k, label: t(`bp.capture.mode.${k}`) }))}
            onChange={(k) => startCapture(k)} />
          <div className={panel.hint}>{t(`bp.capture.hint.${c.kind}`)}</div>
        </div>
        <div className={panel.section}>
          <div className={panel.title}>{t('bp.capture.include')}</div>
          {INCLUDE_KEYS.map((k) => (
            <Check key={k} label={t(`bp.inc.${k}`)} checked={c.include[k]} disabled={k === 'waterState' && !c.include.water} testId={`bp-inc-${k}`}
              onChange={(v) => setRe({ include: { ...c.include, [k]: v } })} hint={k === 'waterState' ? t('bp.inc.waterState.hint') : undefined} />
          ))}
        </div>
        <div className={panel.section}>
          <div className={panel.title}>{t('bp.capture.boundary')}</div>
          <PolicyRow id="roads" label={t('bp.capture.roads')} value={c.roads} onChange={(v) => setRe({ roads: v })} />
          <PolicyRow id="nature" label={t('bp.capture.nature')} value={c.nature} onChange={(v) => setRe({ nature: v })} />
          <div className={panel.note}>{t('bp.policy.note')}</div>
        </div>
        <div className={panel.section}>
          <div className={panel.title}>{t('bp.capture.summary')}</div>
          {!r ? <div className={panel.note}>{t('bp.capture.waiting')}</div> : (
            <>
              <div className={panel.sub} data-testid="bp-capture-counts">{t('bp.capture.counts', { buildings: counts!.buildings, objects: counts!.objects - counts!.buildings, vegetation: counts!.vegetation, roads: counts!.roads, features: counts!.features, water: counts!.water })}</div>
              <div className={panel.note}>{t('bp.capture.size', { w: fmt(r.blueprint.preview.size[0]), d: fmt(r.blueprint.preview.size[1]), datum: fmt(r.report.datum, 2), lo: fmt(r.blueprint.preview.relief[0]), hi: fmt(r.blueprint.preview.relief[1]) })}</div>
              {excluded.length > 0 && <div className={panel.note}>{t('bp.capture.excluded', { list: excluded.map(([k, n]) => t(`bp.ex.${k}`, { n })).join(', ') })}</div>}
              <div className={panel.title}>{t('bp.capture.warnings')}</div>
              {r.blueprint.dependencies.length ? <DependencyList deps={r.blueprint.dependencies} /> : <div className={panel.note}>{t('bp.capture.none')}</div>}
            </>
          )}
        </div>
        <div className={panel.section}>
          <div className={panel.title}>{t('bp.capture.meta')}</div>
          <label className={styles.stack}><span className={styles.label}>{t('bp.field.name')}</span>
            <input className={styles.input} value={c.name} maxLength={120} data-testid="bp-name" onChange={(e) => set({ name: e.target.value })} placeholder={t('bp.untitled')} /></label>
          <label className={styles.stack}><span className={styles.label}>{t('bp.field.description')}</span>
            <textarea className={styles.input} value={c.description} maxLength={4000} data-testid="bp-description" onChange={(e) => set({ description: e.target.value })} /></label>
          <label className={styles.stack}><span className={styles.label}>{t('bp.field.category')}</span>
            <select value={c.category} data-testid="bp-category" onChange={(e) => set({ category: e.target.value as typeof c.category })}>
              {(['auto', ...BLUEPRINT_CATEGORIES] as const).map((k) => <option key={k} value={k}>{t(`bp.cat.${k}`)}</option>)}
            </select></label>
          <label className={styles.stack}><span className={styles.label}>{t('bp.field.tags')}</span>
            <input className={styles.input} value={c.tags} data-testid="bp-tags" onChange={(e) => set({ tags: e.target.value })} /></label>
        </div>
      </div>
      <div className={styles.footerBar}>
        <button onClick={backToLibrary} data-testid="bp-capture-cancel">{t('bp.capture.cancel')}</button>
        <button className={styles.primary} disabled={!r || r.report.empty || busy} data-testid="bp-capture-save" onClick={async () => { setBusy(true); try { await saveCapture(); } finally { setBusy(false); } }}>{t('bp.capture.save')}</button>
      </div>
    </>
  );
}

function PolicyRow({ id, label, value, onChange }: { id: string; label: string; value: BoundaryPolicy; onChange: (v: BoundaryPolicy) => void }) {
  const t = useT();
  return (
    <div className={styles.stack}>
      <span className={styles.label}>{label}</span>
      <div className={styles.policy} role="radiogroup" aria-label={label} style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
        {(['whole', 'inside', 'clip'] as const).map((k) => (
          <button key={k} role="radio" aria-checked={value === k} data-boundary={`${id}:${k}`} className={`${styles.policyBtn} ${value === k ? styles.on : ''}`} onClick={() => onChange(k)}>{t(`bp.policy.${k}`)}</button>
        ))}
      </div>
    </div>
  );
}

// ── Placement ───────────────────────────────────────────────────────────────

function PlaceForm() {
  const t = useT();
  const p = useBlueprintStore((s) => s.place);
  const snap = useEditorStore((s) => s.snap);
  const bp = p.blueprint;
  const o = p.options;
  const setO = useBlueprintStore.getState().setPlaceOptions;
  const change = (patch: Parameters<typeof setO>[0]) => { setO(patch); schedulePlan(0); };
  const entry = useLibraryStore((s) => s.entries.find((e) => e.id === p.entryId)) ?? useLibraryStore.getState().all().find((e) => e.id === p.entryId);
  if (!bp) return null;
  const plan = p.plan;
  const r = plan?.report;
  const hasTerrain = !!bp.terrain;
  const has = { buildings: bp.objects.some((x) => x.type === 'building'), objects: bp.objects.some((x) => x.type !== 'building'), vegetation: bp.vegetation.length > 0, roads: bp.roads.segments.length > 0, landforms: bp.features.some((f) => f.kind !== 'river' && f.kind !== 'lake'), water: bp.features.some((f) => f.kind === 'river' || f.kind === 'lake'), waterState: bp.features.some((f) => f.kind === 'river' || f.kind === 'lake'), terrain: hasTerrain };
  const deg = Math.round((p.yaw * 180) / Math.PI);
  const statusColor = !r ? '#7aa7ff' : r.errors.length ? '#ff5d5d' : r.warnings.length ? '#ffb347' : '#5ad37e';
  const validation = (
    <div className={panel.section} data-testid="bp-validation">
      <div className={panel.title}>{t('bp.place.status')}</div>
      <div className={styles.status}><span className={styles.statusDot} style={{ background: statusColor }} />{!r ? t('bp.place.computing') : r.errors.length ? t('bp.place.blocked') : t('bp.place.ok')}</div>
      {r && (
        <>
          <div className={panel.sub}>{t('bp.place.summary', { objects: r.counts.objects, trees: r.counts.vegetation, roads: r.counts.roads, features: r.counts.features })}</div>
          <div className={panel.note}>{t('bp.place.datum', { d: fmt(r.datum, 2) })} · {t('bp.place.terrainInfo', { raise: fmt(r.terrain.raise), cut: fmt(r.terrain.cut), mean: fmt(r.terrain.meanDiff), max: fmt(r.terrain.maxDiff) })}</div>
          {r.connections.length > 0 && <div className={panel.note}>{t('bp.place.connections', { roads: r.connections.filter((c) => c.kind === 'node' || c.kind === 'road').length, water: r.connections.filter((c) => c.kind !== 'node' && c.kind !== 'road').length })}</div>}
          <IssueList errors={r.errors} warnings={r.warnings} />
        </>
      )}
    </div>
  );
  return (
    <>
      <div className={panel.scroll} data-testid="bp-placement">
        <div className={panel.section}>
          <div className={panel.title}>{t('bp.place.title')}</div>
          <div className={styles.detailName}>{entry ? entryName(entry) : bp.meta.name}</div>
          <div className={panel.hint}>{t('bp.place.hint')}</div>
          <div className={panel.sub} data-testid="bp-pin">{p.pinned ? t('bp.place.pinned', { x: fmt(p.pinned[0]), z: fmt(p.pinned[1]) }) : t('bp.place.notPinned')}</div>
          {p.pinned && <button onClick={() => pinPlacement(null)} data-testid="bp-unpin">{t('bp.place.unpin')}</button>}
        </div>
        {validation}
        <div className={panel.section}>
          <div className={panel.title}>{t('bp.place.transform')}</div>
          <span className={styles.label}>{t('bp.place.rotation')}</span>
          <div className={styles.rotButtons}>
            <button onClick={() => rotatePlacement(-Math.PI / 2)} title="Shift+R">−90°</button>
            <button onClick={() => rotatePlacement(-Math.PI / 12)}>−15°</button>
            <input type="number" aria-label={t('bp.place.rotation')} data-testid="bp-yaw" value={deg} min={-180} max={180} step={1}
              onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setPlacementYaw((Math.max(-180, Math.min(180, v)) * Math.PI) / 180); }} />
            <button onClick={() => rotatePlacement(Math.PI / 12)}>+15°</button>
            <button onClick={() => rotatePlacement(Math.PI / 2)} title="R">+90°</button>
          </div>
          <Check label={t('bp.place.gridSnap')} checked={snap} onChange={() => useEditorStore.getState().toggleSnap()} testId="bp-grid-snap" />
          <Check label={t('bp.place.terrainSnap')} checked={o.terrainSnap} onChange={(v) => change({ terrainSnap: v })} hint={t('bp.place.terrainSnap.hint')} testId="bp-terrain-snap" />
          <label className={styles.numRow}><span>{t('bp.place.heightOffset')} (m)</span>
            <input type="number" step={0.1} min={-30} max={30} value={o.heightOffset} data-testid="bp-height-offset" onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) change({ heightOffset: Math.max(-30, Math.min(30, v)) }); }} /></label>
          <Check label={t('bp.place.preserveRelative')} checked={o.preserveRelative} onChange={(v) => change({ preserveRelative: v })} hint={t('bp.place.preserveRelative.hint')} testId="bp-preserve-relative" />
          <div className={styles.actions}>
            <button onClick={alignToRoad} data-testid="bp-align-road">{t('bp.place.alignRoad')}</button>
            <button onClick={alignToObjects} data-testid="bp-align-objects">{t('bp.place.alignObjects')}</button>
          </div>
          <div className={panel.note}>{t('bp.place.noScale')}</div>
        </div>
        <div className={panel.section}>
          <div className={panel.title}>{t('bp.place.terrainPolicy')}</div>
          <div className={styles.policy} role="radiogroup" aria-label={t('bp.place.terrainPolicy')}>
            {TERRAIN_POLICIES.map((k) => (
              <button key={k} role="radio" aria-checked={o.terrain === k} data-terrain-policy={k} className={`${styles.policyBtn} ${o.terrain === k ? styles.on : ''}`}
                disabled={!hasTerrain && k !== 'preserve' && k !== 'offset'} onClick={() => change({ terrain: k })}>
                <b>{t(`bp.terrain.${k}`)}</b>
              </button>
            ))}
          </div>
          <div className={panel.note}>{t(`bp.terrain.${o.terrain}.hint`)}</div>
          {o.terrain === 'blend' && <SliderField label={t('bp.place.blendWidth')} value={o.blendWidth} min={1} max={30} step={1} unit="m" precision={0} onChange={(v) => change({ blendWidth: v })} />}
        </div>
        {has.roads && (
          <div className={panel.section}>
            <div className={panel.title}>{t('bp.place.roadPolicy')}</div>
            <div className={styles.policy} role="radiogroup" aria-label={t('bp.place.roadPolicy')} style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
              {ROAD_POLICIES.map((k) => (
                <button key={k} role="radio" aria-checked={o.roads === k} data-road-policy={k} className={`${styles.policyBtn} ${o.roads === k ? styles.on : ''}`} onClick={() => change({ roads: k })}>
                  <b>{t(`bp.road.${k}`)}</b>
                </button>
              ))}
            </div>
            <div className={panel.note}>{t(`bp.road.${o.roads}.hint`)}</div>
          </div>
        )}
        <div className={panel.section}>
          <div className={panel.title}>{t('bp.place.include')}</div>
          {INCLUDE_KEYS.filter((k) => has[k]).map((k) => (
            <Check key={k} label={t(`bp.inc.${k}`)} checked={o.include[k]} disabled={k === 'waterState' && !o.include.water} testId={`bp-pinc-${k}`} onChange={(v) => change({ include: { ...o.include, [k]: v } })} />
          ))}
        </div>
      </div>
      <div className={styles.footerBar}>
        <button onClick={backToLibrary} data-testid="bp-place-close">{t('bp.place.close')}</button>
        <button className={styles.primary} disabled={!p.pinned || !!r?.errors.length} title="Enter" data-testid="bp-confirm" onClick={() => confirmPlacement()}>{t('bp.place.confirm')}</button>
      </div>
    </>
  );
}

function Check({ label, checked, onChange, disabled, hint, testId }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; hint?: string; testId?: string }) {
  return (
    <label className={`${styles.check} ${disabled ? styles.disabled : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} data-testid={testId} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}{hint && <small>{hint}</small>}</span>
    </label>
  );
}

function IssueList({ errors, warnings }: { errors: readonly PlacementIssue[]; warnings: readonly PlacementIssue[] }) {
  const t = useT();
  const text = (i: PlacementIssue) => t(`bp.issue.${i.code}`, { n: i.value ?? 0, detail: i.detail ? (t(`bp.hydro.${i.detail}` as MessageKey) ?? i.detail) : '' });
  return (
    <ul className={styles.issues} data-testid="bp-issues">
      {errors.map((i, k) => <li key={`e${k}`} className={`${styles.issue} ${styles.err}`} data-issue={i.code}><span className={styles.dot} />{text(i)}{i.detail && i.code !== 'hydrology' ? ` (${i.detail})` : ''}</li>)}
      {warnings.map((i, k) => <li key={`w${k}`} className={`${styles.issue} ${i.code === 'riverJoins' ? styles.ok : styles.warn}`} data-issue={i.code}><span className={styles.dot} />{text(i)}</li>)}
    </ul>
  );
}
