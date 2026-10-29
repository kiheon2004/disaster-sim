import { useT, type MessageKey } from '@/i18n/i18n';
import { useSimStore, type CelestialLive } from '@/simulation/simStore';
import { Icon } from '@/ui/common/Icon';
import { energyText } from '@/thermal/units';

/** Number in SI with an exponent when it spans decades (masses, μ, r_s). */
export const sci = (x: number, d = 2) => (!Number.isFinite(x) ? '—' : x === 0 ? '0' : Math.abs(x) >= 1e4 || Math.abs(x) < 1e-2 ? x.toExponential(d) : x.toFixed(d));
const kg = (m: number) => (m >= 1e6 ? `${(m / 1000).toExponential(2)} t` : m >= 1000 ? `${(m / 1000).toFixed(2)} t` : `${m.toFixed(1)} kg`);

/** First probe's distance to its source (green) and specific energy change (blue, own scale) over the run. */
function Spark({ pts }: { pts: CelestialLive['series'] }) {
  if (pts.length < 2 || !pts.some((p) => Number.isFinite(p.r[0]))) return null;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  let rmax = 1e-9, emin = Infinity, emax = -Infinity;
  for (const p of pts) {
    if (Number.isFinite(p.r[0])) rmax = Math.max(rmax, p.r[0]);
    if (Number.isFinite(p.e[0])) { emin = Math.min(emin, p.e[0]); emax = Math.max(emax, p.e[0]); }
  }
  const x = (t: number) => ((t - t0) / Math.max(1e-9, t1 - t0)) * 200;
  const ok = pts.filter((p) => Number.isFinite(p.r[0]));
  const span = Math.max(1e-12, emax - emin);
  return (
    <svg width="100%" viewBox="0 0 200 42" preserveAspectRatio="none" style={{ height: 34 }} data-testid="celestial-hud-chart">
      <polyline points={ok.map((p) => `${x(p.t)},${40 - ((p.e[0] - emin) / span) * 38}`).join(' ')} fill="none" stroke="#7fb6ff" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <polyline points={ok.map((p) => `${x(p.t)},${40 - (p.r[0] / rmax) * 38}`).join(' ')} fill="none" stroke="#7ff0c0" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * Live celestial readout (Phase 32): each source (mass, μ, r_s as a reference only, ε, capture radius), the largest
 * |g| and tidal stretch at the bodies, the bodies the KDK integrator carries, captures (count, mass, ledger closure),
 * structures loaded / pulled up, the integrator's substeps, the model-limit state and the scale label. Computed values
 * only; the disc and lens are labelled illustrative.
 */
export function CelestialHud() {
  const t = useT();
  const c = useSimStore((x) => x.celestial);
  if (!c) return null;
  const s = c.stats, L = c.ledger;
  const k = (key: MessageKey) => <span style={{ color: 'var(--text-2)', textAlign: 'left' }}>{t(key)}</span>;
  const educational = c.experiments.some((e) => e.scale === 'educational');
  const visual = c.experiments.some((e) => e.disc || e.lensing);
  return (
    <div
      data-testid="celestial-hud"
      style={{
        padding: '8px 10px', borderRadius: 8, background: 'rgba(14,10,22,0.9)', border: '1px solid rgba(255,150,110,0.4)',
        backdropFilter: 'blur(4px)', display: 'flex', flexDirection: 'column', gap: 3, width: 340, boxSizing: 'border-box', fontSize: 11,
      }}
    >
      <span style={{ fontWeight: 700, color: '#ffc49a', display: 'flex', alignItems: 'center', gap: 5 }}>
        <Icon name="celestial" size={13} /> {t('celestialHud.title')}
        <span style={{ marginLeft: 'auto', fontWeight: 600 }}>{c.t.toFixed(1)} s</span>
      </span>
      {educational && <span style={{ fontSize: 10, color: '#ffd29a', fontWeight: 600 }} data-testid="celestial-hud-scaled">{t('celestial.lim.scaled')}</span>}
      <div style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', columnGap: 8, rowGap: 1, color: 'var(--text-1)', textAlign: 'right' }}>
        {s.sources.map((q, i) => (
          <span key={`s${i}`} style={{ display: 'contents' }}>
            {k('celestialHud.source')}<span className="mono" data-testid={`celestial-hud-source-${i}`}>M {sci(q.mass)} kg · μ {sci(q.mu)} m³/s²</span>
            {k('celestialHud.radii')}<span className="mono">ε {q.eps.toFixed(2)} · r_c {q.capture.toFixed(2)} · r_s {sci(q.rs)} m{q.moving ? ` · ${t('celestialHud.moving')}` : ''}</span>
          </span>
        ))}
        {k('celestialHud.maxAccel')}<span className="mono" data-testid="celestial-hud-accel">{sci(s.maxAccel)} m/s² · {(s.maxAccel / 9.81).toFixed(1)} g₀</span>
        {k('celestialHud.maxTidal')}<span className="mono" data-testid="celestial-hud-tidal">λ₁ {sci(s.maxTidal, 3)} s⁻²</span>
        {k('celestialHud.bodies')}<span className="mono" data-testid="celestial-hud-bodies">{t('celestialHud.bodiesLine', { n: s.orbiting, c: s.contact, p: s.particles, l: s.landed })}</span>
        {k('celestialHud.captured')}<span className="mono" data-testid="celestial-hud-captured">{L.count} · {kg(L.mass)} · Δm {L.massResidual.toExponential(1)}</span>
        {k('celestialHud.energy')}<span className="mono">K {energyText(L.kinetic)} · {t('celestialHud.unresolved')} {energyText(L.unresolved)}</span>
        {k('celestialHud.structures')}<span className="mono" data-testid="celestial-hud-structures">{t('celestialHud.structLine', { u: c.structures.loadedUnits, f: c.structures.failures, p: c.structures.uplifted })}</span>
        {k('celestialHud.integrator')}<span className="mono" data-testid="celestial-hud-integrator">KDK · {t('celestialHud.substeps', { m: s.maxSubsteps, a: s.meanSubsteps.toFixed(1), c: s.capped })}</span>
        {k('celestialHud.limit')}<span className="mono" data-testid="celestial-hud-limit" style={{ color: s.limit === 'none' ? 'var(--text-1)' : '#ff8a6b' }}>{t(`celestialHud.limit.${s.limit}` as MessageKey)}{s.limitReason ? ` · ${t(`celestialHud.reason.${s.limitReason}` as MessageKey)}` : ''}</span>
        {k('celestialHud.cost')}<span className="mono">{c.ms.toFixed(2)} ms</span>
      </div>
      <Spark pts={c.series} />
      {visual && <span style={{ fontSize: 10, color: '#ffb36b' }} data-testid="celestial-hud-visual">⚠ {t('overlay.celestial.illustrative')}</span>}
      <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{t('celestialHud.note')}</span>
    </div>
  );
}
