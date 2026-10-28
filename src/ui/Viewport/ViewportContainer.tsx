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
import { FloodHud } from './FloodHud';
import { OverlayToggles } from './OverlayToggles';
import { PerfHud } from './PerfHud';
import { PerfProbe } from '@/rendering/PerfProbe';
import { useViewStore } from '@/rendering/viewStore';
import { BuildHint, AreaApplyBar, OriginalWorldBadge } from './BuildOverlays';
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
        {!isEditor && <OriginalWorldBadge />}
        {perf && <PerfHud />}
      </div>
      <div className={`${styles.overlay} ${styles.topRight}`}>
        <Compass />
        {!isEditor && <WindHud />}
        {!isEditor && <QuakeHud />}
        {!isEditor && <FloodHud />}
      </div>
      <div className={`${styles.overlay} ${styles.bottomLeft}`}>
        <span className={styles.hint} data-testid="viewport-hint">
          {!isEditor
            ? t('viewport.hint.sim')
            : tool === 'terrain'
                ? t(terrainTool === 'inspect' ? 'viewport.hint.terrainInspect' : 'viewport.hint.terrain', { tool: t(`terrain.tool.${terrainTool}`) })
                : <BuildHint fallback={tool === 'place' && placeItem ? t('viewport.hint.place', { name: t(placeItem.labelKey) }) : t('viewport.hint.camera')} />}
        </span>
      </div>
      {isEditor && tool === 'area' && <AreaApplyBar />}
      {!isEditor && (
        <div className={`${styles.overlay} ${styles.bottomRight}`}>
          <OverlayToggles />
        </div>
      )}
      {loading && <div className={styles.loading}>{t('app.loadingPhysics')}</div>}
    </div>
  );
}
