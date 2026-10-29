import { useMemo, useState } from 'react';
import { useT } from '@/i18n/i18n';
import type { TerrainPresetId } from '@/core/model';
import { randomSeed } from '@/core/random';
import { useEditorStore } from '@/editor/editorStore';
import { useWorldStore } from '@/world/worldStore';
import { useViewStore } from '@/rendering/viewStore';
import { TERRAIN_PRESETS } from '@/terrain/TerrainPresets';
import { heightRange } from '@/terrain/TerrainData';
import { Icon } from '@/ui/common/Icon';
import { NumberField, ToggleField } from '@/ui/common/fields';
import { Segmented } from '@/ui/common/Segmented';
import { applyTerrainPreset } from '@/app/actions';
import { EnvironmentSection, TerrainToolSections } from './NatureSections';
import styles from './TerrainPanel.module.css';

/** Left-panel tab of the Terrain Editing Mode: tools, brush, ground paint, presets, view. */
export function TerrainPanel() {
  const t = useT();
  const editing = useEditorStore((s) => s.mode) === 'editor';
  const view = useViewStore((s) => s.terrainView);
  const terrain = useWorldStore((s) => s.doc.terrain);
  const [preset, setPreset] = useState<TerrainPresetId>(terrain.settings.preset === 'flat' ? 'gentleHills' : terrain.settings.preset);
  const [seed, setSeed] = useState(terrain.settings.seed);
  const range = useMemo(() => heightRange(terrain), [terrain]);

  return (
    <div className={styles.wrap}>
      <div className={styles.scroll}>
        <TerrainToolSections editing={editing} />

        <div className={styles.section}>
          <div className={styles.title}>{t('terrain.preset')}</div>
          <select value={preset} onChange={(e) => setPreset(e.target.value as TerrainPresetId)} disabled={!editing} aria-label={t('terrain.preset')}>
            {TERRAIN_PRESETS.map((p) => (
              <option key={p} value={p}>{t(`terrain.preset.${p}`)}</option>
            ))}
          </select>
          <div className={styles.row}>
            <NumberField label={t('terrain.seed')} value={seed} min={0} max={999999999} step={1} precision={0} disabled={!editing || preset === 'flat'} onChange={(v) => setSeed(Math.round(v))} />
            <button className={styles.linkBtn} disabled={!editing || preset === 'flat'} onClick={() => setSeed(randomSeed())} title={t('settings.seed.random')}>
              <Icon name="sparkle" size={13} />
            </button>
          </div>
          <button className={styles.apply} disabled={!editing} onClick={() => applyTerrainPreset(preset, seed)}>
            {t('terrain.preset.apply')}
          </button>
          <div className={styles.note}>{t('terrain.preset.note')}</div>
        </div>

        <EnvironmentSection editing={editing} />

        <div className={styles.section}>
          <div className={styles.title}>{t('terrain.view')}</div>
          <Segmented
            size="small"
            value={view}
            onChange={(v) => useViewStore.getState().setTerrainView(v)}
            options={[
              { value: 'surface', label: t('terrain.view.surface') },
              { value: 'elevation', label: t('terrain.view.elevation') },
              { value: 'ground', label: t('terrain.view.ground') },
              { value: 'soil', label: t('terrain.view.soil') },
            ]}
          />
          {view === 'elevation' && <div className={styles.note}>{t('terrain.view.contours')}</div>}
          <div className={styles.note}>{t('terrain.range', { min: range[0].toFixed(1), max: range[1].toFixed(1) })}</div>
          <ToggleField
            label={t('terrain.waterLevel')}
            checked={terrain.settings.waterLevel !== null}
            disabled={!editing}
            hint={t('terrain.waterLevel.hint')}
            onChange={(b) => useWorldStore.getState().setWaterLevel(b ? 0 : null)}
          />
          {terrain.settings.waterLevel !== null && (
            <NumberField label={t('terrain.waterLevel.height')} value={terrain.settings.waterLevel} min={-40} max={40} step={0.5} precision={1} unit="m"
              disabled={!editing} onChange={(v, live) => !live && useWorldStore.getState().setWaterLevel(v)} />
          )}
        </div>
      </div>
    </div>
  );
}
