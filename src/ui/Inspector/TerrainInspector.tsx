import { useT } from '@/i18n/i18n';
import { useEditorStore } from '@/editor/editorStore';
import { useWorldStore } from '@/world/worldStore';
import { samplerFor } from '@/terrain/TerrainSampler';
import { Section } from '@/ui/common/Panel';
import { INFIL_RATE_FULL } from '@/simulation/water/waterParams';
import { initialWater } from '@/landscape/hydrology';
import { layerBreakdown } from '@/landscape/inspect';
import styles from './Inspector.module.css';

const sign = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`;

/** Values of the terrain at the point picked with the inspect tool (Terrain Editing Mode). */
export function TerrainInspector() {
  const t = useT();
  const probe = useEditorStore((s) => s.terrainProbe);
  const terrain = useWorldStore((s) => s.doc.terrain);
  const doc = useWorldStore((s) => s.doc);
  if (!probe) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyTitle}>{t('terrain.inspector.title')}</div>
        {t('terrain.inspector.empty')}
      </div>
    );
  }
  const s = samplerFor(terrain);
  const g = s.sampleGround(probe.x, probe.z);
  const rows: [string, string][] = [
    [t('terrain.position'), `${probe.x.toFixed(1)}, ${probe.z.toFixed(1)}`],
    [t('terrain.elevation'), `${s.sampleHeight(probe.x, probe.z).toFixed(2)} m`],
    [t('terrain.slope'), `${s.sampleSlope(probe.x, probe.z).toFixed(1)}°`],
    [t('terrain.ground'), t(g.labelKey)],
    [t('terrain.roughness'), `${g.roughness.toFixed(2)} *`],
    [t('terrain.friction'), `${g.friction.toFixed(2)} *`],
    [t('terrain.permeability'), `${g.permeability.toFixed(2)} *`],
  ];
  const soil = s.sampleSoil(probe.x, probe.z);
  rows.push(
    [t('terrain.soil'), t(soil.labelKey)],
    [t('terrain.soil.amp'), `×${soil.amplification.toFixed(2)} *`],
    [t('terrain.soil.vs'), `${soil.vs30} m/s *`],
    [t('terrain.soil.siteFreq'), `${soil.siteFrequency.toFixed(1)} Hz *`],
    [t('terrain.soil.damping'), `${(soil.damping * 100).toFixed(0)} % *`],
    [t('terrain.soil.bearing'), `${soil.bearingCapacity} kPa *`],
  );
  if (terrain.settings.waterLevel !== null) rows.push([t('terrain.waterDepth'), `${s.sampleWaterDepth(probe.x, probe.z).toFixed(2)} m`]);
  // Phase 19: infiltration capacity of the surface (water model), approximate.
  const water = doc.settings.simulation.water;
  const infil = g.permeability * INFIL_RATE_FULL * (water.infiltration ? water.infiltrationScale : 0);
  rows.push([t('nature.insp.infiltration'), `${infil.toFixed(0)} mm/h *`], [t('nature.insp.erodibility'), `${g.erodibility.toFixed(2)} *`]);
  // Initial water from the natural features (lakes / rivers) at this cell.
  const iw = initialWater(doc.landscape, terrain);
  if (iw) {
    const cx = Math.floor((probe.x - terrain.originX) / terrain.cellSize), cz = Math.floor((probe.z - terrain.originZ) / terrain.cellSize);
    const d = cx >= 0 && cz >= 0 && cx < terrain.nx - 1 && cz < terrain.nz - 1 ? iw[cz * (terrain.nx - 1) + cx] : 0;
    rows.push([t('nature.insp.initialWater'), `${d.toFixed(2)} m`]);
  }
  const b = layerBreakdown(doc.landscape, doc.roads, terrain, probe.x, probe.z);
  const layers: [string, string][] = [
    [t('nature.insp.base'), `${b.base.toFixed(2)} m`],
    [t('nature.insp.sculpt'), `${sign(b.sculpt)} m`],
    ...b.landforms.map((l): [string, string] => [`${t(`nature.kind.${l.kind}` as 'nature.kind.mountain')} ${l.id}`, `${sign(l.dh)} m`]),
    ...(b.carve ? [[`${t(`nature.kind.${b.carve.kind}` as 'nature.kind.river')} ${b.carve.id}`, `${sign(b.carve.dh)} m`] as [string, string]] : []),
    [t('nature.insp.natural'), `${b.natural.toFixed(2)} m`],
    [t('nature.insp.road'), `${sign(b.road)} m`],
    [t('nature.insp.final'), `${b.final.toFixed(2)} m`],
  ];
  const n = b.nearest;
  const nearby: [string, string][] = [
    [t('nature.insp.nearRoad'), n.road ? `${n.road.id} · ${n.road.dist.toFixed(1)} m` : '—'],
    [t('nature.insp.nearRiver'), n.river ? `${n.river.id} · ${n.river.dist.toFixed(1)} m` : '—'],
    [t('nature.insp.nearLake'), n.lake ? `${n.lake.id} · ${n.lake.inside ? t('nature.insp.inside') : `${n.lake.dist.toFixed(1)} m`}` : '—'],
    [t('nature.insp.nearCoast'), n.coast ? `${n.coast.id} · ${n.coast.dist >= 0 ? t('nature.insp.seaSide') : t('nature.insp.landSide')} ${Math.abs(n.coast.dist).toFixed(1)} m` : '—'],
  ];
  return (
    <Section title={t('terrain.inspector.title')}>
      <div className={styles.liveGrid} data-testid="terrain-inspector">
        {rows.map(([k, v]) => (
          <FragmentRow key={k} label={k} value={v} />
        ))}
      </div>
      <div className={styles.note}>{t('terrain.approx')}</div>
      <div className={styles.note} style={{ marginTop: 8, fontWeight: 600 }}>{t('nature.insp.layers')}</div>
      <div className={styles.liveGrid} data-testid="terrain-layers">
        {layers.map(([k, v]) => <FragmentRow key={k} label={k} value={v} />)}
      </div>
      <div className={styles.note} style={{ marginTop: 8, fontWeight: 600 }}>{t('nature.insp.nearby')}</div>
      <div className={styles.liveGrid}>
        {nearby.map(([k, v]) => <FragmentRow key={k} label={k} value={v} />)}
      </div>
      <div className={styles.note}>{t('nature.insp.note')}</div>
    </Section>
  );
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span>{label}</span>
      <span>{value}</span>
    </>
  );
}
