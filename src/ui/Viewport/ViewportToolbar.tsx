import { useT } from '@/i18n/i18n';
import { useEditorStore, type TransformMode } from '@/editor/editorStore';
import { Icon, type IconName } from '@/ui/common/Icon';
import styles from './ViewportToolbar.module.css';

const MODES: { mode: TransformMode; icon: IconName; key: string; label: 'tool.move' | 'tool.rotate' | 'tool.scale' }[] = [
  { mode: 'translate', icon: 'move', key: 'W', label: 'tool.move' },
  { mode: 'rotate', icon: 'rotate', key: 'E', label: 'tool.rotate' },
  { mode: 'scale', icon: 'scale', key: 'R', label: 'tool.scale' },
];

/** Vertical tool strip: select/transform modes and grid snap. */
export function ViewportToolbar() {
  const t = useT();
  const tool = useEditorStore((s) => s.tool);
  const transformMode = useEditorStore((s) => s.transformMode);
  const snap = useEditorStore((s) => s.snap);
  const ed = useEditorStore.getState;

  return (
    <div className={styles.bar} role="toolbar">
      <button
        className={`${styles.btn} ${tool === 'select' ? styles.active : ''}`}
        title={`${t('tool.select')} (Esc)`}
        onClick={() => ed().armPlacement(null)}
      >
        <Icon name="cursor" size={16} />
      </button>
      <div className={styles.sep} />
      {MODES.map((m) => (
        <button
          key={m.mode}
          className={`${styles.btn} ${tool === 'select' && transformMode === m.mode ? styles.active : ''}`}
          title={`${t(m.label)} (${m.key})`}
          onClick={() => {
            ed().armPlacement(null);
            ed().setTransformMode(m.mode);
          }}
        >
          <Icon name={m.icon} size={16} />
        </button>
      ))}
      <div className={styles.sep} />
      <button className={`${styles.btn} ${snap ? styles.active : ''}`} title={`${t('palette.snap')} (G)`} onClick={() => ed().toggleSnap()}>
        <Icon name="magnet" size={16} />
      </button>
    </div>
  );
}
