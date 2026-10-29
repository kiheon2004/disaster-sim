import { useMemo, useState } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { PhenomenonInstance } from '@/phenomena/types';
import type { ClimateSpec } from '@/climate/types';
import { climateOutlook, type ClimatePathPoint } from '@/climate/outlook';
import { CLIMATE_PRESETS, climatePreset, type ClimatePresetId } from '@/climate/presets';
import { useViewStore } from '@/rendering/viewStore';
import { useEditorStore } from '@/editor/editorStore';
import { loadClimatePreset } from '@/app/actions';
import { Icon } from '@/ui/common/Icon';
import eq from './EarthquakeForm.module.css';
import x from './ExperimentPanel.module.css';

const C = (K: number) => (Number.isFinite(K) ? `${(K - 273.15).toFixed(1)} °C` : '—');

/** Forcing path chart: air temperature (orange), dew point (blue), wet bulb (cyan), 0 °C line, precipitation bars (snow white / rain blue). */
function PathChart({ path }: { path: ClimatePathPoint[] }) {
  const T = path[path.length - 1]?.t || 1;
  let lo = Infinity, hi = -Infinity, pMax = 0;
  for (const p of path) { lo = Math.min(lo, Number.isFinite(p.dew) ? p.dew : p.T, p.T); hi = Math.max(hi, p.T); pMax = Math.max(pMax, p.P); }
  lo -= 1; hi += 1;
  const y = (K: number) => 52 - ((K - lo) / Math.max(1e-6, hi - lo)) * 48;
  // Points without a value (dew point of air too dry for the saturation curve) are left out of the line.
  const line = (f: (p: ClimatePathPoint) => number) => path.filter((p) => Number.isFinite(f(p))).map((p) => `${(p.t / T) * 200},${y(f(p))}`).join(' ');
  const zero = y(273.15);
  return (
    <svg width="100%" viewBox="0 0 200 56" preserveAspectRatio="none" style={{ height: 64, background: 'rgba(255,170,90,0.06)', borderRadius: 4 }} data-testid="climate-path">
      {pMax > 0 && path.map((p, i) => p.P > 0 && <rect key={i} x={(p.t / T) * 200} y={56 - (p.P / pMax) * 20} width={200 / path.length} height={(p.P / pMax) * 20} fill={p.snow > 0.5 ? 'rgba(255,255,255,0.45)' : 'rgba(110,170,255,0.45)'} />)}
      {zero > 2 && zero < 54 && <line x1={0} x2={200} y1={zero} y2={zero} stroke="rgba(160,220,255,0.5)" strokeDasharray="3 2" />}
      <polyline points={line((p) => p.dew)} fill="none" stroke="#5fb8ff" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <polyline points={line((p) => p.Tw)} fill="none" stroke="#6fe0d8" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <polyline points={line((p) => p.T)} fill="none" stroke="#ffaa5a" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * Climate experiment helpers in the experiment editor (Phase 30): the forcing path from the same functions as the run
 * (background temperature, humidity → dew point / wet bulb, precipitation and its rain / snow split, sun), what it
 * implies at most (precipitation, new snow if nothing melted, evaporation potential), the preview (precipitation area,
 * solar exposure and shadows on the terrain) and the presets with their assumptions. Not a forecast or a safety tool.
 */
export function ClimateTools({ inst }: { inst: PhenomenonInstance }) {
  const t = useT();
  const previewing = useViewStore((s) => s.groundPreview === inst.id);
  const pick = useViewStore((s) => (s.groundPick?.id === inst.id ? s.groundPick.target ?? 'area' : null));
  const inSim = useEditorStore((s) => s.mode === 'simulation');
  const vs = useViewStore.getState();
  const spec = inst.spec as ClimateSpec;
  const o = useMemo(() => climateOutlook(spec), [spec]);
  const [preset, setPreset] = useState<ClimatePresetId>('summerHeatwave');
  const p = useMemo(() => climatePreset(preset), [preset]);
  const first = o.path[0], last = o.path[o.path.length - 1];
  const lines: string[] = [
    t('climate.tools.path', { T0: C(first.T), T1: C(last.T), lo: C(o.Tmin), hi: C(o.Tmax), rh0: (first.RH * 100).toFixed(0), rh1: (last.RH * 100).toFixed(0) }),
    t('climate.tools.dew', { d: C(o.dewStart), w: C(first.Tw), sky: C(first.Tsky) }),
  ];
  if (o.precipTotal > 0) lines.push(t('climate.tools.precip', { P: o.precipTotal.toFixed(1), s: o.snowTotal.toFixed(1), r: o.rainTotal.toFixed(1), d: (o.snowDepth * 100).toFixed(1) }));
  if (spec.solar !== 'off') {
    const gMax = Math.max(...o.path.map((q) => q.G));
    lines.push(t('climate.tools.sun', { el: ((first.sunEl * 180) / Math.PI).toFixed(1), G: gMax.toFixed(0) }));
  }
  lines.push(t('climate.tools.evap', { a: o.evapStart.toFixed(2), b: o.evapEnd.toFixed(2), boil: C(o.boiling) }));
  if ((spec.initialSnow ?? 0) > 0) lines.push(t('climate.tools.initialSnow', { d: ((spec.initialSnow ?? 0) * 100).toFixed(0), swe: ((spec.initialSnow ?? 0) * (spec.initialSnowDensity ?? 250)).toFixed(0), kPa: (((spec.initialSnow ?? 0) * (spec.initialSnowDensity ?? 250) * 9.81) / 1000).toFixed(2) }));
  return (
    <div className={x.deform} data-testid="climate-tools">
      <div className={x.deformButtons}>
        {(spec.precipitation ?? 0) > 0 && spec.area && (
          <button className={eq.small} aria-pressed={pick === 'area'} disabled={inSim} onClick={() => vs.setGroundPick(pick === 'area' ? null : { id: inst.id, mode: 'point', target: 'area' })} data-testid="climate-pick">
            <Icon name="focus" size={12} /> {t(pick === 'area' ? 'deform.pick.active' : 'climate.tools.pick')}
          </button>
        )}
        <button className={eq.small} aria-pressed={previewing} onClick={() => vs.setGroundPreview(previewing ? null : inst.id)} data-testid="climate-preview">
          <Icon name={previewing ? 'eye' : 'eyeOff'} size={12} /> {t('deform.preview')}
        </button>
      </div>
      <div className={x.deformSummary} data-testid="climate-summary">
        {lines.map((l, i) => <div key={i}>{l}</div>)}
        {o.issues.map((k) => <div key={k} className={x.issue}>⚠ {t(k as MessageKey)}</div>)}
        {o.warnings.map((k) => <div key={k} style={{ color: '#ffb36b' }}>⚠ {t(k as MessageKey)}</div>)}
        <div style={{ color: 'var(--text-2)' }}>{t('climate.tools.pathTitle')}</div>
        <PathChart path={o.path} />
        <div style={{ color: 'var(--text-3)' }}>{t('climate.tools.approx')}</div>
      </div>
      <div className={x.deformSummary} data-testid="climate-presets">
        <b>{t('climate.tools.presets')}</b>
        <select value={preset} onChange={(e) => setPreset(e.target.value as ClimatePresetId)} disabled={inSim} data-testid="climate-preset-select">
          {CLIMATE_PRESETS.map((id) => <option key={id} value={id}>{t(`climate.preset.${id}` as MessageKey)}</option>)}
        </select>
        <div style={{ color: 'var(--text-2)' }}>{t(`climate.preset.d.${preset}` as MessageKey)}</div>
        {p.assumptions.map((k) => <div key={k} style={{ color: 'var(--text-3)' }}>· {t(k as MessageKey)}</div>)}
        <button className={eq.small} disabled={inSim} onClick={() => loadClimatePreset(preset)} data-testid="climate-preset-load">
          <Icon name="climate" size={12} /> {t('climate.tools.loadPreset')}
        </button>
      </div>
    </div>
  );
}
