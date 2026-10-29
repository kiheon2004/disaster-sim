import { useT, type MessageKey } from '@/i18n/i18n';
import { useSimStore, type ClimateLive } from '@/simulation/simStore';
import { Icon } from '@/ui/common/Icon';
import { energyText } from '@/thermal/units';

const C = (K: number) => `${(K - 273.15).toFixed(1)} °C`;
const mass = (kg: number) => (Math.abs(kg) >= 1e6 ? `${(kg / 1e6).toFixed(2)} kt` : Math.abs(kg) >= 1000 ? `${(kg / 1000).toFixed(2)} t` : `${kg.toFixed(1)} kg`);

/** Mean air / surface temperature history (computed samples). */
function Spark({ pts }: { pts: ClimateLive['series'] }) {
  if (pts.length < 2) return null;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || 1;
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) { lo = Math.min(lo, p.T, p.Ts); hi = Math.max(hi, p.T, p.Ts); }
  lo -= 0.5; hi += 0.5;
  const y = (K: number) => 40 - ((K - lo) / (hi - lo)) * 38;
  const line = (f: (p: ClimateLive['series'][number]) => number) => pts.map((p) => `${((p.t - t0) / Math.max(1e-9, t1 - t0)) * 200},${y(f(p))}`).join(' ');
  return (
    <svg width="100%" viewBox="0 0 200 42" preserveAspectRatio="none" style={{ height: 34 }} data-testid="climate-hud-chart">
      <polyline points={line((p) => p.Ts)} fill="none" stroke="#9fd3ff" strokeWidth={1.1} vectorEffect="non-scaling-stroke" />
      <polyline points={line((p) => p.T)} fill="none" stroke="#ffaa5a" strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * Live climate readout (Phase 30): air and surface temperatures (mean, min, max), humidity, the background state,
 * snow / ice / stores, meltwater and evaporation, frozen ground, roof loads, roads, the water and energy ledgers with
 * their residuals. Computed values only.
 */
export function ClimateHud() {
  const t = useT();
  const c = useSimStore((x) => x.climate);
  if (!c) return null;
  const s = c.stats, W = c.water, E = c.energy, Th = c.thermal;
  const k = (key: MessageKey) => <span style={{ color: 'var(--text-2)', textAlign: 'left' }}>{t(key)}</span>;
  return (
    <div
      data-testid="climate-hud"
      style={{
        padding: '8px 10px', borderRadius: 8, background: 'rgba(14,24,36,0.88)', border: '1px solid rgba(191,227,255,0.35)',
        backdropFilter: 'blur(4px)', display: 'flex', flexDirection: 'column', gap: 3, width: 330, boxSizing: 'border-box', fontSize: 11,
      }}
    >
      <span style={{ fontWeight: 700, color: '#bfe3ff', display: 'flex', alignItems: 'center', gap: 5 }}>
        <Icon name="climate" size={13} /> {t('climateHud.title')}
        <span style={{ marginLeft: 'auto', fontWeight: 600 }} data-testid="climate-hud-scenario">{t(`climate.scenario.${c.spec.scenario}` as MessageKey)} · {(c.t / 60).toFixed(1)} min</span>
      </span>
      {c.rejected.map((r) => <span key={r.name} style={{ color: '#ffb36b' }}>⚠ {r.name}: {t(r.reason as MessageKey)}</span>)}
      <div style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', columnGap: 8, rowGap: 1, color: 'var(--text-1)', textAlign: 'right' }}>
        {k('climateHud.air')}<span className="mono" data-testid="climate-hud-air">{C(s.meanAirT)} ({(s.minAirT - 273.15).toFixed(1)}…{(s.maxAirT - 273.15).toFixed(1)})</span>
        {k('climateHud.surface')}<span className="mono" data-testid="climate-hud-surface">{C(s.meanSurfaceT)} ({(s.minSurfaceT - 273.15).toFixed(1)}…{(s.maxSurfaceT - 273.15).toFixed(1)})</span>
        {k('climateHud.background')}<span className="mono">{C(s.bgT)} · {(s.bgRH * 100).toFixed(0)} %</span>
        {k('climateHud.skyRow')}<span className="mono">{C(s.Tsky)}</span>
        {k('climateHud.rh')}<span className="mono" data-testid="climate-hud-rh">{(s.meanRH * 100).toFixed(0)} % · {mass(s.vapour)}{s.condensate > 0.01 ? ` · ${t('climateHud.fog')} ${mass(s.condensate)}` : ''}</span>
        {s.solar > 0 && <>{k('climateHud.sun')}<span className="mono">{((s.sunElevation * 180) / Math.PI).toFixed(1)}° · {s.solar.toFixed(0)} W/m²</span></>}
        {s.precipRate > 0 && <>{k('climateHud.precip')}<span className="mono" data-testid="climate-hud-precip">{s.precipRate.toFixed(1)} mm/h</span></>}
        {k('climateHud.snow')}<span className="mono" data-testid="climate-hud-snow">{mass(s.snowMass)} · {t('climateHud.maxDepth')} {(s.maxSnowDepth * 100).toFixed(1)} cm{s.storeMass > 0 ? ` · ${t('climateHud.onObjects')} ${mass(s.storeMass)}` : ''}</span>
        {k('climateHud.ice')}<span className="mono" data-testid="climate-hud-ice">{mass(s.iceMass)} · {t('climateHud.max')} {(s.maxIce * 100).toFixed(1)} cm</span>
        {k('climateHud.melt')}<span className="mono" data-testid="climate-hud-melt">{(s.meltwater / 1000).toFixed(2)} m³ · {t('climateHud.evap')} {mass(s.evaporation)} ({mass(s.evaporationRate)}/s)</span>
        {s.frozenSoilCells > 0 && <>{k('climateHud.frost')}<span className="mono">{(s.frostDepth * 100).toFixed(0)} cm · {s.frozenSoilCells} m²</span></>}
        {s.maxRoofLoad > 0 && <>{k('climateHud.roof')}<span className="mono" data-testid="climate-hud-roof">{s.maxRoofLoad.toFixed(2)} kPa · {s.roofsLoaded}</span></>}
        {(s.roadsIcy > 0 || s.roadsSnow > 0) && <>{k('climateHud.roads')}<span className="mono">{t('climateHud.roadsLine', { i: s.roadsIcy, s: s.roadsSnow, x: s.roadsImpassable })}</span></>}
        {s.treesBroken > 0 && <>{k('climateHud.trees')}<span className="mono">{s.treesBroken}</span></>}
        {k('climateHud.waterLedger')}<span className="mono" data-testid="climate-hud-water">+{mass(W.precipitation + W.vaporIn + W.floodIn + W.blownIn)} −{mass(W.vaporOut + W.floodOut + W.removed + W.blownOut)}</span>
        {k('climateHud.energyLedger')}<span className="mono" data-testid="climate-hud-energy">L {energyText(Th.latent)} · S {energyText(Th.solar + E.solar)} · F {energyText(Th.climate)}</span>
        {k('climateHud.residual')}<span className="mono" data-testid="climate-residual">{s.waterResidual.toExponential(1)} · {s.energyResidual.toExponential(1)} · {s.thermalResidual.toExponential(1)}</span>
        {k('climateHud.cost')}<span className="mono">{c.ms.toFixed(2)} ms</span>
      </div>
      <Spark pts={c.series} />
      {c.warnings.map((w) => <span key={w} style={{ fontSize: 10, color: '#ffb36b' }}>⚠ {t(w as MessageKey)}</span>)}
      <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{t('climateHud.note')}</span>
    </div>
  );
}
