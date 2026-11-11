/**
 * Phase 37 (§14) — the command bar: one input that is always there (bottom strip), one summary line of fixed height,
 * and a result area that opens only on explicit events (Enter, a question, a result, its button) — the strip must not
 * change height while typing, the 3D canvas would resize with it.
 *
 * The bar wires no stores together: typing sets the session's text, everything else goes through app/commandActions.
 * It is not a dialog (no `role="dialog"`, no `aria-modal`): the editor's shortcuts keep working around it and rest by
 * themselves while its input has the keyboard.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { scriptLines } from '@/command/interpret';
import { createPortal } from 'react-dom';
import { translateMessage, useLocale, useT } from '@/i18n/i18n';
import { Icon } from '@/ui/common/Icon';
import { useUiStore } from '@/ui/uiStore';
import { useWorldStore } from '@/world/worldStore';
import { cancelCommand, chooseOption, confirmPlan, draftCommand, enterAppliesAtOnce, proposeCommand, submitCommand, understandCommand } from '@/app/commandActions';
import { useCommandSession, type Feedback } from './commandSession';
import { focusCommandBar, registerBarInput, useBarStore, type BarPanel } from './barStore';
import { barKey, DRAFT_DELAY, draftDelay, walkHistory, WALK_START, type Walk } from './barKeys';
import { applyCompletion, complete, type Completion } from './complete';
import { barState, diffCounts, hints, planLines, richResult, STATE_SYMBOL, warningCount } from './summary';
import { Counts, ResultArea } from './ResultArea';
import { HelpPanel } from './HelpPanel';
import { ScriptEditor } from './ScriptEditor';
import styles from './CommandBar.module.css';

const LIST_ID = 'command-completions';
const RESULTS_ID = 'command-results';

type Outcome = Awaited<ReturnType<typeof submitCommand>>;

interface OpenList {
  /** The text and caret the list was opened on (Esc goes back to them). */
  base: string;
  caret: number;
  completion: Completion;
  index: number;
  /** Where the list hangs: over the input (the bottom strip clips its children, so the list is a portal). */
  left: number;
  bottom: number;
}

export function CommandBar() {
  const t = useT();
  const locale = useLocale();
  const text = useCommandSession((s) => s.text);
  const plan = useCommandSession((s) => s.plan);
  const feedback = useCommandSession((s) => s.feedback);
  const understood = useCommandSession((s) => s.understood);
  const draftMs = useCommandSession((s) => s.draftMs);
  // (the hint "Enter applies at once" depends on this setting)
  useCommandSession((s) => s.settings.applySmall);
  const open = useUiStore((s) => s.commandOpen);
  const panel = useBarStore((s) => s.panel);

  const inputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const walk = useRef<Walk>(WALK_START);
  const busy = useRef(false);
  const caretAfter = useRef<number | null>(null);
  /** The text a question / message was given for: once the text is another one, it is a draft again (the message stays readable). */
  const answered = useRef<{ feedback: Feedback; text: string }>({ feedback, text });
  if (answered.current.feedback !== feedback) answered.current = { feedback, text };
  const [list, setList] = useState<OpenList | null>(null);

  useEffect(() => {
    registerBarInput(inputRef.current);
    return () => registerBarInput(null);
  }, []);

  // A draft plan follows the text (debounced; slower after a slow draft; after a very slow one only the parser follows
  // the text). An empty bar is drafted at once: that costs nothing and lets the live preview start again.
  useEffect(() => {
    const s = useCommandSession.getState();
    if (s.plan?.armed) return;
    if (!text.trim()) {
      draftCommand();
      return;
    }
    // Paused: only the parser runs while typing ("understood as …"); the plan is made by Enter.
    const delay = draftDelay(s.draftMs);
    const h = setTimeout(delay === null ? understandCommand : draftCommand, delay ?? DRAFT_DELAY);
    return () => clearTimeout(h);
  }, [text]);

  // When the open plan goes away (Esc, Cancel, a mode switch …) the text stays: say what it is understood as again —
  // the parser only, no new draft plan (nothing may reappear in the viewport after a plan was cancelled).
  const armed = !!plan?.armed;
  useEffect(() => {
    if (!armed) understandCommand();
  }, [armed]);

  // A script (several lines) is in the bar only as an open plan (Run → preview → Enter confirms): once that plan is
  // gone — cancelled, or stopped by a question / an error — the one-line input is free again. The script itself stays
  // in the script editor.
  const scriptLeft = text.includes('\n') && !plan?.armed;
  useEffect(() => {
    if (scriptLeft) useCommandSession.getState().setText('');
  }, [scriptLeft]);

  // After a completion the caret goes behind the inserted word (a controlled input would leave it at the end).
  useLayoutEffect(() => {
    if (caretAfter.current === null || !inputRef.current) return;
    inputRef.current.setSelectionRange(caretAfter.current, caretAfter.current);
    caretAfter.current = null;
  });

  useEffect(() => {
    if (list) document.getElementById(`${LIST_ID}-${list.index}`)?.scrollIntoView({ block: 'nearest' });
  }, [list]);

  const stale = text.trim() !== '' && text !== answered.current.text;
  const facts = { text, plan, feedback, stale };
  const state = barState(facts);
  const lines = planLines(plan);
  const counts = diffCounts(plan?.preview.diff ?? null);
  const warnings = warningCount(lines);
  const paused = state === 'draft' && draftDelay(draftMs) === null && !plan;
  const isScript = text.includes('\n');
  const tr = (m: Parameters<typeof translateMessage>[1]) => translateMessage(locale, m);

  /** The text as the user (or a button of the bar) changes it. */
  const edit = (next: string) => {
    walk.current = WALK_START;
    setList(null);
    useCommandSession.getState().setText(next);
  };

  const showPanel = (p: BarPanel) => {
    useBarStore.getState().setPanel(p);
    if (!useUiStore.getState().commandOpen) useUiStore.getState().setCommandOpen(true);
  };

  /** After Enter / Confirm / an answer: the result area opens for what needs more than the summary line. */
  const show = (r: Outcome) => {
    if (r === 'empty') return;
    walk.current = WALK_START;
    if (r === 'applied' && !richResult(useCommandSession.getState().feedback)) return;
    showPanel('results');
  };

  const act = async (fn: () => Promise<Outcome>) => {
    if (busy.current) return;
    busy.current = true;
    try {
      show(await fn());
    } finally {
      busy.current = false;
    }
  };

  /** A command from a button (a suggestion, a help example): into the input, drafted, the keyboard in the bar. */
  const propose = (command: string) => {
    walk.current = WALK_START;
    setList(null);
    proposeCommand(command);
    focusCommandBar(false);
  };

  const put = (base: string, completion: Completion, k: number) => {
    const r = applyCompletion(base, completion, k);
    caretAfter.current = r.caret;
    walk.current = WALK_START;
    useCommandSession.getState().setText(r.text);
  };

  const cycle = (dir: -1 | 1) => {
    const el = inputRef.current;
    if (!el || isScript) return;
    if (list) {
      const n = list.completion.candidates.length;
      const index = (list.index + dir + n) % n;
      setList({ ...list, index });
      put(list.base, list.completion, index);
      return;
    }
    const caret = el.selectionStart ?? text.length;
    const completion = complete(text, caret, useWorldStore.getState().doc);
    if (!completion.candidates.length) return;
    if (completion.candidates.length === 1) {
      put(text, completion, 0);
      return;
    }
    const r = el.getBoundingClientRect();
    const index = dir > 0 ? 0 : completion.candidates.length - 1;
    setList({ base: text, caret, completion, index, left: r.left, bottom: window.innerHeight - r.top + 4 });
    put(text, completion, index);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const a = barKey(
      { key: e.key, keyCode: e.keyCode, isComposing: e.nativeEvent.isComposing, shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey },
      { composing: composing.current, listOpen: !!list, text, clarify: feedback.k === 'clarify' ? { options: feedback.options.length, text: feedback.text } : null },
    );
    if (a.do === 'ime') {
      // The key is the IME's. (Tab alone is held back: the keyboard must not leave the bar in the middle of a syllable.)
      if (e.key === 'Tab') e.preventDefault();
      return;
    }
    if (a.do === 'pass') return;
    e.preventDefault();
    switch (a.do) {
      case 'submit':
        void act(() => submitCommand());
        break;
      case 'cancel':
        // Esc: the open plan, then a question / message; with nothing left to cancel the keyboard goes back to the editor.
        if (!cancelCommand()) inputRef.current?.blur();
        break;
      case 'history': {
        // (scripts are remembered too, but a script does not fit the one-line input: the editor's "from history" has them)
        const step = walkHistory(useCommandSession.getState().history.filter((h) => !h.includes('\n')), walk.current, a.dir, text);
        if (!step) break;
        useCommandSession.getState().setText(step.text);
        walk.current = step.walk;
        break;
      }
      case 'complete':
      case 'listMove':
        cycle(a.dir);
        break;
      case 'listAccept':
        setList(null);
        break;
      case 'listClose':
        if (list) {
          caretAfter.current = list.caret;
          useCommandSession.getState().setText(list.base);
          setList(null);
        }
        break;
      case 'choose': {
        const k = a.k;
        void act(async () => {
          await chooseOption(k);
          return 'planned';
        });
        break;
      }
    }
  };

  const understoodText =
    state === 'plan' || state === 'confirm' ? (plan?.canonical ?? []).join(' ; ')
      : state === 'draft' ? (understood ?? []).join(' ; ')
        : state === 'question' && feedback.k === 'ask' ? feedback.understood
          : state === 'done' && feedback.k === 'done' ? feedback.lines.map((l) => l.plan.canonical).join(' ; ')
            : '';
  const resultText = state === 'done' && feedback.k === 'done' && feedback.lines[0]?.plan.table ? tr(feedback.lines[0].plan.table.title) : '';
  const hintText = hints({ ...facts, understood, appliesAtOnce: enterAppliesAtOnce(), paused }).map(tr).join(' · ');

  return (
    <div className={styles.bar} data-testid="command-bar" data-state={state} role="group" aria-label={t('cmd37.ui.label')}>
      {open && (
        <div className={styles.results} id={RESULTS_ID} data-testid="command-results" data-panel={panel} role="region" aria-label={t(`cmd37.ui.panel.${panel}`)} aria-live={panel === 'results' ? 'polite' : 'off'}>
          {panel === 'help' ? (
            <HelpPanel onPick={propose} />
          ) : panel === 'script' ? (
            <ScriptEditor onDone={show} />
          ) : (
            <ResultArea
              onConfirm={() => void act(() => confirmPlan())}
              onCancel={() => {
                cancelCommand();
                focusCommandBar(false);
              }}
              onChoose={(k) =>
                void act(async () => {
                  await chooseOption(k);
                  focusCommandBar(false);
                  return 'planned';
                })
              }
              onPick={propose}
            />
          )}
        </div>
      )}
      <div className={styles.summary} data-testid="command-summary">
        <span className={`${styles.state} ${styles[`s_${state}`]}`} data-testid="command-state-label">
          <span aria-hidden="true">{STATE_SYMBOL[state]}</span> {t(`cmd37.ui.state.${state}`)}
        </span>
        <span data-testid="command-state" hidden>{state}</span>
        <span className={styles.understood} data-testid="command-understood" title={understoodText}>{understoodText}</span>
        {(state === 'plan' || state === 'confirm' || state === 'draft') && <Counts c={counts} />}
        {warnings > 0 && (state === 'plan' || state === 'confirm' || state === 'draft') && (
          <span className={styles.warn} data-testid="command-warning-count"><span aria-hidden="true">!</span> {t('cmd37.ui.warnings', { count: warnings })}</span>
        )}
        {resultText && <span className={styles.result}>{resultText}</span>}
        <span className={styles.hint} data-testid="command-hint">{hintText}</span>
      </div>
      <div className={styles.row}>
        <span className={styles.prompt} aria-hidden="true">›</span>
        <input
          ref={inputRef}
          className={styles.input}
          value={isScript ? t('cmd37.ui.scriptInBar', { count: scriptLines(text).length }) : text}
          readOnly={isScript}
          onChange={(e) => edit(e.target.value)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onBlur={() => {
            composing.current = false;
            setList(null);
          }}
          placeholder={t('cmd37.ui.placeholder')}
          aria-label={t('cmd37.ui.label')}
          role="combobox"
          aria-expanded={!!list}
          aria-controls={LIST_ID}
          aria-autocomplete="list"
          aria-activedescendant={list ? `${LIST_ID}-${list.index}` : undefined}
          data-testid="command-input"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
        />
        <button className={styles.btn} aria-pressed={open && panel === 'help'} title={t('cmd37.ui.help.title')} aria-label={t('cmd37.ui.help.title')} data-testid="command-help"
          onClick={() => (open && panel === 'help' ? useBarStore.getState().setPanel('results') : showPanel('help'))}>
          ?
        </button>
        <button className={styles.btn} aria-pressed={open && panel === 'script'} title={t('cmd37.ui.script.title')} data-testid="command-script"
          onClick={() => (open && panel === 'script' ? useBarStore.getState().setPanel('results') : showPanel('script'))}>
          <Icon name="list" size={13} /> {t('cmd37.ui.script')}
        </button>
        <button className={styles.btn} aria-expanded={open} aria-controls={RESULTS_ID} title={t('cmd37.ui.toggle.title')} data-testid="command-toggle"
          onClick={() => useUiStore.getState().setCommandOpen(!open)}>
          <Icon name="terminal" size={13} /> {t('cmd37.ui.toggle')} <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        </button>
      </div>
      {list && createPortal(
        <ul className={styles.list} id={LIST_ID} role="listbox" aria-label={t('cmd37.ui.cand.title')} data-testid="command-completions" style={{ left: list.left, bottom: list.bottom }}>
          {list.completion.candidates.map((c, k) => (
            <li
              key={c.text}
              id={`${LIST_ID}-${k}`}
              role="option"
              aria-selected={k === list.index}
              className={`${styles.cand} ${k === list.index ? styles.candOn : ''}`}
              data-testid="command-completion"
              // (mousedown, not click: the input keeps the keyboard)
              onMouseDown={(e) => {
                e.preventDefault();
                put(list.base, list.completion, k);
                setList(null);
              }}
            >
              <span className={styles.candMark} aria-hidden="true">{k === list.index ? '▸' : ''}</span>
              <span className={styles.candText}>{c.text}</span>
              <span className={styles.candKind}>{t(`cmd37.ui.cand.${c.kind}`)}{c.hint ? ` · ${c.hint}` : ''}</span>
            </li>
          ))}
          {list.completion.total > list.completion.candidates.length && (
            <li className={styles.candMore} role="presentation">{t('cmd37.ui.cand.more', { count: list.completion.total - list.completion.candidates.length })}</li>
          )}
        </ul>,
        document.body,
      )}
    </div>
  );
}
