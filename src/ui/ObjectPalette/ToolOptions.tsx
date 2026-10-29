import { useT } from '@/i18n/i18n';
import { useEditorStore } from '@/editor/editorStore';
import { GRID_SIZES, ROTATION_STEPS, useBuildStore, BRUSH_LIMITS, type GridSize } from '@/editor/buildStore';
import { SCALE_BOUNDS, type TerrainAlign } from '@/editor/build/placementPlan';
import { NumberField, SelectField, Toggle } from '@/ui/common/fields';
import { Icon } from '@/ui/common/Icon';
import { Section } from '@/ui/common/Panel';
import styles from './ObjectPalette.module.css';

const b = () => useBuildStore.getState();

/** Options shared by the bulk tools: heading, scale, seed, terrain alignment, slope, overlaps. */
function PlacementOptions({ rotation }: { rotation: boolean }) {
  const t = useT();
  const p = useBuildStore((s) => s.placement);
  return (
    <>
      {rotation && <Toggle checked={p.randomRotation} onChange={(v) => b().setPlacement({ randomRotation: v })} label={t('opts.randomRotation')} />}
      <div className={styles.pair}>
        <NumberField label={`${t('opts.scale')} ${t('opts.scale.min')}`} value={p.scaleMin} min={SCALE_BOUNDS[0]} max={SCALE_BOUNDS[1]} step={0.05} precision={2} onChange={(v) => b().setPlacement({ scaleMin: v })} />
        <NumberField label={t('opts.scale.max')} value={p.scaleMax} min={SCALE_BOUNDS[0]} max={SCALE_BOUNDS[1]} step={0.05} precision={2} onChange={(v) => b().setPlacement({ scaleMax: v })} />
      </div>
      <SelectField<TerrainAlign>
        label={t('opts.align')}
        value={p.align}
        options={(['auto', 'upright', 'surface'] as const).map((v) => ({ value: v, label: t(`opts.align.${v}`) }))}
        onChange={(v) => b().setPlacement({ align: v })}
      />
      <NumberField label={t('opts.slopeLimit')} value={p.slopeLimit} min={0} max={90} step={1} precision={0} unit="°" onChange={(v) => b().setPlacement({ slopeLimit: v })} />
      <Toggle checked={p.avoidCollisions} onChange={(v) => b().setPlacement({ avoidCollisions: v })} label={t('opts.avoid')} />
      <div className={styles.seedRow}>
        <NumberField label={t('opts.seed')} value={p.seed} min={0} max={999_999} step={1} precision={0} onChange={(v) => b().setPlacement({ seed: Math.round(v) })} />
        <button className={styles.iconBtn} title={t('opts.seed.reroll')} onClick={() => b().rerollSeed()}><Icon name="dice" size={14} /></button>
      </div>
    </>
  );
}

function BrushOptions() {
  const t = useT();
  const brush = useBuildStore((s) => s.brush);
  return (
    <>
      <NumberField label={t('opts.brush.radius')} value={brush.radius} min={BRUSH_LIMITS.radius[0]} max={BRUSH_LIMITS.radius[1]} step={0.5} precision={1} unit="m" onChange={(v) => b().setBrushSettings({ radius: v })} />
      <NumberField label={`${t('opts.brush.density')} /100m²`} title={t('opts.brush.density.unit')} value={brush.density} min={BRUSH_LIMITS.density[0]} max={BRUSH_LIMITS.density[1]} step={0.1} precision={1} onChange={(v) => b().setBrushSettings({ density: v })} />
      <NumberField label={t('opts.spacing')} value={brush.spacing} min={BRUSH_LIMITS.spacing[0]} max={BRUSH_LIMITS.spacing[1]} step={0.25} precision={2} unit="m" onChange={(v) => b().setBrushSettings({ spacing: v })} />
    </>
  );
}

function LineOptions() {
  const t = useT();
  const line = useBuildStore((s) => s.line);
  return (
    <>
      <NumberField label={t('opts.spacing')} value={line.spacing} min={0.5} max={100} step={0.5} precision={1} unit="m" onChange={(v) => b().setLine({ spacing: v })} />
      <SelectField
        label={t('opts.line.orient')}
        value={line.orient}
        options={(['along', 'across', 'fixed'] as const).map((v) => ({ value: v, label: t(`opts.line.${v}`) }))}
        onChange={(v) => b().setLine({ orient: v })}
      />
      <NumberField label={t('opts.line.offset')} value={line.offset} min={-30} max={30} step={0.5} precision={1} unit="m" onChange={(v) => b().setLine({ offset: v })} />
      <Toggle checked={line.bothSides} onChange={(v) => b().setLine({ bothSides: v })} label={t('opts.line.bothSides')} disabled={line.offset === 0} />
    </>
  );
}

function AreaOptions() {
  const t = useT();
  const area = useBuildStore((s) => s.area);
  return (
    <>
      <SelectField
        label={t('opts.area.shape')}
        value={area.shape}
        options={(['rect', 'circle', 'brush'] as const).map((v) => ({ value: v, label: t(`opts.area.${v}`) }))}
        onChange={(v) => {
          b().setArea({ shape: v });
          b().setAreaSession({ shape: null, dragging: false });
        }}
      />
      {area.shape === 'brush' && <BrushRadiusOnly />}
      <SelectField
        label={t('opts.area.mode')}
        value={area.mode}
        options={(['random', 'grid'] as const).map((v) => ({ value: v, label: t(`opts.area.${v}`) }))}
        onChange={(v) => b().setArea({ mode: v })}
      />
      <NumberField label={t('opts.spacing')} value={area.spacing} min={0.5} max={50} step={0.5} precision={1} unit="m" onChange={(v) => b().setArea({ spacing: v })} />
      {area.mode === 'random'
        ? <NumberField label={`${t('opts.brush.density')} /100m²`} title={t('opts.brush.density.unit')} value={area.density} min={0.1} max={40} step={0.1} precision={1} onChange={(v) => b().setArea({ density: v })} />
        : <NumberField label={t('opts.area.jitter')} value={area.jitter} min={0} max={1} step={0.05} precision={2} onChange={(v) => b().setArea({ jitter: v })} />}
    </>
  );
}

function BrushRadiusOnly() {
  const t = useT();
  const radius = useBuildStore((s) => s.brush.radius);
  return <NumberField label={t('opts.brush.radius')} value={radius} min={BRUSH_LIMITS.radius[0]} max={BRUSH_LIMITS.radius[1]} step={0.5} precision={1} unit="m" onChange={(v) => b().setBrushSettings({ radius: v })} />;
}

function AssistOptions() {
  const t = useT();
  const s = useBuildStore((st) => st.snapping);
  const snap = useEditorStore((st) => st.snap);
  const randomize = useEditorStore((st) => st.randomize);
  return (
    <>
      <Toggle checked={snap} onChange={() => useEditorStore.getState().toggleSnap()} label={<>{t('palette.snap')} <span className={styles.kbd}>G</span></>} />
      <SelectField<string>
        label={t('opts.grid')}
        value={String(s.grid)}
        options={GRID_SIZES.map((g) => ({ value: String(g), label: g === 'auto' ? t('opts.grid.auto') : `${g} m` }))}
        onChange={(v) => b().setSnapping({ grid: (v === 'auto' ? 'auto' : Number(v)) as GridSize })}
      />
      <SelectField<string>
        label={t('opts.rotationStep')}
        value={String(s.rotationStep)}
        options={ROTATION_STEPS.map((r) => ({ value: String(r), label: `${r}°` }))}
        onChange={(v) => b().setSnapping({ rotationStep: Number(v) })}
      />
      <Toggle checked={s.surface} onChange={(v) => b().setSnapping({ surface: v })} label={t('opts.surface')} />
      <Toggle checked={s.collisionWarning} onChange={(v) => b().setSnapping({ collisionWarning: v })} label={t('opts.collisionWarning')} />
      <Toggle checked={randomize} onChange={() => useEditorStore.getState().toggleRandomize()} label={t('palette.randomize')} />
    </>
  );
}

function LastResult() {
  const t = useT();
  const r = useBuildStore((s) => s.lastResult);
  if (!r) return null;
  const reasons = Object.entries(r.reasons).map(([k, n]) => t(`opts.reason.${k}` as 'opts.reason.slope', { n })).join(', ');
  return <div className={styles.hint} data-testid="last-result">{t('opts.last', { placed: r.placed, skipped: r.skipped })}{reasons && ` (${reasons})`}</div>;
}

function PasteInfo() {
  const t = useT();
  const clip = useBuildStore((s) => s.clipboard);
  if (!clip) return <div className={styles.hint}>{t('opts.paste.empty')}</div>;
  return <div className={styles.hint}>{t('opts.paste.info', { count: clip.objects.length, w: clip.size[0].toFixed(1), d: clip.size[1].toFixed(1) })}</div>;
}

/** Options of the active build tool + placement assistance (left panel, under the palette). */
export function ToolOptions() {
  const t = useT();
  const tool = useEditorStore((s) => s.tool);
  const bulk = tool === 'brush' || tool === 'line' || tool === 'area';
  return (
    <div className={styles.options} data-testid="tool-options">
      <Section title={`${t('opts.title')} · ${t(`build.tool.${tool === 'terrain' || tool === 'road' ? 'select' : tool}`)}`}>
        <div className={styles.optBody}>
          {tool === 'select' && <div className={styles.hint}>{t('opts.select.info')}</div>}
          {tool === 'paste' && <PasteInfo />}
          {tool === 'brush' && <BrushOptions />}
          {tool === 'line' && <LineOptions />}
          {tool === 'area' && <AreaOptions />}
          {bulk && <PlacementOptions rotation={tool !== 'line'} />}
          {bulk && <LastResult />}
        </div>
      </Section>
      <Section key={bulk ? 'bulk' : 'single'} title={t('opts.assist')} defaultOpen={!bulk}>
        <div className={styles.optBody}>
          <AssistOptions />
        </div>
      </Section>
    </div>
  );
}
