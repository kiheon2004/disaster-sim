import { useT } from '@/i18n/i18n';
import { Timeline } from '@/ui/Timeline/Timeline';
import { Seismogram } from '@/ui/Timeline/Seismogram';
import { Icon } from '@/ui/common/Icon';
import { useUiStore } from '@/ui/uiStore';
import { CommandPanel } from './CommandPanel';
import styles from './BottomPanel.module.css';

/**
 * Bottom strip (Phase 35.5): only the simulation transport — play / pause, reset, time, the event track, speed (Timeline) —
 * and the seismogram while an earthquake runs. The disaster forms moved to the right panel's disasters tab; the command
 * console is a drawer opened from here (same parser, same execution path).
 */
export function BottomPanel() {
  const t = useT();
  const cmd = useUiStore((s) => s.commandOpen);
  return (
    <div className={styles.root}>
      <Timeline />
      <Seismogram />
      <div className={styles.drawerBar}>
        <button className={styles.drawerBtn} aria-expanded={cmd} onClick={() => useUiStore.getState().setCommandOpen(!cmd)} title={t('cmd.toggleHint')} data-testid="command-toggle">
          <Icon name="terminal" size={13} /> {t('cmd.toggle')} <Icon name={cmd ? 'chevronDown' : 'chevronRight'} size={12} />
        </button>
      </div>
      {cmd && (
        <div className={styles.drawer}>
          <CommandPanel />
        </div>
      )}
    </div>
  );
}
