import { useT, type MessageKey } from '@/i18n/i18n';
import { useSimStore } from '@/simulation/simStore';
import { Icon } from '@/ui/common/Icon';
import { energyText } from '@/thermal/units';

const C = (K: number) => `${(K - 273.15).toFixed(0)} °C`;
const tons = (kg: number) => (kg >= 1e5 ? `${(kg / 1000).toFixed(0)} t` : kg >= 1000 ? `${(kg / 1000).toFixed(1)} t` : `${kg.toFixed(0)} kg`);

/**
 * Live volcano readout (Phase 28): eruption phase and supply, mobile / solidified lava, bombs and ash,
 * the largest depth / temperature / speed, where the heat went, objects and roads affected, and the mass /
 * energy ledgers with their residuals. Computed values only.
 */
export function VolcanoHud() {
  const t = useT();
  const s = useSimStore((x) => x.volcano);
  if (!s) return null;
  const k = (key: MessageKey) => <span style={{ color: 'var(--text-2)', textAlign: 'left' }}>{t(key)}</span>;
  const M = s.ledger.mass, E = s.ledger.energy;
  const erupting = s.supplyRate > 0;
  return (
    <div
      data-testid="volcano-hud"
      style={{
        padding: '8px 10px', borderRadius: 8, background: 'rgba(40,12,6,0.86)', border: `1px solid ${erupting ? '#ff6a1a' : 'rgba(255,255,255,0.1)'}`,
        backdropFilter: 'blur(4px)', display: 'flex', flexDirection: 'column', gap: 3, width: 300, boxSizing: 'border-box', fontSize: 11,
      }}
    >
      <span style={{ fontWeight: 700, color: '#ff8a3d', display: 'flex', alignItems: 'center', gap: 5 }}>
        <Icon name="volcano" size={13} /> {t('volcanoHud.title')}
        <span style={{ marginLeft: 'auto', fontWeight: 600 }} data-testid="volcano-hud-rate">{s.supplyRate.toFixed(2)} m³/s</span>
      </span>
      {s.eruptions.map((e) => (
        <span key={e.id} style={{ color: e.reason ? '#ffb36b' : 'var(--text-1)' }} data-testid="volcano-hud-eruption">
          {e.reason ? `⚠ ${e.name}: ${t(e.reason as MessageKey)}` : `${e.name} · ${t(`volcano.phase.${e.phase}` as MessageKey)}`}
        </span>
      ))}
      <div style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', columnGap: 8, rowGap: 1, color: 'var(--text-1)', textAlign: 'right' }}>
        {k('volcanoHud.supplied')}<span className="mono">{tons(M.supplied)}</span>
        {k('volcanoHud.mobile')}<span className="mono" data-testid="volcano-hud-mobile">{s.mobileVolume.toFixed(1)} m³ · {s.area.toFixed(0)} m²</span>
        {k('volcanoHud.solid')}<span className="mono" data-testid="volcano-hud-solid">{tons(M.solidified)} · {s.depositArea.toFixed(0)} m² · {s.maxDeposit.toFixed(2)} m</span>
        {k('volcanoHud.lava')}<span className="mono" data-testid="volcano-hud-lava">{s.maxDepth.toFixed(2)} m · {C(s.maxT)} · {s.maxSpeed.toFixed(2)} m/s</span>
        {M.bombsLaunched > 0 && <>{k('volcanoHud.bombs')}<span className="mono">{tons(M.bombsDeposited)} · {t('volcanoHud.air', { n: s.bombsAir })}</span></>}
        {M.ashReleased > 0 && <>{k('volcanoHud.ash')}<span className="mono" data-testid="volcano-hud-ash">{tons(M.ashDeposited + M.ashCaught)} · {tons(M.ashAirborne)} {t('volcanoHud.airborne')} · {tons(M.outAsh)} {t('volcanoHud.out')}</span></>}
        {k('volcanoHud.heat')}<span className="mono">{energyText(E.toGround)} / {energyText(E.toObjects)} / {energyText(E.toWater)} / {energyText(E.radiated + E.toAir)}</span>
        {(s.objects.contact > 0 || s.roads.blocked > 0) && <>{k('volcanoHud.affected')}<span className="mono" data-testid="volcano-hud-objects">{t('volcanoHud.affectedValue', { c: s.objects.contact, b: s.objects.buried, h: s.objects.held, r: s.roads.blocked })}</span></>}
        {s.objects.roofAsh > 0 && <>{k('volcanoHud.roofs')}<span className="mono">{t('volcanoHud.roofsValue', { n: s.objects.roofAsh, kPa: s.objects.maxAshLoad.toFixed(2) })}</span></>}
        {s.waterAbove100 > 0 && <>{k('volcanoHud.water100')}<span className="mono" style={{ color: '#ffb36b' }}>{s.waterAbove100}</span></>}
        {k('volcanoHud.residual')}<span className="mono" data-testid="volcano-residual">{(M.residual / Math.max(1, M.supplied)).toExponential(1)} · {(E.residual / Math.max(1, E.supplied)).toExponential(1)}</span>
        {k('volcanoHud.cost')}<span className="mono">{s.ms.toFixed(2)} ms · {s.activeLava}/{s.hotDeposits}</span>
      </div>
      <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{t('volcanoHud.note')}</span>
    </div>
  );
}
