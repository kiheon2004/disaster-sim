import { useT } from '@/i18n/i18n';
import { useViewStore } from '@/rendering/viewStore';
import { DAMAGE_STATE_COLORS, DAMAGE_STATE_IDS } from '@/simulation/damage/DamageState';
import { Toggle } from '@/ui/common/fields';

/** Simulation view options + damage color legend. */
export function OverlayToggles() {
  const t = useT();
  const showDamage = useViewStore((s) => s.showDamage);
  const showWind = useViewStore((s) => s.showWind);
  return (
    <div
      style={{
        padding: '8px 10px', borderRadius: 8, background: 'rgba(11,15,20,0.72)', border: '1px solid rgba(255,255,255,0.1)',
        backdropFilter: 'blur(4px)', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12,
      }}
    >
      <Toggle checked={showDamage} onChange={() => useViewStore.getState().toggleDamage()} label={t('overlay.damage')} />
      {showDamage && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingLeft: 38, maxWidth: 260 }}>
          {DAMAGE_STATE_IDS.slice(1).map((id, i) => (
            <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--text-1)', fontSize: 11 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: DAMAGE_STATE_COLORS[(i + 1) as 1] }} />
              {t(`damage.${id}`)}
            </span>
          ))}
        </div>
      )}
      <Toggle checked={showWind} onChange={() => useViewStore.getState().toggleWind()} label={t('overlay.wind')} />
    </div>
  );
}
