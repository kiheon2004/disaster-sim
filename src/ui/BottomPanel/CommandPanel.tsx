import { useEffect, useRef, useState } from 'react';
import { useLocale, useT, translateMessage, type MessageKey } from '@/i18n/i18n';
import type { ParseResult } from '@/commands/CommandParser';
import { executeCommand, parseCommand } from '@/app/actions';
import { Icon } from '@/ui/common/Icon';
import { nearestCompass } from '@/core/compass';
import { useSimStore } from '@/simulation/simStore';
import { useEditorStore } from '@/editor/editorStore';
import { useWindForm } from './windFormStore';
import { useCommandStore, type CommandEntry } from './commandStore';
import { describeParsed, describeUnsupported, waterAssumptions } from './describeCommand';
import { useWorldStore } from '@/world/worldStore';
import bp from './BottomPanel.module.css';
import styles from './CommandPanel.module.css';

const EXAMPLES: MessageKey[] = ['cmd.ex.1', 'cmd.ex.2', 'cmd.ex.3', 'cmd.ex.7', 'cmd.ex.8', 'cmd.ex.4', 'cmd.ex.6'];

/** Unspecified values come from the wind form — or from the wind currently blowing in the simulation. */
function defaults() {
  const f = useWindForm.getState();
  const live = useSimStore.getState().wind;
  const blowing = useEditorStore.getState().mode === 'simulation' && live.speed > 0.5;
  return { direction: blowing ? nearestCompass(live.bearing) : f.direction, duration: f.duration, gustStrength: f.gust };
}

/** Natural-language / structured command console. */
export function CommandPanel() {
  const t = useT();
  const entries = useCommandStore((s) => s.entries);
  const [input, setInput] = useState('');
  const [preview, setPreview] = useState<ParseResult | null>(null);
  const [busy, setBusy] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);
  const recall = useRef(-1);

  // Live parse preview (debounced).
  useEffect(() => {
    if (!input.trim()) {
      setPreview(null);
      return;
    }
    const h = setTimeout(() => void parseCommand(input, defaults()).then(setPreview), 120);
    return () => clearTimeout(h);
  }, [input]);

  useEffect(() => {
    historyRef.current?.scrollTo({ top: historyRef.current.scrollHeight });
  }, [entries.length]);

  const submit = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const result = await executeCommand(text, defaults());
      useCommandStore.getState().add({ input: text, result, executed: result.ok && result.commands.length > 0 });
      if (result.ok) setInput('');
    } finally {
      setBusy(false);
      recall.current = -1;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const inputs = useCommandStore.getState().inputs;
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    } else if (e.key === 'ArrowUp' && inputs.length) {
      e.preventDefault();
      recall.current = recall.current < 0 ? inputs.length - 1 : Math.max(0, recall.current - 1);
      setInput(inputs[recall.current]);
    } else if (e.key === 'ArrowDown' && recall.current >= 0) {
      e.preventDefault();
      recall.current = recall.current + 1;
      if (recall.current >= inputs.length) {
        recall.current = -1;
        setInput('');
      } else setInput(inputs[recall.current]);
    }
  };

  return (
    <>
      <div className={bp.colHead}>
        <Icon name="terminal" size={14} /> {t('cmd.title')}
        <span className={bp.aside}>
          <span className={styles.badge} title={t('cmd.parser.title')}>{t('cmd.parser')}</span>
        </span>
      </div>
      <div className={styles.body}>
        <div className={styles.history} ref={historyRef} aria-live="polite">
          {entries.length === 0 && <div className={styles.intro}>{t('cmd.empty')}</div>}
          {entries.map((e) => (
            <Entry key={e.id} entry={e} />
          ))}
        </div>
        <div className={styles.examples}>
          {EXAMPLES.map((k) => (
            <button key={k} className={styles.chip} onClick={() => setInput(t(k))}>
              {t(k)}
            </button>
          ))}
        </div>
        <PreviewLine result={preview} />
        <div className={styles.form}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('cmd.placeholder')}
            aria-label={t('cmd.title')}
            data-testid="command-input"
            spellCheck={false}
          />
          <button onClick={() => void submit()} disabled={!input.trim() || busy}>
            <Icon name="play" size={13} /> {t('cmd.run')}
          </button>
        </div>
      </div>
    </>
  );
}

function PreviewLine({ result }: { result: ParseResult | null }) {
  const t = useT();
  const locale = useLocale();
  if (!result) return <div className={styles.preview} />;
  const parts = [
    ...result.commands.map((c) => describeParsed(c, t)),
    ...result.unsupported.map((u) => describeUnsupported(u, t)),
  ];
  const err = result.errors[0];
  return (
    <div className={`${styles.preview} ${err ? styles.err : styles.ok}`}>
      <b>{t('cmd.preview')}</b>
      {err ? translateMessage(locale, err) : parts.join('  ⟶  ')}
    </div>
  );
}

function Entry({ entry }: { entry: CommandEntry }) {
  const t = useT();
  const locale = useLocale();
  const [json, setJson] = useState(false);
  const r = entry.result;
  return (
    <div className={styles.entry}>
      <div className={styles.input}>
        <span>{entry.input}</span>
        {r.commands.length > 0 && (
          <button className={styles.jsonBtn} onClick={() => setJson((j) => !j)} aria-pressed={json}>
            {t('cmd.showJson')}
          </button>
        )}
      </div>
      {r.commands.map((c, i) => (
        <div key={i}>
          <div className={`${styles.line} ${styles.ok}`}>✓ {describeParsed(c, t)}</div>
          {c.notes.map((n, j) => (
            <div key={j} className={styles.note}>· {translateMessage(locale, n)}</div>
          ))}
          {c.command.kind === 'event' &&
            waterAssumptions(c.command.spec, useWorldStore.getState().doc.terrain, useWorldStore.getState().doc.settings.simulation.water).map((n, j) => (
              <div key={`w${j}`} className={styles.note}>· {translateMessage(locale, n)}</div>
            ))}
        </div>
      ))}
      {r.unsupported.map((u, i) => (
        <div key={`u${i}`} className={`${styles.line} ${styles.warn}`}>⚠ {describeUnsupported(u, t)}</div>
      ))}
      {r.warnings.map((w, i) => (
        <div key={`w${i}`} className={`${styles.line} ${styles.warn}`}>⚠ {translateMessage(locale, w)}</div>
      ))}
      {r.errors.map((er, i) => (
        <div key={`e${i}`} className={`${styles.line} ${styles.err}`}>✗ {translateMessage(locale, er)}</div>
      ))}
      {json && (
        <pre className={styles.json}>
          {JSON.stringify(r.commands.map((c) => (c.delay ? { ...c.command, delay: c.delay } : c.command)), null, 2)}
        </pre>
      )}
    </div>
  );
}
