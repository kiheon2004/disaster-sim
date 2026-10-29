import { useT } from '@/i18n/i18n';
import { useSimStore } from '@/simulation/simStore';
import { Icon } from '@/ui/common/Icon';

/** Live terrain deformation readout (Phase 21): size of the field, water moved with the bed, update cost. */
export function DeformHud() {
  const t = useT();
  const d = useSimStore((s) => s.deform);
  if (!d) return null;
  const k = (key: Parameters<typeof t>[0]) => <span style={{ color: 'var(--text-2)' }}>{t(key)}</span>;
  return (
    <div
      data-testid="deform-hud"
      style={{
        padding: '8px 10px', borderRadius: 8, background: 'rgba(32,22,8,0.78)', border: `1px solid ${d.changing > 0 ? '#e0a64a' : 'rgba(255,255,255,0.1)'}`,
        backdropFilter: 'blur(4px)', display: 'flex', flexDirection: 'column', gap: 3, minWidth: 190, fontSize: 11,
      }}
    >
      <span style={{ fontWeight: 700, color: '#ffd9a0', display: 'flex', alignItems: 'center', gap: 5 }}>
        <Icon name="terrain" size={13} /> {t('deformHud.title')}
        <span style={{ marginLeft: 'auto', fontWeight: 600 }}>{t(d.changing > 0 ? 'deformHud.moving' : 'deformHud.settled')}</span>
      </span>
      <span className="mono" style={{ fontSize: 15, fontWeight: 700 }}>
        {d.maxAbs.toFixed(2)} <span style={{ fontSize: 10.5, color: 'var(--text-2)' }}>m {t('deformHud.max')}</span>
      </span>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', columnGap: 10, rowGap: 1, color: 'var(--text-1)' }}>
        {k('deformHud.sources')}<span className="mono">{d.sources}</span>
        {k('deformHud.volume')}<span className="mono">{d.volume >= 0 ? '+' : '−'}{Math.abs(d.volume).toFixed(0)} m³</span>
        {d.bedVolume > 0 && (<>{k('deformHud.bed')}<span className="mono">{d.bedVolume.toFixed(1)} m³</span></>)}
        {k('deformHud.cost')}<span className="mono">{(d.fieldMs + d.colliderMs + d.waterMs + d.responseMs).toFixed(2)} ms ({t('deformHud.collider')} {d.colliderMs.toFixed(2)})</span>
      </div>
    </div>
  );
}
