import { useT, type MessageKey } from '@/i18n/i18n';
import { BOUNDARY_SIDES } from '@/core/model';
import { useSimStore } from '@/simulation/simStore';
import { Icon } from '@/ui/common/Icon';

const fmtArea = (m2: number) => (m2 >= 10000 ? `${(m2 / 10000).toFixed(2)} ha` : `${Math.round(m2)} m²`);
const fmtVol = (m3: number) => (m3 >= 10000 ? `${(m3 / 1000).toFixed(1)}k m³` : `${m3.toFixed(m3 < 10 ? 2 : 0)} m³`);

/** Live water readout (Phase 14): inputs (rain, sources, edges) and the state of the water. */
export function FloodHud() {
  const t = useT();
  const f = useSimStore((s) => s.flood);
  if (!f) return null;
  const edges = BOUNDARY_SIDES.filter((s) => f.boundaries[s]?.type === 'fixedLevel');
  return (
    <div
      data-testid="flood-hud"
      style={{
        padding: '8px 10px', borderRadius: 8, background: 'rgba(6,18,32,0.78)', border: `1px solid ${f.rain > 0 || f.sources > 0 ? '#46a0e6' : 'rgba(255,255,255,0.1)'}`,
        backdropFilter: 'blur(4px)', display: 'flex', flexDirection: 'column', gap: 3, minWidth: 190, fontSize: 11,
      }}
    >
      <span style={{ fontWeight: 700, color: '#9fd3ff', display: 'flex', alignItems: 'center', gap: 5 }}>
        <Icon name="water" size={13} /> {t('floodHud.title')}
        {f.rain > 0 && <span style={{ marginLeft: 'auto', fontWeight: 600 }}><Icon name="rain" size={12} /> {f.rain.toFixed(f.rain < 10 ? 1 : 0)} mm/h</span>}
      </span>
      <span className="mono" style={{ fontSize: 15, fontWeight: 700 }}>
        {f.maxDepth.toFixed(2)} <span style={{ fontSize: 10.5, color: 'var(--text-2)' }}>m {t('floodHud.maxDepth')}</span>
      </span>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', columnGap: 10, rowGap: 1, color: 'var(--text-1)' }}>
        <span style={{ color: 'var(--text-2)' }}>{t('floodHud.area')}</span><span className="mono">{fmtArea(f.floodedArea)}</span>
        <span style={{ color: 'var(--text-2)' }}>{t('floodHud.volume')}</span><span className="mono">{fmtVol(f.volume)}</span>
        <span style={{ color: 'var(--text-2)' }}>{t('floodHud.maxSpeed')}</span><span className="mono">{f.maxSpeed.toFixed(2)} m/s</span>
        {f.sources > 0 && (<><span style={{ color: 'var(--text-2)' }}>{t('floodHud.inflow')}</span><span className="mono">{f.sources.toFixed(2)} m³/s</span></>)}
        {edges.length > 0 && (
          <>
            <span style={{ color: 'var(--text-2)' }}>{t('floodHud.edges')}</span>
            <span className="mono">{edges.map((s) => `${t(`side.${s}` as MessageKey)} ${f.boundaries[s]!.level!.toFixed(2)}m${f.boundaries[s]!.event ? '↑' : ''}`).join(' · ')}</span>
          </>
        )}
        <span style={{ color: 'var(--text-2)' }}>{t('floodHud.mass')}</span><span className="mono">{f.relativeError.toExponential(1)}</span>
      </div>
    </div>
  );
}
