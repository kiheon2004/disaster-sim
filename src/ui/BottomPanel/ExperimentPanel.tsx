import { useMemo, useState } from 'react';
import { GravityTools } from './GravityTools';
import { CelestialTools } from './CelestialTools';
import { isMessageKey, translateMessage, useLocale, useT, type MessageKey } from '@/i18n/i18n';
import { phenomena } from '@/phenomena/registry';
import { resolveSchedule } from '@/phenomena/schedule';
import { CHANNELS } from '@/phenomena/channels';
import type { ImplementedPhenomenon, ParamField, PhenomenonInstance } from '@/phenomena/types';
import type { EventSpec } from '@/events/specs';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { useSimStore } from '@/simulation/simStore';
import { addPhenomenon, phenomenonContext, runExperiment, updatePhenomenon } from '@/app/actions';
import { deleteInstance, duplicateInstance, runInstance } from '@/app/placementActions';
import { usePlacementStore } from '@/ui/placement/placementStore';
import { simulationController } from '@/simulation/SimulationController';
import type { TimelineEventView } from '@/simulation/simStore';
import { toast } from '@/ui/common/toast';
import { NumberField, Toggle } from '@/ui/common/fields';
import { Icon } from '@/ui/common/Icon';
import { ModelBadge } from '@/ui/common/ModelBadge';
import { useUiStore } from '@/ui/uiStore';
import styles from './BottomPanel.module.css';
import eq from './EarthquakeForm.module.css';
import x from './ExperimentPanel.module.css';
import { DeformationTools } from './DeformationTools';
import { catalogOf } from '@/phenomena/catalog';
import { GroundTools } from './GroundTools';
import { ImpactTools } from './ImpactTools';
import { BlastTools } from './BlastTools';
import { ThermalTools } from './ThermalTools';
import { FireTools } from './FireTools';
import { VolcanoTools } from './VolcanoTools';
import { ClimateTools } from './ClimateTools';
import { AtmosphereTools } from './AtmosphereTools';

/**
 * Experiment tab (Phase 15): the list of phenomena of an experiment, each with its own
 * parameters, start (absolute or after another phenomenon), on/off, visualization and model
 * information. Run starts all enabled ones on one clock; Compare runs them alone and together
 * on the same initial world. The detailed hazard tabs keep their full settings and can add
 * their current configuration here.
 *
 * Phase 35.5: it is the instance list of the right panel's disasters tab — every row is an independent instance with its
 * live state in the run (scheduled / active / paused / stopped / done) and its own controls (run just this one, pause /
 * resume, stop, cancel, duplicate, delete); a row selects its pin on the map. `tabs` (the old bottom-panel header) is
 * optional.
 */
export function ExperimentPanel({ tabs }: { tabs?: React.ReactNode }) {
  const t = useT();
  const locale = useLocale();
  const exp = useWorldStore((s) => s.doc.scenario.experiment);
  const interactions = useWorldStore((s) => s.doc.settings.simulation.interactions?.enabled ?? true);
  const doc = useWorldStore((s) => s.doc);
  const mode = useEditorStore((s) => s.mode);
  const status = useSimStore((s) => s.status);
  const events = useSimStore((s) => s.events);
  const selected = usePlacementStore((s) => s.selected);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const instances = exp?.instances ?? [];
  const sched = useMemo(() => resolveSchedule(instances, phenomenonContext()), [instances, doc.terrain, doc.settings.simulation]); // eslint-disable-line react-hooks/exhaustive-deps
  const startOf = new Map(sched.items.map((r) => [r.instance.id, r]));
  const issueOf = new Map(sched.issues.map((i) => [i.id, i]));
  const live = new Map(events.map((e) => [e.key, e]));
  const inSim = mode === 'simulation';
  const pending = instances.filter((i) => i.enabled && !live.has(i.id)).length;

  return (
    <>
      {tabs && (
        <div className={styles.colHead}>
          {tabs}
          <span className={styles.aside} title={t('exp.interactions.hint')}>
            <Toggle checked={interactions} onChange={(v) => useWorldStore.getState().updateSimulationSettings({ interactions: v })} label={t('exp.interactions')} disabled={mode === 'simulation'} />
          </span>
        </div>
      )}
      <div className={tabs ? styles.colBody : x.body} data-testid="experiment-panel">
        {instances.length === 0 && <div className={eq.info}>{t('exp.empty')}</div>}
        <div className={x.list}>
          {instances.map((inst) => {
            const def = phenomena.implemented(inst.type)!;
            const r = startOf.get(inst.id);
            const issue = issueOf.get(inst.id);
            const ev = live.get(inst.id);
            const st = ev?.status;
            return (
              <div key={inst.id} className={x.row} data-disabled={!inst.enabled} data-instance={inst.id} data-selected={selected === inst.id} data-status={st ?? 'configured'}
                onClick={(e) => { if ((e.target as HTMLElement).closest('button, input, select, label, details')) return; usePlacementStore.getState().select(selected === inst.id ? null : inst.id); }}>
                <div className={x.head}>
                  <Toggle checked={inst.enabled} onChange={(v) => updatePhenomenon(inst.id, { enabled: v })} title={t('exp.enabled')} disabled={!!ev} />
                  <Icon name={def.icon as 'wind'} size={14} />
                  <b className={x.name}>{inst.id} · {t(def.labelKey)}</b>
                  <span className={x.status} data-state={st ?? 'configured'} data-testid={`inst-status-${inst.id}`}>{t(`inst.status.${st ?? (inSim && inst.enabled ? 'notRun' : 'configured')}` as MessageKey)}</span>
                  <span className={x.spacer} />
                  <InstanceControls id={inst.id} ev={ev} enabled={inst.enabled} />
                  <button className={x.icon} title={t(inst.visualize ? 'exp.viz.on' : 'exp.viz.off')} aria-pressed={inst.visualize} onClick={() => updatePhenomenon(inst.id, { visualize: !inst.visualize })}>
                    <Icon name={inst.visualize ? 'eye' : 'eyeOff'} size={13} />
                  </button>
                  <button className={x.icon} title={t('inst.duplicate')} data-testid={`inst-dup-${inst.id}`} onClick={() => duplicateInstance(inst.id)}><Icon name="copy" size={13} /></button>
                  <button className={x.icon} title={t('exp.edit')} aria-expanded={open === inst.id} data-testid={`exp-edit-${inst.id}`} onClick={() => setOpen(open === inst.id ? null : inst.id)}>
                    <Icon name={open === inst.id ? 'chevronDown' : 'chevronRight'} size={13} />
                  </button>
                  <button className={x.icon} title={t('exp.remove')} onClick={() => deleteInstance(inst.id)}><Icon name="trash" size={13} /></button>
                </div>
                <div className={x.sub}>
                  <span className={x.desc}>{translateMessage(locale, def.describe(inst.spec, phenomenonContext()))}</span>
                  <span className={x.time}>{r ? `${r.start.toFixed(0)}–${r.end.toFixed(0)} s` : '—'}</span>
                </div>
                {issue && <div className={x.issue} data-testid="exp-issue">⚠ {t(`exp.issue.${issue.problem}` as MessageKey, { id: inst.id })}</div>}
                {ev && open === inst.id && <div className={x.locked}>{t('inst.locked')}</div>}
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
          <button className={styles.primary} disabled={status === 'loading' || sched.items.length === 0 || (inSim && pending === 0)} onClick={() => void runExperiment()} data-testid="exp-run">
            <Icon name="play" size={14} /> {inSim ? t('exp.applyNow') : t('exp.run')}{inSim && pending > 0 ? ` (${pending})` : ''}
          </button>
          <button className={styles.secondary} disabled={instances.filter((i) => i.enabled).length === 0} onClick={() => useUiStore.getState().setCompareOpen(true)}>
            <Icon name="list" size={14} /> {t('exp.compare')}
          </button>
        </div>
        <div className={eq.disclaimer}>{t('exp.disclaimer')}</div>
      </div>
    </>
  );
}

/** Run / pause / resume / stop / cancel of ONE instance (Phase 35.5) — what its state allows; the reason is in the title. */
function InstanceControls({ id, ev, enabled }: { id: string; ev: TimelineEventView | undefined; enabled: boolean }) {
  const t = useT();
  const ctl = (op: 'cancel' | 'stop' | 'pause' | 'resume') => () => { if (!simulationController.controlEvent(id, op)) toast('warn', { key: 'inst.refused' }); };
  if (!ev) {
    return (
      <button className={x.icon} title={t('inst.runOne')} disabled={!enabled} data-testid={`inst-run-${id}`} onClick={() => void runInstance(id)}>
        <Icon name="play" size={12} />
      </button>
    );
  }
  if (ev.status === 'pending') return <button className={x.icon} title={t('inst.cancel')} data-testid={`inst-cancel-${id}`} onClick={ctl('cancel')}><Icon name="x" size={13} /></button>;
  if (ev.status === 'active' || ev.status === 'paused') {
    return (
      <>
        {ev.pause && (ev.status === 'active'
          ? <button className={x.icon} title={t('inst.pause')} data-testid={`inst-pause-${id}`} onClick={ctl('pause')}><Icon name="pause" size={12} /></button>
          : <button className={x.icon} title={t('inst.resume')} data-testid={`inst-resume-${id}`} onClick={ctl('resume')}><Icon name="play" size={12} /></button>)}
        <button className={x.icon} title={ev.stop ? t('inst.stop') : t('inst.notStoppable')} disabled={!ev.stop} data-testid={`inst-stop-${id}`} onClick={ctl('stop')}>
          <span className={x.stopSq} />
        </button>
      </>
    );
  }
  return null;
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
  const basic = basicKeys(def);
  const advanced = def.fields.filter((f) => !basic.has(f.key));
  return (
    <div className={x.editor}>
      <div className={x.params}>
        <SpecFields def={def} spec={inst.spec} onChange={set} only={basic} />
        {advanced.length > 0 && (
          <details className={x.advanced} data-testid="exp-advanced">
            <summary>{t('place.advanced')} ({advanced.length})</summary>
            <SpecFields def={def} spec={inst.spec} onChange={set} skip={basic} />
          </details>
        )}
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
        {!valid.success && <div className={x.issue} data-testid="exp-invalid">⚠ {valid.error.issues.map((i) => (isMessageKey(i.message) ? t(i.message) : i.message)).join(' · ')}</div>}
        {inst.type === 'terrainDeformation' && <DeformationTools inst={inst} />}
        {(inst.type === 'sinkhole' || inst.type === 'landslide') && <GroundTools inst={inst} />}
        {inst.type === 'impact' && <ImpactTools inst={inst} />}
        {inst.type === 'blast' && <BlastTools inst={inst} />}
        {inst.type === 'heatSource' && <ThermalTools inst={inst} />}
        {inst.type === 'fire' && <FireTools inst={inst} />}
        {inst.type === 'volcano' && <VolcanoTools inst={inst} />}
        {inst.type === 'atmosphere' && <AtmosphereTools inst={inst} />}
          {inst.type === 'climate' && <ClimateTools inst={inst} />}
        {inst.type === 'gravity' && <GravityTools inst={inst} />}
        {inst.type === 'celestial' && <CelestialTools inst={inst} />}
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

/**
 * Editor fields of a phenomenon spec (Phase 35.5: shared by the instance editor and the placement bar). `only` limits them
 * to a set of keys, `skip` leaves keys out — basic / advanced groups (progressive disclosure).
 */
export function SpecFields({ def, spec, onChange, only, skip }: { def: ImplementedPhenomenon<EventSpec>; spec: EventSpec; onChange: (s: EventSpec) => void; only?: ReadonlySet<string>; skip?: ReadonlySet<string> }) {
  const t = useT();
  const fields = def.fields.filter((f) => (!only || only.has(f.key)) && (!skip || !skip.has(f.key)));
  return (
    <>
    {fields.map((f) => {
      if (f.visible && !f.visible(spec)) return null;
      const v = fieldValue(f, spec);
      if (f.options) {
        return (
          <label key={f.key} className={eq.row}>
            <span className={eq.label}>{t(f.labelKey)}</span>
            <select value={String(v)} data-field={f.key} onChange={(e) => onChange(setField(f, spec, e.target.value))}>
              {f.options.map((o) => <option key={o.value} value={o.value}>{t(o.labelKey)}</option>)}
            </select>
          </label>
        );
      }
      // "Auto": show the value the model actually uses (not a placeholder).
      const auto = v === undefined && f.autoValue ? f.autoValue(spec) * (f.scale ?? 1) : undefined;
      return (
        <div key={f.key} className={eq.autoRow} data-field={f.key}>
          <NumberField label={t(f.labelKey)} value={typeof v === 'number' ? v : auto ?? f.min} min={f.min} max={f.max} step={f.step} precision={f.precision} unit={f.unit}
            disabled={v === undefined} onChange={(n, live) => !live && onChange(setField(f, spec, n))} />
          {f.optional ? <Toggle checked={v === undefined} onChange={(b) => onChange(setField(f, spec, b ? undefined : auto ?? f.min + (f.max - f.min) / 4))} label={t('eq.form.auto')} /> : <span />}
        </div>
      );
    })}
    </>
  );
}

/** Field keys shown without opening "advanced": the catalog's basic list (fallback: the first three non-position fields). */
export function basicKeys(def: ImplementedPhenomenon<EventSpec>): ReadonlySet<string> {
  const listed = catalogOf(def.type)?.basic.filter((k) => def.fields.some((f) => f.key === k)) ?? [];
  return new Set(listed.length ? listed : def.fields.filter((f) => !['x', 'z', 'endX', 'endZ'].includes(f.key)).slice(0, 3).map((f) => f.key));
}
