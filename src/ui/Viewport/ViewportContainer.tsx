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
import { OverlayToggles } from './OverlayToggles';
import styles from './ViewportContainer.module.css';

export function ViewportContainer() {
  const t = useT();
  const mode = useEditorStore((s) => s.mode);
  const tool = useEditorStore((s) => s.tool);
  const loading = useSimStore((s) => s.status === 'loading');
  const placeItem = getPaletteItem(useEditorStore((s) => s.placeItemId));
  const isEditor = mode === 'editor';

  return (
    <div className={styles.wrap}>
      <Viewport showGrid={isEditor}>{isEditor ? <EditorScene /> : <SimulationScene />}</Viewport>
      <div className={`${styles.overlay} ${styles.topLeft}`}>
        <span className={`${styles.badge} ${isEditor ? '' : styles.sim}`}>
          {t(isEditor ? 'mode.editorShort' : 'mode.simulationShort')}
        </span>
        {isEditor && <ViewportToolbar />}
        {!isEditor && (
          <span className={styles.approx} title={t('model.approximate')}>{t('model.badge')}</span>
        )}
      </div>
      <div className={`${styles.overlay} ${styles.topRight}`}>
        <Compass />
        {!isEditor && <WindHud />}
      </div>
      <div className={`${styles.overlay} ${styles.bottomLeft}`}>
        <span className={styles.hint}>
          {!isEditor
            ? t('viewport.hint.sim')
            : tool === 'place' && placeItem
              ? t('viewport.hint.place', { name: t(placeItem.labelKey) })
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
