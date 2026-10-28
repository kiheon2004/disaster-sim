import { useRef, useState } from 'react';
import { useT } from '@/i18n/i18n';
import { Timeline } from '@/ui/Timeline/Timeline';
import { WindForm } from './WindForm';
import { CommandPanel } from './CommandPanel';
import styles from './BottomPanel.module.css';

const KEY = 'ds.bottomHeight';
const MIN = 210;

function initialHeight() {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v >= MIN ? v : 262;
  } catch {
    return 262;
  }
}

export function BottomPanel() {
  const t = useT();
  const [height, setHeight] = useState(initialHeight);
  const drag = useRef<{ y: number; h: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, h: height };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const max = Math.round(window.innerHeight * 0.65);
    setHeight(Math.min(max, Math.max(MIN, drag.current.h + (drag.current.y - e.clientY))));
  };
  const onPointerUp = () => {
    drag.current = null;
    try {
      localStorage.setItem(KEY, String(height));
    } catch {
      /* ignore */
    }
  };

  return (
    <div className={styles.root} style={{ height }}>
      <div
        className={styles.resizer}
        role="separator"
        aria-orientation="horizontal"
        title={t('panel.resize')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => setHeight(262)}
      />
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
