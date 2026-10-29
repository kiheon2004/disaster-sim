import { useMemo, useState } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { PhenomenonInstance } from '@/phenomena/types';
import type { GravityScenario, GravitySpec } from '@/gravity/types';
import { GRAVITY_SCENARIOS } from '@/gravity/types';
import { gravityOutlook, SUPPORTED_MODELS, type GravityPathPoint, type Support } from '@/gravity/outlook';
import { useViewStore } from '@/rendering/viewStore';
import { useEditorStore } from '@/editor/editorStore';
import { loadGravityDemo } from '@/app/actions';
import { gravityDemo } from '@/gravity/demos';
import { Icon } from '@/ui/common/Icon';
import eq from './EarthquakeForm.module.css';
import x from './ExperimentPanel.module.css';

const SUPPORT_COLOR: Record<Support, string> = { full: '#8fd18f', scaled: '#e8d48a', limited: '#ffb36b', unsupported: '#ff7a7a' };

/** Gravity path chart: |g| (orange), downward component (white), horizontal part (blue), Earth 9.81 dashed. */
function PathChart({ path }: { path: GravityPathPoint[] }) {
  const T = path[path.length - 1]?.t || 1;
  let hi = 10.5, lo = 0;
  for (const p of path) { hi = Math.max(hi, p.magnitude); lo = Math.min(lo, -p.gy); }
  hi += 0.5;
  const y = (v: number) => 52 - ((v - lo) / Math.max(1e-6, hi - lo)) * 48;
  const line = (f: (p: GravityPathPoint) => number) => path.map((p) => `${(p.t / T) * 200},${y(f(p))}`).join(' ');
  return (
    <svg width="100%" viewBox="0 0 200 56" preserveAspectRatio="none" style={{ height: 64, background: 'rgba(255,170,90,0.06)', borderRadius: 4 }} data-testid="gravity-path">
      <line x1={0} x2={200} y1={y(9.81)} y2={y(9.81)} stroke="rgba(255,255,255,0.35)" strokeDasharray="3 2" />
      {lo < 0 && <line x1={0} x2={200} y1={y(0)} y2={y(0)} stroke="rgba(255,255,255,0.2)" />}
      <polyline points={line((p) => Math.hypot(p.gx, p.gz))} fill="none" stroke="#7fb6ff" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <polyline points={line((p) => -p.gy)} fill="none" stroke="#f2f2ea" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <polyline points={line((p) => p.magnitude)} fill="none" stroke="#ffb35c" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * Gravity experiment helpers in the experiment editor (Phase 31): the global path from the same functions as the run
 * (|g|, downward and horizontal components), its extremes, the local sources' peak, which models are valid / scaled /
 * limited / unsupported under it, the preview (the field's arrows and source regions at its largest departure) and the
 * presets with a demo world. A user-defined acceleration field — not a real body, not a safety tool.
 */
export function GravityTools({ inst }: { inst: PhenomenonInstance }) {
  const t = useT();
  const previewing = useViewStore((s) => s.groundPreview === inst.id);
  const inSim = useEditorStore((s) => s.mode === 'simulation');
  const vs = useViewStore.getState();
  const spec = inst.spec as GravitySpec;
  const o = useMemo(() => gravityOutlook(spec), [spec]);
  const [preset, setPreset] = useState<GravityScenario>('moon');
  const demo = useMemo(() => gravityDemo(preset), [preset]);
  const lines: string[] = [
    t('gravity.tools.range', { a: o.minMagnitude.toFixed(2), b: o.maxMagnitude.toFixed(2), x: (o.maxMagnitude / 9.81).toFixed(2) }),
    t('gravity.tools.down', { a: o.minDown.toFixed(2), b: o.maxDown.toFixed(2), h: o.maxHorizontal.toFixed(2) }),
  ];
  if (spec.sources.length) lines.push(t('gravity.tools.local', { n: spec.sources.length, p: o.localPeak.toFixed(2) }));
  return (
    <div className={x.deform} data-testid="gravity-tools">
      <div className={x.deformButtons}>
        <button className={eq.small} aria-pressed={previewing} onClick={() => vs.setGroundPreview(previewing ? null : inst.id)} data-testid="gravity-preview">
          <Icon name={previewing ? 'eye' : 'eyeOff'} size={12} /> {t('deform.preview')}
        </button>
      </div>
      <div className={x.deformSummary} data-testid="gravity-summary">
        {lines.map((l, i) => <div key={i}>{l}</div>)}
        <div style={{ color: 'var(--text-2)' }}>{t('gravity.tools.pathTitle')}</div>
        <PathChart path={o.path} />
        <div style={{ color: 'var(--text-2)', marginTop: 4 }}>{t('gravity.tools.support')}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }} data-testid="gravity-support">
          {SUPPORTED_MODELS.map((m) => (
            <span key={m} title={t(`gravity.support.${o.support[m]}` as MessageKey)} style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, border: `1px solid ${SUPPORT_COLOR[o.support[m]]}`, color: SUPPORT_COLOR[o.support[m]] }}>
              {t(`gravity.model.${m}` as MessageKey)}
            </span>
          ))}
        </div>
        {o.limits.map((k) => <div key={k} style={{ color: '#ffb36b' }}>⚠ {t(k as MessageKey)}</div>)}
        <div style={{ color: 'var(--text-3)' }}>{t('gravity.tools.approx')}</div>
      </div>
      <div className={x.deformSummary} data-testid="gravity-presets">
        <b>{t('gravity.tools.presets')}</b>
        <select value={preset} onChange={(e) => setPreset(e.target.value as GravityScenario)} disabled={inSim} data-testid="gravity-preset-select">
          {GRAVITY_SCENARIOS.filter((s) => s !== 'custom').map((id) => <option key={id} value={id}>{t(`gravity.scenario.${id}` as MessageKey)}</option>)}
        </select>
        <div style={{ color: 'var(--text-2)' }}>{t(`gravity.preset.d.${preset}` as MessageKey)}</div>
        {demo.assumptions.map((k) => <div key={k} style={{ color: 'var(--text-3)' }}>· {t(k as MessageKey)}</div>)}
        <button className={eq.small} disabled={inSim} onClick={() => loadGravityDemo(preset)} data-testid="gravity-preset-load">
          <Icon name="gravity" size={12} /> {t('gravity.tools.loadPreset')}
        </button>
      </div>
    </div>
  );
}
