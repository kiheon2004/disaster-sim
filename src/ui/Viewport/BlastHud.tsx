import { useT, type MessageKey } from '@/i18n/i18n';
import { useSimStore } from '@/simulation/simStore';
import { Icon } from '@/ui/common/Icon';
import { energyText } from '@/phenomena/blastDefinitions';

/**
 * Live air-blast readout (Phase 24): phase, front radius, largest overpressure / impulse felt by an
 * object so far, and the energy ledger (input = near-source + dissipated + in transit + left the world).
 */
export function BlastHud() {
  const t = useT();
  const list = useSimStore((s) => s.blasts);
  if (!list?.length) return null;
  const k = (key: MessageKey) => <span style={{ color: 'var(--text-2)' }}>{t(key)}</span>;
  return (
    <>
      {list.map((b) => (
        <div
          key={b.id}
          data-testid="blast-hud"
          data-phase={b.phase}
          style={{
            padding: '8px 10px', borderRadius: 8, background: 'rgba(36,28,10,0.82)', border: `1px solid ${b.phase === 'propagating' ? '#ffcf5c' : 'rgba(255,255,255,0.1)'}`,
            backdropFilter: 'blur(4px)', display: 'flex', flexDirection: 'column', gap: 3, width: 290, boxSizing: 'border-box', fontSize: 11,
          }}
        >
          <span style={{ fontWeight: 700, color: '#ffcf5c', display: 'flex', alignItems: 'center', gap: 5 }}>
            <Icon name="alert" size={13} /> {t('blastHud.title')} {b.name}
            <span style={{ marginLeft: 'auto', fontWeight: 600 }}>{t(`blastHud.phase.${b.phase}` as MessageKey)}</span>
          </span>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', columnGap: 8, rowGap: 1, color: 'var(--text-1)' }}>
            {k('blastHud.energy')}<span className="mono">{energyText(b.energy)}</span>
            {b.phase !== 'pending' && (<>{k('blastHud.front')}<span className="mono" data-testid="blast-front">{b.front.toFixed(0)} m · {(b.local * 1000).toFixed(0)} ms</span></>)}
            {b.phase === 'pending' && (<>{k('blastHud.in')}<span className="mono">{(-b.local).toFixed(1)} s</span></>)}
            {k('blastHud.peak')}<span className="mono" data-testid="blast-peak">{(b.peak / 1000).toFixed(1)} kPa · {b.impulse.toFixed(0)} Pa·s</span>
            {k('blastHud.reached')}<span className="mono">{b.reached}</span>
          </div>
          {/* Energy ledger as a stacked bar: near-source | shock losses | in transit | left the world. */}
          <div data-testid="blast-ledger" title={`${energyText(b.nearSource)} / ${energyText(b.dissipated)} / ${energyText(b.inTransit)} / ${energyText(b.leftWorld)} · ${t('blastHud.residual')} ${b.residual.toExponential(1)} J`}>
            <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', background: 'rgba(255,255,255,0.08)' }}>
              {[[b.nearSource, '#8a6d3b'], [b.dissipated, '#ec6b23'], [b.inTransit, '#ffcf5c'], [b.leftWorld, '#6aa6d8']].map(([v, c], i) => <div key={i} style={{ width: `${(100 * (v as number)) / Math.max(1, b.energy)}%`, background: c as string }} />)}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, color: 'var(--text-2)', marginTop: 2 }}>
              <span>{t('blastHud.l.near')}</span><span>{t('blastHud.l.diss')}</span><span>{t('blastHud.l.transit')}</span><span>{t('blastHud.l.out')}</span>
            </div>
          </div>
          <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{t('blastHud.note')}</span>
        </div>
      ))}
    </>
  );
}
