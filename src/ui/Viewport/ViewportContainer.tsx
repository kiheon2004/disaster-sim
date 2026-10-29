import { Viewport } from '@/rendering/Viewport';
import { EditorScene } from '@/editor/EditorScene';
import { SimulationScene } from '@/rendering/sim/SimulationScene';
import { useBlueprintStore } from '@/editor/blueprintStore';
import { useEditorStore } from '@/editor/editorStore';
import { useRoadStore } from '@/editor/roadStore';
import { isBrushTool } from '@/editor/tools/TerrainTool';
import { useSimStore } from '@/simulation/simStore';
import { getPaletteItem } from '@/objects/palette';
import { BuildingEditBar } from './BuildingEditBar';
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
  const roadMode = useRoadStore((s) => s.mode);
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
            : tool === 'building'
              ? t('viewport.hint.building')
              : tool === 'blueprint'
                ? <BlueprintHint />
              : tool === 'road'
                ? t('viewport.hint.road', { mode: t(`road.mode.${roadMode}`), hint: t(`road.hint.${roadMode}`) })
              : tool === 'terrain'
                ? isBrushTool(terrainTool) || terrainTool === 'inspect'
                  ? t(terrainTool === 'inspect' ? 'viewport.hint.terrainInspect' : 'viewport.hint.terrain', { tool: t(`terrain.tool.${terrainTool}`) })
                  : `${t(`terrain.tool.${terrainTool}`)} — ${t(`nature.hint.${terrainTool}` as 'nature.hint.idle')}`
                : <BuildHint fallback={tool === 'place' && placeItem ? t('viewport.hint.place', { name: t(placeItem.labelKey) }) : t('viewport.hint.camera')} />}
        </span>
      </div>
      {isEditor && tool === 'area' && <AreaApplyBar />}
      {isEditor && tool === 'building' && (
        <div className={styles.overlay} style={{ top: 10, left: '50%', transform: 'translateX(-50%)' }}>
          <BuildingEditBar />
        </div>
      )}
      {!isEditor && (
        <div className={`${styles.overlay} ${styles.bottomRight}`}>
          <OverlayToggles />
        </div>
      )}
      {loading && <div className={styles.loading}>{t('app.loadingPhysics')}</div>}
    </div>
  );
}

/** Blueprint Mode hint (Phase 20): what the viewport does in the current capture / placement step. */
function BlueprintHint() {
  const t = useT();
  const mode = useBlueprintStore((s) => s.mode);
  const kind = useBlueprintStore((s) => s.capture.kind);
  return <>{mode === 'place' ? t('bp.place.hint') : t(`bp.capture.hint.${kind}`)}</>;
}
