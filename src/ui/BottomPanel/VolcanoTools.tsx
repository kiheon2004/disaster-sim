import { useMemo, useState } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { PhenomenonInstance } from '@/phenomena/types';
import type { VolcanoSpec } from '@/volcano/types';
import { volcanoOutlook } from '@/volcano/outlook';
import { VOLCANO_PRESETS, volcanoPreset, type VolcanoPresetId } from '@/volcano/presets';
import { useViewStore } from '@/rendering/viewStore';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { loadVolcanoPreset, updatePhenomenon } from '@/app/actions';
import { samplerFor } from '@/terrain/TerrainSampler';
import { Icon } from '@/ui/common/Icon';
import eq from './EarthquakeForm.module.css';
import x from './ExperimentPanel.module.css';

const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const sci = (v: number) => (v >= 1e4 || v < 1e-2 ? v.toExponential(1) : v.toFixed(0));

/**
 * Volcano scenario helpers in the experiment editor (Phase 28): place the vent on the map (and the
 * fissure's second end, or extra vents), the preview (vents, source area, potential downslope directions
 * on the bare terrain — not a prediction of the flow), the initial material state and the erupted
 * amounts, and the presets with their assumptions. Not an eruption forecast or a hazard-planning tool.
 */
export function VolcanoTools({ inst }: { inst: PhenomenonInstance }) {
  const t = useT();
  const pick = useViewStore((s) => (s.groundPick?.id === inst.id ? s.groundPick.target ?? 'vent' : null));
  const previewing = useViewStore((s) => s.groundPreview === inst.id);
  const terrain = useWorldStore((s) => s.doc.terrain);
  const inSim = useEditorStore((s) => s.mode === 'simulation');
  const vs = useViewStore.getState();
  const spec = inst.spec as VolcanoSpec;
  const out = useMemo(() => { const s = samplerFor(terrain); return volcanoOutlook(spec, terrain, (px, pz) => s.sampleHeight(px, pz)); }, [spec, terrain]);
  const [preset, setPreset] = useState<VolcanoPresetId>('smallVent');
  const p = volcanoPreset(preset);
  const pickBtn = (target: 'vent' | 'end' | 'add', label: MessageKey, testid: string) => (
    <button className={eq.small} aria-pressed={pick === target} disabled={inSim} onClick={() => vs.setGroundPick(pick === target ? null : { id: inst.id, mode: 'point', target })} data-testid={testid}>
      <Icon name="focus" size={12} /> {t(pick === target ? 'deform.pick.active' : label)}
    </button>
  );
  const lines: string[] = [];
  out.vents.forEach((v, k) => lines.push(t('volcano.tools.vent', { k: k + 1, x: fmt(v.x), z: fmt(v.z), h: fmt(v.ground), s: fmt(v.slope), b: Number.isFinite(v.bearing) ? v.bearing.toFixed(0) : '—', hc: Number.isFinite(v.hcr) ? fmt(v.hcr, 2) : '∞' })));
  lines.push(t('volcano.tools.amount', { V: fmt(out.volume, 0), t: fmt(out.mass / 1000, 0), b: Math.round(out.bombs * 100), a: Math.round(out.ash * 100) }));
  lines.push(t('volcano.tools.material', { phi: Math.round(out.crystals * 100), eta: sci(out.viscosity), tau: fmt(out.yieldStrength, 0), lock: fmt(out.lockC, 0) }));
  return (
    <div className={x.deform} data-testid="volcano-tools">
      <div className={x.deformButtons}>
        {pickBtn('vent', 'volcano.tools.pick', 'volcano-pick')}
        {spec.vents[0]?.kind === 'fissure' && spec.vents.length === 1 && pickBtn('end', 'volcano.tools.pickEnd', 'volcano-pick-end')}
        {spec.vents.length > 1 && pickBtn('add', 'volcano.tools.addVent', 'volcano-add-vent')}
        <button className={eq.small} aria-pressed={previewing} onClick={() => vs.setGroundPreview(previewing ? null : inst.id)} data-testid="volcano-preview">
          <Icon name={previewing ? 'eye' : 'eyeOff'} size={12} /> {t('deform.preview')}
        </button>
      </div>
      {pick && <div className={x.deformHint}>{t(pick === 'end' ? 'volcano.tools.pickEndHint' : pick === 'add' ? 'volcano.tools.addHint' : 'volcano.tools.pickHint')}</div>}
      {spec.vents.length > 1 && (
        <div className={x.deformSummary} data-testid="volcano-vents">
          {spec.vents.map((v, k) => (
            <div key={k} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span>{t('volcano.tools.ventShort', { k: k + 1, x: fmt(v.position[0]), z: fmt(v.position[1]) })}</span>
              {k > 0 && <button className={eq.small} disabled={inSim} onClick={() => updatePhenomenon(inst.id, { spec: { ...spec, vents: spec.vents.filter((_, j) => j !== k) } as VolcanoSpec })} data-testid={`volcano-remove-${k}`}>✕</button>}
            </div>
          ))}
        </div>
      )}
      <div className={x.deformSummary} data-testid="volcano-summary">
        {lines.map((l, i) => <div key={i}>{l}</div>)}
        {out.issues.map((k) => <div key={k} className={x.issue}>⚠ {t(k as MessageKey)}</div>)}
        <div style={{ color: 'var(--text-3)' }}>{t('volcano.tools.paths')}</div>
        <div style={{ color: 'var(--text-3)' }}>{t('volcano.tools.approx')}</div>
      </div>
      <div className={x.deformSummary} data-testid="volcano-presets">
        <b>{t('volcano.tools.presets')}</b>
        <select value={preset} onChange={(e) => setPreset(e.target.value as VolcanoPresetId)} disabled={inSim} data-testid="volcano-preset-select">
          {VOLCANO_PRESETS.map((id) => <option key={id} value={id}>{t(`volcano.preset.${id}` as MessageKey)}</option>)}
        </select>
        <div style={{ color: 'var(--text-2)' }}>{t(`volcano.preset.d.${preset}` as MessageKey)}</div>
        {p.assumptions.map((k) => <div key={k} style={{ color: 'var(--text-3)' }}>· {t(k as MessageKey)}</div>)}
        <button className={eq.small} disabled={inSim} onClick={() => loadVolcanoPreset(preset)} data-testid="volcano-preset-load">
          <Icon name="volcano" size={12} /> {t('volcano.tools.loadPreset')}
        </button>
      </div>
    </div>
  );
}
