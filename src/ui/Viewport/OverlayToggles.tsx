import { useT } from '@/i18n/i18n';
import { useViewStore } from '@/rendering/viewStore';
import { WIND_COLOR_STOPS } from '@/rendering/sim/windColors';
import { DAMAGE_STATE_COLORS, DAMAGE_STATE_IDS } from '@/simulation/damage/DamageState';
import { Toggle } from '@/ui/common/fields';
import { Segmented } from '@/ui/common/Segmented';
import { QUAKE_EXAGGERATIONS, DEFORM_EXAGGERATIONS } from '@/rendering/viewStore';
import { DISPLACEMENT_GRADIENT, displacementScale } from '@/rendering/deformation/deformColors';
import { useSimStore } from '@/simulation/simStore';
import { DEPOSIT_GRADIENT, DEPOSIT_MAX, FS_GRADIENT, SEDIMENT_GRADIENT, SEDIMENT_MAX } from '@/rendering/ground/groundColors';
import { accelGradient } from '@/rendering/sim/seismic/quakeColors';
import { cssGradient, DEPTH_MAX, DEPTH_STOPS, SPEED_MAX, SPEED_STOPS } from '@/rendering/sim/water/waterColors';

/** Simulation view options: damage colors, wind visualization (mode, height, legend). */
export function OverlayToggles() {
  const t = useT();
  const showDamage = useViewStore((s) => s.showDamage);
  const showWind = useViewStore((s) => s.showWind);
  const windViz = useViewStore((s) => s.windViz);
  const arrowHeight = useViewStore((s) => s.arrowHeight);
  const v = useViewStore.getState();
  const quake = useViewStore((s) => s.quakeViz);
  const hasQuake = useSimStore((s) => s.quake !== null);
  const hasFlood = useSimStore((s) => s.flood !== null);
  const flood = useViewStore((s) => s.floodViz);
  const deform = useViewStore((s) => s.deformViz);
  const deformLive = useSimStore((s) => s.deform);
  const groundLive = useSimStore((s) => s.ground !== null);
  const ground = useViewStore((s) => s.groundViz);
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
      {hasFlood && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#9fd3ff', marginTop: 2 }}>{t('overlay.flood')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 2 }} data-testid="flood-overlay">
            <Segmented
              size="small"
              value={flood.mode}
              onChange={(m) => v.setFloodViz({ mode: m })}
              options={[
                { value: 'normal', label: t('overlay.flood.normal') },
                { value: 'depth', label: t('overlay.flood.depth') },
                { value: 'flow', label: t('overlay.flood.flow') },
                { value: 'speed', label: t('overlay.flood.speed') },
              ]}
            />
            <Toggle checked={flood.arrows} onChange={(b) => v.setFloodViz({ arrows: b })} label={t('overlay.flood.arrows')} />
            {(flood.mode === 'depth' || flood.mode === 'normal') && (
              <div>
                <div style={{ height: 6, borderRadius: 3, background: flood.mode === 'depth' ? cssGradient(DEPTH_STOPS, DEPTH_MAX) : 'linear-gradient(90deg, #6fb7cf, #0b2d55)' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-2)', marginTop: 2 }}>
                  <span>0</span><span>0.5</span><span>1.2</span><span>2</span><span>3+ m</span>
                </div>
              </div>
            )}
            {(flood.mode === 'speed' || flood.mode === 'flow' || flood.arrows) && (
              <div>
                <div style={{ height: 6, borderRadius: 3, background: cssGradient(SPEED_STOPS, SPEED_MAX) }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-2)', marginTop: 2 }}>
                  <span>0</span><span>0.8</span><span>1.5</span><span>2.2</span><span>3+ m/s</span>
                </div>
              </div>
            )}
            <span style={{ fontSize: 10.5, color: 'var(--text-3)', lineHeight: 1.35 }}>{t('overlay.flood.note')}</span>
          </div>
        </>
      )}
      {deformLive && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#ffd9a0', marginTop: 2 }}>{t('overlay.deform')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 2 }} data-testid="deform-overlay">
            <Segmented
              size="small"
              value={deform.mode}
              onChange={(m) => v.setDeformViz({ mode: m })}
              options={(['off', 'displacement', 'original', 'vectors'] as const).map((m) => ({ value: m, label: t(`overlay.deform.${m}`) }))}
            />
            {deform.mode === 'displacement' && (
              <div>
                <div style={{ height: 6, borderRadius: 3, background: DISPLACEMENT_GRADIENT }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-2)', marginTop: 2 }}>
                  <span>−{displacementScale(deformLive.maxAbs)} m</span><span>0</span><span>+{displacementScale(deformLive.maxAbs)} m</span>
                </div>
              </div>
            )}
            {deform.mode === 'original' && <span style={{ fontSize: 10.5, color: 'var(--text-2)' }}>{t('overlay.deform.originalNote')}</span>}
            {deform.mode === 'vectors' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{t('overlay.deform.exaggeration')}</span>
                <Segmented size="small" value={deform.exaggeration} onChange={(e) => v.setDeformViz({ exaggeration: e })} options={DEFORM_EXAGGERATIONS.map((e) => ({ value: e, label: `×${e}` }))} />
              </div>
            )}
            {deform.mode !== 'off' && <Toggle checked={deform.foundations} onChange={(b) => v.setDeformViz({ foundations: b })} label={t('overlay.deform.foundations')} />}
            {deform.mode !== 'off' && deform.foundations && <span style={{ fontSize: 10.5, color: 'var(--text-2)' }}>{t('overlay.deform.contact')}</span>}
            <span style={{ fontSize: 10.5, color: 'var(--text-3)', lineHeight: 1.35 }}>{t('overlay.deform.note')}</span>
          </div>
        </>
      )}
      {groundLive && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#ffc58f', marginTop: 2 }}>{t('overlay.ground')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 2 }} data-testid="ground-overlay">
            <Segmented
              size="small"
              value={ground.mode}
              onChange={(m) => v.setGroundViz({ mode: m })}
              options={(['off', 'stability', 'sediment', 'deposit', 'change'] as const).map((m) => ({ value: m, label: t(`overlay.ground.${m}`) }))}
            />
            {ground.mode === 'stability' && (
              <div>
                <div style={{ height: 6, borderRadius: 3, background: FS_GRADIENT }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-2)', marginTop: 2 }}>
                  <span>FS 0.8</span><span>1.0</span><span>1.2</span><span>1.5</span><span>2.5+</span>
                </div>
                <span style={{ fontSize: 10.5, color: 'var(--text-2)' }}>{t('overlay.ground.stabilityNote')}</span>
              </div>
            )}
            {(ground.mode === 'sediment' || ground.mode === 'deposit') && (
              <div>
                <div style={{ height: 6, borderRadius: 3, background: ground.mode === 'sediment' ? SEDIMENT_GRADIENT : DEPOSIT_GRADIENT }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-2)', marginTop: 2 }}>
                  <span>0</span><span>{(ground.mode === 'sediment' ? SEDIMENT_MAX : DEPOSIT_MAX)}+ m</span>
                </div>
              </div>
            )}
            {ground.mode === 'change' && <span style={{ fontSize: 10.5, color: 'var(--text-2)' }}>{t('overlay.ground.changeNote')}</span>}
            <Toggle checked={ground.arrows} onChange={(b) => v.setGroundViz({ arrows: b })} label={t('overlay.ground.arrows')} />
            <Toggle checked={ground.sources} onChange={(b) => v.setGroundViz({ sources: b })} label={t('overlay.ground.sources')} />
            <Toggle checked={ground.dust} onChange={(b) => v.setGroundViz({ dust: b })} label={t('overlay.ground.dust')} />
            <span style={{ fontSize: 10.5, color: 'var(--text-3)', lineHeight: 1.35 }}>{t('overlay.ground.note')}</span>
          </div>
        </>
      )}
      {hasQuake && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#ffb3a1', marginTop: 2 }}>{t('overlay.quake')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 2 }}>
            <Toggle checked={quake.ground} onChange={(b) => v.setQuakeViz({ ground: b })} label={t('overlay.quake.ground')} />
            <Toggle checked={quake.arrows} onChange={(b) => v.setQuakeViz({ arrows: b })} label={t('overlay.quake.arrows')} />
            <Toggle checked={quake.stress} onChange={(b) => v.setQuakeViz({ stress: b })} label={t('overlay.quake.stress')} />
            <Toggle checked={quake.epicenter} onChange={(b) => v.setQuakeViz({ epicenter: b })} label={t('overlay.quake.epicenter')} />
            <Toggle checked={quake.cameraShake} onChange={(b) => v.setQuakeViz({ cameraShake: b })} label={t('overlay.quake.cameraShake')} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{t('overlay.quake.exaggeration')}</span>
              <Segmented
                size="small"
                value={quake.exaggeration}
                onChange={(k) => v.setQuakeViz({ exaggeration: k })}
                options={QUAKE_EXAGGERATIONS.map((k) => ({ value: k, label: `${k}×` }))}
              />
            </div>
            <div>
              <div style={{ height: 6, borderRadius: 3, background: accelGradient() }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-2)', marginTop: 2 }}>
                <span>0</span><span>0.2</span><span>0.4</span><span>0.7</span><span>1.2 g</span>
              </div>
            </div>
            <span style={{ fontSize: 10.5, color: 'var(--text-3)', lineHeight: 1.35 }}>{t('overlay.quake.note')}</span>
          </div>
        </>
      )}
    </div>
  );
}
