/**
 * Placement bar (Phase 35.5): while a disaster is armed — what is being placed and how the map click is interpreted, the
 * run mode (run on click / place and run later), continuous placement, the template's basic settings (advanced folded),
 * undo / redo and Done. While nothing is armed but placed instances wait: the "run placed disasters" button.
 */
import { useT, type MessageKey } from '@/i18n/i18n';
import { phenomena } from '@/phenomena/registry';
import { catalogOf } from '@/phenomena/catalog';
import { disarmPlacement, redoPlacement, undoPlacement } from '@/app/placementActions';
import { usePlacementStore } from '@/ui/placement/placementStore';
import { Segmented } from '@/ui/common/Segmented';
import { Toggle } from '@/ui/common/fields';
import { Icon } from '@/ui/common/Icon';
import { SpecFields, basicKeys } from '@/ui/BottomPanel/ExperimentPanel';
import s from './Phenomena.module.css';

export function PlacementBar() {
  const t = useT();
  const type = usePlacementStore((st) => st.type);
  const template = usePlacementStore((st) => st.template);
  const runMode = usePlacementStore((st) => st.runMode);
  const continuous = usePlacementStore((st) => st.continuous);
  const undo = usePlacementStore((st) => st.undo.length);
  const redo = usePlacementStore((st) => st.redo.length);
  const def = type ? phenomena.implemented(type) : undefined;
  const c = type ? catalogOf(type) : undefined;
  if (!type || !template || !def || !c) return null;
  const basic = basicKeys(def);
  const set = (spec: typeof template) => usePlacementStore.getState().setTemplate(spec);
  return (
    <div className={s.bar} data-testid="placement-bar">
      <div className={s.barHead}>
        <span className={s.pulse} />
        <Icon name={def.icon as 'wind'} size={15} />
        <b>{t('place.armed', { name: t(def.labelKey) })}</b>
        <span className={s.spacer} />
        <button className={s.iconBtn} title={`${t('place.undo')} (Ctrl/⌘+Z)`} disabled={!undo} onClick={() => undoPlacement()}><Icon name="undo" size={13} /></button>
        <button className={s.iconBtn} title={`${t('place.redo')} (Ctrl/⌘+Shift+Z)`} disabled={!redo} onClick={() => redoPlacement()}><Icon name="redo" size={13} /></button>
        <button className={s.done} onClick={() => disarmPlacement()} data-testid="placement-done">{t('place.done')}</button>
      </div>
      <div className={s.barHint}>{t(`place.kind.${c.placement.kind}` as MessageKey)} · {t('place.hint')}</div>
      <div className={s.barRow}>
        <Segmented size="small" value={runMode} onChange={(v) => usePlacementStore.getState().setRunMode(v)} ariaLabel={t('place.mode.plan')}
          options={[{ value: 'plan', label: t('place.mode.plan') }, { value: 'now', label: t('place.mode.now'), tone: 'sim' }]} />
        <Toggle checked={continuous} onChange={(v) => usePlacementStore.getState().setContinuous(v)} label={t('place.continuous')} />
      </div>
      <div className={s.barFields}>
        <SpecFields def={def} spec={template} onChange={set} only={basic} />
        <details className={s.advanced}>
          <summary>{t('place.advanced')}</summary>
          <SpecFields def={def} spec={template} onChange={set} skip={basic} />
        </details>
      </div>
    </div>
  );
}
