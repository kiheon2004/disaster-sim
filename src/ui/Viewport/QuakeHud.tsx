import { useT } from '@/i18n/i18n';
import { useSimStore } from '@/simulation/simStore';
import { useViewStore } from '@/rendering/viewStore';
import { accelColor } from '@/rendering/sim/seismic/quakeColors';
import * as THREE from 'three';

const c = new THREE.Color();

/** Live earthquake readout: ground acceleration at the map center, phase, peak, shaking axis. */
export function QuakeHud() {
  const t = useT();
  const q = useSimStore((s) => s.quake);
  const az = useViewStore((s) => s.azimuthDeg);
  if (!q) return null;
  const color = `#${accelColor(q.accelH, c).getHexString()}`;
  return (
    <div
      style={{
        padding: '8px 10px', borderRadius: 8, background: 'rgba(30,10,8,0.72)', border: `1px solid ${q.active ? color : 'rgba(255,255,255,0.1)'}`,
        backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', gap: 10, minWidth: 170,
      }}
    >
      {/* Principal shaking axis relative to the camera heading. */}
      <svg width="34" height="34" viewBox="0 0 24 24" style={{ transform: `rotate(${q.direction - az}deg)`, opacity: q.active ? 1 : 0.35 }}>
        <path d="M12 2l-4 5h8zM12 22l-4-5h8zM12 7v10" fill={color} stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#ffb3a1' }}>
          {t('quakeHud.title')} M{q.magnitude.toFixed(1)} · {t(`quakeHud.phase.${q.phase}`)}
        </span>
        <span className="mono" style={{ fontSize: 16, fontWeight: 700 }}>
          {q.accelH.toFixed(2)} <span style={{ fontSize: 11, color: 'var(--text-2)' }}>g</span>
          <span style={{ fontSize: 11, color: 'var(--text-2)', marginLeft: 6 }}>{t('quakeHud.peak')} {q.peak.toFixed(2)}g</span>
        </span>
        <span style={{ fontSize: 10.5, color: 'var(--text-2)' }}>
          {t('quakeHud.accel')} · PGA {q.pga.toFixed(2)}g{q.pgaAssumed ? t('cmd.describe.eq.assumed') : ''} · {t('quakeHud.synthetic')}
        </span>
      </div>
    </div>
  );
}
