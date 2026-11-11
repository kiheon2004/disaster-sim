/**
 * Phase 37 (§15) — the script editor, inside the command bar's result area (a text area, not a dialog): several
 * commands, one per line, run as ONE plan → preview → confirm, like a single command. Scripts are plain text
 * (`.dscmd.txt`): loaded from and saved to a file, kept in the browser between visits — never in the world document,
 * and never evaluated as code.
 */
import { useRef, useState } from 'react';
import { useT } from '@/i18n/i18n';
import { cancelCommand, historyScript, runScript } from '@/app/commandActions';
import { MAX_SCRIPT_LINES } from '@/command/interpret';
import { SMALL_EDIT_ITEMS } from '@/command/planTypes';
import { useCommandSession } from './commandSession';
import { focusCommandBar, useBarStore } from './barStore';
import { scriptKey } from './barKeys';
import styles from './CommandBar.module.css';

export const SCRIPT_FILE = 'commands.dscmd.txt';
/** Largest script file read (a 500-line script is a few tens of kB; anything far larger is not a script). */
const MAX_FILE_BYTES = 1_000_000;

type Outcome = Awaited<ReturnType<typeof runScript>>;

export function ScriptEditor({ onDone }: { onDone: (r: Outcome) => void }) {
  const t = useT();
  const script = useBarStore((s) => s.script);
  const perLine = useCommandSession((s) => s.settings.scriptPerLine);
  const applySmall = useCommandSession((s) => s.settings.applySmall);
  const composing = useRef(false);
  const busy = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState('');
  const setScript = (text: string) => useBarStore.getState().setScript(text);
  const lines = script.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).length;

  const run = async () => {
    if (busy.current || !script.trim()) return;
    busy.current = true;
    try {
      const r = await runScript(script, useCommandSession.getState().settings.scriptPerLine);
      onDone(r);
      // The plan (or what stopped it) is shown by the bar; Enter there confirms.
      focusCommandBar(false);
    } finally {
      busy.current = false;
    }
  };

  const load = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setNote(t('cmd37.ui.script.tooLarge', { name: file.name }));
      return;
    }
    try {
      setScript(await file.text());
      setNote(t('cmd37.ui.script.loaded', { name: file.name }));
    } catch {
      setNote(t('cmd37.ui.script.unreadable', { name: file.name }));
    }
  };

  const save = () => {
    const url = URL.createObjectURL(new Blob([script], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = SCRIPT_FILE;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setNote(t('cmd37.ui.script.saved', { name: SCRIPT_FILE }));
  };

  return (
    <div className={`${styles.view} ${styles.scriptView}`} data-testid="command-script-panel">
      <div className={styles.head}>
        <span className={styles.title}>{t('cmd37.ui.script.title')}</span>
        <button className={`${styles.small} ${styles.primary}`} data-testid="command-script-run" disabled={!lines} title={t('cmd37.ui.script.run.title')} onClick={() => void run()}>
          {t('cmd37.ui.script.run')}
        </button>
        <button className={styles.small} data-testid="command-script-history" title={t('cmd37.ui.script.history.title')} onClick={() => { setScript(historyScript()); setNote(''); }}>
          {t('cmd37.ui.script.history')}
        </button>
        <button className={styles.small} data-testid="command-script-load" onClick={() => fileRef.current?.click()}>{t('cmd37.ui.script.load')}</button>
        <input
          ref={fileRef}
          type="file"
          accept=".txt,text/plain"
          hidden
          data-testid="command-script-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            void load(f);
          }}
        />
        <button className={styles.small} data-testid="command-script-save" disabled={!script} onClick={save}>{t('cmd37.ui.script.save')}</button>
        <label className={styles.check} title={t('cmd37.ui.script.perLine.title')}>
          <input type="checkbox" checked={perLine} data-testid="command-script-perline" onChange={(e) => useCommandSession.getState().setSettings({ scriptPerLine: e.target.checked })} />
          {t('cmd37.ui.script.perLine')}
        </label>
        <label className={styles.check} title={t('cmd37.ui.script.applySmall.title', { max: SMALL_EDIT_ITEMS })}>
          <input type="checkbox" checked={applySmall} data-testid="command-apply-small" onChange={(e) => useCommandSession.getState().setSettings({ applySmall: e.target.checked })} />
          {t('cmd37.ui.script.applySmall')}
        </label>
      </div>
      <textarea
        className={styles.script}
        value={script}
        data-testid="command-script-text"
        aria-label={t('cmd37.ui.script.title')}
        placeholder={t('cmd37.ui.script.placeholder')}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        onChange={(e) => {
          setScript(e.target.value);
          if (note) setNote('');
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onBlur={() => {
          composing.current = false;
        }}
        onKeyDown={(e) => {
          const a = scriptKey({ key: e.key, keyCode: e.keyCode, isComposing: e.nativeEvent.isComposing, shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey }, composing.current);
          if (a.do === 'pass' || a.do === 'ime') return;
          e.preventDefault();
          if (a.do === 'run') void run();
          else if (!cancelCommand()) e.currentTarget.blur();
        }}
      />
      <div className={`${styles.line} ${styles.note}`} data-testid="command-script-note">
        {note || t(lines > MAX_SCRIPT_LINES ? 'cmd37.ui.script.tooLong' : 'cmd37.ui.script.count', { count: lines, max: MAX_SCRIPT_LINES })}
      </div>
    </div>
  );
}
