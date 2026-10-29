import { useMemo } from 'react';
import { useT } from '@/i18n/i18n';
import type { PhenomenonInstance } from '@/phenomena/types';
import type { ImpactSpec } from '@/impact/types';
import { impactOutlook } from '@/phenomena/impactDefinitions';
import { tntTonnes } from '@/impact/energy';
import { shockRadius } from '@/rendering/impact/ImpactPreview';
import { useViewStore } from '@/rendering/viewStore';
import { useWorldStore } from '@/world/worldStore';
import { Icon } from '@/ui/common/Icon';
import eq from './EarthquakeForm.module.css';
import x from './ExperimentPanel.module.css';

const energyText = (E: number) => (E >= 1e12 ? `${(E / 1e12).toFixed(2)} TJ` : E >= 1e9 ? `${(E / 1e9).toFixed(2)} GJ` : `${(E / 1e6).toFixed(2)} MJ`);

/**
 * Impact helpers in the experiment editor (Phase 23): pick the aim point on the ground, show the
 * predicted trajectory / impact point / crater / ejecta / shock on the map, and the numbers of the
 * SAME plan the simulation runs (energy, momentum, crater, affected region, warnings — model
 * estimates, labelled as approximate).
 */
export function ImpactTools({ inst }: { inst: PhenomenonInstance }) {
  const t = useT();
  const picking = useViewStore((s) => s.groundPick?.id === inst.id);
  const previewing = useViewStore((s) => s.groundPreview === inst.id);
  const terrain = useWorldStore((s) => s.doc.terrain);
  const seed = useWorldStore((s) => s.doc.settings.simulation.seed);
  const vs = useViewStore.getState();
  const spec = inst.spec as ImpactSpec;
  const plan = useMemo(() => impactOutlook(spec, { seed: inst.seed ?? seed, terrain }), [spec, terrain, seed, inst.seed]);
  const lines: string[] = [];
  let verdict: 'crater' | 'airburst' | 'invalid' = 'invalid';
  if (plan) {
    const [px, , pz] = plan.arc.point;
    if (plan.airburst) {
      verdict = 'airburst';
      lines.push(t('impact.tools.airburst', { z: (((plan.entry?.airburst?.altitude ?? 0) / 1000)).toFixed(1), E: energyText(plan.partition.atmosphere) }));
    } else {
      verdict = plan.crater ? 'crater' : 'invalid';
      lines.push(t('impact.tools.point', { x: px.toFixed(1), z: pz.toFixed(1), d: plan.arc.miss.toFixed(1), t: plan.timeToImpact.toFixed(1) }));
      lines.push(t('impact.tools.energy', { E: energyText(plan.energy), tnt: tntTonnes(plan.energy).toFixed(2), p: (Math.hypot(...plan.momentum) / 1000).toFixed(0), v: plan.speed.toFixed(0), a: plan.angle.toFixed(0) }));
      if (plan.crater) {
        lines.push(t('impact.tools.crater', { D: (2 * plan.crater.radius).toFixed(1), d: plan.crater.depth.toFixed(1), regime: t(plan.crater.regime === 'gravity' ? 'impact.regime.gravity' : 'impact.regime.strength') }));
        const range = Math.max(0, ...plan.parcels.filter((p) => !p.outflow).map((p) => Math.hypot(p.p1[0] - px, p.p1[2] - pz)));
        lines.push(t('impact.tools.region', { r: range.toFixed(0), s: shockRadius(plan, 0.1).toFixed(0), m: (plan.ejectaMass / 1000).toFixed(1), out: (plan.ejectaOut / 1000).toFixed(1) }));
      }
    }
  }
  return (
    <div className={x.deform} data-testid="impact-tools">
      <div className={x.deformButtons}>
        <button className={eq.small} aria-pressed={picking} onClick={() => vs.setGroundPick(picking ? null : { id: inst.id, mode: 'point' })} data-testid="impact-pick">
          <Icon name="focus" size={12} /> {t(picking ? 'deform.pick.active' : 'impact.tools.pick')}
        </button>
        <button className={eq.small} aria-pressed={previewing} onClick={() => vs.setGroundPreview(previewing ? null : inst.id)} data-testid="impact-preview">
          <Icon name={previewing ? 'eye' : 'eyeOff'} size={12} /> {t('deform.preview')}
        </button>
      </div>
      {picking && <div className={x.deformHint}>{t('deform.pick.hint')}</div>}
      <div className={x.deformSummary} data-testid="impact-summary" data-verdict={verdict}>
        {lines.map((l, i) => <div key={i}>{l}</div>)}
        <div style={{ color: 'var(--text-3)' }}>{t('impact.tools.approx')}</div>
      </div>
      {previewing && <div style={{ fontSize: 10.5, color: 'var(--text-2)' }}>{t('impact.tools.legend')}</div>}
    </div>
  );
}
