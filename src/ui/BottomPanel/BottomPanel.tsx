import { useRef, useState } from 'react';
import { useT } from '@/i18n/i18n';
import { Timeline } from '@/ui/Timeline/Timeline';
import { WindForm } from './WindForm';
import { EarthquakeForm } from './EarthquakeForm';
import { FloodForm } from './FloodForm';
import { ExperimentPanel } from './ExperimentPanel';
import { Seismogram } from '@/ui/Timeline/Seismogram';
import { Icon } from '@/ui/common/Icon';
import eq from './EarthquakeForm.module.css';
import { CommandPanel } from './CommandPanel';
import styles from './BottomPanel.module.css';

const KEY = 'ds.bottomHeight';
const TAB_KEY = 'ds.hazardTab';
type HazardTab = 'wind' | 'earthquake' | 'flood' | 'experiment';

function initialTab(): HazardTab {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return v === 'earthquake' || v === 'flood' || v === 'experiment' ? v : 'wind';
  } catch {
    return 'wind';
  }
}
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
  const [tab, setTabState] = useState<HazardTab>(initialTab);
  const setTab = (v: HazardTab) => {
    setTabState(v);
    try {
      localStorage.setItem(TAB_KEY, v);
    } catch {
      /* ignore */
    }
  };
  const tabs = (
    <span className={eq.tabs} role="tablist" aria-label={t('panel.wind')}>
      <button role="tab" className={eq.tab} aria-selected={tab === 'wind'} onClick={() => setTab('wind')}>
        <Icon name="wind" size={13} /> {t('hazard.tab.wind')}
      </button>
      <button role="tab" className={eq.tab} aria-selected={tab === 'earthquake'} onClick={() => setTab('earthquake')}>
        <Icon name="quake" size={13} /> {t('hazard.tab.earthquake')}
      </button>
      <button role="tab" className={eq.tab} aria-selected={tab === 'flood'} onClick={() => setTab('flood')}>
        <Icon name="water" size={13} /> {t('hazard.tab.flood')}
      </button>
      <button role="tab" className={eq.tab} aria-selected={tab === 'experiment'} onClick={() => setTab('experiment')}>
        <Icon name="flask" size={13} /> {t('hazard.tab.experiment')}
      </button>
    </span>
  );
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
      <Seismogram />
      <div className={styles.body}>
        <div className={styles.col}>
          {tab === 'wind' ? <WindForm tabs={tabs} /> : tab === 'earthquake' ? <EarthquakeForm tabs={tabs} /> : tab === 'flood' ? <FloodForm tabs={tabs} /> : <ExperimentPanel tabs={tabs} />}
        </div>
        <div className={styles.col}>
          <CommandPanel />
        </div>
      </div>
    </div>
  );
}
