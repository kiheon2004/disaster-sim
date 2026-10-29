import { useT, type MessageKey } from '@/i18n/i18n';
import { useSimStore } from '@/simulation/simStore';
import { Icon } from '@/ui/common/Icon';

/**
 * Live structural destruction readout (Phase 25): buildings collapsing now, falling blocks, collapse
 * classes, fragments (moving / at rest), rubble and the mass balance of every collapse model.
 */
export function StructureHud() {
  const t = useT();
  const s = useSimStore((x) => x.structure);
  if (!s || s.models === 0) return null;
  const k = (key: MessageKey) => <span style={{ color: 'var(--text-2)' }}>{t(key)}</span>;
  return (
    <div
      data-testid="structure-hud"
      style={{
        padding: '8px 10px', borderRadius: 8, background: 'rgba(24,18,36,0.82)', border: `1px solid ${s.fallingBlocks > 0 ? '#c9b8ff' : 'rgba(255,255,255,0.1)'}`,
        backdropFilter: 'blur(4px)', display: 'flex', flexDirection: 'column', gap: 3, width: 290, boxSizing: 'border-box', fontSize: 11,
      }}
    >
      <span style={{ fontWeight: 700, color: '#c9b8ff', display: 'flex', alignItems: 'center', gap: 5 }}>
        <Icon name="alert" size={13} /> {t('structHud.title')}
        <span style={{ marginLeft: 'auto', fontWeight: 600 }}>{s.fallingBlocks > 0 ? t('structHud.collapsing') : s.active > 0 ? t('structHud.active') : t('structHud.quiet')}</span>
      </span>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', columnGap: 8, rowGap: 1, color: 'var(--text-1)' }}>
        {k('structHud.blocks')}<span className="mono" data-testid="struct-blocks">{s.fallingBlocks}</span>
        {k('structHud.classes')}<span className="mono">{s.local} / {s.partial} / {s.global}</span>
        {k('structHud.members')}<span className="mono">{s.failedMembers}</span>
        {k('structHud.fragments')}<span className="mono">{s.fragmentsMoving} / {s.fragments}{s.aggregated > 0 ? ` (+${(s.aggregated / 1000).toFixed(1)} t)` : ''}</span>
        {k('structHud.rubble')}<span className="mono">{(s.rubbleMass / 1000).toFixed(1)} t · {s.heaps}</span>
        {k('structHud.secondary')}<span className="mono">{s.secondary}</span>
        {k('structHud.residual')}<span className="mono" data-testid="struct-residual">{s.residual.toExponential(1)} kg</span>
      </div>
      <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{t('structHud.note')}</span>
    </div>
  );
}
