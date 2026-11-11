/**
 * Phase 37 (§9, §13, §14) — what the command bar's result area shows of the session: the open plan (what each line
 * would do, item by item, with Confirm / Cancel), a question with its options, what was not understood with the
 * nearest commands, an error, or what the last command did (query tables included). Every status is a mark and a
 * word; colour only repeats them.
 */
import { useEffect } from 'react';
import { translateMessage, useLocale, useT, type MessageKey } from '@/i18n/i18n';
import type { EntityId } from '@/core/types';
import type { Msg } from '@/command/context';
import type { Plan, PlanItem, QueryTable } from '@/command/planTypes';
import { useEditorStore } from '@/editor/editorStore';
import { useCommandSession } from './commandSession';
import { diffCounts, planLines, type DiffCounts } from './summary';
import styles from './CommandBar.module.css';

/** Items listed per line before the list is cut (a plan may hold 2000). */
const ITEMS_SHOWN = 60;

const ITEM_MARK: Record<PlanItem['status'], string> = { ok: '✓', warn: '!', rejected: '✕' };

/** Reasons a placement check gives have their words since Phase 16 / 36 (`warn.*`); the planner's own are new. */
const reasonKey = (r: PlanItem['reasons'][number]): MessageKey =>
  r === 'room' || r === 'onRoad' || r === 'endedLane' || r === 'noSidewalk' ? `cmd37.ui.reason.${r}` : `warn.${r}`;

/** What would change, as marks with words: + new, ~ changed, − removed, ground, roads, disasters. */
export function Counts({ c }: { c: DiffCounts }) {
  const t = useT();
  const parts: string[] = [];
  if (c.created) parts.push(t('cmd37.ui.count.created', { count: c.created }));
  if (c.changed) parts.push(t('cmd37.ui.count.changed', { count: c.changed }));
  if (c.removed) parts.push(t('cmd37.ui.count.removed', { count: c.removed }));
  if (c.terrainArea) parts.push(t('cmd37.ui.count.terrain', { area: Math.round(c.terrainArea) }));
  if (c.roadsAdded) parts.push(t('cmd37.ui.count.roadsAdded', { count: c.roadsAdded }));
  if (c.roadsRemoved) parts.push(t('cmd37.ui.count.roadsRemoved', { count: c.roadsRemoved }));
  if (c.disastersAdded) parts.push(t('cmd37.ui.count.disastersAdded', { count: c.disastersAdded }));
  if (c.disastersChanged) parts.push(t('cmd37.ui.count.disastersChanged', { count: c.disastersChanged }));
  if (c.disastersRemoved) parts.push(t('cmd37.ui.count.disastersRemoved', { count: c.disastersRemoved }));
  if (!parts.length) return null;
  return <span className={styles.counts} data-testid="command-counts">{parts.join(' · ')}</span>;
}

function useTr() {
  const locale = useLocale();
  return (m: Msg) => translateMessage(locale, m);
}

function Notes({ plan }: { plan: Plan }) {
  const tr = useTr();
  return (
    <>
      {plan.warnings.map((w, k) => (
        <div key={`w${k}`} className={`${styles.line} ${styles.warnLine}`} data-testid="command-warning"><span aria-hidden="true">!</span> {tr(w)}</div>
      ))}
      {plan.notes.map((n, k) => (
        <div key={`n${k}`} className={`${styles.line} ${styles.note}`}><span aria-hidden="true">·</span> {tr(n)}</div>
      ))}
    </>
  );
}

function Items({ items }: { items: readonly PlanItem[] }) {
  const t = useT();
  if (!items.length) return null;
  return (
    <ul className={styles.items}>
      {items.slice(0, ITEMS_SHOWN).map((i, k) => (
        <li key={k} className={`${styles.item} ${styles[`i_${i.status}`]}`} data-testid="command-item" data-status={i.status}>
          <span aria-hidden="true">{ITEM_MARK[i.status]}</span> {t(`cmd37.ui.item.${i.status}`)}
          <span className={styles.mono}> ({Math.round(i.x * 10) / 10}, {Math.round(i.z * 10) / 10})</span>
          {i.snap && i.snap !== 'free' && <span className={styles.dim}> — {t(`snap.kind.${i.snap}`)}</span>}
          {i.reasons.length > 0 && <span> — {i.reasons.map((r) => t(reasonKey(r))).join(' · ')}</span>}
        </li>
      ))}
      {items.length > ITEMS_SHOWN && <li className={styles.dim}>{t('cmd37.ui.item.more', { count: items.length - ITEMS_SHOWN })}</li>}
    </ul>
  );
}

function planCounts(p: Plan): DiffCounts {
  return { ...diffCounts(null), created: p.counts.create, changed: p.counts.change, removed: p.counts.remove };
}

function Table({ table }: { table: QueryTable }) {
  const t = useT();
  const tr = useTr();
  const select = (ids: EntityId[], primary?: EntityId) => useEditorStore.getState().setSelection(ids, primary);
  const cell = (v: string | number | Msg | undefined) => (v === undefined ? '' : typeof v === 'object' ? tr(v) : String(v));
  return (
    <div className={styles.tableWrap}>
      {table.columns.length > 0 && table.rows.length > 0 && (
        <table className={styles.table} data-testid="command-table">
          <caption>{tr(table.title)}</caption>
          <thead>
            <tr>{table.columns.map((c) => <th key={c.key} scope="col">{tr(c.label)}</th>)}</tr>
          </thead>
          <tbody>
            {table.rows.map((r, k) => {
              const id = r.id;
              return (
                <tr
                  key={k}
                  data-id={id}
                  className={id ? styles.pick : undefined}
                  tabIndex={id ? 0 : undefined}
                  title={id ? t('cmd37.ui.table.rowHint') : undefined}
                  onClick={id ? () => select([id], id) : undefined}
                  onKeyDown={id ? (e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    select([id], id);
                  } : undefined}
                >
                  {table.columns.map((c) => <td key={c.key}>{cell(r.cells[c.key])}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {table.ids.length > 0 && table.columns.length > 0 && (
        <button className={styles.small} data-testid="command-select-these" onClick={() => select([...table.ids])}>
          {t('cmd37.ui.table.select', { count: table.ids.length })}
        </button>
      )}
    </div>
  );
}

interface Props {
  onConfirm: () => void;
  onCancel: () => void;
  onChoose: (k: number) => void;
  /** Put a command in the input (a suggestion). */
  onPick: (command: string) => void;
}

export function ResultArea({ onConfirm, onCancel, onChoose, onPick }: Props) {
  const t = useT();
  const tr = useTr();
  const plan = useCommandSession((s) => s.plan);
  const feedback = useCommandSession((s) => s.feedback);

  // The option under the pointer / the keyboard focus is emphasised in the viewport; nothing stays emphasised after.
  const question = feedback.k === 'clarify' && !plan?.armed;
  useEffect(() => {
    if (!question) return;
    return () => useCommandSession.getState().setHover(null);
  }, [question]);

  if (plan?.armed) {
    const lines = planLines(plan);
    return (
      <div className={styles.view} data-testid="command-plan">
        <div className={styles.head}>
          <span className={styles.title}><span aria-hidden="true">◆</span> {t('cmd37.ui.plan.title')}</span>
          <Counts c={diffCounts(plan.preview.diff)} />
          <span className={styles.spacer} />
          <button className={`${styles.small} ${styles.primary}`} data-testid="command-confirm" onClick={onConfirm}>
            {t(plan.confirm && !plan.confirmed ? 'cmd37.ui.plan.confirmFirst' : 'cmd37.ui.plan.confirm')}
          </button>
          <button className={styles.small} data-testid="command-cancel" onClick={onCancel}>{t('cmd37.ui.plan.cancel')}</button>
        </div>
        {plan.notice && <div className={`${styles.line} ${styles.warnLine}`} data-testid="command-notice"><span aria-hidden="true">!</span> {tr(plan.notice)}</div>}
        {plan.confirm && (
          <div className={`${styles.line} ${styles.warnLine}`} data-testid="command-confirm-note">
            <span aria-hidden="true">!</span> {tr(plan.confirm)}{plan.confirmed ? ` ${t('cmd37.ui.plan.confirmAsked')}` : ''}
          </div>
        )}
        {plan.perLine && lines.length > 1 && <div className={`${styles.line} ${styles.note}`}><span aria-hidden="true">·</span> {t('cmd37.ui.plan.perLine', { count: lines.length })}</div>}
        {lines.map((p, k) => (
          <div key={k} className={styles.block} data-testid="command-line">
            <div className={styles.line}>
              {lines.length > 1 && <span className={styles.dim}>{k + 1}. </span>}
              <span className={styles.mono}>{p.canonical}</span> <Counts c={planCounts(p)} />
            </div>
            <Notes plan={p} />
            <Items items={p.items} />
          </div>
        ))}
      </div>
    );
  }

  switch (feedback.k) {
    case 'clarify':
      return (
        <div className={styles.view} data-testid="command-question">
          <div className={styles.head}><span className={styles.title}><span aria-hidden="true">?</span> {tr(feedback.question)}</span></div>
          <div className={styles.options} role="group" aria-label={tr(feedback.question)}>
            {feedback.options.map((o, k) => {
              const point = () => useCommandSession.getState().setHover(o.highlight ?? null);
              const leave = () => useCommandSession.getState().setHover(null);
              return (
                <button key={k} className={styles.option} data-testid="command-option" title={o.canonical} onClick={() => onChoose(k)} onMouseEnter={point} onMouseLeave={leave} onFocus={point} onBlur={leave}>
                  {k < 9 && <span className={styles.key}>{k + 1}</span>} {tr(o.label)}
                  <span className={`${styles.mono} ${styles.dim}`}> {o.canonical}</span>
                </button>
              );
            })}
          </div>
        </div>
      );
    case 'ask':
      return (
        <div className={styles.view} data-testid="command-question">
          <div className={styles.head}><span className={styles.title}><span aria-hidden="true">?</span> {tr(feedback.question)}</span></div>
          {feedback.understood && <div className={styles.line}>{t('cmd37.ui.ask.understood')} <span className={styles.mono}>{feedback.understood}</span></div>}
          <div className={`${styles.line} ${styles.note}`}><span aria-hidden="true">·</span> {t('cmd37.ui.ask.how')}</div>
        </div>
      );
    case 'unknown':
      return (
        <div className={styles.view} data-testid="command-unknown">
          <div className={styles.head}><span className={`${styles.title} ${styles.errLine}`}><span aria-hidden="true">✕</span> {t('cmd37.ui.unknown.title')}</span></div>
          <div className={styles.line}>{tr(feedback.reason)}</div>
          {feedback.suggestions.length > 0 && (
            <div className={styles.options} role="group" aria-label={t('cmd37.ui.unknown.suggestions')}>
              <span className={styles.dim}>{t('cmd37.ui.unknown.suggestions')}</span>
              {feedback.suggestions.map((s, k) => (
                <button key={k} className={`${styles.option} ${styles.mono}`} data-testid="command-suggestion" onClick={() => onPick(s)}>{s}</button>
              ))}
            </div>
          )}
          <div className={`${styles.line} ${styles.note}`}><span aria-hidden="true">·</span> {t('cmd37.ui.unknown.nothing')}</div>
        </div>
      );
    case 'error':
      return (
        <div className={styles.view} data-testid="command-error">
          <div className={styles.head}>
            <span className={`${styles.title} ${styles.errLine}`}><span aria-hidden="true">✕</span> {t('cmd37.ui.error.title')}</span>
            {feedback.line > 0 && <span className={styles.dim}>{t('cmd37.ui.error.line', { line: feedback.line + 1 })}</span>}
          </div>
          <div className={styles.line}>{tr(feedback.error)}</div>
          {feedback.notes.map((n, k) => <div key={k} className={`${styles.line} ${styles.note}`}><span aria-hidden="true">·</span> {tr(n)}</div>)}
          <div className={`${styles.line} ${styles.note}`}><span aria-hidden="true">·</span> {t('cmd37.ui.error.nothing')}</div>
        </div>
      );
    case 'done':
      return (
        <div className={styles.view} data-testid="command-done">
          {feedback.lines.map((l, k) => (
            <div key={k} className={styles.block} data-testid="command-line">
              <div className={styles.line}>
                <span className={styles.okMark}><span aria-hidden="true">✓</span> {t('cmd37.ui.done')}</span>{' '}
                <span className={styles.mono}>{l.plan.canonical}</span>
                {l.plan.table ? <span> — {tr(l.plan.table.title)}</span> : <> <Counts c={planCounts(l.plan)} /></>}
              </div>
              <Notes plan={l.plan} />
              <Items items={l.plan.items.filter((i) => i.status !== 'ok')} />
              {l.plan.table && <Table table={l.plan.table} />}
            </div>
          ))}
        </div>
      );
    default:
      return <div className={`${styles.view} ${styles.dim}`} data-testid="command-empty">{t('cmd37.ui.empty')}</div>;
  }
}
