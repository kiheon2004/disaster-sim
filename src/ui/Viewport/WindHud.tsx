import { nearestCompass } from '@/core/compass';
import { useT, type MessageKey } from '@/i18n/i18n';
import { useSimStore } from '@/simulation/simStore';
import { useViewStore } from '@/rendering/viewStore';
import { windClass } from '@/simulation/damage/windScale';

/** Current wind readout with an arrow showing the flow direction relative to the camera. */
export function WindHud() {
  const t = useT();
  const wind = useSimStore((s) => s.wind);
  const az = useViewStore((s) => s.azimuthDeg);
  const cls = windClass(wind.speed);
  const active = wind.speed > 0.3;
  // Flow goes toward bearing+180; rotate relative to camera heading.
  const rot = wind.bearing + 180 - az;
  return (
    <div
      style={{
        padding: '8px 10px', borderRadius: 8, background: 'rgba(11,15,20,0.7)', border: '1px solid rgba(255,255,255,0.1)',
        backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', gap: 10, minWidth: 170,
      }}
    >
      <svg width="34" height="34" viewBox="0 0 24 24" style={{ transform: `rotate(${rot}deg)`, opacity: active ? 1 : 0.3, transition: 'transform 0.2s' }}>
        <path d="M12 3v15M12 21l-5-6h10z" fill={cls.color} stroke={cls.color} strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span className="mono" style={{ fontSize: 16, fontWeight: 700 }}>{wind.speed.toFixed(1)} <span style={{ fontSize: 11, color: 'var(--text-2)' }}>m/s</span></span>
        <span style={{ fontSize: 11, color: cls.color, fontWeight: 600 }}>{t(cls.key)}</span>
        {active && (
          <span style={{ fontSize: 10.5, color: 'var(--text-2)' }}>
            {t('wind.hud.from', { dir: t(`compass.${nearestCompass(wind.bearing)}` as MessageKey) })} · {t('wind.gust')} {Math.round(wind.gust * 100)}%
          </span>
        )}
      </div>
    </div>
  );
}
