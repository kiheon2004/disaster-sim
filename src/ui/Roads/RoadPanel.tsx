import { useMemo, useState } from 'react';
import { useT } from '@/i18n/i18n';
import { randomSeed } from '@/core/random';
import { useEditorStore } from '@/editor/editorStore';
import { useRoadStore, ROAD_MODES, type RoadMode } from '@/editor/roadStore';
import { useWorldStore } from '@/world/worldStore';
import { Icon, type IconName } from '@/ui/common/Icon';
import { NumberField, SelectField, ToggleField } from '@/ui/common/fields';
import { Segmented } from '@/ui/common/Segmented';
import { blocksOf } from '@/roads/blocks';
import { intersectionsOf } from '@/roads/intersections';
import { segmentLine } from '@/roads/network';
import { INFRA_KINDS, INFRA_SPACING, NEIGHBORHOODS, type FrontSide, type InfraKind } from '@/roads/city';
import {
  DRAINAGE_LEVELS, ELEVATION_POLICIES, LINK_POLICIES, PROFILE_LIMITS, PROFILE_PRESETS, ROAD_MATERIALS, SIDEWALK_SIDES, ZONE_TYPES,
  type RoadProfile, type ZoneType,
} from '@/roads/types';
import {
  addBuildingsAlong, addInfrastructure, addVehiclesAlong, assignZone, convertLegacyRoads, fillBlocks, linkedObjects, setLinkPolicyFor, updateRoadProfile,
} from '@/app/roadActions';
import styles from '@/ui/Terrain/TerrainPanel.module.css';

const MODE_ICONS: Record<RoadMode, IconName> = { draw: 'road', curve: 'line', edit: 'cursor', split: 'scale', delete: 'trash', zone: 'area' };

/** Left-panel tab of the Road Editing Mode (Phase 18). */
export function RoadPanel() {
  const t = useT();
  const editing = useEditorStore((s) => s.mode) === 'editor';
  const active = useEditorStore((s) => s.tool === 'road');
  const mode = useRoadStore((s) => s.mode);
  const roads = useWorldStore((s) => s.doc.roads);
  const legacy = useWorldStore((s) => Object.values(s.doc.objects).filter((o) => o.type === 'road').length);
  const rs = useRoadStore.getState;
  const stats = useMemo(() => {
    let len = 0;
    for (const s of Object.values(roads.segments)) len += segmentLine(roads, s).length;
    const junctions = [...intersectionsOf(roads).values()].filter((i) => i.junction).length;
    return { segments: Object.keys(roads.segments).length, junctions, len: Math.round(len) };
  }, [roads]);

  const setMode = (m: RoadMode) => {
    if (!active) useEditorStore.getState().setRoadEdit(true);
    rs().setMode(m);
  };

  return (
    <div className={styles.wrap} data-testid="road-panel">
      <div className={styles.scroll}>
        <div className={styles.section}>
          <div className={styles.title}>{t('panel.roads')}</div>
          <div className={styles.tools}>
            {ROAD_MODES.map((m) => (
              <button key={m} className={`${styles.tool} ${active && mode === m ? styles.active : ''}`} disabled={!editing} aria-pressed={active && mode === m}
                data-road-mode={m} onClick={() => setMode(m)}>
                <Icon name={MODE_ICONS[m]} size={18} />
                {t(`road.mode.${m}`)}
              </button>
            ))}
          </div>
          <div className={styles.hint}>{t(`road.hint.${mode}`)}</div>
          <div className={styles.note} data-testid="road-stats">{t('road.stats', stats)}</div>
        </div>

        <ProfileSection editing={editing} />
        <SelectionSection editing={editing} />
        <LinkSection editing={editing} />
        <CitySection editing={editing} />
        <InfraSection editing={editing} />
        <BuildingsSection editing={editing} />
        <VehiclesSection editing={editing} />
        <HoodSection editing={editing} />
        {legacy > 0 && (
          <div className={styles.section}>
            <div className={styles.title}>{t('road.legacy')}</div>
            <div className={styles.sub}>{t('road.legacy.count', { n: legacy })}</div>
            <button className={styles.apply} disabled={!editing} data-testid="road-convert-legacy" onClick={() => convertLegacyRoads()}>{t('road.legacy.convert')}</button>
            <div className={styles.note}>{t('road.legacy.note')}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Profile fields; they edit the profile for new roads, and — with a selection — the selected roads. */
export function ProfileFields({ value, onChange, disabled }: { value: RoadProfile; onChange: (patch: Partial<RoadProfile>) => void; disabled: boolean }) {
  const t = useT();
  return (
    <>
      <NumberField label={t('road.width')} value={value.width} min={PROFILE_LIMITS.width[0]} max={PROFILE_LIMITS.width[1]} step={0.5} precision={1} unit="m" disabled={disabled} onChange={(v, live) => !live && onChange({ width: v })} />
      <NumberField label={t('road.lanes')} value={value.lanes} min={PROFILE_LIMITS.lanes[0]} max={PROFILE_LIMITS.lanes[1]} step={1} precision={0} disabled={disabled} onChange={(v, live) => !live && onChange({ lanes: Math.round(v) })} />
      <ToggleField label={t('road.oneWay')} checked={value.oneWay} disabled={disabled} onChange={(v) => onChange({ oneWay: v })} />
      <SelectField label={t('road.material')} value={value.material} disabled={disabled} onChange={(v) => onChange({ material: v })}
        options={ROAD_MATERIALS.map((m) => ({ value: m, label: t(`road.material.${m}`) }))} />
      <SelectField label={t('road.sidewalk')} value={value.sidewalk} disabled={disabled} onChange={(v) => onChange({ sidewalk: v })}
        options={SIDEWALK_SIDES.map((m) => ({ value: m, label: t(`road.sidewalk.${m}`) }))} />
      {value.sidewalk !== 'none' && (
        <>
          <NumberField label={t('road.sidewalkWidth')} value={value.sidewalkWidth} min={PROFILE_LIMITS.sidewalkWidth[0]} max={PROFILE_LIMITS.sidewalkWidth[1]} step={0.1} precision={1} unit="m" disabled={disabled} onChange={(v, live) => !live && onChange({ sidewalkWidth: v })} />
          <NumberField label={t('road.curbHeight')} value={value.curbHeight * 100} min={PROFILE_LIMITS.curbHeight[0] * 100} max={PROFILE_LIMITS.curbHeight[1] * 100} step={1} precision={0} unit="cm" disabled={disabled} onChange={(v, live) => !live && onChange({ curbHeight: v / 100 })} />
        </>
      )}
      <SelectField label={t('road.elevation')} value={value.elevation} disabled={disabled} onChange={(v) => onChange({ elevation: v })}
        options={ELEVATION_POLICIES.map((m) => ({ value: m, label: t(`road.elevation.${m}`) }))} />
      <SelectField label={t('road.drainage')} value={value.drainage} disabled={disabled} onChange={(v) => onChange({ drainage: v })}
        options={DRAINAGE_LEVELS.map((m) => ({ value: m, label: t(`road.drainage.${m}`) }))} />
      <ToggleField label={t('road.markings')} checked={value.markings} disabled={disabled} onChange={(v) => onChange({ markings: v })} />
    </>
  );
}

function ProfileSection({ editing }: { editing: boolean }) {
  const t = useT();
  const profile = useRoadStore((s) => s.profile);
  const preset = useRoadStore((s) => s.preset);
  const rs = useRoadStore.getState;
  return (
    <div className={styles.section}>
      <div className={styles.title}>{t('road.profile')}</div>
      <SelectField label={t('road.preset')} value={preset ?? 'custom'} disabled={!editing}
        onChange={(v) => v !== 'custom' && rs().applyPreset(v)}
        options={[...Object.keys(PROFILE_PRESETS).map((k) => ({ value: k, label: t(`road.preset.${k}` as 'road.preset.street') })), { value: 'custom', label: t('road.preset.custom') }]} />
      <ProfileFields value={profile} disabled={!editing} onChange={(p) => rs().setProfile(p)} />
      <div className={styles.note}>{t('road.newRoads')}</div>
      <div className={styles.note}>{t(`road.elevation.note`)}</div>
    </div>
  );
}

function SelectionSection({ editing }: { editing: boolean }) {
  const t = useT();
  const selection = useRoadStore((s) => s.selection);
  const profile = useRoadStore((s) => s.profile);
  const ids = selection.segments;
  if (!ids.length) return null;
  return (
    <div className={styles.section}>
      <div className={styles.title}>{t('road.selection')}</div>
      <div className={styles.sub}>{t('road.selection.n', { n: ids.length })}</div>
      <button className={styles.apply} disabled={!editing} data-testid="road-apply-profile" onClick={() => updateRoadProfile(ids, profile)}>{t('road.applyToSelected')}</button>
    </div>
  );
}

function LinkSection({ editing }: { editing: boolean }) {
  const t = useT();
  const policy = useRoadStore((s) => s.linkPolicy);
  const selection = useRoadStore((s) => s.selection);
  useWorldStore((s) => s.doc.objects);
  const linked = linkedObjects(selection.segments).length;
  return (
    <div className={styles.section}>
      <div className={styles.title}>{t('road.links')}</div>
      <SelectField label={t('road.link.policy')} value={policy} disabled={!editing} onChange={(v) => useRoadStore.getState().setLinkPolicy(v)}
        options={LINK_POLICIES.map((p) => ({ value: p, label: t(`road.link.${p}`) }))} />
      {selection.segments.length > 0 && (
        <button disabled={!editing || !linked} onClick={() => setLinkPolicyFor(selection.segments, policy)}>{t('road.link.applyAll', { n: linked })}</button>
      )}
      <div className={styles.note}>{t('road.link.note')}</div>
    </div>
  );
}

function CitySection({ editing }: { editing: boolean }) {
  const t = useT();
  const roads = useWorldStore((s) => s.doc.roads);
  const block = useRoadStore((s) => s.block);
  const [seed, setSeed] = useState(1);
  const [scale, setScale] = useState(1);
  const blocks = useMemo(() => blocksOf(roads), [roads]);
  const sel = blocks.find((b) => b.id === block) ?? null;
  return (
    <div className={styles.section}>
      <div className={styles.title}>{t('road.city')}</div>
      <div className={styles.sub} data-testid="road-blocks">{t('road.city.blocks', { n: blocks.length })}</div>
      {sel ? (
        <>
          <div className={styles.hint}>{t('road.zone.selected', { area: Math.round(sel.area), zone: t(`road.zone.${sel.zone ?? 'none'}`) })}</div>
          <SelectField<ZoneType | 'none'> label={t('road.zone')} value={sel.zone ?? 'none'} disabled={!editing}
            onChange={(v) => assignZone(sel.id, v === 'none' ? null : v)}
            options={[{ value: 'none', label: t('road.zone.none') }, ...ZONE_TYPES.map((z) => ({ value: z, label: t(`road.zone.${z}`) }))]} />
        </>
      ) : <div className={styles.note}>{t('road.zone.noneSelected')}</div>}
      <div className={styles.row}>
        <NumberField label={t('road.city.seed')} value={seed} min={0} max={999999} step={1} precision={0} onChange={(v) => setSeed(Math.round(v))} />
        <button className={styles.linkBtn} onClick={() => setSeed(randomSeed())}><Icon name="dice" size={13} /></button>
      </div>
      <NumberField label={t('road.city.heightScale')} value={scale} min={0.5} max={2} step={0.1} precision={1} onChange={(v) => setScale(v)} />
      <button className={styles.apply} disabled={!editing || !sel?.zone} data-testid="road-fill-block" onClick={() => sel && fillBlocks([sel.id], seed, scale)}>{t('road.city.fill')}</button>
      <button disabled={!editing || !blocks.some((b) => b.zone)} onClick={() => fillBlocks([], seed, scale)}>{t('road.city.fillAll')}</button>
      <div className={styles.note}>{t('road.city.note')}</div>
    </div>
  );
}

function SideField({ value, onChange }: { value: FrontSide; onChange: (v: FrontSide) => void }) {
  const t = useT();
  return (
    <Segmented size="small" value={value} onChange={onChange}
      options={(['both', 'left', 'right'] as FrontSide[]).map((s) => ({ value: s, label: t(`road.side.${s}`) }))} />
  );
}

function InfraSection({ editing }: { editing: boolean }) {
  const t = useT();
  const selection = useRoadStore((s) => s.selection);
  const [kind, setKind] = useState<InfraKind>('streetLight');
  const [side, setSide] = useState<FrontSide>('both');
  const [spacing, setSpacing] = useState(INFRA_SPACING.streetLight);
  const spaced = kind !== 'sign' && kind !== 'signal';
  return (
    <div className={styles.section}>
      <div className={styles.title}>{t('road.infra')}</div>
      <SelectField label={t('road.infra.kind')} value={kind} onChange={(v) => { setKind(v); setSpacing(INFRA_SPACING[v] || 10); }}
        options={INFRA_KINDS.map((k) => ({ value: k, label: t(`road.infra.${k}`) }))} />
      {spaced && <SideField value={side} onChange={setSide} />}
      {spaced && <NumberField label={t('road.infra.spacing')} value={spacing} min={2} max={100} step={1} precision={0} unit="m" onChange={(v) => setSpacing(v)} />}
      <button className={styles.apply} disabled={!editing} data-testid="road-add-infra" onClick={() => addInfrastructure(selection.segments, kind, side, spacing)}>
        {selection.segments.length ? t('road.infra.add') : t('road.infra.addAll')}
      </button>
      <div className={styles.note}>{t('road.infra.note')}</div>
    </div>
  );
}

function BuildingsSection({ editing }: { editing: boolean }) {
  const t = useT();
  const selection = useRoadStore((s) => s.selection);
  const [zone, setZone] = useState<Exclude<ZoneType, 'park'>>('residential');
  const [side, setSide] = useState<FrontSide>('both');
  const [setback, setSetback] = useState(3);
  const [gap, setGap] = useState(4);
  const [slope, setSlope] = useState(20);
  const [seed, setSeed] = useState(1);
  return (
    <div className={styles.section}>
      <div className={styles.title}>{t('road.buildings')}</div>
      <SelectField label={t('road.zone')} value={zone} onChange={setZone}
        options={ZONE_TYPES.filter((z) => z !== 'park').map((z) => ({ value: z as Exclude<ZoneType, 'park'>, label: t(`road.zone.${z}`) }))} />
      <SideField value={side} onChange={setSide} />
      <NumberField label={t('road.buildings.setback')} value={setback} min={0} max={30} step={0.5} precision={1} unit="m" onChange={setSetback} />
      <NumberField label={t('road.buildings.gap')} value={gap} min={0} max={30} step={0.5} precision={1} unit="m" onChange={setGap} />
      <NumberField label={t('road.buildings.slope')} value={slope} min={1} max={45} step={1} precision={0} unit="°" onChange={setSlope} />
      <div className={styles.row}>
        <NumberField label={t('road.city.seed')} value={seed} min={0} max={999999} step={1} precision={0} onChange={(v) => setSeed(Math.round(v))} />
        <button className={styles.linkBtn} onClick={() => setSeed(randomSeed())}><Icon name="dice" size={13} /></button>
      </div>
      <button className={styles.apply} disabled={!editing} data-testid="road-add-buildings" onClick={() => addBuildingsAlong(selection.segments, zone, side, setback, gap, seed, slope)}>{t('road.buildings.add')}</button>
    </div>
  );
}

function VehiclesSection({ editing }: { editing: boolean }) {
  const t = useT();
  const selection = useRoadStore((s) => s.selection);
  const [mode, setMode] = useState<'lanes' | 'parked'>('lanes');
  const [spacing, setSpacing] = useState(18);
  return (
    <div className={styles.section}>
      <div className={styles.title}>{t('road.vehicles')}</div>
      <Segmented size="small" value={mode} onChange={setMode} options={[{ value: 'lanes', label: t('road.vehicles.lanes') }, { value: 'parked', label: t('road.vehicles.parked') }]} />
      <NumberField label={t('road.vehicles.spacing')} value={spacing} min={6} max={80} step={1} precision={0} unit="m" onChange={setSpacing} />
      <button disabled={!editing} data-testid="road-add-vehicles" onClick={() => addVehiclesAlong(selection.segments, mode, spacing, 1)}>{t('road.vehicles.add')}</button>
    </div>
  );
}

function HoodSection({ editing }: { editing: boolean }) {
  const t = useT();
  const hood = useRoadStore((s) => s.hood);
  const [seed, setSeed] = useState(1);
  const [deg, setDeg] = useState(0);
  const arm = (kind: (typeof NEIGHBORHOODS)[number]) => {
    if (useEditorStore.getState().tool !== 'road') useEditorStore.getState().setRoadEdit(true);
    useRoadStore.getState().setHood(hood?.kind === kind ? null : { kind, yaw: (deg * Math.PI) / 180, seed });
  };
  return (
    <div className={styles.section}>
      <div className={styles.title}>{t('road.hood')}</div>
      <div className={styles.swatches}>
        {NEIGHBORHOODS.map((k) => (
          <button key={k} className={`${styles.swatch} ${hood?.kind === k ? styles.active : ''}`} disabled={!editing} data-hood={k} onClick={() => arm(k)}>{t(`road.hood.${k}`)}</button>
        ))}
      </div>
      {hood && <div className={styles.hint}>{t('road.hood.placing')}</div>}
      <NumberField label={t('road.hood.rotation')} value={deg} min={-180} max={180} step={15} precision={0} unit="°" onChange={(v) => setDeg(v)} />
      <div className={styles.row}>
        <NumberField label={t('road.city.seed')} value={seed} min={0} max={999999} step={1} precision={0} onChange={(v) => setSeed(Math.round(v))} />
        <button className={styles.linkBtn} onClick={() => setSeed(randomSeed())}><Icon name="dice" size={13} /></button>
      </div>
      <div className={styles.note}>{t('road.hood.note')}</div>
    </div>
  );
}
