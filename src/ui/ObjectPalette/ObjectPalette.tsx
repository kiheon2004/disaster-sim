import { countRender } from '@/utils/renderCounter';
import { useMemo, useState } from 'react';
import { useT } from '@/i18n/i18n';
import { CATEGORY_ORDER, PALETTE } from '@/objects/palette';
import { getDefinition } from '@/objects/registry';
import { useEditorStore } from '@/editor/editorStore';
import { useWorldStore } from '@/world/worldStore';
import { focusObject } from '@/app/actions';
import { Icon, type IconName } from '@/ui/common/Icon';
import { Toggle } from '@/ui/common/fields';
import { displayName } from '@/ui/format';
import { StateDot } from '@/ui/common/StateBadge';
import { useEntityStates } from '@/ui/useEntityStates';
import { TerrainPanel } from '@/ui/Terrain/TerrainPanel';
import styles from './ObjectPalette.module.css';

type Tab = 'objects' | 'terrain' | 'scene';

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
  const shown: Tab = terrainActive ? 'terrain' : tab;
  return (
    <div className={styles.wrap}>
      <div className={styles.tabs} role="tablist">
        <button role="tab" aria-selected={shown === 'objects'} className={`${styles.tab} ${shown === 'objects' ? styles.active : ''}`} onClick={() => setTab('objects')}>
          {t('panel.objects')}
        </button>
        <button role="tab" aria-selected={shown === 'terrain'} className={`${styles.tab} ${shown === 'terrain' ? styles.active : ''}`} onClick={() => setTab('terrain')}>
          {t('panel.terrain')}
        </button>
        <button role="tab" aria-selected={shown === 'scene'} className={`${styles.tab} ${shown === 'scene' ? styles.active : ''}`} onClick={() => setTab('scene')}>
          {t('panel.scene')} ({count})
        </button>
      </div>
      {shown === 'objects' ? <PaletteTab /> : shown === 'terrain' ? <TerrainPanel /> : <OutlinerTab />}
    </div>
  );
}

function PaletteTab() {
  const t = useT();
  const placeItemId = useEditorStore((s) => s.placeItemId);
  const mode = useEditorStore((s) => s.mode);
  const snap = useEditorStore((s) => s.snap);
  const randomize = useEditorStore((s) => s.randomize);
  const editing = mode === 'editor';

  return (
    <>
      <div className={styles.scroll}>
        {CATEGORY_ORDER.map((cat) => {
          const items = PALETTE.filter((p) => p.category === cat);
          if (!items.length) return null;
          return (
            <div key={cat} className={styles.cat}>
              <div className={styles.catTitle}>{t(`category.${cat}`)}</div>
              <div className={styles.grid}>
                {items.map((item) => (
                  <button
                    key={item.id}
                    className={`${styles.tile} ${placeItemId === item.id ? styles.armed : ''}`}
                    disabled={item.disabled || !editing}
                    aria-pressed={placeItemId === item.id}
                    title={item.disabled ? t('common.comingSoon') : t('palette.clickToPlace')}
                    onClick={() => useEditorStore.getState().armPlacement(item.id)}
                  >
                    <Icon name={item.icon as IconName} size={22} />
                    {t(item.labelKey)}
                    {item.disabled && <span className={styles.soon}>{t('common.comingSoon')}</span>}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className={styles.footer}>
        <div className={styles.hint}>
          {!editing
            ? t('palette.hint.simulation')
            : placeItemId
              ? <>{t('palette.hint.placing')} <span className={styles.kbd}>R</span> {t('palette.hint.rotate')} · <span className={styles.kbd}>Esc</span> {t('palette.hint.cancel')}</>
              : t('palette.hint.idle')}
        </div>
        <Toggle checked={snap} onChange={() => useEditorStore.getState().toggleSnap()} label={<>{t('palette.snap')} <span className={styles.kbd}>G</span></>} />
        <Toggle checked={randomize} onChange={() => useEditorStore.getState().toggleRandomize()} label={t('palette.randomize')} />
      </div>
    </>
  );
}

function OutlinerTab() {
  const t = useT();
  const objects = useWorldStore((s) => s.doc.objects);
  const selectedId = useEditorStore((s) => s.selectedId);
  const states = useEntityStates();
  const list = useMemo(
    () => Object.values(objects).sort((a, b) => a.type.localeCompare(b.type) || a.serial - b.serial),
    [objects],
  );
  if (!list.length) return <div className={styles.empty}>{t('outliner.empty')}</div>;
  return (
    <div className={`${styles.scroll} ${styles.list}`}>
      {list.map((o) => (
        <button
          key={o.id}
          className={`${styles.item} ${o.id === selectedId ? styles.sel : ''}`}
          onClick={() => useEditorStore.getState().select(o.id)}
          onDoubleClick={() => focusObject(o.id)}
          title={t('outliner.doubleClickFocus')}
        >
          <Icon name={getDefinition(o.type).icon as IconName} size={14} />
          <span className={styles.itemName}>{displayName(o, t)}</span>
          {states && states[o.id] !== undefined && <StateDot state={states[o.id]} />}
        </button>
      ))}
    </div>
  );
}
