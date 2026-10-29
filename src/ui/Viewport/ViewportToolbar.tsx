import { useT, type MessageKey } from '@/i18n/i18n';
import { useEditorStore, type EditorTool, type TransformMode } from '@/editor/editorStore';
import { useBuildStore } from '@/editor/buildStore';
import { copySelection, deleteSelection, duplicateSelection, startPaste } from '@/app/buildActions';
import { Icon, type IconName } from '@/ui/common/Icon';
import styles from './ViewportToolbar.module.css';

const MODES: { mode: TransformMode; icon: IconName; key: string; label: 'tool.move' | 'tool.rotate' | 'tool.scale' }[] = [
  { mode: 'translate', icon: 'move', key: 'W', label: 'tool.move' },
  { mode: 'rotate', icon: 'rotate', key: 'E', label: 'tool.rotate' },
  { mode: 'scale', icon: 'scale', key: 'R', label: 'tool.scale' },
];

/** Build tools (Phase 16). Exactly one is active; each owns viewport input while active. */
export const BUILD_TOOLS: { tool: Exclude<EditorTool, 'terrain' | 'paste' | 'building' | 'road'>; icon: IconName; key: string; label: MessageKey }[] = [
  { tool: 'select', icon: 'cursor', key: 'V', label: 'build.tool.select' },
  { tool: 'place', icon: 'place', key: 'P', label: 'build.tool.place' },
  { tool: 'brush', icon: 'scatter', key: 'B', label: 'build.tool.brush' },
  { tool: 'line', icon: 'line', key: 'L', label: 'build.tool.line' },
  { tool: 'area', icon: 'area', key: 'A', label: 'build.tool.area' },
];

/**
 * Build toolbar (vertical strip in the viewport): tools, transform modes, edit actions and grid
 * snap. Only shown in edit mode — the hazard tools live in the bottom panel.
 */
export function ViewportToolbar() {
  const t = useT();
  const tool = useEditorStore((s) => s.tool);
  const transformMode = useEditorStore((s) => s.transformMode);
  const snap = useEditorStore((s) => s.snap);
  const count = useEditorStore((s) => s.selectedIds.length);
  const hasClip = useBuildStore((s) => !!s.clipboard);
  const ed = useEditorStore.getState;

  return (
    <div className={styles.bar} role="toolbar" aria-label={t('build.title')} data-testid="build-toolbar">
      {BUILD_TOOLS.map((b) => (
        <button
          key={b.tool}
          className={`${styles.btn} ${tool === b.tool ? styles.active : ''}`}
          title={`${t(b.label)} (${b.key})`}
          aria-pressed={tool === b.tool}
          data-tool={b.tool}
          onClick={() => ed().setTool(b.tool)}
        >
          <Icon name={b.icon} size={16} />
        </button>
      ))}
      <button
        className={`${styles.btn} ${tool === 'paste' ? styles.active : ''}`}
        title={`${t('build.tool.paste')} (Ctrl/⌘+V)`}
        aria-pressed={tool === 'paste'}
        data-tool="paste"
        disabled={!hasClip}
        onClick={startPaste}
      >
        <Icon name="paste" size={16} />
      </button>
      <div className={styles.sep} />
      {MODES.map((m) => (
        <button
          key={m.mode}
          className={`${styles.btn} ${tool === 'select' && transformMode === m.mode ? styles.active : ''}`}
          title={`${t(m.label)} (${m.key})`}
          onClick={() => {
            ed().setTool('select');
            ed().setTransformMode(m.mode);
          }}
        >
          <Icon name={m.icon} size={16} />
        </button>
      ))}
      <div className={styles.sep} />
      <button className={styles.btn} disabled={!count} title={`${t('build.tool.copy')} (Ctrl/⌘+C)`} onClick={() => copySelection()}>
        <Icon name="copy" size={16} />
      </button>
      <button className={styles.btn} disabled={!count} title={`${t('build.tool.duplicate')} (Ctrl/⌘+D)`} onClick={duplicateSelection}>
        <Icon name="plus" size={16} />
      </button>
      <button className={styles.btn} disabled={!count} title={`${t('build.tool.delete')} (Delete)`} onClick={deleteSelection}>
        <Icon name="trash" size={16} />
      </button>
      <div className={styles.sep} />
      <button className={`${styles.btn} ${snap ? styles.active : ''}`} title={`${t('palette.snap')} (G)`} onClick={() => ed().toggleSnap()}>
        <Icon name="magnet" size={16} />
      </button>
    </div>
  );
}
