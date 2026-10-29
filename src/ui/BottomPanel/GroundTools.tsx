import { useMemo } from 'react';
import { useT } from '@/i18n/i18n';
import type { PhenomenonInstance } from '@/phenomena/types';
import type { LandslideSpec, SinkholeSpec } from '@/ground/types';
import { LANDSLIDE_LIMITS } from '@/ground/types';
import { areaCentroid } from '@/ground/common';
import { landslideOutlook, sinkholeOutlook } from '@/phenomena/groundDefinitions';
import { FS_GRADIENT } from '@/rendering/ground/groundColors';
import { useViewStore } from '@/rendering/viewStore';
import { useWorldStore } from '@/world/worldStore';
import { updatePhenomenon } from '@/app/actions';
import { Icon } from '@/ui/common/Icon';
import { Segmented } from '@/ui/common/Segmented';
import eq from './EarthquakeForm.module.css';
import x from './ExperimentPanel.module.css';

/**
 * Sinkhole / landslide helpers in the experiment editor (Phase 22): pick the position on the
 * ground (sinkhole centre, landslide area centre) or draw a polygon source area, show the
 * predicted outcome on the map before running, and the numbers computed on the actual ground
 * (roof FS and critical radius / plug drop or choke; FS map of the area, unstable share and
 * volume). Nothing is silently corrected: problems are listed in the assumptions.
 */
export function GroundTools({ inst }: { inst: PhenomenonInstance }) {
  const t = useT();
  const pick = useViewStore((s) => (s.groundPick?.id === inst.id ? s.groundPick.mode : null));
  const previewing = useViewStore((s) => s.groundPreview === inst.id);
  const terrain = useWorldStore((s) => s.doc.terrain);
  const vs = useViewStore.getState();
  const isSlide = inst.type === 'landslide';
  const spec = inst.spec as SinkholeSpec | LandslideSpec;
  const summary = useMemo(() => {
    if (inst.type === 'sinkhole') {
      const o = sinkholeOutlook(spec as SinkholeSpec, { seed: 0, terrain });
      return {
        lines: [
          t('ground.tools.sinkSummary', { ac: o.criticalRadius.toFixed(1), fs0: o.fs0.toFixed(2), fs1: o.fsEnd.toFixed(2) }),
          o.choked ? t('ground.tools.choked', { d: o.drop.toFixed(2) }) : t('ground.tools.pit', { d: o.drop.toFixed(2), r: o.pitRadius.toFixed(1) }),
        ],
        verdict: o.fails ? 'fail' : 'stable',
      };
    }
    const o = landslideOutlook(spec as LandslideSpec, { seed: 0, terrain });
    if (!o || !o.cells.length) return { lines: [t('geo.issue.outside')], verdict: 'invalid' };
    const min = Number.isFinite(o.minFS) ? o.minFS.toFixed(2) : '∞';
    return {
      lines: [t('ground.tools.slideSummary', { min, n: o.unstable, total: o.cells.length, v: Math.round(o.volume).toLocaleString() })],
      verdict: o.unstable > 0 ? 'fail' : 'stable',
    };
  }, [inst.type, spec, terrain, t]);
  const area = isSlide ? (spec as LandslideSpec).area : null;
  const toCircle = () => {
    if (!area || area.kind === 'circle') return;
    const c = areaCentroid(area);
    let r = 0;
    for (const [px, pz] of area.points) r = Math.max(r, Math.hypot(px - c[0], pz - c[1]));
    r = Math.min(LANDSLIDE_LIMITS.radius[1], Math.max(LANDSLIDE_LIMITS.radius[0], Math.round(r)));
    updatePhenomenon(inst.id, { spec: { ...(spec as LandslideSpec), area: { kind: 'circle', center: [Math.round(c[0] * 10) / 10, Math.round(c[1] * 10) / 10], radius: r } } });
  };
  return (
    <div className={x.deform} data-testid="ground-tools">
      {area && (
        <Segmented
          size="small"
          value={area.kind}
          onChange={(k) => (k === 'circle' ? toCircle() : vs.setGroundPick({ id: inst.id, mode: 'polygon' }))}
          options={[{ value: 'circle', label: t('ground.tools.circle') }, { value: 'polygon', label: t('ground.tools.polygon') }]}
        />
      )}
      <div className={x.deformButtons}>
        <button className={eq.small} aria-pressed={pick === 'point'} onClick={() => vs.setGroundPick(pick === 'point' ? null : { id: inst.id, mode: 'point' })} data-testid="ground-pick">
          <Icon name="focus" size={12} /> {t(pick === 'point' ? 'deform.pick.active' : isSlide ? 'ground.tools.pickArea' : 'deform.pick')}
        </button>
        {isSlide && (
          <button className={eq.small} aria-pressed={pick === 'polygon'} onClick={() => vs.setGroundPick(pick === 'polygon' ? null : { id: inst.id, mode: 'polygon' })} data-testid="ground-draw">
            <Icon name="area" size={12} /> {t(pick === 'polygon' ? 'deform.pick.active' : 'ground.tools.draw')}
          </button>
        )}
        <button className={eq.small} aria-pressed={previewing} onClick={() => vs.setGroundPreview(previewing ? null : inst.id)} data-testid="ground-preview">
          <Icon name={previewing ? 'eye' : 'eyeOff'} size={12} /> {t('deform.preview')}
        </button>
      </div>
      {pick === 'point' && <div className={x.deformHint}>{t('deform.pick.hint')}</div>}
      {pick === 'polygon' && <div className={x.deformHint}>{t('ground.tools.drawHint')}</div>}
      <div className={x.deformSummary} data-testid="ground-summary" data-verdict={summary.verdict}>
        {summary.lines.map((l, i) => <div key={i}>{l}</div>)}
        <div style={{ color: summary.verdict === 'fail' ? '#ff8a65' : summary.verdict === 'stable' ? '#7fd49a' : '#ffd34d' }}>
          {t(summary.verdict === 'fail' ? 'ground.tools.expectFail' : summary.verdict === 'stable' ? 'ground.tools.expectStable' : 'ground.tools.invalid')}
        </div>
      </div>
      {previewing && (
        <div style={{ fontSize: 10.5, color: 'var(--text-2)' }}>
          {isSlide ? (
            <>
              <div style={{ height: 6, borderRadius: 3, background: FS_GRADIENT }} />
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>FS 0.8</span><span>1.0</span><span>1.2</span><span>1.5</span><span>2.5+</span></div>
            </>
          ) : (
            <div>{t('ground.tools.sinkLegend')}</div>
          )}
        </div>
      )}
    </div>
  );
}
