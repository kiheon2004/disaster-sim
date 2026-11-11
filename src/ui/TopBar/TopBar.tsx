import { useViewStore } from '@/rendering/viewStore';
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/i18n';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import {
  exportProject,
  importProject,
  loadProject,
  loadSampleTown,
  loadStressScene,
  newProject,
  saveProject,
} from '@/app/actions';
import { Icon } from '@/ui/common/Icon';
import { LanguageToggle } from './LanguageToggle';
import { ModeSwitch } from './ModeSwitch';
import { HelpButton } from './HelpDialog';
import { useBlueprintStore } from '@/editor/blueprintStore';
import styles from './TopBar.module.css';
import { exportBackup, hasBackup } from '@/app/autosave';

export function TopBar() {
  const t = useT();
  const name = useWorldStore((s) => s.doc.meta.name);
  const canUndo = useWorldStore((s) => s.past.length > 0);
  const canRedo = useWorldStore((s) => s.future.length > 0);
  const editing = useEditorStore((s) => s.mode) === 'editor';

  return (
    <div className={styles.bar}>
      <div className={styles.brand}>
        <img src="/favicon.svg" className={styles.logo} alt="" />
        <span>{t('app.title')}</span>
      </div>
      <div className={styles.sep} />
      <input
        className={styles.name}
        value={name}
        placeholder={t('app.untitled')}
        aria-label={t('topbar.projectName')}
        onChange={(e) => useWorldStore.getState().setProjectName(e.target.value)}
      />
      <div className={styles.group}>
        <button className={styles.iconBtn} disabled={!editing} onClick={() => useBlueprintStore.getState().setWizardOpen(true)} title={t('wiz.title')} data-testid="topbar-new-world">
          <Icon name="globe" /> {t('topbar.newWorld')}
        </button>
        <button className={styles.iconBtn} onClick={saveProject} title={t(editing ? 'topbar.save.title' : 'topbar.save.titleRun')} data-testid="save">
          <Icon name="save" /> {t('topbar.save')}
        </button>
        <button className={styles.iconBtn} onClick={loadProject} disabled={!editing} title={t('topbar.load.title')}>
          <Icon name="folder" /> {t('topbar.load')}
        </button>
        <MoreMenu disabled={!editing} />
      </div>
      <div className={styles.sep} />
      <div className={styles.group}>
        <button className={styles.iconBtn} disabled={!editing || !canUndo} title={t('topbar.undo')} onClick={() => useWorldStore.getState().undo()}>
          <Icon name="undo" />
        </button>
        <button className={styles.iconBtn} disabled={!editing || !canRedo} title={t('topbar.redo')} onClick={() => useWorldStore.getState().redo()}>
          <Icon name="redo" />
        </button>
      </div>
      <div className={styles.center}>
        <ModeSwitch />
      </div>
      <div className={styles.right}>
        <LanguageToggle />
        <HelpButton />
      </div>
    </div>
  );
}

function MoreMenu({ disabled }: { disabled: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div className={styles.menuWrap} ref={ref}>
      <button className={styles.iconBtn} disabled={disabled} onClick={() => setOpen((o) => !o)} title={t('topbar.more')} aria-haspopup="menu" aria-expanded={open}>
        <Icon name="more" />
      </button>
      {open && (
        <div className={styles.menu} role="menu">
          <button role="menuitem" onClick={run(newProject)}><Icon name="plus" size={14} /> {t('topbar.new')}</button>
          <button role="menuitem" onClick={run(loadSampleTown)}><Icon name="sparkle" size={14} /> {t('topbar.sample')}</button>
          {[100, 500, 1000].map((n) => (
            <button key={n} role="menuitem" onClick={run(() => loadStressScene(n))}><Icon name="list" size={14} /> {t('topbar.stress', { n })}</button>
          ))}
          <button role="menuitem" onClick={run(() => useViewStore.getState().togglePerfHud())}><Icon name="list" size={14} /> {t('topbar.perfHud')}</button>
          <div className={styles.menuSep} />
          <button role="menuitem" onClick={run(exportProject)}><Icon name="save" size={14} /> {t('topbar.export')}</button>
          <button role="menuitem" onClick={run(() => void importProject())}><Icon name="folder" size={14} /> {t('topbar.import')}</button>
          {hasBackup() && <button role="menuitem" onClick={run(() => void exportBackup())}><Icon name="save" size={14} /> {t('ed36.exportBackup')}</button>}
        </div>
      )}
    </div>
  );
}
