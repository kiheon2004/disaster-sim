import { Timeline } from '@/ui/Timeline/Timeline';
import { WindForm } from './WindForm';
import { CommandPanel } from './CommandPanel';
import styles from './BottomPanel.module.css';

export function BottomPanel() {
  return (
    <div className={styles.root}>
      <Timeline />
      <div className={styles.body}>
        <div className={styles.col}>
          <WindForm />
        </div>
        <div className={styles.col}>
          <CommandPanel />
        </div>
      </div>
    </div>
  );
}
