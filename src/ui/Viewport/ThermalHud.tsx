import { useT, type MessageKey } from '@/i18n/i18n';
import { useSimStore } from '@/simulation/simStore';
import { Icon } from '@/ui/common/Icon';
import { energyText, powerText } from '@/thermal/units';

const C = (K: number) => `${(K - 273.15).toFixed(1)} °C`;

/**
 * Live thermal readout (Phase 26): sources on / off with their current output, the hottest place,
 * air / water / room maxima, heated area, the energy ledger (added, lost to the surroundings, held,
 * residual) and the structural effect (strength factors, thermal failures). Computed values only.
 */
export function ThermalHud() {
  const t = useT();
  const s = useSimStore((x) => x.thermal);
  // With a fire the fire HUD carries the story: the thermal one shrinks to its key numbers (Phase 27).
  const compact = useSimStore((x) => x.fire !== null);
  if (!s) return null;
  const k = (key: MessageKey) => <span style={{ color: 'var(--text-2)' }}>{t(key)}</span>;
  const on = s.sources.filter((x) => x.on).length;
  return (
    <div
      data-testid="thermal-hud"
      style={{
        padding: '8px 10px', borderRadius: 8, background: 'rgba(40,18,10,0.82)', border: `1px solid ${on ? '#ffb36b' : 'rgba(255,255,255,0.1)'}`,
        backdropFilter: 'blur(4px)', display: 'flex', flexDirection: 'column', gap: 3, width: 290, boxSizing: 'border-box', fontSize: 11,
      }}
    >
      <span style={{ fontWeight: 700, color: '#ffb36b', display: 'flex', alignItems: 'center', gap: 5 }}>
        <Icon name="heat" size={13} /> {t('thermalHud.title')}
        <span style={{ marginLeft: 'auto', fontWeight: 600 }}>{t('thermalHud.sources', { on, n: s.sources.length })}</span>
      </span>
      {!compact && s.sources.map((x) => (
        <span key={x.id} className="mono" style={{ color: x.on ? 'var(--text-1)' : 'var(--text-3)' }}>
          {x.name} · {t(`thermal.kind.${x.kind}` as MessageKey).split(' (')[0]} · {x.temperature !== null ? C(x.temperature) : x.on ? powerText(x.power) : t('thermalHud.off')}
        </span>
      ))}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', columnGap: 8, rowGap: 1, color: 'var(--text-1)' }}>
        {k('thermalHud.max')}<span className="mono" data-testid="thermal-max">{C(s.maxT)} · {t(`thermal.where.${s.maxWhere}` as MessageKey)}</span>
        {!compact && <>{k('thermalHud.air')}<span className="mono">{C(s.maxAirT)}{s.maxRoomT > s.ambient + 0.05 ? ` · ${t('thermalHud.room')} ${C(s.maxRoomT)}` : ''}</span>
        {s.maxWaterT > s.ambient + 0.01 && <>{k('thermalHud.water')}<span className="mono">{C(s.maxWaterT)}</span></>}
        {k('thermalHud.heated')}<span className="mono">{s.heatedArea.toFixed(0)} m² · {C(s.meanHeatedT)}</span>
        {k('thermalHud.flux')}<span className="mono">{(s.maxFlux / 1000).toFixed(1)} kW/m²</span>
        {k('thermalHud.added')}<span className="mono">{energyText(s.added + s.boundarySupply + s.impactDeposit)}</span></>}
        {s.combustion > 0 && <>{k('thermalHud.combustion')}<span className="mono">{energyText(s.combustion)}</span></>}
        {!compact && <>{k('thermalHud.lost')}<span className="mono">{energyText(s.lost)}</span>
        {k('thermalHud.held')}<span className="mono">{energyText(s.internal)}</span></>}
        {k('thermalHud.residual')}<span className="mono" data-testid="thermal-residual">{s.residual.toExponential(1)} J ({(s.relativeResidual * 100).toExponential(1)} %)</span>
        {s.buildings > 0 && <>{k('thermalHud.strength')}<span className="mono">{(s.minFactor * 100).toFixed(0)} % · {t('thermalHud.failed', { n: s.failedMembers })}</span></>}
        {!compact && <>{k('thermalHud.cost')}<span className="mono">{s.ms.toFixed(2)} ms · ×{s.substeps} · {s.activeTiles}</span></>}
      </div>
      {!compact && <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{t('thermalHud.note')}</span>}
    </div>
  );
}
