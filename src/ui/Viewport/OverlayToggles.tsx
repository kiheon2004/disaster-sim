import { useT } from '@/i18n/i18n';
import { useViewStore } from '@/rendering/viewStore';
import { WIND_COLOR_STOPS } from '@/rendering/sim/windColors';
import { DAMAGE_STATE_COLORS, DAMAGE_STATE_IDS } from '@/simulation/damage/DamageState';
import { Toggle } from '@/ui/common/fields';
import { Segmented } from '@/ui/common/Segmented';

/** Simulation view options: damage colors, wind visualization (mode, height, legend). */
export function OverlayToggles() {
  const t = useT();
  const showDamage = useViewStore((s) => s.showDamage);
  const showWind = useViewStore((s) => s.showWind);
  const windViz = useViewStore((s) => s.windViz);
  const arrowHeight = useViewStore((s) => s.arrowHeight);
  const v = useViewStore.getState();
  const gradient = `linear-gradient(90deg, ${WIND_COLOR_STOPS.map(([s, c]) => `${c} ${(s / 60) * 100}%`).join(', ')})`;
  return (
    <div
      style={{
        padding: '8px 10px', borderRadius: 8, background: 'rgba(11,15,20,0.78)', border: '1px solid rgba(255,255,255,0.1)',
        backdropFilter: 'blur(4px)', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, width: 262,
      }}
    >
      <Toggle checked={showDamage} onChange={() => v.toggleDamage()} label={t('overlay.damage')} />
      {showDamage && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingLeft: 38 }}>
          {DAMAGE_STATE_IDS.slice(1).map((id, i) => (
            <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--text-1)', fontSize: 11 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: DAMAGE_STATE_COLORS[(i + 1) as 1] }} />
              {t(`damage.${id}`)}
            </span>
          ))}
        </div>
      )}
      <Toggle checked={showWind} onChange={() => v.toggleWind()} label={t('overlay.wind')} />
      {showWind && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 38 }}>
          <Segmented
            size="small"
            value={windViz}
            onChange={(m) => v.setWindViz(m)}
            options={[
              { value: 'arrows', label: t('overlay.viz.arrows') },
              { value: 'particles', label: t('overlay.viz.particles') },
              { value: 'both', label: t('overlay.viz.both') },
            ]}
          />
          {windViz !== 'particles' && (
            <Segmented
              size="small"
              value={arrowHeight}
              onChange={(h) => v.setArrowHeight(h)}
              options={[3, 10, 25].map((h) => ({ value: h, label: `${t('overlay.height')} ${h}m` }))}
            />
          )}
          <div>
            <div style={{ height: 6, borderRadius: 3, background: gradient }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-2)', marginTop: 2 }}>
              <span>0</span><span>25</span><span>45</span><span>60+ m/s</span>
            </div>
          </div>
          <span style={{ fontSize: 10.5, color: 'var(--text-3)', lineHeight: 1.35 }}>{t('overlay.viz.note')}</span>
        </div>
      )}
    </div>
  );
}
