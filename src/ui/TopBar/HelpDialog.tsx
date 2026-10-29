import { useEffect, useState } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import { Icon } from '@/ui/common/Icon';
import styles from './HelpDialog.module.css';

const KEYS: [string, MessageKey][] = [
  ['LMB drag', 'help.key.orbit'],
  ['RMB drag', 'help.key.pan'],
  ['Wheel', 'help.key.zoom'],
  ['V / P / B / L / A', 'shortcut.tools'],
  ['Shift + click / drag', 'shortcut.multiSelect'],
  ['Ctrl/⌘ + C / V', 'shortcut.copyPaste'],
  ['Ctrl/⌘ + A', 'shortcut.selectAll'],
  ['Ctrl/⌘ + G / Shift+G', 'shortcut.group'],
  ['T', 'shortcut.fineRotate'],
  ['Enter', 'shortcut.apply'],
  ['W / E / R', 'shortcut.transform'],
  ['R (placing)', 'help.key.rotateGhost'],
  ['R / T / Enter (blueprint)', 'help.key.blueprint'],
  ['F', 'shortcut.focus'],
  ['G', 'shortcut.snap'],
  ['Ctrl/⌘ + D', 'shortcut.duplicate'],
  ['Delete', 'shortcut.delete'],
  ['Ctrl/⌘ + Z', 'shortcut.undo'],
  ['Ctrl/⌘ + Shift + Z', 'help.key.redo'],
  ['Space', 'help.key.playPause'],
  ['Esc', 'shortcut.escape'],
];

const STEPS: MessageKey[] = ['help.step1', 'help.step2', 'help.step3', 'help.step4', 'help.step5'];

export function HelpButton() {
  const t = useT();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <>
      <button className={styles.btn} title={t('topbar.help')} onClick={() => setOpen(true)}>
        <Icon name="help" />
      </button>
      {open && (
        <div className={styles.backdrop} onMouseDown={() => setOpen(false)}>
          <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={t('topbar.help')} onMouseDown={(e) => e.stopPropagation()}>
            <div className={styles.head}>
              {t('help.title')}
              <button onClick={() => setOpen(false)} aria-label={t('common.close')}><Icon name="x" /></button>
            </div>
            <div className={styles.body}>
              <div>
                <h3>{t('help.workflow')}</h3>
                <ol>{STEPS.map((k) => <li key={k}>{t(k)}</li>)}</ol>
              </div>
              <div>
                <h3>{t('help.shortcuts')}</h3>
                <div className={styles.keys}>
                  {KEYS.map(([k, d]) => (
                    <span key={k} style={{ display: 'contents' }}>
                      <span className={styles.kbd}>{k}</span>
                      <span>{t(d)}</span>
                    </span>
                  ))}
                </div>
              </div>
              <div className={styles.full}>
                <h3>{t('help.model')}</h3>
                <ul>
                  <li>{t('help.model.1')}</li>
                  <li>{t('help.model.2')}</li>
                  <li>{t('help.model.3')}</li>
                  <li>{t('help.model.4')}</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
