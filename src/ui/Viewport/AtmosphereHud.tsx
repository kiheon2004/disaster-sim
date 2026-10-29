import { useT, type MessageKey } from '@/i18n/i18n';
import { useSimStore } from '@/simulation/simStore';
import { Icon } from '@/ui/common/Icon';
import { energyText } from '@/thermal/units';

const kPa = (p: number) => (p >= 1000 ? `${(p / 1000).toFixed(2)} kPa` : p >= 1 ? `${p.toFixed(1)} Pa` : `${p.toExponential(1)} Pa`);
const C = (K: number) => `${(K - 273.15).toFixed(1)} °C`;
const mass = (kg: number) => (Math.abs(kg) >= 1e9 ? `${(kg / 1e9).toFixed(3)} Mt` : Math.abs(kg) >= 1e6 ? `${(kg / 1e6).toFixed(2)} kt` : Math.abs(kg) >= 1000 ? `${(kg / 1000).toFixed(1)} t` : `${kg.toFixed(1)} kg`);

/** Datum pressure history (computed samples) as a sparkline, 0 … initial pressure. */
function Spark({ pts, p0 }: { pts: { t: number; p: number }[]; p0: number }) {
  if (pts.length < 2) return null;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || 1;
  const d = pts.map((s) => `${((s.t - t0) / Math.max(1e-9, t1 - t0)) * 200},${40 - (Math.min(p0 * 1.05, s.p) / (p0 * 1.05)) * 38}`).join(' ');
  return (
    <svg width="100%" viewBox="0 0 200 42" preserveAspectRatio="none" style={{ height: 34 }} data-testid="atmos-hud-chart">
      <polyline points={d} fill="none" stroke="#5fb8ff" strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * Live atmosphere readout (Phase 29): the remaining air (indicator), mean / lowest surface pressure,
 * density, the air mass removed / restored, the fastest computed flow, temperatures, O₂ in the layer,
 * fires limited by it, volcanic gas, the energy terms and the ledger residuals. Computed values only —
 * the remaining-air badge replaces any darkening of the scene.
 */
export function AtmosphereHud() {
  const t = useT();
  const a = useSimStore((x) => x.atmosphere);
  if (!a) return null;
  const s = a.stats, E = a.energy, M = a.mass;
  const k = (key: MessageKey) => <span style={{ color: 'var(--text-2)', textAlign: 'left' }}>{t(key)}</span>;
  const share = Math.max(0, s.share);
  const thin = share < 0.5;
  return (
    <div
      data-testid="atmos-hud"
      style={{
        padding: '8px 10px', borderRadius: 8, background: 'rgba(8,22,40,0.86)', border: `1px solid ${thin ? '#5fb8ff' : 'rgba(255,255,255,0.1)'}`,
        backdropFilter: 'blur(4px)', display: 'flex', flexDirection: 'column', gap: 3, width: 300, boxSizing: 'border-box', fontSize: 11,
      }}
    >
      <span style={{ fontWeight: 700, color: '#5fb8ff', display: 'flex', alignItems: 'center', gap: 5 }}>
        <Icon name="atmosphere" size={13} /> {t('atmosHud.title')}
        <span style={{ marginLeft: 'auto', fontWeight: 600 }} data-testid="atmos-hud-share" title={t('atmosHud.shareTip')}>{t('atmosHud.share', { f: (share * 100).toFixed(share < 0.01 ? 3 : 1) })}</span>
      </span>
      <div style={{ height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }} data-testid="atmos-hud-indicator">
        <div style={{ width: `${Math.min(100, share * 100)}%`, height: '100%', background: '#5fb8ff' }} />
      </div>
      {a.rejected.map((r) => <span key={r.name} style={{ color: '#ffb36b' }}>⚠ {r.name}: {t(r.reason as MessageKey)}</span>)}
      <div style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', columnGap: 8, rowGap: 1, color: 'var(--text-1)', textAlign: 'right' }}>
        {k('atmosHud.pressure')}<span className="mono" data-testid="atmos-hud-pressure">{kPa(s.meanPressure)} · {t('atmosHud.min')} {kPa(s.minPressure)}</span>
        {k('atmosHud.density')}<span className="mono" data-testid="atmos-hud-density">{s.meanDensity.toFixed(3)} · {t('atmosHud.min')} {s.minDensity.toFixed(3)} kg/m³</span>
        {k('atmosHud.mass')}<span className="mono" data-testid="atmos-hud-mass">{mass(s.mass)} · −{mass(M.removed)}{M.restored > 0 ? ` · +${mass(M.restored)}` : ''}</span>
        {(M.boundaryIn > 0 || M.boundaryOut > 0) && <>{k('atmosHud.boundary')}<span className="mono">+{mass(M.boundaryIn)} / −{mass(M.boundaryOut)}</span></>}
        {k('atmosHud.flow')}<span className="mono" data-testid="atmos-hud-flow">{Math.max(s.maxColumnSpeed, s.maxLayerSpeed).toFixed(2)} m/s · {t('atmosHud.peak')} {s.peakSpeed.toFixed(2)}</span>
        {k('atmosHud.temp')}<span className="mono">{C(s.meanLayerT)} · {t('atmosHud.aloft')} {C(s.Tcol)}</span>
        {s.maxUpdraft > 0.05 && <>{k('atmosHud.updraft')}<span className="mono">{s.maxUpdraft.toFixed(2)} m/s</span></>}
        {k('atmosHud.o2')}<span className="mono" data-testid="atmos-hud-o2">{mass(s.o2Layer)} · {(s.o2Fraction * 100).toFixed(1)} %{s.o2LimitedEver > 0 ? ` · ${t('atmosHud.o2Limited', { n: s.o2Limited })}` : ''}</span>
        {a.gas.emitted > 0 && <>{k('atmosHud.gas')}<span className="mono">{mass(a.gas.airborne)} · {t('atmosHud.out')} {mass(a.gas.out)}</span></>}
        {k('atmosHud.energy')}<span className="mono" data-testid="atmos-hud-energy">−{energyText(E.removed)} · W {energyText(E.pressureWork)} · Q {energyText(E.heatIn)}</span>
        {k('atmosHud.boiling')}<span className="mono">{C(s.boiling)}{s.waterAboveBoiling > 0 ? ` · ${t('atmosHud.waterAbove', { n: s.waterAboveBoiling })}` : ''}</span>
        {k('atmosHud.residual')}<span className="mono" data-testid="atmos-residual">{s.massResidual.toExponential(1)} · {s.energyResidual.toExponential(1)}</span>
        {k('atmosHud.cost')}<span className="mono">{a.ms.toFixed(2)} ms · {s.iterations} it</span>
      </div>
      <Spark pts={a.series} p0={a.p0} />
      {a.warnings.map((w) => <span key={w} style={{ fontSize: 10, color: '#ffb36b' }}>⚠ {t(w as MessageKey)}</span>)}
      <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{t('atmosHud.note')}</span>
    </div>
  );
}
