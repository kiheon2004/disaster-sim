import { useMemo, useState } from 'react';
import { useT } from '@/i18n/i18n';
import type { TerrainPresetId } from '@/core/model';
import { randomSeed } from '@/core/random';
import { useEditorStore, BRUSH_RADIUS_RANGE, type TerrainToolId } from '@/editor/editorStore';
import { useWorldStore } from '@/world/worldStore';
import { useViewStore } from '@/rendering/viewStore';
import { GROUND_MATERIALS } from '@/terrain/GroundMaterials';
import { TERRAIN_PRESETS } from '@/terrain/TerrainPresets';
import { heightRange } from '@/terrain/TerrainData';
import { Icon, type IconName } from '@/ui/common/Icon';
import { NumberField, ToggleField } from '@/ui/common/fields';
import { Segmented } from '@/ui/common/Segmented';
import { applyTerrainPreset } from '@/app/actions';
import styles from './TerrainPanel.module.css';

const TOOLS: { id: TerrainToolId; icon: IconName }[] = [
  { id: 'raise', icon: 'raise' },
  { id: 'lower', icon: 'lower' },
  { id: 'flatten', icon: 'flatten' },
  { id: 'smooth', icon: 'smooth' },
  { id: 'paint', icon: 'brush' },
  { id: 'inspect', icon: 'probe' },
];

/** Left-panel tab of the Terrain Editing Mode: tools, brush, ground paint, presets, view. */
export function TerrainPanel() {
  const t = useT();
  const editing = useEditorStore((s) => s.mode) === 'editor';
  const active = useEditorStore((s) => (s.tool === 'terrain' ? s.terrainTool : null));
  const radius = useEditorStore((s) => s.brushRadius);
  const strength = useEditorStore((s) => s.brushStrength);
  const paintType = useEditorStore((s) => s.paintType);
  const view = useViewStore((s) => s.terrainView);
  const terrain = useWorldStore((s) => s.doc.terrain);
  const [preset, setPreset] = useState<TerrainPresetId>(terrain.settings.preset === 'flat' ? 'gentleHills' : terrain.settings.preset);
  const [seed, setSeed] = useState(terrain.settings.seed);
  const range = useMemo(() => heightRange(terrain), [terrain]);
  const ed = useEditorStore.getState;
  const brushTool = active !== null && active !== 'inspect';

  return (
    <div className={styles.wrap}>
      <div className={styles.scroll}>
        <div className={styles.section}>
          <div className={styles.title}>{t('terrain.tools')}</div>
          <div className={styles.tools}>
            {TOOLS.map((tool) => (
              <button
                key={tool.id}
                className={`${styles.tool} ${active === tool.id ? styles.active : ''}`}
                disabled={!editing}
                aria-pressed={active === tool.id}
                onClick={() => ed().setTerrainTool(active === tool.id ? null : tool.id)}
              >
                <Icon name={tool.icon} size={18} />
                {t(`terrain.tool.${tool.id}`)}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.title}>{t('terrain.brush')}</div>
          <NumberField label={t('terrain.brushSize')} value={radius} min={BRUSH_RADIUS_RANGE[0]} max={BRUSH_RADIUS_RANGE[1]} step={1} precision={0} unit="m"
            disabled={!editing} onChange={(v) => ed().setBrush({ radius: v })} />
          <NumberField label={t('terrain.brushStrength')} value={Math.round(strength * 100)} min={5} max={100} step={5} precision={0} unit="%"
            disabled={!editing} onChange={(v) => ed().setBrush({ strength: v / 100 })} />
          {active === 'paint' && (
            <>
              <div className={styles.sub}>{t('terrain.paintType')}</div>
              <div className={styles.swatches}>
                {GROUND_MATERIALS.map((g) => (
                  <button key={g.id} className={`${styles.swatch} ${paintType === g.id ? styles.active : ''}`} onClick={() => ed().setPaintType(g.id)} disabled={!editing}>
                    <span className={styles.chip} style={{ background: g.color }} />
                    {t(g.labelKey)}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className={styles.hint}>
            {brushTool ? t('terrain.hint.brush') : active === 'inspect' ? t('terrain.hint.inspect') : t('terrain.hint.idle')}
          </div>
        </div>

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
