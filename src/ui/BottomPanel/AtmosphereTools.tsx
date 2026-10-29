import { useMemo, useState } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { PhenomenonInstance } from '@/phenomena/types';
import type { AtmosphereSpec } from '@/atmosphere/types';
import { atmosphereOutlook } from '@/atmosphere/outlook';
import { ATMOS_PRESETS, atmosPreset, type AtmosPresetId } from '@/atmosphere/presets';
import { useViewStore } from '@/rendering/viewStore';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { loadAtmosPreset } from '@/app/actions';
import { samplerFor } from '@/terrain/TerrainSampler';
import { Icon } from '@/ui/common/Icon';
import eq from './EarthquakeForm.module.css';
import x from './ExperimentPanel.module.css';

const kPa = (p: number) => `${(p / 1000).toFixed(p < 1000 ? 4 : 2)} kPa`;
const C = (K: number) => `${(K - 273.15).toFixed(1)} °C`;
const tons = (kg: number) => (kg >= 1e9 ? `${(kg / 1e9).toFixed(2)} Mt` : kg >= 1e6 ? `${(kg / 1e6).toFixed(2)} kt` : `${(kg / 1000).toFixed(1)} t`);

/** The planned air-mass path as a small chart (share of the initial mass over time). */
function PathChart({ path }: { path: [number, number][] }) {
  const T = path[path.length - 1]?.[0] ?? 1;
  const pts = path.map(([t, f]) => `${(t / Math.max(1e-9, T)) * 200},${(1 - f) * 50 + 2}`).join(' ');
  return (
    <svg width="100%" viewBox="0 0 200 56" preserveAspectRatio="none" style={{ height: 56, background: 'rgba(95,184,255,0.06)', borderRadius: 4 }} data-testid="atmos-path">
      <polyline points={pts} fill="none" stroke="#5fb8ff" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      <line x1={0} x2={200} y1={2} y2={2} stroke="rgba(255,255,255,0.15)" />
      <line x1={0} x2={200} y1={52} y2={52} stroke="rgba(255,255,255,0.15)" />
    </svg>
  );
}

/**
 * Atmosphere experiment helpers in the experiment editor (Phase 29): the reference state and what the
 * plan does to the air mass, from the same relations as the run (density derived, never entered), the
 * planned path, the sink picked on the map, the preview (initial pressure field, boundary, sink) and the
 * presets with their assumptions. Not a weather forecast or a safety tool.
 */
export function AtmosphereTools({ inst }: { inst: PhenomenonInstance }) {
  const t = useT();
  const pick = useViewStore((s) => (s.groundPick?.id === inst.id ? s.groundPick.target ?? 'sink' : null));
  const previewing = useViewStore((s) => s.groundPreview === inst.id);
  const terrain = useWorldStore((s) => s.doc.terrain);
  const inSim = useEditorStore((s) => s.mode === 'simulation');
  const vs = useViewStore.getState();
  const spec = inst.spec as AtmosphereSpec;
  const o = useMemo(() => { const s = samplerFor(terrain); return atmosphereOutlook(spec, terrain, (px, pz) => s.sampleHeight(px, pz)); }, [spec, terrain]);
  const [preset, setPreset] = useState<AtmosPresetId>('standard');
  const p = atmosPreset(preset);
  const local = spec.extent === 'local' && (spec.removal !== 'none' || spec.restore === 'reservoir');
  const lines: string[] = [
    t('atmos.tools.state', { p: kPa(o.p0), T: C(o.T0), rho: o.rho0.toFixed(3), Hs: (o.Hs / 1000).toFixed(2), c: o.c.toFixed(0) }),
    t('atmos.tools.field', { lo: kPa(o.pLow), hi: kPa(o.pHigh), rlo: o.rhoLow.toFixed(3), rhi: o.rhoHigh.toFixed(3) }),
    t('atmos.tools.mass', { s: o.sigma0.toFixed(0), M: tons(o.mass) }),
  ];
  if (spec.removal !== 'none') {
    lines.push(t('atmos.tools.removal', { m: tons(o.removed), r: o.rate >= 1000 ? `${(o.rate / 1000).toFixed(1)} t/s` : `${o.rate.toFixed(0)} kg/s`, f: (o.endShare * 100).toFixed(1) }));
    lines.push(t('atmos.tools.end', { p: kPa(o.pEnd), Ta: C(o.TendAdiabatic), ra: o.rhoEndAdiabatic.toFixed(3), ri: o.rhoEndIsothermal.toFixed(3) }));
    lines.push(t('atmos.tools.boil', { b0: C(o.boilingStart), b1: C(o.boilingEnd), l: o.lambdaEnd < 1e-3 ? `${(o.lambdaEnd * 1e6).toFixed(2)} µm` : `${(o.lambdaEnd * 1000).toFixed(2)} mm`, kn: o.knEnd.toExponential(1) }));
  }
  lines.push(t('atmos.tools.adjust', { s: o.adjust.toFixed(2) }));
  return (
    <div className={x.deform} data-testid="atmos-tools">
      <div className={x.deformButtons}>
        {local && (
          <button className={eq.small} aria-pressed={pick === 'sink'} disabled={inSim} onClick={() => vs.setGroundPick(pick === 'sink' ? null : { id: inst.id, mode: 'point', target: 'sink' })} data-testid="atmos-pick">
            <Icon name="focus" size={12} /> {t(pick === 'sink' ? 'deform.pick.active' : 'atmos.tools.pick')}
          </button>
        )}
        <button className={eq.small} aria-pressed={previewing} onClick={() => vs.setGroundPreview(previewing ? null : inst.id)} data-testid="atmos-preview">
          <Icon name={previewing ? 'eye' : 'eyeOff'} size={12} /> {t('deform.preview')}
        </button>
      </div>
      {pick && <div className={x.deformHint}>{t('atmos.tools.pickHint')}</div>}
      <div className={x.deformSummary} data-testid="atmos-summary">
        {lines.map((l, i) => <div key={i}>{l}</div>)}
        {o.issues.map((k) => <div key={k} className={x.issue}>⚠ {t(k as MessageKey)}</div>)}
        {o.warnings.map((k) => <div key={k} style={{ color: '#ffb36b' }}>⚠ {t(k as MessageKey)}</div>)}
        <div style={{ color: 'var(--text-2)' }}>{t('atmos.tools.pathTitle')}</div>
        <PathChart path={o.path} />
        <div style={{ color: 'var(--text-3)' }}>{t('atmos.tools.approx')}</div>
      </div>
      <div className={x.deformSummary} data-testid="atmos-presets">
        <b>{t('atmos.tools.presets')}</b>
        <select value={preset} onChange={(e) => setPreset(e.target.value as AtmosPresetId)} disabled={inSim} data-testid="atmos-preset-select">
          {ATMOS_PRESETS.map((id) => <option key={id} value={id}>{t(`atmos.preset.${id}` as MessageKey)}</option>)}
        </select>
        <div style={{ color: 'var(--text-2)' }}>{t(`atmos.preset.d.${preset}` as MessageKey)}</div>
        {p.assumptions.map((k) => <div key={k} style={{ color: 'var(--text-3)' }}>· {t(k as MessageKey)}</div>)}
        <button className={eq.small} disabled={inSim} onClick={() => loadAtmosPreset(preset)} data-testid="atmos-preset-load">
          <Icon name="atmosphere" size={12} /> {t('atmos.tools.loadPreset')}
        </button>
      </div>
    </div>
  );
}
