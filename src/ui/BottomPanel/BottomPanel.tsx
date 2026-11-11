import { Timeline } from '@/ui/Timeline/Timeline';
import { Seismogram } from '@/ui/Timeline/Seismogram';
import { CommandBar } from '@/ui/Command/CommandBar';
import styles from './BottomPanel.module.css';

/**
 * Bottom strip: the simulation transport — play / pause, reset, time, the event track, speed (Timeline) — the
 * seismogram while an earthquake runs, and (Phase 37) the command bar: one input that is always there, a summary line,
 * and a result area that opens on Enter. (The disaster forms are in the right panel's disasters tab since Phase 35.5;
 * the command bar replaces that phase's command drawer.)
 */
export function BottomPanel() {
  return (
    <div className={styles.root}>
      <Timeline />
      <Seismogram />
      <CommandBar />
    </div>
  );
}
