import { useT, type MessageKey } from '@/i18n/i18n';
import { useSimStore, type GravityLive } from '@/simulation/simStore';
import { Icon } from '@/ui/common/Icon';
import { energyText } from '@/thermal/units';
import { SUPPORTED_MODELS } from '@/gravity/outlook';

const vec = (v: readonly number[]) => `(${v.map((x) => (Math.abs(x) < 5e-3 ? '0.00' : x.toFixed(2))).join(', ')})`;
const imp = (x: number) => (Math.abs(x) >= 1e6 ? `${(x / 1e6).toFixed(2)} MN·s` : Math.abs(x) >= 1e3 ? `${(x / 1e3).toFixed(1)} kN·s` : `${x.toFixed(0)} N·s`);

/** |g| (orange) and the kinetic energy of the bodies (blue, own scale) over the run. */
function Spark({ pts }: { pts: GravityLive['series'] }) {
  if (pts.length < 2) return null;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  let gmax = 1e-9, kmax = 1e-9;
  for (const p of pts) { gmax = Math.max(gmax, p.magnitude); kmax = Math.max(kmax, p.kinetic); }
  const x = (t: number) => ((t - t0) / Math.max(1e-9, t1 - t0)) * 200;
  return (
    <svg width="100%" viewBox="0 0 200 42" preserveAspectRatio="none" style={{ height: 34 }} data-testid="gravity-hud-chart">
      <polyline points={pts.map((p) => `${x(p.t)},${40 - (p.kinetic / kmax) * 38}`).join(' ')} fill="none" stroke="#7fb6ff" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <polyline points={pts.map((p) => `${x(p.t)},${40 - (p.magnitude / gmax) * 38}`).join(' ')} fill="none" stroke="#ffb35c" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * Live gravity readout (Phase 31): the field acting now (vector, |g|, multiple of Earth gravity, regime), the bodies it
 * moves, the structures it loads, the air-column pressure (model or estimate), the energy / momentum ledger of gravity
 * on the bodies, and which models are limited or unsupported under it. Computed values only.
 */
export function GravityHud() {
  const t = useT();
  const g = useSimStore((x) => x.gravity);
  if (!g) return null;
  const s = g.stats, b = g.balance;
  const k = (key: MessageKey) => <span style={{ color: 'var(--text-2)', textAlign: 'left' }}>{t(key)}</span>;
  const limited = SUPPORTED_MODELS.filter((m) => g.support[m] === 'limited' || g.support[m] === 'unsupported');
  return (
    <div
      data-testid="gravity-hud"
      style={{
        padding: '8px 10px', borderRadius: 8, background: 'rgba(24,18,10,0.88)', border: '1px solid rgba(255,190,110,0.35)',
        backdropFilter: 'blur(4px)', display: 'flex', flexDirection: 'column', gap: 3, width: 330, boxSizing: 'border-box', fontSize: 11,
      }}
    >
      <span style={{ fontWeight: 700, color: '#ffd29a', display: 'flex', alignItems: 'center', gap: 5 }}>
        <Icon name="gravity" size={13} /> {t('gravityHud.title')}
        <span style={{ marginLeft: 'auto', fontWeight: 600 }} data-testid="gravity-hud-mode">{t(`gravity.mode.${g.mode}` as MessageKey)} · {g.t.toFixed(1)} s</span>
      </span>
      <div style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', columnGap: 8, rowGap: 1, color: 'var(--text-1)', textAlign: 'right' }}>
        {k('gravityHud.g')}<span className="mono" data-testid="gravity-hud-g">{g.magnitude.toFixed(2)} m/s² · {g.ratio.toFixed(2)} g₀</span>
        {k('gravityHud.vector')}<span className="mono" data-testid="gravity-hud-vector">{vec(g.G)} m/s²</span>
        {k('gravityHud.down')}<span className="mono">{g.down.toFixed(2)} m/s²</span>
        {k('gravityHud.field')}<span className="mono" data-testid="gravity-hud-field">{g.uniform ? t('gravityHud.uniform') : t('gravityHud.local', { n: g.sources.length })}{s.peak > 0 ? ` · ${t('gravityHud.range', { a: (Number.isFinite(s.minimum) ? s.minimum : 0).toFixed(2), b: s.peak.toFixed(2) })}` : ''}</span>
        {k('gravityHud.bodies')}<span className="mono" data-testid="gravity-hud-bodies">{t('gravityHud.bodiesLine', { n: s.bodies, a: s.affected, w: s.wakes })}</span>
        {k('gravityHud.structures')}<span className="mono" data-testid="gravity-hud-structures">{t('gravityHud.structLine', { n: g.structures.loaded, f: g.structures.failures, r: g.structures.roofFailures })}</span>
        {k('gravityHud.pressure')}<span className="mono" data-testid="gravity-hud-pressure">{(g.pressure.value / 1000).toFixed(1)} kPa {g.pressure.modelled ? '' : t('gravityHud.estimate')}</span>
        {k('gravityHud.energy')}<span className="mono" data-testid="gravity-hud-energy">K {energyText(b.kinetic)} · {Number.isFinite(b.potential) ? `U ${energyText(b.potential)}` : t('gravityHud.noPotential')}</span>
        {k('gravityHud.work')}<span className="mono">W_g {energyText(b.workGravity)} · W_f {Number.isFinite(b.workField) ? energyText(b.workField) : '—'} · {t('gravityHud.other')} {energyText(b.workOther)}</span>
        {k('gravityHud.momentum')}<span className="mono">J_g {imp(Math.hypot(...b.impulse))} · {t('gravityHud.other')} {imp(Math.hypot(...b.impulseOther))}</span>
        {k('gravityHud.residual')}<span className="mono" data-testid="gravity-residual">{Number.isFinite(b.fieldResidual) ? b.fieldResidual.toExponential(1) : '—'} J</span>
        {k('gravityHud.cost')}<span className="mono">{g.ms.toFixed(2)} ms</span>
      </div>
      <Spark pts={g.series} />
      {limited.length > 0 && (
        <span style={{ fontSize: 10, color: '#ffb36b' }} data-testid="gravity-hud-limits">
          ⚠ {t('gravityHud.limited')}: {limited.map((m) => `${t(`gravity.model.${m}` as MessageKey)} (${t(`gravity.support.${g.support[m]}` as MessageKey)})`).join(', ')}
        </span>
      )}
      {g.held.water > 0 && <span style={{ fontSize: 10, color: '#ffb36b' }}>⚠ {t('gravityHud.waterHeld', { s: g.held.water.toFixed(1) })}</span>}
      {g.held.atmosphere > 0 && <span style={{ fontSize: 10, color: '#ffb36b' }}>⚠ {t('gravityHud.airHeld', { s: g.held.atmosphere.toFixed(1) })}</span>}
      <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{t('gravityHud.note')}</span>
    </div>
  );
}
