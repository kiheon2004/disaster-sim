import { useT, type MessageKey } from '@/i18n/i18n';
import { useSimStore } from '@/simulation/simStore';
import { Icon } from '@/ui/common/Icon';

const energyText = (E: number) => (E >= 1e12 ? `${(E / 1e12).toFixed(2)} TJ` : E >= 1e9 ? `${(E / 1e9).toFixed(2)} GJ` : `${(E / 1e6).toFixed(1)} MJ`);

/**
 * Live impact readout (Phase 23): during the entry stage (outside the world) a countdown with the
 * computed altitude and speed; after the impact the energy, crater and ejecta progress.
 */
export function ImpactHud() {
  const t = useT();
  const list = useSimStore((s) => s.impacts);
  if (!list?.length) return null;
  const k = (key: MessageKey) => <span style={{ color: 'var(--text-2)' }}>{t(key)}</span>;
  return (
    <>
      {list.map((m) => (
        <div
          key={m.id}
          data-testid="impact-hud"
          style={{
            padding: '8px 10px', borderRadius: 8, background: 'rgba(40,14,30,0.8)', border: `1px solid ${m.phase === 'entry' ? '#ff8fd0' : 'rgba(255,255,255,0.1)'}`,
            backdropFilter: 'blur(4px)', display: 'flex', flexDirection: 'column', gap: 3, minWidth: 210, fontSize: 11,
          }}
        >
          <span style={{ fontWeight: 700, color: '#ff8fd0', display: 'flex', alignItems: 'center', gap: 5 }}>
            <Icon name="alert" size={13} /> {t('impactHud.title')} {m.name}
            <span style={{ marginLeft: 'auto', fontWeight: 600 }}>{t(`impactHud.phase.${m.phase}` as MessageKey)}</span>
          </span>
          {m.phase === 'entry' && (
            <span className="mono" style={{ fontSize: 15, fontWeight: 700 }} data-testid="impact-countdown">
              T−{m.toImpact.toFixed(1)} s <span style={{ fontSize: 10.5, color: 'var(--text-2)' }}>{(m.altitude / 1000).toFixed(1)} km · {(m.speed / 1000).toFixed(2)} km/s</span>
            </span>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', columnGap: 10, rowGap: 1, color: 'var(--text-1)' }}>
            {m.phase === 'airburst' ? (
              <>{k('impactHud.airburst')}<span className="mono">{(m.airburstAltitude / 1000).toFixed(1)} km</span></>
            ) : (
              <>
                {k('impactHud.energy')}<span className="mono">{energyText(m.energy)} (TNT {m.tnt.toFixed(2)} t)</span>
                {m.craterD > 0 && (<>{k('impactHud.crater')}<span className="mono">⌀ {m.craterD.toFixed(1)} m · {m.depth.toFixed(1)} m · {t(m.regime === 'gravity' ? 'impact.regime.gravity' : 'impact.regime.strength')}</span></>)}
                {m.parcels > 0 && (<>{k('impactHud.ejecta')}<span className="mono">{m.landed}/{m.parcels} · {(m.ejectaMass / 1000).toFixed(1)} t ({t('impactHud.out')} {(m.outflowMass / 1000).toFixed(1)} t)</span></>)}
              </>
            )}
          </div>
          <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{t('impactHud.note')}</span>
        </div>
      ))}
    </>
  );
}
