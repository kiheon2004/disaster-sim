import { useMemo } from 'react';
import { ATMOS_OVERLAYS, CLIMATE_OVERLAYS, type AtmosOverlay, type ClimateOverlay } from '@/rendering/viewStore';
import { climateGradient, climateLabels } from '@/rendering/climate/climateColors';
import { GRAVITY_OVERLAYS, gravityGradient, gravityLabels, type GravityOverlay } from '@/rendering/gravity/gravityColors';
import { CELESTIAL_OVERLAYS, celestialGradient, celestialLabels, type CelestialOverlay } from '@/rendering/celestial/celestialColors';
import { atmosGradient, atmosLabels } from '@/rendering/atmosphere/atmosColors';
import { useT, type MessageKey } from '@/i18n/i18n';
import { useViewStore } from '@/rendering/viewStore';
import { WIND_COLOR_STOPS } from '@/rendering/sim/windColors';
import { DAMAGE_STATE_COLORS, DAMAGE_STATE_IDS } from '@/simulation/damage/DamageState';
import { Toggle } from '@/ui/common/fields';
import { Segmented } from '@/ui/common/Segmented';
import { QUAKE_EXAGGERATIONS, DEFORM_EXAGGERATIONS, FRAGMENT_SCALES, FRONT_GLOWS } from '@/rendering/viewStore';
import { ARRIVAL_GRADIENT, cssLogGradient, IMPULSE_STOPS, PRESSURE_STOPS } from '@/rendering/blast/blastColors';
import { DISPLACEMENT_GRADIENT, displacementScale } from '@/rendering/deformation/deformColors';
import { FACTOR_GRADIENT, TEMPERATURE_GRADIENT, THERMAL_SCALES, UTIL_GRADIENT } from '@/rendering/thermal/thermalColors';
import { useSimStore } from '@/simulation/simStore';
import { simulationController } from '@/simulation/SimulationController';
import { INJURY_LEVELS } from '@/human/injury';
import { LEVEL_COLORS } from '@/ui/Inspector/HumanInspector';
import { FUEL_GRADIENT, HRR_GRADIENT, ROOM_COLORS, STATE_COLORS, VISIBILITY_GRADIENT } from '@/rendering/fire/fireColors';
import { FIRE_STATES } from '@/fire/FireWorld';
import { GLOW_GRADIENT, OVERLAY_SCALE, overlayGradient } from '@/rendering/volcano/volcanoColors';
import { VOLCANO_OVERLAYS } from '@/rendering/viewStore';
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
  const impactLive = useSimStore((s) => s.impacts !== null);
  const impact = useViewStore((s) => s.impactViz);
  const blastLive = useSimStore((s) => s.blasts !== null);
  const blast = useViewStore((s) => s.blastViz);
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
      {impactLive && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#ff8fd0', marginTop: 2 }}>{t('overlay.impact')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 2 }} data-testid="impact-overlay">
            <Toggle checked={impact.trajectory} onChange={(b) => v.setImpactViz({ trajectory: b })} label={t('overlay.impact.trajectory')} />
            <Toggle checked={impact.ejecta} onChange={(b) => v.setImpactViz({ ejecta: b })} label={t('overlay.impact.ejecta')} />
            <Toggle checked={impact.trails} onChange={(b) => v.setImpactViz({ trails: b })} label={t('overlay.impact.trails')} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{t('overlay.impact.fragmentScale')}</span>
              <Segmented size="small" value={impact.fragmentScale} onChange={(k) => v.setImpactViz({ fragmentScale: k })} options={FRAGMENT_SCALES.map((k) => ({ value: k, label: `×${k}` }))} />
            </div>
            <Toggle checked={impact.flash} onChange={(b) => v.setImpactViz({ flash: b })} label={t('overlay.impact.flash')} />
            <Toggle checked={impact.dust} onChange={(b) => v.setImpactViz({ dust: b })} label={t('overlay.impact.dust')} />
            <span style={{ fontSize: 10.5, color: 'var(--text-3)', lineHeight: 1.35 }}>{t('overlay.impact.note')}</span>
          </div>
        </>
      )}
      {blastLive && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#ffcf5c', marginTop: 2 }}>{t('overlay.blast')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 2 }} data-testid="blast-overlay">
            <Segmented
              size="small"
              value={blast.field}
              onChange={(m) => v.setBlastViz({ field: m })}
              options={(['off', 'current', 'peak', 'arrival', 'impulse'] as const).map((m) => ({ value: m, label: t(`overlay.blast.${m}`) }))}
            />
            {(blast.field === 'current' || blast.field === 'peak') && (
              <div>
                <div style={{ height: 6, borderRadius: 3, background: cssLogGradient(PRESSURE_STOPS) }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-2)', marginTop: 2 }}>
                  <span>0.1</span><span>1</span><span>3</span><span>10</span><span>30</span><span>100 kPa</span>
                </div>
                {blast.field === 'current' && <span style={{ fontSize: 10.5, color: 'var(--text-2)' }}>{t('overlay.blast.suction')}</span>}
              </div>
            )}
            {blast.field === 'impulse' && (
              <div>
                <div style={{ height: 6, borderRadius: 3, background: cssLogGradient(IMPULSE_STOPS) }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-2)', marginTop: 2 }}>
                  <span>1</span><span>10</span><span>100</span><span>1000 Pa·s</span>
                </div>
              </div>
            )}
            {blast.field === 'arrival' && (
              <div>
                <div style={{ height: 6, borderRadius: 3, background: ARRIVAL_GRADIENT }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-2)', marginTop: 2 }}>
                  <span>{t('overlay.blast.early')}</span><span>{t('overlay.blast.late')}</span>
                </div>
              </div>
            )}
            <Toggle checked={blast.front} onChange={(b) => v.setBlastViz({ front: b })} label={t('overlay.blast.front')} />
            {blast.front && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{t('overlay.blast.glow')}</span>
                <Segmented size="small" value={blast.frontGlow} onChange={(k) => v.setBlastViz({ frontGlow: k })} options={FRONT_GLOWS.map((k) => ({ value: k, label: `×${k}` }))} />
              </div>
            )}
            <Toggle checked={blast.vectors} onChange={(b) => v.setBlastViz({ vectors: b })} label={t('overlay.blast.vectors')} />
            <Toggle checked={blast.objects} onChange={(b) => v.setBlastViz({ objects: b })} label={t('overlay.blast.objects')} />
            <Toggle checked={blast.flash} onChange={(b) => v.setBlastViz({ flash: b })} label={t('overlay.blast.flash')} />
            <span style={{ fontSize: 10.5, color: 'var(--text-3)', lineHeight: 1.35 }}>{t('overlay.blast.note')}</span>
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
      <ThermalToggles />
      <VolcanoToggles />
      <AtmosphereToggles />
      <GravityToggles />
      <CelestialToggles />
      <HumanToggles />
      <ClimateToggles />
      <FireToggles />
      <StructureToggles />
    </div>
  );
}

/** Structural destruction views (Phase 25): shown when the run has modular buildings. */
function StructureToggles() {
  const t = useT();
  const live = useSimStore((s) => s.structure);
  const viz = useViewStore((s) => s.structureViz);
  const set = useViewStore.getState().setStructureViz;
  if (!live) return null;
  return (
    <>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#c9b8ff', marginTop: 2 }}>{t('overlay.struct')}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 2 }} data-testid="structure-overlay">
        <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{t('overlay.struct.colorLabel')}</span>
        <Segmented
          size="small"
          value={viz.color}
          onChange={(c) => set({ color: c })}
          ariaLabel={t('overlay.struct.colorLabel')}
          options={(['normal', 'demand', 'failure', 'sequence'] as const).map((c) => ({ value: c, label: t(`overlay.struct.colorShort.${c}`), title: t(`overlay.struct.color.${c}`) }))}
        />
        {viz.color === 'demand' && (
          <div>
            <div style={{ height: 6, borderRadius: 3, background: 'linear-gradient(90deg, #3fbf7f, #f2c94c 50%, #e0443a)' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-2)', marginTop: 2 }}>
              <span>0</span><span>{t('overlay.struct.demandMid')}</span><span>{t('overlay.struct.demandFail')}</span>
            </div>
          </div>
        )}
        {viz.color === 'sequence' && <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{t('overlay.struct.sequenceNote')}</span>}
        <Toggle checked={viz.loadPath} onChange={(b) => set({ loadPath: b })} label={t('overlay.struct.loadPath')} />
        <Toggle checked={viz.connections} onChange={(b) => set({ connections: b })} label={t('overlay.struct.connections')} />
        <Toggle checked={viz.support} onChange={(b) => set({ support: b })} label={t('overlay.struct.support')} />
        <Toggle checked={viz.debris} onChange={(b) => set({ debris: b })} label={t('overlay.struct.debris')} />
        <Toggle checked={viz.rubble} onChange={(b) => set({ rubble: b })} label={t('overlay.struct.rubble')} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{t('overlay.struct.dust')}</span>
          <Segmented size="small" value={viz.dust} onChange={(d) => set({ dust: d })} options={[0, 1, 2].map((d) => ({ value: d, label: d === 0 ? t('overlay.struct.off') : `${d}×` }))} />
        </div>
        <span style={{ fontSize: 10.5, color: 'var(--text-3)', lineHeight: 1.35 }}>{t('overlay.struct.note')}</span>
      </div>
    </>
  );
}

/** Fire views (Phase 27): shown once the combustion model runs. Visual effects are labelled as such. */
function FireToggles() {
  const t = useT();
  const live = useSimStore((s) => s.fire);
  const hasModular = useSimStore((s) => (s.structure?.modular ?? 0) > 0);
  const viz = useViewStore((s) => s.fireViz);
  const color = useViewStore((s) => s.structureViz.color);
  const set = useViewStore.getState().setFireViz;
  if (!live) return null;
  return (
    <>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#ff8a3d', marginTop: 2 }}>{t('overlay.fire')}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 2 }} data-testid="fire-overlay">
        <Toggle checked={viz.flames} onChange={(b) => set({ flames: b })} label={t('overlay.fire.flames')} />
        <Toggle checked={viz.smoke} onChange={(b) => set({ smoke: b })} label={t('overlay.fire.smoke')} />
        <Toggle checked={viz.glow} onChange={(b) => set({ glow: b })} label={t('overlay.fire.glow')} />
        <Toggle checked={viz.embers} onChange={(b) => set({ embers: b })} label={t('overlay.fire.embers')} />
        <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{t('overlay.fire.overlay')}</span>
        <Segmented size="small" value={viz.overlay} onChange={(o) => set({ overlay: o })} ariaLabel={t('overlay.fire.overlay')}
          options={(['off', 'state', 'fuel', 'hrr', 'smoke', 'rooms'] as const).map((o) => ({ value: o, label: t(`overlay.fire.o.${o}`), title: t(`overlay.fire.ot.${o}`) }))} />
        {viz.overlay === 'state' && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 8px', fontSize: 10, color: 'var(--text-2)' }} data-testid="fire-legend">
            {FIRE_STATES.map((st, k) => <span key={st}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: STATE_COLORS[k], marginRight: 3 }} />{t(`fire.state.${st}`)}</span>)}
          </div>
        )}
        {viz.overlay === 'fuel' && <Legend gradient={FUEL_GRADIENT} labels={['0 %', '50 %', '100 %']} note={t('overlay.fire.ot.fuel')} />}
        {viz.overlay === 'hrr' && <Legend gradient={HRR_GRADIENT} labels={['10 kW', '1 MW', '100 MW']} note={t('overlay.fire.ot.hrr')} />}
        {viz.overlay === 'smoke' && <Legend gradient={VISIBILITY_GRADIENT} labels={['≤ 1 m', '5 m', '≥ 30 m']} note={t('overlay.fire.ot.smoke')} />}
        {viz.overlay === 'rooms' && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 8px', fontSize: 10, color: 'var(--text-2)' }} data-testid="fire-legend">
            {(Object.keys(ROOM_COLORS) as (keyof typeof ROOM_COLORS)[]).map((r) => <span key={r}><span style={{ display: 'inline-block', width: 8, height: 8, background: ROOM_COLORS[r], marginRight: 3 }} />{t(`overlay.fire.room.${r}`)}</span>)}
          </div>
        )}
        {hasModular && (
          <Toggle checked={color === 'fire'} onChange={(b) => useViewStore.getState().setStructureViz({ color: b ? 'fire' : 'normal' })} label={t('overlay.fire.members')} />
        )}
        <span style={{ fontSize: 10.5, color: 'var(--text-3)', lineHeight: 1.35 }}>{t('overlay.fire.note')}</span>
      </div>
    </>
  );
}

/** Volcano views (Phase 28): shown once an eruption runs. Visual-only effects are labelled as such. */
function VolcanoToggles() {
  const t = useT();
  const live = useSimStore((s) => s.volcano !== null);
  const viz = useViewStore((s) => s.volcanoViz);
  const set = useViewStore.getState().setVolcanoViz;
  if (!live) return null;
  const o = viz.overlay;
  return (
    <>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#ff6a1a', marginTop: 2 }}>{t('overlay.volcano')}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 2 }} data-testid="volcano-overlay">
        <Toggle checked={viz.lava} onChange={(b) => set({ lava: b })} label={t('overlay.volcano.lava')} />
        <Toggle checked={viz.ejecta} onChange={(b) => set({ ejecta: b })} label={t('overlay.volcano.ejecta')} />
        <Toggle checked={viz.ash} onChange={(b) => set({ ash: b })} label={t('overlay.volcano.ash')} />
        <Toggle checked={viz.steam} onChange={(b) => set({ steam: b })} label={t('overlay.volcano.steam')} />
        <Toggle checked={viz.fountain} onChange={(b) => set({ fountain: b })} label={t('overlay.volcano.fountain')} />
        <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{t('overlay.volcano.overlay')}</span>
        <Segmented size="small" value={o} onChange={(v) => set({ overlay: v })} ariaLabel={t('overlay.volcano.overlay')}
          options={VOLCANO_OVERLAYS.map((v) => ({ value: v, label: t(`overlay.volcano.o.${v}`), title: t(`overlay.volcano.ot.${v}`) }))} />
        {o === 'off' && viz.lava && <Legend gradient={GLOW_GRADIENT} labels={['300 °C', '750 °C', '1200 °C']} note={t('overlay.volcano.glowNote')} />}
        {o !== 'off' && <Legend gradient={overlayGradient(o)} labels={[`0 ${OVERLAY_SCALE[o].unit}`.trim(), `${OVERLAY_SCALE[o].max / 2} ${OVERLAY_SCALE[o].unit}`.trim(), `${OVERLAY_SCALE[o].max} ${OVERLAY_SCALE[o].unit}`.trim()]} note={t(`overlay.volcano.ot.${o}`)} />}
        <span style={{ fontSize: 10.5, color: 'var(--text-3)', lineHeight: 1.35 }}>{t('overlay.volcano.note')}</span>
      </div>
    </>
  );
}

/** Atmosphere views (Phase 29): shown while an atmosphere experiment runs. Fixed SI legends. */
function AtmosphereToggles() {
  const t = useT();
  const live = useSimStore((s) => s.atmosphere !== null);
  const viz = useViewStore((s) => s.atmosViz);
  const set = useViewStore.getState().setAtmosViz;
  if (!live) return null;
  const o = viz.overlay;
  return (
    <>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#5fb8ff', marginTop: 2 }}>{t('overlay.atmos')}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 2 }} data-testid="atmos-overlay">
        <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{t('overlay.atmos.overlay')}</span>
        <select value={o} onChange={(e) => set({ overlay: e.target.value as AtmosOverlay })} aria-label={t('overlay.atmos.overlay')} data-testid="atmos-overlay-select"
          style={{ fontSize: 11, background: 'var(--surface-2, #1c2128)', color: 'var(--text-1)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 4, padding: '2px 4px' }}>
          {ATMOS_OVERLAYS.map((v) => <option key={v} value={v} title={t(`overlay.atmos.ot.${v}`)}>{t(`overlay.atmos.o.${v}`)}</option>)}
        </select>
        {o !== 'off' && <Legend gradient={atmosGradient(o)} labels={atmosLabels(o)} note={t(`overlay.atmos.ot.${o}`)} />}
        <Toggle checked={viz.arrows} onChange={(b) => set({ arrows: b })} label={t('overlay.atmos.arrows')} />
        <Toggle checked={viz.streamlines} onChange={(b) => set({ streamlines: b })} label={t('overlay.atmos.streamlines')} />
        <span style={{ fontSize: 10.5, color: 'var(--text-3)', lineHeight: 1.35 }}>{t('overlay.atmos.note')}</span>
      </div>
    </>
  );
}

/** Celestial views (Phase 32): shown while a celestial experiment runs. Fixed log legends; disc / lens are illustrative. */
function CelestialToggles() {
  const t = useT();
  const live = useSimStore((s) => s.celestial !== null);
  const viz = useViewStore((s) => s.celestialViz);
  const set = useViewStore.getState().setCelestialViz;
  if (!live) return null;
  const o = viz.overlay;
  return (
    <>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#ffc49a', marginTop: 2 }}>{t('overlay.celestial')}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 2 }} data-testid="celestial-overlay">
        <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{t('overlay.celestial.overlay')}</span>
        <select value={o} onChange={(e) => set({ overlay: e.target.value as CelestialOverlay })} aria-label={t('overlay.celestial.overlay')} data-testid="celestial-overlay-select"
          style={{ fontSize: 11, background: 'var(--surface-2, #1c2128)', color: 'var(--text-1)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 4, padding: '2px 4px' }}>
          {CELESTIAL_OVERLAYS.map((v) => <option key={v} value={v}>{t(`overlay.celestial.o.${v}` as MessageKey)}</option>)}
        </select>
        {o !== 'off' && <Legend gradient={celestialGradient(o)} labels={o === 'zones' ? [t('overlay.celestial.z.far'), t('overlay.celestial.z.core'), t('overlay.celestial.z.capture'), t('overlay.celestial.z.limit')] : celestialLabels(o)} note={t(`overlay.celestial.ot.${o}` as MessageKey)} />}
        <Toggle checked={viz.cores} onChange={(b) => set({ cores: b })} label={t('overlay.celestial.cores')} />
        <Toggle checked={viz.bounds} onChange={(b) => set({ bounds: b })} label={t('overlay.celestial.bounds')} />
        <Toggle checked={viz.trails} onChange={(b) => set({ trails: b })} label={t('overlay.celestial.trails')} />
        <Toggle checked={viz.particles} onChange={(b) => set({ particles: b })} label={t('overlay.celestial.particles')} />
        <Toggle checked={viz.tidal} onChange={(b) => set({ tidal: b })} label={t('overlay.celestial.tidal')} />
        <Toggle checked={viz.disc} onChange={(b) => set({ disc: b })} label={t('overlay.celestial.disc')} />
        <Toggle checked={viz.lens} onChange={(b) => set({ lens: b })} label={t('overlay.celestial.lens')} />
        <span style={{ fontSize: 10.5, color: '#ffb36b', lineHeight: 1.35 }} data-testid="celestial-illustrative">{t('overlay.celestial.illustrative')}</span>
        <span style={{ fontSize: 10.5, color: 'var(--text-3)', lineHeight: 1.35 }}>{t('overlay.celestial.note')}</span>
      </div>
    </>
  );
}

/** Human body overlay (Phase 33): shown while a run has extended-model people. Render-only; arrow scales are fixed. */
function HumanToggles() {
  const t = useT();
  const version = useSimStore((s) => s.runtimeVersion);
  const viz = useViewStore((s) => s.humanViz);
  const set = useViewStore.getState().setHumanViz;
  const live = useMemo(() => {
    const rt = simulationController.getRuntime();
    if (!rt) return false;
    for (const e of rt.entities.values()) if (e.human) return true;
    return false;
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!live) return null;
  return (
    <>
      <Toggle checked={viz.enabled} onChange={(b) => set({ enabled: b })} label={t('humanUi.overlay')} />
      {viz.enabled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 38 }} data-testid="human-overlay">
          <Toggle checked={viz.com} onChange={(b) => set({ com: b })} label={t('humanUi.overlay.com')} />
          <Toggle checked={viz.support} onChange={(b) => set({ support: b })} label={t('humanUi.overlay.support')} />
          <Toggle checked={viz.gravity} onChange={(b) => set({ gravity: b })} label={t('humanUi.overlay.gravity')} />
          <Toggle checked={viz.velocity} onChange={(b) => set({ velocity: b })} label={t('humanUi.overlay.velocity')} />
          <Toggle checked={viz.contact} onChange={(b) => set({ contact: b })} label={t('humanUi.overlay.contact')} />
          <Toggle checked={viz.segments} onChange={(b) => set({ segments: b })} label={t('humanUi.overlay.segments')} />
          <Toggle checked={viz.trail} onChange={(b) => set({ trail: b })} label={t('humanUi.overlay.trail')} />
          {viz.segments && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {INJURY_LEVELS.map((l, i) => (
                <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--text-1)', fontSize: 11 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: LEVEL_COLORS[i] }} />
                  {t(`human.level.${l}`)}
                </span>
              ))}
            </div>
          )}
          <span style={{ fontSize: 10.5, color: 'var(--text-3)', lineHeight: 1.35 }}>{t('humanUi.overlay.note')}</span>
        </div>
      )}
    </>
  );
}

/** Gravity views (Phase 31): shown while a gravity experiment runs. Fixed m/s² / × g₀ legends. */
function GravityToggles() {
  const t = useT();
  const live = useSimStore((s) => s.gravity !== null);
  const viz = useViewStore((s) => s.gravityViz);
  const set = useViewStore.getState().setGravityViz;
  if (!live) return null;
  const o = viz.overlay;
  return (
    <>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#ffd29a', marginTop: 2 }}>{t('overlay.gravity')}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 2 }} data-testid="gravity-overlay">
        <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{t('overlay.gravity.overlay')}</span>
        <select value={o} onChange={(e) => set({ overlay: e.target.value as GravityOverlay })} aria-label={t('overlay.gravity.overlay')} data-testid="gravity-overlay-select"
          style={{ fontSize: 11, background: 'var(--surface-2, #1c2128)', color: 'var(--text-1)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 4, padding: '2px 4px' }}>
          {GRAVITY_OVERLAYS.map((v) => <option key={v} value={v}>{t(`overlay.gravity.o.${v}`)}</option>)}
        </select>
        {o !== 'off' && <Legend gradient={gravityGradient(o)} labels={gravityLabels(o)} note={t(`overlay.gravity.ot.${o}`)} />}
        <Toggle checked={viz.arrows} onChange={(b) => set({ arrows: b })} label={t('overlay.gravity.arrows')} />
        <Toggle checked={viz.sources} onChange={(b) => set({ sources: b })} label={t('overlay.gravity.sources')} />
        <span style={{ fontSize: 10.5, color: 'var(--text-3)', lineHeight: 1.35 }}>{t('overlay.gravity.note')}</span>
      </div>
    </>
  );
}

/** Climate views (Phase 30): shown while a climate experiment runs. Fixed SI legends; particles / shimmer are visual. */
function ClimateToggles() {
  const t = useT();
  const live = useSimStore((s) => s.climate !== null);
  const viz = useViewStore((s) => s.climateViz);
  const set = useViewStore.getState().setClimateViz;
  if (!live) return null;
  const o = viz.overlay;
  return (
    <>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#bfe3ff', marginTop: 2 }}>{t('overlay.climate')}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 2 }} data-testid="climate-overlay">
        <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{t('overlay.climate.overlay')}</span>
        <select value={o} onChange={(e) => set({ overlay: e.target.value as ClimateOverlay })} aria-label={t('overlay.climate.overlay')} data-testid="climate-overlay-select"
          style={{ fontSize: 11, background: 'var(--surface-2, #1c2128)', color: 'var(--text-1)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 4, padding: '2px 4px' }}>
          {CLIMATE_OVERLAYS.map((v) => <option key={v} value={v} title={t(`overlay.climate.ot.${v}`)}>{t(`overlay.climate.o.${v}`)}</option>)}
        </select>
        {o !== 'off' && <Legend gradient={climateGradient(o)} labels={climateLabels(o)} note={t(`overlay.climate.ot.${o}`)} />}
        <Toggle checked={viz.snow} onChange={(b) => set({ snow: b })} label={t('overlay.climate.snow')} />
        <Toggle checked={viz.ice} onChange={(b) => set({ ice: b })} label={t('overlay.climate.ice')} />
        <Toggle checked={viz.particles} onChange={(b) => set({ particles: b })} label={t('overlay.climate.particles')} />
        <Toggle checked={viz.shimmer} onChange={(b) => set({ shimmer: b })} label={t('overlay.climate.shimmer')} />
        <span style={{ fontSize: 10.5, color: 'var(--text-3)', lineHeight: 1.35 }}>{t('overlay.climate.note')}</span>
      </div>
    </>
  );
}

function Legend({ gradient, labels, note }: { gradient: string; labels: string[]; note: string }) {
  return (
    <div data-testid="fire-legend">
      <div style={{ height: 6, borderRadius: 3, background: gradient }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-2)', marginTop: 2 }}>{labels.map((l) => <span key={l}>{l}</span>)}</div>
      <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{note}</span>
    </div>
  );
}

/** Thermal views (Phase 26): shown once heat enters the run. Fixed °C scales, never auto-rescaled. */
function ThermalToggles() {
  const t = useT();
  const live = useSimStore((s) => s.thermal);
  const hasModular = useSimStore((s) => (s.structure?.modular ?? 0) > 0);
  const viz = useViewStore((s) => s.thermalViz);
  const color = useViewStore((s) => s.structureViz.color);
  const set = useViewStore.getState().setThermalViz;
  if (!live) return null;
  const lab = (C: number) => (viz.unit === 'K' ? `${(C + 273.15).toFixed(0)} K` : `${C} °C`);
  return (
    <>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#ffb36b', marginTop: 2 }}>{t('overlay.thermal')}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 2 }} data-testid="thermal-overlay">
        <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{t('overlay.thermal.field')}</span>
        <Segmented size="small" value={viz.field} onChange={(f) => set({ field: f })} ariaLabel={t('overlay.thermal.field')}
          options={(['off', 'surface', 'air', 'peak', 'gradient'] as const).map((f) => ({ value: f, label: t(`overlay.thermal.f.${f}`), title: t(`overlay.thermal.ft.${f}`) }))} />
        {viz.field !== 'off' && (
          <div data-testid="thermal-legend">
            <div style={{ height: 6, borderRadius: 3, background: TEMPERATURE_GRADIENT }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-2)', marginTop: 2 }}>
              {viz.field === 'gradient'
                ? <><span>0</span><span>25</span><span>50 K/m</span></>
                : <><span>{lab(0)}</span><span>{lab(viz.scale / 2)}</span><span>{lab(viz.scale)}</span></>}
            </div>
            <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{t('overlay.thermal.legendNote')}</span>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{t('overlay.thermal.scale')}</span>
          <Segmented size="small" value={viz.scale} onChange={(k) => set({ scale: k })} options={THERMAL_SCALES.map((k) => ({ value: k, label: `${k}` }))} />
          <Segmented size="small" value={viz.unit} onChange={(u) => set({ unit: u })} options={[{ value: 'C' as const, label: '°C' }, { value: 'K' as const, label: 'K' }]} />
        </div>
        <Toggle checked={viz.isotherms} onChange={(b) => set({ isotherms: b })} label={t('overlay.thermal.isotherms')} />
        <Toggle checked={viz.vectors} onChange={(b) => set({ vectors: b })} label={t('overlay.thermal.vectors')} />
        <Toggle checked={viz.objects} onChange={(b) => set({ objects: b })} label={t('overlay.thermal.objects')} />
        <Toggle checked={viz.glow} onChange={(b) => set({ glow: b })} label={t('overlay.thermal.glow')} />
        {hasModular && (
          <>
            <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{t('overlay.thermal.members')}</span>
            <Segmented size="small" value={(['temperature', 'thermalStress', 'strength'] as const).includes(color as 'temperature') ? color : 'normal'}
              onChange={(c) => useViewStore.getState().setStructureViz({ color: c })} ariaLabel={t('overlay.thermal.members')}
              options={(['normal', 'temperature', 'thermalStress', 'strength'] as const).map((c) => ({ value: c, label: t(`overlay.thermal.m.${c}`), title: t(`overlay.thermal.mt.${c}`) }))} />
            {color === 'strength' && <div style={{ height: 6, borderRadius: 3, background: FACTOR_GRADIENT }} title={t('overlay.thermal.mt.strength')} />}
            {color === 'thermalStress' && <div style={{ height: 6, borderRadius: 3, background: UTIL_GRADIENT }} title={t('overlay.thermal.mt.thermalStress')} />}
          </>
        )}
        <span style={{ fontSize: 10.5, color: 'var(--text-3)', lineHeight: 1.35 }}>{t('overlay.thermal.note')}</span>
      </div>
    </>
  );
}
