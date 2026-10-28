import { Viewport } from '@/rendering/Viewport';
import { EditorScene } from '@/editor/EditorScene';
import { SimulationScene } from '@/rendering/sim/SimulationScene';
import { useEditorStore } from '@/editor/editorStore';
import { useSimStore } from '@/simulation/simStore';
import { getPaletteItem } from '@/objects/palette';
import { useT } from '@/i18n/i18n';
import { Compass } from './Compass';
import { ViewportToolbar } from './ViewportToolbar';
import { WindHud } from './WindHud';
import { QuakeHud } from './QuakeHud';
import { OverlayToggles } from './OverlayToggles';
import { PerfHud } from './PerfHud';
import { PerfProbe } from '@/rendering/PerfProbe';
import { useViewStore } from '@/rendering/viewStore';
import styles from './ViewportContainer.module.css';

export function ViewportContainer() {
  const t = useT();
  const mode = useEditorStore((s) => s.mode);
  const tool = useEditorStore((s) => s.tool);
  const loading = useSimStore((s) => s.status === 'loading');
  const placeItem = getPaletteItem(useEditorStore((s) => s.placeItemId));
  const terrainTool = useEditorStore((s) => s.terrainTool);
  const isEditor = mode === 'editor';
  const perf = useViewStore((s) => s.showPerfHud);

  return (
    <div className={styles.wrap}>
      <Viewport showGrid={isEditor}>
        {isEditor ? <EditorScene /> : <SimulationScene />}
        {perf && <PerfProbe />}
      </Viewport>
      <div className={`${styles.overlay} ${styles.topLeft}`}>
        <span className={`${styles.badge} ${isEditor ? '' : styles.sim}`}>
          {t(isEditor ? 'mode.editorShort' : 'mode.simulationShort')}
        </span>
        {isEditor && <ViewportToolbar />}
        {!isEditor && (
          <span className={styles.approx} title={t('model.approximate')}>{t('model.badge')}</span>
        )}
        {perf && <PerfHud />}
      </div>
      <div className={`${styles.overlay} ${styles.topRight}`}>
        <Compass />
        {!isEditor && <WindHud />}
        {!isEditor && <QuakeHud />}
      </div>
      <div className={`${styles.overlay} ${styles.bottomLeft}`}>
        <span className={styles.hint}>
          {!isEditor
            ? t('viewport.hint.sim')
            : tool === 'place' && placeItem
              ? t('viewport.hint.place', { name: t(placeItem.labelKey) })
              : tool === 'terrain'
                ? t(terrainTool === 'inspect' ? 'viewport.hint.terrainInspect' : 'viewport.hint.terrain', { tool: t(`terrain.tool.${terrainTool}`) })
                : t('viewport.hint.camera')}
        </span>
      </div>
      {!isEditor && (
        <div className={`${styles.overlay} ${styles.bottomRight}`}>
          <OverlayToggles />
        </div>
      )}
      {loading && <div className={styles.loading}>{t('app.loadingPhysics')}</div>}
    </div>
  );
}
