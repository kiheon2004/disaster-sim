import { countRender } from '@/utils/renderCounter';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ObjectCategory } from '@/core/types';
import { translate, useLocale, useT } from '@/i18n/i18n';
import { CATEGORY_ORDER, PALETTE, getPaletteItem, type PaletteItem } from '@/objects/palette';
import { getDefinition, hasDefinition } from '@/objects/registry';
import { STATIC_VIEWS } from '@/rendering/views';
import { useBuildStore } from '@/editor/buildStore';
import { clearSelection, clickSelect, selectAll } from '@/app/buildActions';
import { renderThumbnails, subscribeThumbnails, thumbnail } from './thumbnails';
import { ToolOptions } from './ToolOptions';
import { itemParams } from '@/editor/build/itemDesign';
import { useEditorStore } from '@/editor/editorStore';
import { useWorldStore } from '@/world/worldStore';
import { focusObject } from '@/app/actions';
import { Icon, type IconName } from '@/ui/common/Icon';
import { displayName } from '@/ui/format';
import { StateDot } from '@/ui/common/StateBadge';
import { useEntityStates } from '@/ui/useEntityStates';
import { TerrainPanel } from '@/ui/Terrain/TerrainPanel';
import { BuildingPanel } from '@/ui/Building/BuildingPanel';
import styles from './ObjectPalette.module.css';

type Tab = 'objects' | 'building' | 'terrain' | 'scene';

export function ObjectPalette() {
  countRender('ObjectPalette');
  const t = useT();
  const [tab, setTabState] = useState<Tab>('objects');
  const count = useWorldStore((s) => Object.keys(s.doc.objects).length);
  const terrainActive = useEditorStore((s) => s.tool === 'terrain');
  // The Terrain tab is Terrain Editing Mode: opening it arms the last terrain tool; leaving it
  // (or arming an object preset) returns to object editing.
  const setTab = (next: Tab) => {
    setTabState(next);
    const ed = useEditorStore.getState();
    if (next === 'terrain' && ed.mode === 'editor') ed.setTerrainTool(ed.terrainTool);
    else if (ed.tool === 'terrain') ed.setTerrainTool(null);
  };
  const buildingActive = useEditorStore((s) => s.tool === 'building');
  const shown: Tab = terrainActive ? 'terrain' : buildingActive ? 'building' : tab;
  return (
    <div className={styles.wrap}>
      <div className={styles.tabs} role="tablist">
        <button role="tab" aria-selected={shown === 'objects'} className={`${styles.tab} ${shown === 'objects' ? styles.active : ''}`} onClick={() => setTab('objects')}>
          {t('panel.objects')}
        </button>
        <button role="tab" aria-selected={shown === 'building'} data-testid="tab-building" className={`${styles.tab} ${shown === 'building' ? styles.active : ''}`} onClick={() => setTab('building')}>
          {t('panel.building')}
        </button>
        <button role="tab" aria-selected={shown === 'terrain'} className={`${styles.tab} ${shown === 'terrain' ? styles.active : ''}`} onClick={() => setTab('terrain')}>
          {t('panel.terrain')}
        </button>
        <button role="tab" aria-selected={shown === 'scene'} className={`${styles.tab} ${shown === 'scene' ? styles.active : ''}`} onClick={() => setTab('scene')}>
          {t('panel.scene')} ({count})
        </button>
      </div>
      {shown === 'objects' ? <PaletteTab /> : shown === 'building' ? <BuildingPanel /> : shown === 'terrain' ? <TerrainPanel /> : <OutlinerTab />}
    </div>
  );
}

/** Presets that can actually be placed (implemented type with an editor view; never "coming soon"). */
export const PLACEABLE = PALETTE.filter((p) => !p.disabled && hasDefinition(p.type) && !!STATIC_VIEWS[p.type]);
type Filter = 'all' | 'favorites' | ObjectCategory;

function PaletteTab() {
  const t = useT();
  const locale = useLocale();
  const placeItemId = useEditorStore((s) => s.placeItemId);
  const mode = useEditorStore((s) => s.mode);
  const recent = useBuildStore((s) => s.recent);
  const favorites = useBuildStore((s) => s.favorites);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  useSyncExternalStore(subscribeThumbnails, () => thumbnail(PLACEABLE[0]?.id ?? ''));
  useEffect(() => void renderThumbnails(PLACEABLE), []);
  const editing = mode === 'editor';

  const q = query.trim().toLowerCase();
  const matches = (item: PaletteItem) => {
    if (filter === 'favorites' && !favorites.includes(item.id)) return false;
    if (filter !== 'all' && filter !== 'favorites' && item.category !== filter) return false;
    if (!q) return true;
    // Both languages + the type id, so "tree", "나무" and "conifer" all find trees.
    const hay = [translate('ko', item.labelKey), translate('en', item.labelKey), translate(locale, `category.${item.category}`), item.type, item.id].join(' ').toLowerCase();
    return hay.includes(q);
  };
  const visible = PLACEABLE.filter(matches);
  const recentItems = recent.map((id) => PLACEABLE.find((p) => p.id === id)).filter((p): p is PaletteItem => !!p);
  const cats = CATEGORY_ORDER.filter((c) => PLACEABLE.some((p) => p.category === c));

  return (
    <>
      <div className={styles.searchBox}>
        <Icon name="search" size={13} />
        <input value={query} placeholder={t('palette.search')} aria-label={t('palette.search')} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQuery('')} />
      </div>
      <div className={styles.chips} role="radiogroup" aria-label={t('palette.filter.all')}>
        {(['all', 'favorites', ...cats] as Filter[]).map((f) => (
          <button key={f} role="radio" aria-checked={filter === f} className={`${styles.chip} ${filter === f ? styles.chipOn : ''}`} onClick={() => setFilter(f)}>
            {f === 'all' ? t('palette.filter.all') : f === 'favorites' ? <>★ {t('palette.filter.favorites')}</> : t(`category.${f}`)}
          </button>
        ))}
      </div>
      <div className={styles.scroll} data-testid="palette">
        {!q && filter === 'all' && recentItems.length > 0 && (
          <div className={styles.cat}>
            <div className={styles.catTitle}>{t('palette.recent')}</div>
            <div className={styles.recent}>
              {recentItems.map((item) => <Tile key={item.id} item={item} armed={placeItemId === item.id} editing={editing} small />)}
            </div>
          </div>
        )}
        {visible.length === 0 && <div className={styles.empty}>{t('palette.noResults')}</div>}
        {CATEGORY_ORDER.map((cat) => {
          const items = visible.filter((p) => p.category === cat);
          if (!items.length) return null;
          return (
            <div key={cat} className={styles.cat}>
              <div className={styles.catTitle}>{t(`category.${cat}`)}</div>
              <div className={styles.grid}>
                {items.map((item) => <Tile key={item.id} item={item} armed={placeItemId === item.id} editing={editing} favorite={favorites.includes(item.id)} />)}
              </div>
            </div>
          );
        })}
      </div>
      {editing && <ArmedCard />}
      {editing ? <ToolOptions /> : <div className={styles.footer}><div className={styles.hint}>{t('palette.hint.simulation')}</div></div>}
    </>
  );
}

function Tile({ item, armed, editing, favorite, small }: { item: PaletteItem; armed: boolean; editing: boolean; favorite?: boolean; small?: boolean }) {
  const t = useT();
  const img = thumbnail(item.id);
  return (
    <div className={`${styles.tileWrap} ${small ? styles.small : ''}`}>
      <button
        className={`${styles.tile} ${armed ? styles.armed : ''}`}
        disabled={!editing}
        aria-pressed={armed}
        data-item={item.id}
        title={t('palette.clickToPlace')}
        onClick={() => useEditorStore.getState().armPlacement(item.id)}
      >
        {img ? <img src={img} alt="" className={styles.thumb} draggable={false} /> : <Icon name={item.icon as IconName} size={22} />}
        <span className={styles.tileLabel}>{t(item.labelKey)}</span>
      </button>
      {!small && (
        <button
          className={`${styles.star} ${favorite ? styles.starOn : ''}`}
          title={t(favorite ? 'palette.favorite.remove' : 'palette.favorite.add')}
          aria-pressed={!!favorite}
          onClick={() => useBuildStore.getState().toggleFavorite(item.id)}
        >
          ★
        </button>
      )}
    </div>
  );
}

/** The armed preset: preview, size and the active tool's hint (placement options below). */
function ArmedCard() {
  const t = useT();
  const item = getPaletteItem(useEditorStore((s) => s.placeItemId));
  const tool = useEditorStore((s) => s.tool);
  if (!item) return null;
  const def = getDefinition(item.type);
  const d = def.getDimensions(itemParams(item));
  const img = thumbnail(item.id);
  return (
    <div className={styles.card} data-testid="armed-card">
      {img ? <img src={img} alt="" className={styles.cardThumb} /> : <Icon name={item.icon as IconName} size={28} />}
      <div className={styles.cardText}>
        <b>{t(item.labelKey)}</b>
        <span>{t('palette.size', { w: d[0].toFixed(1), d: d[2].toFixed(1), h: d[1].toFixed(1) })}</span>
        <span className={styles.cardTools}>
          {(['place', 'brush', 'line', 'area'] as const).map((tl) => (
            <button key={tl} className={`${styles.miniTool} ${tool === tl ? styles.miniOn : ''}`} onClick={() => useEditorStore.getState().setTool(tl)} title={t(`build.tool.${tl}`)}>
              <Icon name={tl === 'place' ? 'place' : tl === 'brush' ? 'scatter' : tl} size={13} />
            </button>
          ))}
        </span>
      </div>
    </div>
  );
}

function OutlinerTab() {
  const t = useT();
  const objects = useWorldStore((s) => s.doc.objects);
  const selectedIds = useEditorStore((s) => s.selectedIds);
  const editing = useEditorStore((s) => s.mode) === 'editor';
  const states = useEntityStates();
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const list = useMemo(
    () => Object.values(objects).sort((a, b) => a.type.localeCompare(b.type) || a.serial - b.serial),
    [objects],
  );
  const cats = useMemo(() => CATEGORY_ORDER.filter((c) => list.some((o) => getDefinition(o.type).category === c)), [list]);
  if (!list.length) return <div className={styles.empty}>{t('outliner.empty')}</div>;
  return (
    <>
      {editing && (
        <div className={styles.chips} aria-label={t('outliner.selectCategory')} data-testid="select-category">
          <button className={styles.chip} onClick={() => selectAll()}>{t('outliner.selectAll')}</button>
          {cats.map((c) => (
            <button key={c} className={styles.chip} title={t('outliner.selectCategory')} onClick={() => selectAll(c)}>{t(`category.${c}`)}</button>
          ))}
          <button className={styles.chip} disabled={!selectedIds.length} onClick={clearSelection}>{t('outliner.clear')}</button>
        </div>
      )}
      <div className={`${styles.scroll} ${styles.list}`}>
        {list.map((o) => (
          <button
            key={o.id}
            className={`${styles.item} ${selected.has(o.id) ? styles.sel : ''}`}
            onClick={(e) => (editing ? clickSelect(o.id, { shift: e.shiftKey, alt: e.altKey }) : useEditorStore.getState().select(o.id))}
            onDoubleClick={() => focusObject(o.id)}
            title={t('outliner.doubleClickFocus')}
          >
            <Icon name={getDefinition(o.type).icon as IconName} size={14} />
            <span className={styles.itemName}>{displayName(o, t)}</span>
            {o.group && <Icon name="group" size={12} aria-label={t('object.group')} />}
            {states && states[o.id] !== undefined && <StateDot state={states[o.id]} />}
          </button>
        ))}
      </div>
    </>
  );
}
