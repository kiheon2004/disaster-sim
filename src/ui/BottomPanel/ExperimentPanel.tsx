import { useMemo, useState } from 'react';
import { translateMessage, useLocale, useT, type MessageKey } from '@/i18n/i18n';
import { phenomena } from '@/phenomena/registry';
import { resolveSchedule } from '@/phenomena/schedule';
import { CHANNELS } from '@/phenomena/channels';
import type { ImplementedPhenomenon, ParamField, PhenomenonInstance } from '@/phenomena/types';
import type { EventSpec } from '@/events/specs';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { useSimStore } from '@/simulation/simStore';
import { addPhenomenon, phenomenonContext, removePhenomenon, runExperiment, updatePhenomenon } from '@/app/actions';
import { NumberField, Toggle } from '@/ui/common/fields';
import { Icon } from '@/ui/common/Icon';
import { ModelBadge } from '@/ui/common/ModelBadge';
import { useUiStore } from '@/ui/uiStore';
import styles from './BottomPanel.module.css';
import eq from './EarthquakeForm.module.css';
import x from './ExperimentPanel.module.css';
import { DeformationTools } from './DeformationTools';
import { GroundTools } from './GroundTools';

/**
 * Experiment tab (Phase 15): the list of phenomena of an experiment, each with its own
 * parameters, start (absolute or after another phenomenon), on/off, visualization and model
 * information. Run starts all enabled ones on one clock; Compare runs them alone and together
 * on the same initial world. The detailed hazard tabs keep their full settings and can add
 * their current configuration here.
 */
export function ExperimentPanel({ tabs }: { tabs: React.ReactNode }) {
  const t = useT();
  const locale = useLocale();
  const exp = useWorldStore((s) => s.doc.scenario.experiment);
  const interactions = useWorldStore((s) => s.doc.settings.simulation.interactions?.enabled ?? true);
  const doc = useWorldStore((s) => s.doc);
  const mode = useEditorStore((s) => s.mode);
  const status = useSimStore((s) => s.status);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const instances = exp?.instances ?? [];
  const sched = useMemo(() => resolveSchedule(instances, phenomenonContext()), [instances, doc.terrain, doc.settings.simulation]); // eslint-disable-line react-hooks/exhaustive-deps
  const startOf = new Map(sched.items.map((r) => [r.instance.id, r]));
  const issueOf = new Map(sched.issues.map((i) => [i.id, i]));

  return (
    <>
      <div className={styles.colHead}>
        {tabs}
        <span className={styles.aside} title={t('exp.interactions.hint')}>
          <Toggle checked={interactions} onChange={(v) => useWorldStore.getState().updateSimulationSettings({ interactions: v })} label={t('exp.interactions')} disabled={mode === 'simulation'} />
        </span>
      </div>
      <div className={styles.colBody} data-testid="experiment-panel">
        {instances.length === 0 && <div className={eq.info}>{t('exp.empty')}</div>}
        <div className={x.list}>
          {instances.map((inst) => {
            const def = phenomena.implemented(inst.type)!;
            const r = startOf.get(inst.id);
            const issue = issueOf.get(inst.id);
            return (
              <div key={inst.id} className={x.row} data-disabled={!inst.enabled} data-instance={inst.id}>
                <div className={x.head}>
                  <Toggle checked={inst.enabled} onChange={(v) => updatePhenomenon(inst.id, { enabled: v })} title={t('exp.enabled')} />
                  <Icon name={def.icon as 'wind'} size={14} />
                  <b className={x.name}>{inst.id} · {t(def.labelKey)}</b>
                  <span className={x.desc}>{translateMessage(locale, def.describe(inst.spec, phenomenonContext()))}</span>
                  <span className={x.time}>{r ? `${r.start.toFixed(0)}–${r.end.toFixed(0)} s` : '—'}</span>
                  <button className={x.icon} title={t(inst.visualize ? 'exp.viz.on' : 'exp.viz.off')} aria-pressed={inst.visualize} onClick={() => updatePhenomenon(inst.id, { visualize: !inst.visualize })}>
                    <Icon name={inst.visualize ? 'eye' : 'eyeOff'} size={13} />
                  </button>
                  <button className={x.icon} title={t('exp.edit')} aria-expanded={open === inst.id} data-testid={`exp-edit-${inst.id}`} onClick={() => setOpen(open === inst.id ? null : inst.id)}>
                    <Icon name={open === inst.id ? 'chevronDown' : 'chevronRight'} size={13} />
                  </button>
                  <button className={x.icon} title={t('exp.remove')} onClick={() => removePhenomenon(inst.id)}><Icon name="trash" size={13} /></button>
                </div>
                {issue && <div className={x.issue} data-testid="exp-issue">⚠ {t(`exp.issue.${issue.problem}` as MessageKey, { id: inst.id })}</div>}
                {open === inst.id && <InstanceEditor inst={inst} def={def} others={instances.filter((i) => i.id !== inst.id)} />}
              </div>
            );
          })}
        </div>
        <div className={x.addRow}>
          <button className={eq.small} onClick={() => setAdding((a) => !a)} aria-expanded={adding}><Icon name="plus" size={12} /> {t('exp.add')}</button>
          {adding && (
            <div className={x.menu} role="menu">
              {phenomena.listImplemented().map((d) => (
                <button key={d.type} role="menuitem" onClick={() => { addPhenomenon(d.type); setAdding(false); }}>
                  <Icon name={d.icon as 'wind'} size={13} /> {t(d.labelKey)}
                </button>
              ))}
              <div className={x.menuSep}>{t('phen.status.planned')}</div>
              {phenomena.listPlanned().map((d) => (
                <button key={d.type} role="menuitem" disabled title={`${t('exp.planned.needs')}: ${d.missing.map((k) => t(k)).join(', ')}`}>
                  {t(d.labelKey)} <span className={x.planned}>{t('phen.status.planned')}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className={styles.actions}>
          <button className={styles.primary} disabled={status === 'loading' || sched.items.length === 0} onClick={() => void runExperiment()}>
            <Icon name="play" size={14} /> {mode === 'simulation' ? t('exp.applyNow') : t('exp.run')}
          </button>
          <button className={styles.secondary} disabled={instances.filter((i) => i.enabled).length === 0} onClick={() => useUiStore.getState().setCompareOpen(true)}>
            <Icon name="list" size={14} /> {t('exp.compare')}
          </button>
          <div className={eq.disclaimer}>{t('exp.disclaimer')}</div>
        </div>
      </div>
    </>
  );
}

function fieldValue(f: ParamField, spec: EventSpec): number | string | undefined {
  const v = f.get ? f.get(spec) : (spec as unknown as Record<string, number | string | undefined>)[f.key];
  return typeof v === 'number' ? v * (f.scale ?? 1) : v;
}

function setField(f: ParamField, spec: EventSpec, v: number | string | undefined): EventSpec {
  const stored = typeof v === 'number' ? v / (f.scale ?? 1) : v;
  if (f.set) return f.set(spec, stored);
  const next = { ...spec } as unknown as Record<string, unknown>;
  if (stored === undefined) delete next[f.key];
  else next[f.key] = stored;
  return next as unknown as EventSpec;
}

function InstanceEditor({ inst, def, others }: { inst: PhenomenonInstance; def: ImplementedPhenomenon<EventSpec>; others: PhenomenonInstance[] }) {
  const t = useT();
  const locale = useLocale();
  const ctx = phenomenonContext();
  const valid = def.schema.safeParse(inst.spec);
  const set = (spec: EventSpec) => updatePhenomenon(inst.id, { spec });
  const after = 'after' in inst.start ? inst.start : null;
  return (
    <div className={x.editor}>
      <div className={x.params}>
        {def.fields.map((f) => {
          if (f.visible && !f.visible(inst.spec)) return null;
          const v = fieldValue(f, inst.spec);
          if (f.options) {
            return (
              <label key={f.key} className={eq.row}>
                <span className={eq.label}>{t(f.labelKey)}</span>
                <select value={String(v)} data-field={f.key} onChange={(e) => set(setField(f, inst.spec, e.target.value))}>
                  {f.options.map((o) => <option key={o.value} value={o.value}>{t(o.labelKey)}</option>)}
                </select>
              </label>
            );
          }
          return (
            <div key={f.key} className={eq.autoRow} data-field={f.key}>
              <NumberField label={t(f.labelKey)} value={typeof v === 'number' ? v : f.min} min={f.min} max={f.max} step={f.step} precision={f.precision} unit={f.unit}
                disabled={v === undefined} onChange={(n, live) => !live && set(setField(f, inst.spec, n))} />
              {f.optional ? <Toggle checked={v === undefined} onChange={(b) => set(setField(f, inst.spec, b ? undefined : f.min + (f.max - f.min) / 4))} label={t('eq.form.auto')} /> : <span />}
            </div>
          );
        })}
        {def.seeded && (
          <div className={eq.autoRow}>
            <NumberField label={t('eq.form.seed')} value={inst.seed ?? ctx.seed} min={0} max={999999999} step={1} precision={0} disabled={inst.seed === undefined}
              onChange={(n, live) => !live && updatePhenomenon(inst.id, { seed: Math.round(n) })} />
            <Toggle checked={inst.seed === undefined} onChange={(b) => updatePhenomenon(inst.id, { seed: b ? undefined : ctx.seed })} label={t('eq.form.seed.project')} />
          </div>
        )}
      </div>
      <div className={x.side}>
        <div className={eq.row}>
          <span className={eq.label}>{t('exp.start')}</span>
          <select value={after ? `${after.after}:${after.anchor}` : 'at'} onChange={(e) => {
            const val = e.target.value;
            if (val === 'at') updatePhenomenon(inst.id, { start: { at: 0 } });
            else {
              const [id, anchor] = val.split(':');
              updatePhenomenon(inst.id, { start: { after: id, anchor: anchor as 'start' | 'end', offset: after?.offset ?? 0 } });
            }
          }}>
            <option value="at">{t('exp.start.at')}</option>
            {others.map((o) => (
              <optgroup key={o.id} label={`${o.id} · ${t(phenomena.get(o.type)!.labelKey)}`}>
                <option value={`${o.id}:start`}>{t('exp.start.afterStart', { id: o.id })}</option>
                <option value={`${o.id}:end`}>{t('exp.start.afterEnd', { id: o.id })}</option>
              </optgroup>
            ))}
          </select>
        </div>
        <NumberField label={after ? t('exp.start.offset') : t('exp.start.time')} value={after ? after.offset : 'at' in inst.start ? inst.start.at : 0} min={after ? -3600 : 0} max={86400} step={1} precision={1} unit="s"
          onChange={(n, live) => !live && updatePhenomenon(inst.id, { start: after ? { ...after, offset: n } : { at: n } })} />
        {!valid.success && <div className={x.issue} data-testid="exp-invalid">⚠ {valid.error.issues[0]?.message}</div>}
        {inst.type === 'terrainDeformation' && <DeformationTools inst={inst} />}
        {(inst.type === 'sinkhole' || inst.type === 'landslide') && <GroundTools inst={inst} />}
        <div className={eq.assumptions}>
          <b>{t('flood.form.assumptions')}</b>
          {def.assumptions(inst.spec, ctx).map((a, i) => <div key={i}>· {translateMessage(locale, a)}</div>)}
          {def.assumptions(inst.spec, ctx).length === 0 && <div>—</div>}
        </div>
        <div className={x.chips}>
          {def.channels.map((c) => <span key={c} className={x.channel} title={CHANNELS[c].quantity}>{t(CHANNELS[c].labelKey)}</span>)}
        </div>
        <div className={x.chips}>{def.models.map((m) => <ModelBadge key={m} id={m} />)}</div>
      </div>
    </div>
  );
}
