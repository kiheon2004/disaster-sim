import { useMemo, useState } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { PhenomenonInstance } from '@/phenomena/types';
import { CELESTIAL_SCENARIOS, CELESTIAL_LIMITS, type CelestialScenario, type CelestialSpec } from '@/celestial/types';
import { celestialOutlook, CELESTIAL_MODELS, type Support } from '@/celestial/outlook';
import { PRESET_FIELDS, ZERO_G_SCENARIOS } from '@/celestial/presets';
import { celestialDemo } from '@/celestial/demos';
import { useViewStore } from '@/rendering/viewStore';
import { useEditorStore } from '@/editor/editorStore';
import { useWorldStore } from '@/world/worldStore';
import { loadCelestialDemo } from '@/app/actions';
import { Icon } from '@/ui/common/Icon';
import { sci } from '@/ui/Viewport/CelestialHud';
import eq from './EarthquakeForm.module.css';
import x from './ExperimentPanel.module.css';

const SUPPORT_COLOR: Record<Support, string> = { full: '#8fd18f', scaled: '#e8d48a', limited: '#ffb36b', unsupported: '#ff7a7a' };
const deg = (r: number) => ((r * 180) / Math.PI).toFixed(1);

/**
 * Celestial experiment helpers in the experiment editor (Phase 32): the scale label, each source's derived numbers
 * (μ, r_s as a reference, peak |g|, where its pull equals g₀, substeps needed down to the capture radius, escape speed
 * there), each probe's predicted conic (exact or approximate — and why), which models are valid / limited /
 * unsupported, the limitations, a real 10 M☉ black hole's numbers for comparison (computed, never simulated), the
 * preview, and the presets with their documented expectations and a demo world.
 */
export function CelestialTools({ inst }: { inst: PhenomenonInstance }) {
  const t = useT();
  const previewing = useViewStore((s) => s.groundPreview === inst.id);
  const inSim = useEditorStore((s) => s.mode === 'simulation');
  const vs = useViewStore.getState();
  const spec = inst.spec as CelestialSpec;
  // The plan switches the uniform gravity off when a gravity experiment of magnitude 0 is in it (orbit labs).
  const zeroG = useWorldStore((s) => (s.doc.scenario.experiment?.instances ?? []).some((i) => i.type === 'gravity' && i.enabled && (i.spec as { magnitude?: number; global?: boolean }).global !== false && (i.spec as { magnitude?: number }).magnitude === 0));
  const o = useMemo(() => celestialOutlook(spec, 9.81, zeroG), [spec, zeroG]);
  const [preset, setPreset] = useState<CelestialScenario>('compactWell');
  const demo = useMemo(() => celestialDemo(preset), [preset]);
  return (
    <div className={x.deform} data-testid="celestial-tools">
      <div className={x.deformButtons}>
        <button className={eq.small} aria-pressed={previewing} onClick={() => vs.setGroundPreview(previewing ? null : inst.id)} data-testid="celestial-preview">
          <Icon name={previewing ? 'eye' : 'eyeOff'} size={12} /> {t('deform.preview')}
        </button>
      </div>
      <div className={x.deformSummary} data-testid="celestial-summary">
        <div style={{ fontWeight: 700, color: spec.scale === 'educational' ? '#ffd29a' : '#9ad1ff' }} data-testid="celestial-scale-label">
          {spec.scale === 'educational' ? t('celestial.lim.scaled') : t('celestial.tools.physical')}
        </div>
        {o.sources.map((s, i) => (
          <div key={i} data-testid={`celestial-source-facts-${i}`}>
            {t('celestial.tools.source', { i: i + 1, m: sci(s.mass), mu: sci(s.mu), rs: sci(s.rs), p: sci(s.peak), r: s.rEarth.toFixed(1) })}
            <div style={{ color: s.within ? 'var(--text-2)' : '#ff8a6b' }}>
              {t('celestial.tools.regime', { n: Number.isFinite(s.substeps) ? s.substeps : '∞', cap: CELESTIAL_LIMITS.substeps, v: sci(s.vEsc), c: (s.vEsc / 299792458).toExponential(1), f: s.fall20.toFixed(2) })}
              {!s.within && ` — ${t(s.relativistic ? 'celestial.tools.relativistic' : 'celestial.tools.beyond')}`}
            </div>
          </div>
        ))}
        {o.probes.map((p, i) => (
          <div key={`p${i}`} data-testid={`celestial-probe-prediction-${i}`}>
            {t('celestial.tools.probe', { i: i + 1, k: t(`celestial.kind.orbit.${p.kind}` as MessageKey), v: p.speed.toFixed(2), rp: p.periapsis.toFixed(1), ra: Number.isFinite(p.apoapsis) ? p.apoapsis.toFixed(1) : '∞', T: Number.isFinite(p.period) ? p.period.toFixed(2) : '∞' })}
            {Number.isFinite(p.deflection) && ` · ${t('celestial.tools.deflection', { d: deg(p.deflection) })}`}
            {p.captured && ` · ${t('celestial.tools.willCapture')}`}
            <span style={{ color: p.exact ? '#8fd18f' : '#ffb36b' }}> · {t(p.exact ? 'celestial.tools.exact' : 'celestial.tools.approx')}</span>
          </div>
        ))}
        <div style={{ color: 'var(--text-2)', marginTop: 4 }}>{t('celestial.tools.support')}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }} data-testid="celestial-support">
          {CELESTIAL_MODELS.map((m) => (
            <span key={m} title={t(`gravity.support.${o.support[m]}` as MessageKey)} style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, border: `1px solid ${SUPPORT_COLOR[o.support[m]]}`, color: SUPPORT_COLOR[o.support[m]] }}>
              {t(`celestial.model.${m}` as MessageKey)}
            </span>
          ))}
        </div>
        {o.limits.map((k) => <div key={k} style={{ color: '#ffb36b' }}>⚠ {t(k as MessageKey)}</div>)}
        <div style={{ color: 'var(--text-2)' }} data-testid="celestial-real">{t('celestial.tools.real', { m: sci(o.real.mass), rs: sci(o.real.rs), a: sci(o.real.accel20), l: sci(o.real.tidal20), v: sci(o.real.vEsc20) })}</div>
        <div style={{ color: 'var(--text-3)' }}>{t('celestial.tools.approxNote')}</div>
      </div>
      <div className={x.deformSummary} data-testid="celestial-presets">
        <b>{t('celestial.tools.presets')}</b>
        <select value={preset} onChange={(e) => setPreset(e.target.value as CelestialScenario)} disabled={inSim} data-testid="celestial-preset-select">
          {CELESTIAL_SCENARIOS.filter((s) => s !== 'custom').map((id) => <option key={id} value={id}>{t(`celestial.scenario.${id}` as MessageKey)}</option>)}
        </select>
        {PRESET_FIELDS.map((f) => (
          <div key={f} style={{ color: 'var(--text-2)' }}><span style={{ color: 'var(--text-3)' }}>{t(`celestial.info.${f}` as MessageKey)}:</span> {t(`celestial.info.${preset}.${f}` as MessageKey)}</div>
        ))}
        {ZERO_G_SCENARIOS.includes(preset) && <div style={{ color: '#9ad1ff' }}>· {t('celestial.demo.zeroG')}</div>}
        {demo.assumptions.filter((k) => k !== 'celestial.demo.zeroG').map((k) => <div key={k} style={{ color: 'var(--text-3)' }}>· {t(k as MessageKey)}</div>)}
        <button className={eq.small} disabled={inSim} onClick={() => loadCelestialDemo(preset)} data-testid="celestial-preset-load">
          <Icon name="celestial" size={12} /> {t('celestial.tools.loadPreset')}
        </button>
      </div>
    </div>
  );
}
