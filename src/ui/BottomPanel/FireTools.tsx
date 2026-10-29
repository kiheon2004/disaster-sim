import { useMemo, useState } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { PhenomenonInstance } from '@/phenomena/types';
import type { FireSpec } from '@/fire/types';
import { defaultFireSettings, MOISTURE_LIMITS, OPENING_MODES } from '@/fire/types';
import { fireOutlook } from '@/fire/outlook';
import { FIRE_PRESETS, firePreset, type FirePresetId } from '@/fire/presets';
import { MOISTURE_EXTINCTION } from '@/fire/materials';
import { useViewStore } from '@/rendering/viewStore';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { loadFirePreset, updatePhenomenon } from '@/app/actions';
import { samplerFor } from '@/terrain/TerrainSampler';
import { energyText, powerText } from '@/thermal/units';
import { NumberField } from '@/ui/common/fields';
import { Segmented } from '@/ui/common/Segmented';
import { Icon } from '@/ui/common/Icon';
import { displayName } from '@/ui/format';
import eq from './EarthquakeForm.module.css';
import x from './ExperimentPanel.module.css';

/**
 * Fire scenario helpers in the experiment editor (Phase 27): pick the ignition point on the map, an
 * optional target object among those the sphere reaches, the preview (what is fuel, the room and its
 * openings, a reference exposure — not a spread prediction), the world's fire settings (foliage
 * moisture, openings at the start, heat ignition) and the fire scenario presets with their
 * assumptions. Nothing here sets fuel recipes or anything that makes a fire bigger.
 */
export function FireTools({ inst }: { inst: PhenomenonInstance }) {
  const t = useT();
  const picking = useViewStore((s) => s.groundPick?.id === inst.id);
  const previewing = useViewStore((s) => s.groundPreview === inst.id);
  const terrain = useWorldStore((s) => s.doc.terrain);
  const objects = useWorldStore((s) => s.doc.objects);
  const settings = useWorldStore((s) => s.doc.settings.simulation.fire) ?? defaultFireSettings();
  const inSim = useEditorStore((s) => s.mode === 'simulation');
  const vs = useViewStore.getState();
  const spec = inst.spec as FireSpec;
  const out = useMemo(() => {
    const s = samplerFor(terrain);
    return fireOutlook(spec, objects, (px, pz) => s.sampleHeight(px, pz), settings);
  }, [spec, terrain, objects, settings]);
  const [preset, setPreset] = useState<FirePresetId>('singleRoom');
  const setWorld = (patch: Partial<typeof settings>) => useWorldStore.getState().updateSimulationSettings({ fire: patch });
  const nameOf = (id: string) => (objects[id] ? displayName(objects[id], t) : id);
  const reach = out.objects.filter((o) => o.inSphere);
  const lines: string[] = [];
  lines.push(t('fire.tools.point', { x: spec.position[0].toFixed(1), z: spec.position[1].toFixed(1), h: spec.height.toFixed(1), r: spec.radius.toFixed(1) }));
  if (out.room) {
    lines.push(t('fire.tools.room', { story: out.room.story + 1, A: out.room.floor.toFixed(0), kg: out.room.contentsKg.toFixed(0) }));
    lines.push(t(out.room.open ? 'fire.tools.windowsOpen' : 'fire.tools.windowsClosed', { A: out.room.windows.toFixed(1) }));
    lines.push(t('fire.tools.peaks', { fuel: powerText(out.room.fuelPeak), vent: powerText(out.room.ventPeak) }));
  }
  lines.push(t('fire.tools.lit', { n: out.lit, kg: out.fuelKg.toFixed(0), E: energyText(out.energy) }));
  if (out.refPeak > 0) lines.push(t('fire.tools.exposure', { Q: powerText(out.refPeak), r12: out.r12.toFixed(1), r5: out.r5.toFixed(1) }));
  const p = firePreset(preset);
  return (
    <div className={x.deform} data-testid="fire-tools">
      <div className={x.deformButtons}>
        <button className={eq.small} aria-pressed={picking} onClick={() => vs.setGroundPick(picking ? null : { id: inst.id, mode: 'point' })} data-testid="fire-pick">
          <Icon name="focus" size={12} /> {t(picking ? 'deform.pick.active' : 'fire.tools.pick')}
        </button>
        <button className={eq.small} aria-pressed={previewing} onClick={() => vs.setGroundPreview(previewing ? null : inst.id)} data-testid="fire-preview">
          <Icon name={previewing ? 'eye' : 'eyeOff'} size={12} /> {t('deform.preview')}
        </button>
      </div>
      {picking && <div className={x.deformHint}>{t('fire.tools.pickHint')}</div>}
      <label className={eq.row}>
        <span className={eq.label}>{t('fire.tools.target')}</span>
        <select value={spec.target ?? ''} data-testid="fire-target"
          onChange={(e) => updatePhenomenon(inst.id, { spec: { ...spec, target: e.target.value || undefined } as FireSpec })}>
          <option value="">{t('fire.tools.anyTarget')}</option>
          {(spec.target && !reach.some((o) => o.id === spec.target) ? [{ id: spec.target }] : []).concat(reach).map((o) => (
            <option key={o.id} value={o.id}>{nameOf(o.id)}</option>
          ))}
        </select>
      </label>
      <div className={x.deformSummary} data-testid="fire-summary">
        {lines.map((l, i) => <div key={i}>{l}</div>)}
        {out.issues.map((k) => <div key={k} className={x.issue}>⚠ {t(k as MessageKey, { m: Math.round(MOISTURE_EXTINCTION * 100) })}</div>)}
        <div style={{ color: 'var(--text-3)' }}>{t('fire.tools.approx')}</div>
      </div>
      {reach.length > 0 && (
        <div className={x.deformSummary} data-testid="fire-reach">
          <b>{t('fire.tools.inSphere')}</b>
          {reach.slice(0, 8).map((o) => (
            <div key={o.id}>
              {nameOf(o.id)} — {o.fuel.length ? o.fuel.map((f) => t(`fire.fuel.${f}` as MessageKey)).join(' + ') : t('fire.fuel.none')}
              {o.fuelKg > 0 ? ` · ${o.fuelKg.toFixed(0)} kg` : ''}{o.tooMoist ? ` · ${t('fire.tools.tooMoist')}` : ''}
            </div>
          ))}
        </div>
      )}
      <div className={x.deformSummary} data-testid="fire-world">
        <b>{t('fire.tools.world')}</b>
        <NumberField label={t('fire.tools.moisture')} value={settings.foliageMoisture * 100} min={MOISTURE_LIMITS[0] * 100} max={MOISTURE_LIMITS[1] * 100} step={5} precision={0} unit="%" disabled={inSim}
          onChange={(v, live) => !live && setWorld({ foliageMoisture: v / 100 })} />
        <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{t('fire.tools.openings')}</span>
        <Segmented size="small" value={settings.openings} onChange={(o) => !inSim && setWorld({ openings: o })}
          options={OPENING_MODES.map((o) => ({ value: o, label: t(`fire.openings.${o}` as MessageKey), title: t(`fire.openings.t.${o}` as MessageKey) }))} />
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11 }} title={t('fire.tools.heatIgnitionHint')}>
          <input type="checkbox" checked={settings.heatIgnition} disabled={inSim} onChange={(e) => setWorld({ heatIgnition: e.target.checked })} data-testid="fire-heat-ignition" />
          {t('fire.tools.heatIgnition')}
        </label>
        {inSim && <div style={{ color: 'var(--text-3)' }}>{t('thermal.tools.worldLocked')}</div>}
      </div>
      <div className={x.deformSummary} data-testid="fire-presets">
        <b>{t('fire.tools.presets')}</b>
        <select value={preset} onChange={(e) => setPreset(e.target.value as FirePresetId)} disabled={inSim} data-testid="fire-preset-select">
          {FIRE_PRESETS.map((id) => <option key={id} value={id}>{t(`fire.preset.${id}` as MessageKey)}</option>)}
        </select>
        <div style={{ color: 'var(--text-2)' }}>{t(`fire.preset.d.${preset}` as MessageKey)}</div>
        {p.assumptions.map((k) => <div key={k} style={{ color: 'var(--text-3)' }}>· {t(k as MessageKey)}</div>)}
        <button className={eq.small} disabled={inSim} onClick={() => loadFirePreset(preset)} data-testid="fire-preset-load">
          <Icon name="flame" size={12} /> {t('fire.tools.loadPreset')}
        </button>
      </div>
    </div>
  );
}
