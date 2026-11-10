import { TopBar } from '@/ui/TopBar/TopBar';
import { ObjectPalette } from '@/ui/ObjectPalette/ObjectPalette';
import { BottomPanel } from '@/ui/BottomPanel/BottomPanel';
import { ViewportContainer } from '@/ui/Viewport/ViewportContainer';
import { BlueprintDialogs } from '@/ui/Blueprints/BlueprintDialogs';
import { RightPanel } from '@/ui/Phenomena/RightPanel';
import { useUiStore } from '@/ui/uiStore';
import { useT } from '@/i18n/i18n';
import { Icon } from '@/ui/common/Icon';
import styles from './AppLayout.module.css';

export function AppLayout() {
  const t = useT();
  const rightOpen = useUiStore((s) => s.rightOpen);
  return (
    <div className={styles.root} data-right={rightOpen ? 'open' : 'closed'}>
      <header className={styles.top}>
        <TopBar />
      </header>
      <aside className={styles.left}>
        <ObjectPalette />
      </aside>
      <main className={styles.center}>
        <div className={styles.viewport}>
          <ViewportContainer />
          {!rightOpen && (
            <button className={styles.reopen} onClick={() => useUiStore.getState().setRightOpen(true)} title={t('panel.open')} aria-label={t('panel.open')} data-testid="right-open">
              <Icon name="chevronRight" size={14} /> {t('panel.open')}
            </button>
          )}
        </div>
        <section className={styles.bottom}>
          <BottomPanel />
        </section>
      </main>
      {rightOpen && (
        <aside className={styles.right}>
          <RightPanel />
        </aside>
      )}
      <BlueprintDialogs />
    </div>
  );
}
