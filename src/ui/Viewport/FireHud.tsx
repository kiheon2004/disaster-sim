import { useT, type MessageKey } from '@/i18n/i18n';
import { useSimStore } from '@/simulation/simStore';
import { Icon } from '@/ui/common/Icon';
import { energyText, powerText } from '@/thermal/units';

const C = (K: number) => `${(K - 273.15).toFixed(0)} °C`;

/**
 * Live fire readout (Phase 27): heat release now / peak with its history, burning and ignited
 * objects, rooms (burning, flashover, oxygen-limited), smoke visibility, structure effects, and the
 * fuel / chemical-energy ledger with its residual. Computed values only.
 */
export function FireHud() {
  const t = useT();
  const s = useSimStore((x) => x.fire);
  if (!s) return null;
  const k = (key: MessageKey) => <span style={{ color: 'var(--text-2)' }}>{t(key)}</span>;
  const L = s.ledger;
  const h = s.history;
  const max = Math.max(1, ...h);
  const path = h.map((v, i) => `${(i / Math.max(1, h.length - 1)) * 100},${20 - (v / max) * 19}`).join(' ');
  const burning = s.burningItems > 0;
  return (
    <div
      data-testid="fire-hud"
      style={{
        padding: '8px 10px', borderRadius: 8, background: 'rgba(48,14,6,0.84)', border: `1px solid ${burning ? '#ff6a2a' : 'rgba(255,255,255,0.1)'}`,
        backdropFilter: 'blur(4px)', display: 'flex', flexDirection: 'column', gap: 3, width: 290, boxSizing: 'border-box', fontSize: 11,
      }}
    >
      <span style={{ fontWeight: 700, color: '#ff8a3d', display: 'flex', alignItems: 'center', gap: 5 }}>
        <Icon name="flame" size={13} /> {t('fireHud.title')}
        <span style={{ marginLeft: 'auto', fontWeight: 600 }} data-testid="fire-hud-hrr">{powerText(s.hrr)}</span>
      </span>
      {h.length > 1 && (
        <svg viewBox="0 0 100 20" preserveAspectRatio="none" style={{ width: '100%', height: 22 }} aria-label={t('fireHud.history')}>
          <polyline points={path} fill="none" stroke="#ff8a3d" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', columnGap: 8, rowGap: 1, color: 'var(--text-1)' }}>
        {k('fireHud.peak')}<span className="mono">{powerText(s.peakHrr)} · {s.peakTime.toFixed(0)} s</span>
        {k('fireHud.objects')}<span className="mono" data-testid="fire-hud-objects">{t('fireHud.objectsValue', { burning: s.burningObjects, ignited: s.ignitedObjects, out: s.burnedOutObjects })}</span>
        {s.rooms > 0 && <>{k('fireHud.rooms')}<span className="mono">{t('fireHud.roomsValue', { burning: s.roomsBurning, flash: s.flashovers, limited: s.ventLimited })}</span></>}
        {s.rooms > 0 && <>{k('fireHud.roomT')}<span className="mono">{C(s.maxRoomT)}</span></>}
        {k('fireHud.consumed')}<span className="mono">{L.fuelConsumed.toFixed(0)} kg · {energyText(L.released)}</span>
        {k('fireHud.smoke')}<span className="mono">{L.smokeProduced.toFixed(1)} kg{Number.isFinite(s.minVisibility) ? ` · ${t('fireHud.visibility', { S: s.minVisibility.toFixed(1) })}` : ''}</span>
        {(s.charredMembers > 0 || s.fireFailures > 0 || s.windowsBroken > 0) && <>{k('fireHud.structure')}<span className="mono">{t('fireHud.structureValue', { c: s.charredMembers, f: s.fireFailures, w: s.windowsBroken })}</span></>}
        {k('fireHud.residual')}<span className="mono" data-testid="fire-residual">{L.chemResidual.toExponential(1)} J · {L.fuelResidual.toExponential(1)} kg</span>
        {k('fireHud.cost')}<span className="mono">{s.ms.toFixed(2)} ms · {s.items}</span>
      </div>
      {s.ignitions.filter((g) => g.done && g.lit === 0).map((g) => (
        <span key={g.id} style={{ color: '#ffb36b' }}>⚠ {g.name}: {t((g.reason ?? 'fire.reject.noFuel') as MessageKey)}</span>
      ))}
      <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{t('fireHud.note')}</span>
    </div>
  );
}
