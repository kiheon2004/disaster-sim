import { useMemo, useState } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { PhenomenonInstance } from '@/phenomena/types';
import type { HeatSourceSpec } from '@/thermal/types';
import { useViewStore } from '@/rendering/viewStore';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { updatePhenomenon } from '@/app/actions';
import { thermalOutlook } from '@/rendering/thermal/ThermalPreview';
import { defaultThermalSettings } from '@/thermal/ThermalWorld';
import { AMBIENT_LIMITS, energyText, powerText, toC, toK } from '@/thermal/units';
import { peakPower, totalEnergy } from '@/thermal/sources';
import { profileIssues } from '@/thermal/profiles';
import { NumberField } from '@/ui/common/fields';
import { TEMPERATURE_GRADIENT } from '@/rendering/thermal/thermalColors';
import { Segmented } from '@/ui/common/Segmented';
import { Icon } from '@/ui/common/Icon';
import eq from './EarthquakeForm.module.css';
import x from './ExperimentPanel.module.css';

/** "0-30, 60-90" ↔ [[0, 30], [60, 90]] (scheduled on / off, seconds of the source). */
export function parseSchedule(text: string): [number, number][] | null {
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
  const out: [number, number][] = [];
  for (const p of parts) {
    const m = /^(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)$/.exec(p);
    if (!m) return null;
    out.push([Number(m[1]), Number(m[2])]);
  }
  return out.length ? out : null;
}

/**
 * Heat-source helpers in the experiment editor (Phase 26): pick the position on the ground, show the
 * expected absorbed flux map (the SAME ground-receiver model the run uses), the numbers of the source
 * (peak output, total energy, reach, area above 1 / 5 / 10 kW/m²), the scheduled intervals of a
 * schedule profile, and the world's thermal settings (ambient temperature, air layer, restraint).
 * The preview is a flux map at peak output — not a temperature forecast.
 */
export function ThermalTools({ inst }: { inst: PhenomenonInstance }) {
  const t = useT();
  const picking = useViewStore((s) => s.groundPick?.id === inst.id);
  const previewing = useViewStore((s) => s.groundPreview === inst.id);
  const terrain = useWorldStore((s) => s.doc.terrain);
  const settings = useWorldStore((s) => s.doc.settings.simulation.thermal) ?? defaultThermalSettings();
  const inSim = useEditorStore((s) => s.mode === 'simulation');
  const vs = useViewStore.getState();
  const spec = inst.spec as HeatSourceSpec;
  const objects = useWorldStore((s) => s.doc.objects);
  const out = useMemo(() => thermalOutlook(spec, terrain, settings.ambient, objects), [spec, terrain, settings.ambient, objects]);
  const [schedText, setSchedText] = useState(() => (spec.schedule ?? []).map(([a, b]) => `${a}-${b}`).join(', '));
  const setWorld = (patch: Partial<typeof settings>) => useWorldStore.getState().updateSimulationSettings({ thermal: patch });
  const qmax = out.flux.reduce((m, q) => Math.max(m, q), 0);
  const lines: string[] = [];
  lines.push(t('thermal.tools.source', { x: spec.position[0].toFixed(1), z: spec.position[1].toFixed(1), h: spec.height.toFixed(1) }));
  if (spec.kind === 'temperature') lines.push(t('thermal.tools.temperature', { T: toC(spec.temperature ?? 0).toFixed(0), R: spec.radius.toFixed(1) }));
  else lines.push(t('thermal.tools.output', { P: powerText(peakPower(spec)), E: energyText(totalEnergy(spec)), d: spec.duration }));
  if (out.inside) lines.push(t('thermal.tools.inside'));
  else lines.push(t('thermal.tools.flux', { q: (qmax / 1000).toFixed(2), reach: out.reach.toFixed(1), n: out.receivers.length }));
  lines.push(t('thermal.tools.areas', { a1: out.areas[0].toFixed(0), a5: out.areas[1].toFixed(0), a10: out.areas[2].toFixed(0) }));
  const schedBad = spec.profile === 'schedule' && profileIssues(spec).length > 0;
  return (
    <div className={x.deform} data-testid="thermal-tools">
      <div className={x.deformButtons}>
        <button className={eq.small} aria-pressed={picking} onClick={() => vs.setGroundPick(picking ? null : { id: inst.id, mode: 'point' })} data-testid="thermal-pick">
          <Icon name="focus" size={12} /> {t(picking ? 'deform.pick.active' : 'thermal.tools.pick')}
        </button>
        <button className={eq.small} aria-pressed={previewing} onClick={() => vs.setGroundPreview(previewing ? null : inst.id)} data-testid="thermal-preview">
          <Icon name={previewing ? 'eye' : 'eyeOff'} size={12} /> {t('deform.preview')}
        </button>
      </div>
      {picking && <div className={x.deformHint}>{t('deform.pick.hint')}</div>}
      {spec.profile === 'schedule' && (
        <label className={eq.row}>
          <span className={eq.label}>{t('thermal.tools.schedule')}</span>
          <input value={schedText} data-testid="thermal-schedule" placeholder="0-30, 60-90"
            onChange={(e) => setSchedText(e.target.value)}
            onBlur={() => { const s = parseSchedule(schedText); if (s) updatePhenomenon(inst.id, { spec: { ...spec, schedule: s } as HeatSourceSpec }); }} />
        </label>
      )}
      {schedBad && <div className={x.issue}>⚠ {t('thermal.invalid.schedule')}</div>}
      <div className={x.deformSummary} data-testid="thermal-summary">
        {lines.map((l, i) => <div key={i}>{l}</div>)}
        <div style={{ color: 'var(--text-3)' }}>{t('thermal.tools.approx')}</div>
      </div>
      {previewing && (
        <div style={{ fontSize: 10.5, color: 'var(--text-2)' }} data-testid="thermal-preview-legend">
          <div style={{ height: 6, borderRadius: 3, background: TEMPERATURE_GRADIENT }} />
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>0.05</span><span>1</span><span>10</span><span>100 kW/m²</span></div>
          <div>{t('thermal.tools.legend')}</div>
        </div>
      )}
      <div className={x.deformSummary} data-testid="thermal-world">
        <b>{t('thermal.tools.world')}</b>
        <NumberField label={t('thermal.tools.ambient')} value={toC(settings.ambient)} min={toC(AMBIENT_LIMITS[0])} max={toC(AMBIENT_LIMITS[1])} step={1} precision={1} unit="°C" disabled={inSim}
          onChange={(v, live) => !live && setWorld({ ambient: toK(v) })} />
        <NumberField label={t('thermal.tools.layer')} value={settings.airLayerHeight} min={2} max={50} step={1} precision={0} unit="m" disabled={inSim}
          onChange={(v, live) => !live && setWorld({ airLayerHeight: v })} />
        <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{t('thermal.tools.restraint')}</span>
        <Segmented size="small" value={settings.restraint} onChange={(r) => !inSim && setWorld({ restraint: r })}
          options={(['frame', 'full', 'none'] as const).map((r) => ({ value: r, label: t(`thermal.restraint.short.${r}` as MessageKey), title: t(`thermal.restraint.${r}` as MessageKey) }))} />
        {inSim && <div style={{ color: 'var(--text-3)' }}>{t('thermal.tools.worldLocked')}</div>}
      </div>
    </div>
  );
}
