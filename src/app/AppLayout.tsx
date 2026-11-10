import { TopBar } from '@/ui/TopBar/TopBar';
import { ObjectPalette } from '@/ui/ObjectPalette/ObjectPalette';
import { BottomPanel } from '@/ui/BottomPanel/BottomPanel';
import { ViewportContainer } from '@/ui/Viewport/ViewportContainer';
import { BlueprintDialogs } from '@/ui/Blueprints/BlueprintDialogs';
import { RightPanel } from '@/ui/Phenomena/RightPanel';
import { useUiStore } from '@/ui/uiStore';
import styles from './AppLayout.module.css';

export function AppLayout() {
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
