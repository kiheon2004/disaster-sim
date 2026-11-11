/**
 * Phase 37 (§14) — the command bar's help, inside the result area: example sentences per sentence class in the
 * current language (from the corpus, loaded when the help is first opened — it is large), the canonical grammar, the
 * keys. Clicking an example puts it in the input; nothing runs.
 */
import { useEffect, useState } from 'react';
import { useLocale, useT } from '@/i18n/i18n';
import { COMMAND_KEYS, COMMAND_KEYS_MORE, GRAMMAR, GRAMMAR_TERMS, helpExamples, type HelpClass } from './help';
import styles from './CommandBar.module.css';

type Tab = 'examples' | 'grammar' | 'keys';
const TABS: readonly Tab[] = ['examples', 'grammar', 'keys'];

type Corpus = typeof import('@/command/corpus/index');
let corpus: Promise<Corpus> | null = null;
/** One download of the corpus chunk for the session. */
const loadCorpusModule = () => (corpus ??= import('@/command/corpus/index'));

export function HelpPanel({ onPick }: { onPick: (command: string) => void }) {
  const t = useT();
  const locale = useLocale();
  const [tab, setTab] = useState<Tab>('examples');
  const [classes, setClasses] = useState<HelpClass[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let on = true;
    loadCorpusModule()
      .then((m) => {
        if (on) setClasses(helpExamples(m.loadCorpus(), locale, m.CORPUS_CLASSES));
      })
      .catch(() => {
        corpus = null;
        if (on) setFailed(true);
      });
    return () => {
      on = false;
    };
  }, [locale]);

  return (
    <div className={styles.view} data-testid="command-help-panel">
      <div className={styles.head}>
        <span className={styles.title}>{t('cmd37.ui.help.title')}</span>
        <span className={styles.tabs} role="tablist">
          {TABS.map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`${styles.small} ${tab === k ? styles.tabOn : ''}`} data-testid={`command-help-tab-${k}`} onClick={() => setTab(k)}>
              {tab === k && <span aria-hidden="true">▸ </span>}{t(`cmd37.ui.help.tab.${k}`)}
            </button>
          ))}
        </span>
      </div>
      {tab === 'examples' && (
        <>
          <div className={`${styles.line} ${styles.note}`}>{t('cmd37.ui.help.examples.hint')}</div>
          {failed && <div className={`${styles.line} ${styles.errLine}`}><span aria-hidden="true">✕</span> {t('cmd37.ui.help.failed')}</div>}
          {!classes && !failed && <div className={`${styles.line} ${styles.dim}`}>{t('cmd37.ui.help.loading')}</div>}
          {classes && (
            <div className={styles.examples}>
              {classes.map((c) => (
                <section key={c.class} className={styles.exClass} data-testid="command-help-class" data-class={c.class}>
                  <h4>{t(`cmd37.ui.class.${c.class}`)}</h4>
                  {c.examples.map((e) => (
                    <div key={e.text} className={styles.example}>
                      <button className={styles.exBtn} data-testid="command-example" title={t('cmd37.ui.help.examples.put')} onClick={() => onPick(e.text)}>{e.text}</button>
                      <span className={`${styles.mono} ${styles.dim} ${styles.exCanon}`} title={e.canonical.join('\n')}>→ {e.canonical.join(' ; ')}</span>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          )}
        </>
      )}
      {tab === 'grammar' && (
        <>
          <table className={styles.table} data-testid="command-grammar">
            <caption>{t('cmd37.ui.help.grammar.caption')}</caption>
            <thead>
              <tr><th scope="col">{t('cmd37.ui.help.grammar.form')}</th><th scope="col">{t('cmd37.ui.help.grammar.does')}</th></tr>
            </thead>
            <tbody>
              {GRAMMAR.map(([verb, form, desc]) => (
                <tr key={form} data-verb={verb}><td className={styles.mono}>{form}</td><td>{t(desc)}</td></tr>
              ))}
            </tbody>
          </table>
          <table className={styles.table} data-testid="command-grammar-terms">
            <caption>{t('cmd37.ui.help.grammar.terms')}</caption>
            <tbody>
              {GRAMMAR_TERMS.map(([term, form, desc]) => (
                <tr key={term}><th scope="row" className={styles.mono}>{term}</th><td className={styles.mono}>{form}</td><td>{t(desc)}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {tab === 'keys' && (
        <table className={styles.table} data-testid="command-keys">
          <caption>{t('cmd37.ui.help.keys.caption')}</caption>
          <tbody>
            {[...COMMAND_KEYS, ...COMMAND_KEYS_MORE].map(([k, desc]) => (
              <tr key={k}><th scope="row"><kbd className={styles.kbd}>{k}</kbd></th><td>{t(desc)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
