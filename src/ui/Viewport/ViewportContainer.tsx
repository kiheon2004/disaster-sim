import { Viewport } from '@/rendering/Viewport';
import { EditorScene } from '@/editor/EditorScene';
import { useEditorStore } from '@/editor/editorStore';
import { getPaletteItem } from '@/objects/palette';
import { useT } from '@/i18n/i18n';
import { Compass } from './Compass';
import { ViewportToolbar } from './ViewportToolbar';
import styles from './ViewportContainer.module.css';

export function ViewportContainer() {
  const t = useT();
  const mode = useEditorStore((s) => s.mode);
  const tool = useEditorStore((s) => s.tool);
  const placeItem = getPaletteItem(useEditorStore((s) => s.placeItemId));
  const isEditor = mode === 'editor';

  return (
    <div className={styles.wrap}>
      <Viewport showGrid={isEditor}>
        <EditorScene />
      </Viewport>
      <div className={`${styles.overlay} ${styles.topLeft}`}>
        <span className={`${styles.badge} ${isEditor ? '' : styles.sim}`}>
          {t(isEditor ? 'mode.editorShort' : 'mode.simulationShort')}
        </span>
        {isEditor && <ViewportToolbar />}
      </div>
      <div className={`${styles.overlay} ${styles.topRight}`}>
        <Compass />
      </div>
      <div className={`${styles.overlay} ${styles.bottomLeft}`}>
        <span className={styles.hint}>
          {tool === 'place' && placeItem
            ? t('viewport.hint.place', { name: t(placeItem.labelKey) })
            : t('viewport.hint.camera')}
        </span>
      </div>
    </div>
  );
}
