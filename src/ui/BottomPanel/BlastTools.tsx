import { useMemo } from 'react';
import { useT } from '@/i18n/i18n';
import type { PhenomenonInstance } from '@/phenomena/types';
import type { BlastSpec } from '@/blast/types';
import { blastOutlook, energyText } from '@/phenomena/blastDefinitions';
import { PRESSURE_LEVELS } from '@/blast/plan';
import { useViewStore } from '@/rendering/viewStore';
import { useWorldStore } from '@/world/worldStore';
import { cssLogGradient, PRESSURE_STOPS } from '@/rendering/blast/blastColors';
import { Icon } from '@/ui/common/Icon';
import eq from './EarthquakeForm.module.css';
import x from './ExperimentPanel.module.css';

/**
 * Air-blast helpers in the experiment editor (Phase 24): pick the source on the ground, show the
 * predicted field (peak overpressure, arrival contours, validity radii) on the map, and the numbers of
 * the SAME plan the simulation runs — labelled as model estimates. No explosive type, mass or TNT
 * equivalent is offered or shown.
 */
export function BlastTools({ inst }: { inst: PhenomenonInstance }) {
  const t = useT();
  const picking = useViewStore((s) => s.groundPick?.id === inst.id);
  const previewing = useViewStore((s) => s.groundPreview === inst.id);
  const terrain = useWorldStore((s) => s.doc.terrain);
  const seed = useWorldStore((s) => s.doc.settings.simulation.seed);
  const vs = useViewStore.getState();
  const spec = inst.spec as BlastSpec;
  const plan = useMemo(() => blastOutlook(spec, { seed, terrain }), [spec, terrain, seed]);
  const lines: string[] = [];
  if (plan) {
    lines.push(t('blast.tools.source', { x: spec.position[0].toFixed(1), z: spec.position[1].toFixed(1), h: spec.height.toFixed(1), E: energyText(spec.energy) }));
    lines.push(t('blast.tools.scales', { rt: plan.rt.toFixed(1), valid: plan.validRadius.toFixed(1), Ep: energyText(plan.pulseEnergy), eff: (plan.efficiency * 100).toFixed(0) }));
    const s20 = plan.wave.sample(20), s50 = plan.wave.sample(50), s100 = plan.wave.sample(100);
    lines.push(t('blast.tools.pressures', { p20: (s20.dp / 1000).toFixed(1), p50: (s50.dp / 1000).toFixed(2), p100: (s100.dp / 1000).toFixed(2), t100: (s100.t * 1000).toFixed(0) }));
    const far = plan.wave.main.maxRadius * 0.95;
    lines.push(t('blast.tools.levels', { r: PRESSURE_LEVELS.map((p, k) => `${p / 1000} kPa ${plan.levelRadii[k] >= far ? '>' : '≈'}${Math.min(plan.levelRadii[k], far).toFixed(0)} m`).join(' · ') }));
    lines.push(t('blast.tools.exit', { t: (plan.worldExit * 1000).toFixed(0) }));
  }
  const verdict = !plan ? 'invalid' : plan.warnings.some((w) => w.key === 'blast.warn.worldNear') ? 'outside' : 'ok';
  return (
    <div className={x.deform} data-testid="blast-tools">
      <div className={x.deformButtons}>
        <button className={eq.small} aria-pressed={picking} onClick={() => vs.setGroundPick(picking ? null : { id: inst.id, mode: 'point' })} data-testid="blast-pick">
          <Icon name="focus" size={12} /> {t(picking ? 'deform.pick.active' : 'blast.tools.pick')}
        </button>
        <button className={eq.small} aria-pressed={previewing} onClick={() => vs.setGroundPreview(previewing ? null : inst.id)} data-testid="blast-preview">
          <Icon name={previewing ? 'eye' : 'eyeOff'} size={12} /> {t('deform.preview')}
        </button>
      </div>
      {picking && <div className={x.deformHint}>{t('deform.pick.hint')}</div>}
      <div className={x.deformSummary} data-testid="blast-summary" data-verdict={verdict}>
        {lines.map((l, i) => <div key={i}>{l}</div>)}
        <div style={{ color: 'var(--text-3)' }}>{t('blast.tools.approx')}</div>
      </div>
      {previewing && (
        <div style={{ fontSize: 10.5, color: 'var(--text-2)' }}>
          <div style={{ height: 6, borderRadius: 3, background: cssLogGradient(PRESSURE_STOPS) }} />
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>0.1</span><span>1</span><span>3</span><span>10</span><span>30</span><span>100 kPa</span></div>
          <div>{t('blast.tools.legend')}</div>
        </div>
      )}
    </div>
  );
}
