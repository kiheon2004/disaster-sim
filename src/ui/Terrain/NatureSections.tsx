import { useMemo, useState } from 'react';
import { useT } from '@/i18n/i18n';
import { randomSeed } from '@/core/random';
import { useEditorStore, BRUSH_RADIUS_RANGE, type TerrainToolId } from '@/editor/editorStore';
import { useNatureStore, type NatureParams } from '@/editor/natureStore';
import { useWorldStore } from '@/world/worldStore';
import { GROUND_MATERIALS } from '@/terrain/GroundMaterials';
import { SOIL_PROFILES } from '@/terrain/SoilProfiles';
import type { BrushFalloff } from '@/terrain/TerrainEditor';
import { Icon, type IconName } from '@/ui/common/Icon';
import { NumberField, SelectField, ToggleField } from '@/ui/common/fields';
import { Segmented } from '@/ui/common/Segmented';
import { LIMITS, MIN_RIVER_WIDTH, type Feature } from '@/landscape/types';
import { applyEnvironment, deleteFeature, featureWarnings, landformPeak, updateFeature } from '@/app/natureActions';
import { ENVIRONMENT_PRESETS, type EnvironmentPreset } from '@/landscape/presets';
import styles from './TerrainPanel.module.css';

type Category = 'brush' | 'landform' | 'water' | 'vegetation' | 'edit';

const TOOLS: Record<Category, { id: TerrainToolId; icon: IconName }[]> = {
  brush: [
    { id: 'raise', icon: 'raise' }, { id: 'lower', icon: 'lower' }, { id: 'flatten', icon: 'flatten' }, { id: 'smooth', icon: 'smooth' },
    { id: 'plateau', icon: 'flatten' }, { id: 'ridge', icon: 'raise' }, { id: 'valley', icon: 'lower' }, { id: 'slope', icon: 'line' },
    { id: 'noise', icon: 'dice' }, { id: 'erode', icon: 'smooth' }, { id: 'paint', icon: 'brush' }, { id: 'soil', icon: 'soil' },
    { id: 'inspect', icon: 'probe' },
  ],
  landform: [
    { id: 'mountain', icon: 'terrain' }, { id: 'hill', icon: 'terrain' }, { id: 'ridgeLine', icon: 'line' }, { id: 'valleyLine', icon: 'line' }, { id: 'canyon', icon: 'lower' },
  ],
  water: [{ id: 'river', icon: 'water' }, { id: 'lake', icon: 'water' }, { id: 'coast', icon: 'area' }],
  vegetation: [{ id: 'forest', icon: 'tree' }],
  edit: [{ id: 'feature', icon: 'cursor' }],
};

const categoryOf = (tool: TerrainToolId): Category => (Object.keys(TOOLS) as Category[]).find((c) => TOOLS[c].some((x) => x.id === tool)) ?? 'brush';
const FALLOFFS: BrushFalloff[] = ['smooth', 'linear', 'sharp', 'flat'];
const NATURAL_GROUNDS = GROUND_MATERIALS.filter((g) => !g.paved);

/** Tool categories, tool grid and the settings of the active tool (Terrain tab, Phase 19). */
export function TerrainToolSections({ editing }: { editing: boolean }) {
  const t = useT();
  const active = useEditorStore((s) => (s.tool === 'terrain' ? s.terrainTool : null));
  const last = useEditorStore((s) => s.terrainTool);
  const cat = categoryOf(active ?? last);
  const ed = useEditorStore.getState;
  return (
    <>
      <div className={styles.section}>
        <div className={styles.title}>{t('terrain.tools')}</div>
        <Segmented size="small" value={cat} ariaLabel={t('terrain.tools')}
          onChange={(c) => ed().setTerrainTool(TOOLS[c][0].id)}
          options={(Object.keys(TOOLS) as Category[]).map((c) => ({ value: c, label: t(`nature.cat.${c}`) }))} />
        <div className={styles.tools}>
          {TOOLS[cat].map((tool) => (
            <button key={tool.id} className={`${styles.tool} ${active === tool.id ? styles.active : ''}`} disabled={!editing} aria-pressed={active === tool.id}
              data-terrain-tool={tool.id} onClick={() => ed().setTerrainTool(active === tool.id ? null : tool.id)}>
              <Icon name={tool.icon} size={18} />
              {t(`terrain.tool.${tool.id}`)}
            </button>
          ))}
        </div>
        <div className={styles.hint}>{t(`nature.hint.${active ?? 'idle'}` as 'nature.hint.idle')}</div>
      </div>
      {cat === 'brush' && <BrushSettingsSection editing={editing} />}
      {(cat === 'landform' || cat === 'water') && active && active !== 'feature' && <NewFeatureParams tool={active} editing={editing} />}
      {cat === 'vegetation' && <ForestSection editing={editing} />}
      {cat === 'edit' && <FeatureEditor editing={editing} />}
    </>
  );
}

function BrushSettingsSection({ editing }: { editing: boolean }) {
  const t = useT();
  const s = useEditorStore();
  const ed = useEditorStore.getState;
  const delta = s.strokeDelta;
  return (
    <div className={styles.section}>
      <div className={styles.title}>{t('terrain.brush')}</div>
      <NumberField label={t('terrain.brushSize')} value={s.brushRadius} min={BRUSH_RADIUS_RANGE[0]} max={BRUSH_RADIUS_RANGE[1]} step={1} precision={0} unit="m" disabled={!editing} onChange={(v) => ed().setBrush({ radius: v })} />
      <NumberField label={t('terrain.brushStrength')} value={Math.round(s.brushStrength * 100)} min={5} max={100} step={5} precision={0} unit="%" disabled={!editing} onChange={(v) => ed().setBrush({ strength: v / 100 })} />
      <SelectField label={t('nature.falloff')} value={s.brushFalloff} disabled={!editing} onChange={(v) => ed().setBrushOptions({ brushFalloff: v })}
        options={FALLOFFS.map((f) => ({ value: f, label: t(`nature.falloff.${f}`) }))} />
      <Segmented size="small" value={s.brushShape} onChange={(v) => ed().setBrushOptions({ brushShape: v })}
        options={[{ value: 'circle', label: t('nature.shape.circle') }, { value: 'square', label: t('nature.shape.square') }]} />
      {s.terrainTool === 'noise' && (
        <div className={styles.row}>
          <NumberField label={t('terrain.seed')} value={s.brushSeed} min={0} max={999999} step={1} precision={0} onChange={(v) => ed().setBrushOptions({ brushSeed: Math.round(v) })} />
          <button className={styles.linkBtn} onClick={() => ed().setBrushOptions({ brushSeed: randomSeed() })}><Icon name="dice" size={13} /></button>
        </div>
      )}
      <ToggleField label={t('nature.heightLimit')} checked={s.brushMin !== null || s.brushMax !== null} disabled={!editing}
        onChange={(b) => ed().setBrushOptions(b ? { brushMin: -10, brushMax: 30 } : { brushMin: null, brushMax: null })} />
      {(s.brushMin !== null || s.brushMax !== null) && (
        <>
          <NumberField label={t('nature.heightMin')} value={s.brushMin ?? -40} min={-40} max={80} step={0.5} precision={1} unit="m" onChange={(v) => ed().setBrushOptions({ brushMin: v })} />
          <NumberField label={t('nature.heightMax')} value={s.brushMax ?? 80} min={-40} max={80} step={0.5} precision={1} unit="m" onChange={(v) => ed().setBrushOptions({ brushMax: v })} />
        </>
      )}
      {s.terrainTool === 'paint' && (
        <>
          <div className={styles.sub}>{t('terrain.paintType')}</div>
          <div className={styles.swatches}>
            {GROUND_MATERIALS.map((g) => (
              <button key={g.id} className={`${styles.swatch} ${s.paintType === g.id ? styles.active : ''}`} onClick={() => ed().setPaintType(g.id)} disabled={!editing}
                title={`${t('terrain.friction')} ${g.friction} · ${t('terrain.permeability')} ${g.permeability} · n ${g.manning} · ${t('nature.erodibility')} ${g.erodibility}`}>
                <span className={styles.chip} style={{ background: g.color }} />
                {t(g.labelKey)}
              </button>
            ))}
          </div>
          <div className={styles.note}>{t('nature.materials.note')}</div>
        </>
      )}
      {s.terrainTool === 'soil' && (
        <>
          <div className={styles.sub}>{t('terrain.soilType')}</div>
          <div className={styles.swatches}>
            {SOIL_PROFILES.map((g) => (
              <button key={g.id} className={`${styles.swatch} ${s.soilType === g.id ? styles.active : ''}`} onClick={() => ed().setSoilType(g.id)} disabled={!editing}
                title={`${t('terrain.soil.amp')} ×${g.amplification} · Vs30 ${g.vs30} m/s`}>
                <span className={styles.chip} style={{ background: g.color }} />
                {t(g.labelKey)}
              </button>
            ))}
          </div>
          <div className={styles.note}>{t('terrain.soil.note')}</div>
        </>
      )}
      {delta && (
        <div className={styles.note} data-testid="stroke-delta">{t('nature.strokeDelta', { up: delta.up.toFixed(2), down: (-delta.down).toFixed(2), area: Math.round(delta.area) })}</div>
      )}
      {s.brushPreview && (
        <div className={styles.note} data-testid="brush-preview">{t('terrain.preview', { up: s.brushPreview.up.toFixed(2), down: (-s.brushPreview.down).toFixed(2), area: Math.round(s.brushPreview.area) })}</div>
      )}
      <div className={styles.note}>{t('terrain.follow.note')}</div>
      {s.terrainTool === 'erode' && <div className={styles.note}>{t('nature.erode.note')}</div>}
    </div>
  );
}

/** Parameters for NEW features of the active tool. */
function NewFeatureParams({ tool, editing }: { tool: TerrainToolId; editing: boolean }) {
  const t = useT();
  const params = useNatureStore((s) => s.params);
  const kind = (tool === 'ridgeLine' ? 'ridge' : tool === 'valleyLine' ? 'valley' : tool) as keyof NatureParams;
  if (!(kind in params)) return null;
  const set = (patch: Record<string, unknown>) => useNatureStore.getState().setParams(kind, patch as never);
  return (
    <div className={styles.section}>
      <div className={styles.title}>{t('nature.newParams')}</div>
      <FeatureFields kind={kind} value={params[kind] as unknown as Record<string, unknown>} editing={editing} onChange={set} />
      <div className={styles.note}>{t(`nature.note.${kind}` as 'nature.note.mountain')}</div>
    </div>
  );
}

/** Editable parameters of a feature kind (shared by "new" and "selected"). */
function FeatureFields({ kind, value: v, editing, onChange }: { kind: string; value: Record<string, unknown>; editing: boolean; onChange: (patch: Record<string, unknown>) => void }) {
  const t = useT();
  const num = (key: string, label: string, [lo, hi]: readonly [number, number], step: number, unit = 'm', precision = 1, scale = 1) => (
    <NumberField key={key} label={t(label as 'nature.p.radius')} value={Number(v[key]) * scale} min={lo * scale} max={hi * scale} step={step} precision={precision} unit={unit} disabled={!editing}
      onChange={(x, live) => !live && onChange({ [key]: x / scale })} />
  );
  const seedRow = (
    <div className={styles.row} key="seed">
      <NumberField label={t('terrain.seed')} value={Number(v.seed ?? 1)} min={0} max={999999} step={1} precision={0} disabled={!editing} onChange={(x, live) => !live && onChange({ seed: Math.round(x) })} />
      <button className={styles.linkBtn} disabled={!editing} onClick={() => onChange({ seed: randomSeed() })}><Icon name="dice" size={13} /></button>
    </div>
  );
  const material = (
    <SelectField key="material" label={t('nature.p.material')} value={String(v.material)} disabled={!editing} onChange={(x) => onChange({ material: Number(x) })}
      options={NATURAL_GROUNDS.map((g) => ({ value: String(g.id), label: t(g.labelKey) }))} />
  );
  switch (kind) {
    case 'mountain':
    case 'hill':
      return <>{num('radius', 'nature.p.radius', LIMITS.peakRadius, 1)}{num('height', 'nature.p.height', kind === 'mountain' ? LIMITS.mountainHeight : LIMITS.hillHeight, 0.5)}{num('roughness', 'nature.p.roughness', LIMITS.roughness, 5, '%', 0, 100)}{seedRow}</>;
    case 'ridge':
    case 'valley':
    case 'canyon':
      return <>{num('width', 'nature.p.width', LIMITS.lineWidth, 1)}{num('height', kind === 'ridge' ? 'nature.p.height' : 'nature.p.depth', kind === 'ridge' ? LIMITS.ridgeHeight : LIMITS.valleyDepth, 0.5)}{num('roughness', 'nature.p.roughness', LIMITS.roughness, 5, '%', 0, 100)}{seedRow}</>;
    case 'river': {
      const m = v.meander as { amplitude: number; wavelength: number; seed: number };
      const w = v.water as { fill: number; inflow: number; downstream: 'open' | 'closed' };
      return (
        <>
          {num('width', 'nature.p.width', [MIN_RIVER_WIDTH, LIMITS.riverWidth[1]], 0.5)}
          {num('depth', 'nature.p.depth', LIMITS.riverDepth, 0.1)}
          {num('bankSlope', 'nature.p.bankSlope', LIMITS.bankSlope, 0.1, '', 1)}
          {material}
          <SelectField label={t('nature.p.grading')} value={String(v.grading)} disabled={!editing} onChange={(x) => onChange({ grading: x })}
            options={[{ value: 'downhill', label: t('nature.grading.downhill') }, { value: 'follow', label: t('nature.grading.follow') }]} />
          <SelectField label={t('nature.p.crossing')} value={String(v.crossing)} disabled={!editing} onChange={(x) => onChange({ crossing: x })}
            options={[{ value: 'culvert', label: t('nature.crossing.culvert') }, { value: 'embankment', label: t('nature.crossing.embankment') }]} />
          <NumberField label={t('nature.p.meander')} value={m.amplitude} min={0} max={LIMITS.meanderAmplitude[1]} step={1} precision={0} unit="m" disabled={!editing} onChange={(x, live) => !live && onChange({ meander: { ...m, amplitude: x } })} />
          {m.amplitude > 0 && <NumberField label={t('nature.p.wavelength')} value={m.wavelength} min={LIMITS.meanderWavelength[0]} max={LIMITS.meanderWavelength[1]} step={5} precision={0} unit="m" disabled={!editing} onChange={(x, live) => !live && onChange({ meander: { ...m, wavelength: x } })} />}
          <div className={styles.sub}>{t('nature.water')}</div>
          <NumberField label={t('nature.p.fill')} value={Math.round(w.fill * 100)} min={0} max={100} step={10} precision={0} unit="%" disabled={!editing} onChange={(x, live) => !live && onChange({ water: { ...w, fill: x / 100 } })} />
          <NumberField label={t('nature.p.inflow')} value={w.inflow} min={0} max={200} step={0.5} precision={1} unit="m³/s" disabled={!editing} onChange={(x, live) => !live && onChange({ water: { ...w, inflow: x } })} />
          <SelectField label={t('nature.p.downstream')} value={w.downstream} disabled={!editing} onChange={(x) => onChange({ water: { ...w, downstream: x } })}
            options={[{ value: 'open', label: t('nature.downstream.open') }, { value: 'closed', label: t('nature.downstream.closed') }]} />
          <div className={styles.note}>{t('nature.water.note')}</div>
        </>
      );
    }
    case 'lake':
      return (
        <>
          {'surface' in v && num('surface', 'nature.p.surface', [-40, 80], 0.1, 'm', 2)}
          {'freeboard' in v && num('freeboard', 'nature.p.freeboard', [0, 5], 0.1)}
          {num('depth', 'nature.p.depth', LIMITS.lakeDepth, 0.5)}
          {num('shoreWidth', 'nature.p.shoreWidth', LIMITS.shoreWidth, 1)}
          {material}
          <ToggleField label={t('nature.p.filled')} checked={Boolean(v.filled)} disabled={!editing} onChange={(b) => onChange({ filled: b })} />
          <div className={styles.note}>{t('nature.lake.note')}</div>
        </>
      );
    case 'coast':
      return (
        <>
          <Segmented size="small" value={Number(v.seaSide) as 1 | -1} onChange={(x) => onChange({ seaSide: x })}
            options={[{ value: 1, label: t('nature.seaSide.right') }, { value: -1, label: t('nature.seaSide.left') }]} />
          {num('beachSlope', 'nature.p.beachSlope', LIMITS.beachSlope, 0.5, '%', 1, 100)}
          {num('beachWidth', 'nature.p.beachWidth', LIMITS.beachWidth, 1)}
          {num('offshoreSlope', 'nature.p.offshoreSlope', LIMITS.offshoreSlope, 0.5, '%', 1, 100)}
          {num('maxDepth', 'nature.p.maxDepth', LIMITS.coastDepth, 0.5)}
          {material}
          <div className={styles.note}>{t('nature.coast.note')}</div>
        </>
      );
  }
  return null;
}

function ForestSection({ editing }: { editing: boolean }) {
  const t = useT();
  const f = useNatureStore((s) => s.forest);
  const set = useNatureStore.getState().setForest;
  return (
    <div className={styles.section}>
      <div className={styles.title}>{t('nature.forest')}</div>
      <NumberField label={t('terrain.brushSize')} value={f.radius} min={2} max={40} step={1} precision={0} unit="m" disabled={!editing} onChange={(v) => set({ radius: v })} />
      <NumberField label={t('nature.forest.density')} value={f.density} min={0.1} max={8} step={0.1} precision={1} unit="/100 m²" disabled={!editing} onChange={(v) => set({ density: v })} />
      <NumberField label={t('nature.forest.spacing')} value={f.spacing} min={1} max={20} step={0.5} precision={1} unit="m" disabled={!editing} onChange={(v) => set({ spacing: v })} />
      <NumberField label={t('nature.forest.conifer')} value={Math.round(f.coniferShare * 100)} min={0} max={100} step={10} precision={0} unit="%" disabled={!editing} onChange={(v) => set({ coniferShare: v / 100 })} />
      <NumberField label={t('nature.forest.slope')} value={f.slopeLimit} min={1} max={60} step={1} precision={0} unit="°" disabled={!editing} onChange={(v) => set({ slopeLimit: v })} />
      <NumberField label={t('nature.heightMin')} value={f.minElevation} min={-40} max={80} step={0.5} precision={1} unit="m" disabled={!editing} onChange={(v) => set({ minElevation: v })} />
      <NumberField label={t('nature.heightMax')} value={f.maxElevation} min={-40} max={80} step={0.5} precision={1} unit="m" disabled={!editing} onChange={(v) => set({ maxElevation: v })} />
      <ToggleField label={t('nature.forest.variation')} checked={f.variation} disabled={!editing} onChange={(b) => set({ variation: b })} />
      <div className={styles.row}>
        <NumberField label={t('terrain.seed')} value={f.seed} min={0} max={999999} step={1} precision={0} disabled={!editing} onChange={(v) => set({ seed: Math.round(v) })} />
        <button className={styles.linkBtn} onClick={() => set({ seed: randomSeed() })}><Icon name="dice" size={13} /></button>
      </div>
      <div className={styles.note}>{t('nature.forest.note')}</div>
      <VegetationOptions editing={editing} />
    </div>
  );
}

/** Project-level vegetation responses (opt-in, saved with the project). */
function VegetationOptions({ editing }: { editing: boolean }) {
  const t = useT();
  const veg = useWorldStore((s) => s.doc.settings.simulation.vegetation);
  const set = (patch: { canopyShelter?: boolean; floodResponse?: boolean }) => useWorldStore.getState().updateSimulationSettings({ vegetation: patch });
  return (
    <>
      <ToggleField label={t('nature.veg.canopy')} checked={!!veg?.canopyShelter} disabled={!editing} hint={t('nature.veg.canopy.hint')} onChange={(b) => set({ canopyShelter: b })} />
      <ToggleField label={t('nature.veg.flood')} checked={!!veg?.floodResponse} disabled={!editing} hint={t('nature.veg.flood.hint')} onChange={(b) => set({ floodResponse: b })} />
    </>
  );
}

/** Feature list + the selected feature's parameters, warnings and delete. */
function FeatureEditor({ editing }: { editing: boolean }) {
  const t = useT();
  const features = useWorldStore((s) => s.doc.landscape.features);
  const selected = useNatureStore((s) => s.selected);
  const f = features.find((x) => x.id === selected) ?? null;
  const warnings = useMemo(() => (f ? featureWarnings(f) : []), [f]);
  return (
    <div className={styles.section} data-testid="feature-editor">
      <div className={styles.title}>{t('nature.features', { n: features.length })}</div>
      <div className={styles.swatches}>
        {features.map((x) => (
          <button key={x.id} className={`${styles.swatch} ${x.id === selected ? styles.active : ''}`} data-feature={x.id} onClick={() => useNatureStore.getState().select(x.id)}>
            {t(`nature.kind.${x.kind}`)} {x.id}
          </button>
        ))}
      </div>
      {!features.length && <div className={styles.note}>{t('nature.features.none')}</div>}
      {f && (
        <>
          <div className={styles.sub}>{t(`nature.kind.${f.kind}`)} {f.id}{f.kind === 'mountain' || f.kind === 'hill' ? ` · ${t('nature.peak', { v: landformPeak(f).toFixed(1) })}` : ''}</div>
          <FeatureFields kind={f.kind} value={f as unknown as Record<string, unknown>} editing={editing} onChange={(patch) => updateFeature(f.id, patch as Partial<Feature>)} />
          {warnings.map((w) => <div key={w.code} className={styles.note} data-warning={w.code}>⚠ {t(`nature.warn.${w.code}`, { v: Number.isInteger(w.value ?? 0) ? String(w.value ?? 0) : (w.value ?? 0).toFixed(1) })}</div>)}
          <button disabled={!editing} data-testid="feature-delete" onClick={() => deleteFeature(f.id)}>{t('nature.delete')}</button>
          <div className={styles.note}>{t(f.kind === 'lake' ? 'nature.delete.lakeNote' : 'nature.delete.note')}</div>
        </>
      )}
    </div>
  );
}

/** Environment presets (Phase 19): whole editable landscapes, one undo step. */
export function EnvironmentSection({ editing }: { editing: boolean }) {
  const t = useT();
  const [kind, setKind] = useState<EnvironmentPreset>('mountainValley');
  const [seed, setSeed] = useState(1);
  return (
    <div className={styles.section}>
      <div className={styles.title}>{t('nature.env')}</div>
      <SelectField label={t('nature.env.kind')} value={kind} disabled={!editing} onChange={setKind}
        options={ENVIRONMENT_PRESETS.map((k) => ({ value: k, label: t(`nature.env.${k}`) }))} />
      <div className={styles.row}>
        <NumberField label={t('terrain.seed')} value={seed} min={0} max={999999} step={1} precision={0} disabled={!editing} onChange={(v) => setSeed(Math.round(v))} />
        <button className={styles.linkBtn} disabled={!editing} onClick={() => setSeed(randomSeed())}><Icon name="dice" size={13} /></button>
      </div>
      <button className={styles.apply} disabled={!editing} data-testid="env-apply" onClick={() => applyEnvironment(kind, seed)}>{t('nature.env.apply')}</button>
      <div className={styles.note}>{t('nature.env.note')}</div>
    </div>
  );
}
