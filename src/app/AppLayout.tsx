import { TopBar } from '@/ui/TopBar/TopBar';
import { ObjectPalette } from '@/ui/ObjectPalette/ObjectPalette';
import { InspectorPanel } from '@/ui/Inspector/InspectorPanel';
import { BottomPanel } from '@/ui/BottomPanel/BottomPanel';
import { ViewportContainer } from '@/ui/Viewport/ViewportContainer';
import styles from './AppLayout.module.css';

export function AppLayout() {
  return (
    <div className={styles.root}>
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
      <aside className={styles.right}>
        <InspectorPanel />
      </aside>
    </div>
  );
}
