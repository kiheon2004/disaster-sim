import { useMemo } from 'react';
import { useT } from '@/i18n/i18n';
import type { PhenomenonInstance } from '@/phenomena/types';
import type { TerrainDeformationSpec } from '@/deformation/types';
import { validateDeformation } from '@/deformation/field';
import { useViewStore } from '@/rendering/viewStore';
import { useWorldStore } from '@/world/worldStore';
import { Icon } from '@/ui/common/Icon';
import eq from './EarthquakeForm.module.css';
import x from './ExperimentPanel.module.css';

/**
 * Terrain deformation helpers in the experiment editor (Phase 21): pick the centre with a click
 * on the ground, show the predicted final displacement on the map before running, and the
 * numbers validation computed on the actual grid (largest |w|, steepest slope it creates, net
 * volume). Problems are listed with the assumptions (never silently corrected).
 */
export function DeformationTools({ inst }: { inst: PhenomenonInstance }) {
  const t = useT();
  const spec = inst.spec as TerrainDeformationSpec;
  const picking = useViewStore((s) => s.deformPick === inst.id);
  const previewing = useViewStore((s) => s.deformPreview === inst.id);
  const terrain = useWorldStore((s) => s.doc.terrain);
  const seed = useWorldStore((s) => s.doc.settings.simulation.seed);
  const v = useMemo(() => validateDeformation(spec, terrain, spec.seed ?? inst.seed ?? seed), [spec, terrain, inst.seed, seed]);
  const errors = v.issues.filter((i) => i.severity === 'error').length;
  const vs = useViewStore.getState();
  return (
    <div className={x.deform} data-testid="deform-tools">
      <div className={x.deformButtons}>
        <button className={eq.small} aria-pressed={picking} onClick={() => vs.setDeformPick(picking ? null : inst.id)} data-testid="deform-pick">
          <Icon name="focus" size={12} /> {t(picking ? 'deform.pick.active' : 'deform.pick')}
        </button>
        <button className={eq.small} aria-pressed={previewing} onClick={() => vs.setDeformPreview(previewing ? null : inst.id)} data-testid="deform-preview">
          <Icon name={previewing ? 'eye' : 'eyeOff'} size={12} /> {t('deform.preview')}
        </button>
      </div>
      {picking && <div className={x.deformHint}>{t('deform.pick.hint')}</div>}
      <div className={x.deformSummary} data-testid="deform-summary">
        {t('deform.summary', { m: v.maxAbs.toFixed(2), slope: (Math.atan(v.maxSlope) * 180 / Math.PI).toFixed(0), vol: Math.round(v.volume).toLocaleString() })}
      </div>
      {errors > 0 && <div className={x.issue}>⚠ {t('deform.invalid', { n: errors })}</div>}
    </div>
  );
}
