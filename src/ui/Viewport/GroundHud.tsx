import { useT, type MessageKey } from '@/i18n/i18n';
import { useSimStore } from '@/simulation/simStore';
import { Icon } from '@/ui/common/Icon';

const fsText = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '∞');

/**
 * Live ground-failure readout (Phase 22): state of every sinkhole and landslide, the sediment
 * budget (released = moving + deposited + out of the world, with the residual shown so the
 * conservation is visible), blocked roads and the update cost.
 */
export function GroundHud() {
  const t = useT();
  const g = useSimStore((s) => s.ground);
  if (!g) return null;
  const moving = g.mobile > 0.5;
  const k = (key: MessageKey) => <span style={{ color: 'var(--text-2)' }}>{t(key)}</span>;
  return (
    <div
      data-testid="ground-hud"
      style={{
        padding: '8px 10px', borderRadius: 8, background: 'rgba(36,24,12,0.8)', border: `1px solid ${moving ? '#d9773a' : 'rgba(255,255,255,0.1)'}`,
        backdropFilter: 'blur(4px)', display: 'flex', flexDirection: 'column', gap: 3, minWidth: 210, fontSize: 11,
      }}
    >
      <span style={{ fontWeight: 700, color: '#ffc58f', display: 'flex', alignItems: 'center', gap: 5 }}>
        <Icon name="soil" size={13} /> {t('groundHud.title')}
        <span style={{ marginLeft: 'auto', fontWeight: 600 }}>{t(moving ? 'groundHud.moving' : 'groundHud.still')}</span>
      </span>
      {g.sinkholes.map((s) => (
        <span key={s.id} className="mono" data-testid="ground-hud-sinkhole">
          {s.name} · {t(`groundHud.phase.${s.phase}` as MessageKey)} · a {s.radius.toFixed(1)} m · FS {fsText(s.fs)}{s.pitDepth > 0.05 ? ` · ↓${s.pitDepth.toFixed(2)} m` : ''}
        </span>
      ))}
      {g.landslides.map((s) => (
        <span key={s.id} className="mono" data-testid="ground-hud-landslide">
          {s.name} · FS<sub>min</sub> {fsText(s.minFS)} · {t('groundHud.failed', { n: s.failed, total: s.cells })}{s.newmark > 0.001 ? ` · D ${(s.newmark * 100).toFixed(1)} cm` : ''}
        </span>
      ))}
      <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', columnGap: 10, rowGap: 1, color: 'var(--text-1)', marginTop: 2 }}>
        {k('groundHud.released')}<span className="mono">{g.released.toFixed(1)} m³</span>
        {k('groundHud.mobile')}<span className="mono">{g.mobile.toFixed(1)} m³ ({t('groundHud.peak')} {g.peakMobile.toFixed(0)})</span>
        {k('groundHud.deposited')}<span className="mono">{g.deposited.toFixed(1)} m³</span>
        {g.outflow > 0 && (<>{k('groundHud.outflow')}<span className="mono">{g.outflow.toFixed(1)} m³</span></>)}
        {g.intoCavity > 0 && (<>{k('groundHud.cavity')}<span className="mono">{g.intoCavity.toFixed(1)} m³</span></>)}
        {k('groundHud.residual')}<span className="mono">{g.residual.toExponential(1)} m³</span>
        {k('groundHud.speed')}<span className="mono">{g.maxSpeed.toFixed(1)} m/s</span>
        {g.blockedRoads > 0 && (<>{k('groundHud.roads')}<span className="mono" style={{ color: '#ff8a65' }}>{g.blockedRoads}</span></>)}
        {k('groundHud.cost')}<span className="mono">{g.ms.toFixed(2)} ms ({t('groundHud.flow')} {g.flowMs.toFixed(2)} · {g.substeps})</span>
      </div>
    </div>
  );
}
