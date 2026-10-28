import { useMemo } from 'react';
import type { Vec3 } from '@/core/types';
import type { ComponentKind, PhysicalProperties, WorldObject } from '@/core/model';
import { degToRad, radToDeg } from '@/core/math';
import { useT } from '@/i18n/i18n';
import { getDefinition } from '@/objects/registry';
import { useWorldStore } from '@/world/worldStore';
import { deleteSelected, duplicateSelected, focusObject } from '@/app/actions';
import { estimateCriticalSpeeds } from '@/simulation/damage/windLoad';
import { Icon, type IconName } from '@/ui/common/Icon';
import { Section } from '@/ui/common/Panel';
import { SeismicSections } from './SeismicInspector';
import { ColorField, NumberField, SelectField, ToggleField, Vec3Field } from '@/ui/common/fields';
import { displayName, fmt } from '@/ui/format';
import styles from './Inspector.module.css';

const store = () => useWorldStore.getState();

export function ObjectInspector({ obj, readOnly = false }: { obj: WorldObject; readOnly?: boolean }) {
  const t = useT();
  const def = getDefinition(obj.type);
  const id = obj.id;

  return (
    <>
      <div className={styles.header}>
        <div className={styles.typeIcon}><Icon name={def.icon as IconName} size={18} /></div>
        <div className={styles.titleCol}>
          <input
            key={id}
            className={styles.nameInput}
            defaultValue={obj.name}
            placeholder={displayName(obj, t)}
            disabled={readOnly}
            aria-label={t('inspector.name')}
            onBlur={(e) => e.target.value !== obj.name && store().rename(id, e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          <span className={styles.sub}>{t(def.labelKey)} · {id}{obj.group ? ` · ${t('object.group')}` : ''}</span>
        </div>
        <div className={styles.actions}>
          <button className={styles.iconBtn} title={t('inspector.focus')} onClick={() => focusObject(id)}><Icon name="focus" size={15} /></button>
          {!readOnly && (
            <>
              <button className={styles.iconBtn} title={t('inspector.duplicate')} onClick={duplicateSelected}><Icon name="copy" size={15} /></button>
              <button className={`${styles.iconBtn} ${styles.danger}`} title={t('inspector.delete')} onClick={deleteSelected}><Icon name="trash" size={15} /></button>
            </>
          )}
        </div>
      </div>

      <TransformSection obj={obj} readOnly={readOnly} />
      <ParamsSection obj={obj} readOnly={readOnly} />
      {!def.inert && <PhysicsSection obj={obj} readOnly={readOnly} />}
      {!def.inert && <EstimateSection obj={obj} />}
      <SeismicSections obj={obj} readOnly={readOnly} />
      {obj.components.length > 1 && <ComponentsSection obj={obj} />}
    </>
  );
}

function TransformSection({ obj, readOnly }: { obj: WorldObject; readOnly: boolean }) {
  const t = useT();
  const { position, rotation, scale } = obj.transform;
  const rotDeg = rotation.map((r) => radToDeg(r)) as Vec3;
  const upd = (patch: Parameters<ReturnType<typeof store>['updateTransform']>[1], live: boolean) =>
    store().updateTransform(obj.id, patch, { history: !live });
  const checkpoint = () => store().checkpoint();
  return (
    <Section title={t('inspector.transform')}>
      <Vec3Field label={t('inspector.position')} value={position} step={0.1} precision={2} disabled={readOnly}
        onScrubStart={checkpoint} onChange={(v, live) => upd({ position: [v[0], Math.max(0, v[1]), v[2]] }, live)} />
      <Vec3Field label={t('inspector.rotation')} value={rotDeg} step={1} precision={1} disabled={readOnly}
        onScrubStart={checkpoint} onChange={(v, live) => upd({ rotation: v.map(degToRad) as Vec3 }, live)} />
      <Vec3Field label={t('inspector.scale')} value={scale} step={0.05} precision={2} min={0.1} max={10} disabled={readOnly}
        onScrubStart={checkpoint} onChange={(v, live) => upd({ scale: v }, live)} />
    </Section>
  );
}

function ParamsSection({ obj, readOnly }: { obj: WorldObject; readOnly: boolean }) {
  const t = useT();
  const def = getDefinition(obj.type);
  if (!def.paramSchema.length) return null;
  const set = (key: string, value: number | string | boolean, live = false) =>
    store().updateParams(obj.id, { [key]: value }, { history: !live });
  return (
    <Section title={t('inspector.parameters')}>
      {def.paramSchema.map((s) => {
        const v = obj.params[s.key];
        switch (s.kind) {
          case 'number':
            return (
              <NumberField key={s.key} label={t(s.labelKey)} value={Number(v)} min={s.min} max={s.max} step={s.step}
                precision={s.step && s.step >= 1 ? 0 : 2} unit={s.unit} disabled={readOnly}
                onScrubStart={() => store().checkpoint()}
                onChange={(n, live) => set(s.key, s.step && s.step >= 1 ? Math.round(n) : n, live)} />
            );
          case 'color':
            return <ColorField key={s.key} label={t(s.labelKey)} value={String(v)} disabled={readOnly} onChange={(c) => set(s.key, c)} />;
          case 'boolean':
            return <ToggleField key={s.key} label={t(s.labelKey)} checked={Boolean(v)} disabled={readOnly} onChange={(b) => set(s.key, b)} />;
          case 'select':
            return (
              <SelectField key={s.key} label={t(s.labelKey)} value={String(v)} disabled={readOnly}
                options={(s.options ?? []).map((o) => ({ value: o.value, label: t(o.labelKey) }))}
                onChange={(o) => set(s.key, o)} />
            );
        }
      })}
    </Section>
  );
}

function PhysicsSection({ obj, readOnly }: { obj: WorldObject; readOnly: boolean }) {
  const t = useT();
  const p = obj.physics;
  const def = getDefinition(obj.type);
  const set = (patch: Partial<PhysicalProperties>, live = false) => store().updatePhysics(obj.id, patch, { history: !live });
  const scrub = () => store().checkpoint();
  return (
    <Section title={t('inspector.physics')}>
      <NumberField label={t('physics.mass')} value={p.mass} min={1} max={1e8} step={10} precision={0} unit="kg" disabled={readOnly}
        onScrubStart={scrub} onChange={(v, live) => set({ mass: Math.round(v) }, live)} />
      <NumberField label={t('physics.windResistance')} value={p.windResistance} min={1} max={150} step={1} precision={0} unit="m/s" disabled={readOnly}
        hint={t('physics.windResistance.hint')} onScrubStart={scrub} onChange={(v, live) => set({ windResistance: Math.round(v) }, live)} />
      <NumberField label={t('physics.durability')} value={p.durability} min={1} max={100} step={1} precision={0} disabled={readOnly}
        hint={t('physics.durability.hint')} onScrubStart={scrub} onChange={(v, live) => set({ durability: Math.round(v) }, live)} />
      <NumberField label={t('physics.breakThreshold')} value={p.breakThreshold} min={1} max={5} step={0.05} precision={2} unit="×" disabled={readOnly}
        hint={t('physics.breakThreshold.hint')} onScrubStart={scrub} onChange={(v, live) => set({ breakThreshold: v }, live)} />
      <NumberField label={t('physics.dragCoefficient')} value={p.dragCoefficient} min={0.05} max={3} step={0.05} precision={2} unit="Cd" disabled={readOnly}
        onScrubStart={scrub} onChange={(v, live) => set({ dragCoefficient: v }, live)} />
      <NumberField label={t('physics.friction')} value={p.friction} min={0} max={1.5} step={0.05} precision={2} disabled={readOnly}
        onScrubStart={scrub} onChange={(v, live) => set({ friction: v }, live)} />
      <NumberField label={t('physics.restitution')} value={p.restitution} min={0} max={1} step={0.05} precision={2} disabled={readOnly}
        onScrubStart={scrub} onChange={(v, live) => set({ restitution: v }, live)} />
      <ToggleField label={t('physics.anchored')} checked={p.anchored} disabled={readOnly || def.physicsProfile === 'static'}
        hint={t(def.physicsProfile === 'static' ? 'physics.anchored.static' : 'physics.anchored.hint')} onChange={(b) => set({ anchored: b })} />
      {!readOnly && (
        <button className={styles.linkBtn} onClick={() => store().resetPhysics(obj.id)}>{t('inspector.resetPhysics')}</button>
      )}
    </Section>
  );
}

function EstimateSection({ obj }: { obj: WorldObject }) {
  const t = useT();
  const est = useMemo(() => estimateCriticalSpeeds(obj), [obj]);
  return (
    <Section title={t('inspector.estimate')}>
      <div className={styles.estimate}>
        <span>{t(`estimate.structural.${obj.type === 'human' ? 'human' : obj.type === 'tree' ? 'tree' : 'default'}`)}</span>
        <span>≈ {fmt(est.structural, 0)} m/s</span>
        {est.sliding !== undefined && (<><span>{t('estimate.sliding')}</span><span>≈ {fmt(est.sliding, 0)} m/s</span></>)}
        {est.tipping !== undefined && (<><span>{t('estimate.tipping')}</span><span>≈ {fmt(est.tipping, 0)} m/s</span></>)}
      </div>
      <div className={styles.note}>{t('estimate.note')}</div>
    </Section>
  );
}

const KIND_ORDER: ComponentKind[] = ['structure', 'trunk', 'canopy', 'window', 'sign', 'roof', 'wall', 'exterior'];

function ComponentsSection({ obj }: { obj: WorldObject }) {
  const t = useT();
  const rows = useMemo(() => {
    const m = new Map<ComponentKind, { n: number; min: number; max: number; detachable: boolean }>();
    for (const c of obj.components) {
      const r = m.get(c.kind) ?? { n: 0, min: Infinity, max: -Infinity, detachable: c.detachable };
      r.n++;
      r.min = Math.min(r.min, c.windResistance);
      r.max = Math.max(r.max, c.windResistance);
      m.set(c.kind, r);
    }
    return KIND_ORDER.filter((k) => m.has(k)).map((k) => ({ kind: k, ...m.get(k)! }));
  }, [obj.components]);
  return (
    <Section title={t('inspector.components')} aside={obj.components.length} defaultOpen={false}>
      <table className={styles.compTable}>
        <thead>
          <tr><th>{t('inspector.component')}</th><th>#</th><th style={{ textAlign: 'right' }}>{t('physics.windResistance')}</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.kind}>
              <td>{t(`component.${r.kind}`)}{r.detachable ? ' ↗' : ''}</td>
              <td className={styles.num}>{r.n}</td>
              <td className={styles.num}>{r.min === r.max ? fmt(r.min, 0) : `${fmt(r.min, 0)}–${fmt(r.max, 0)}`} m/s</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className={styles.note}>{t('inspector.components.note')}</div>
    </Section>
  );
}
