import { useT } from '@/i18n/i18n';
import { useEditorStore } from '@/editor/editorStore';
import { useWorldStore } from '@/world/worldStore';
import { samplerFor } from '@/terrain/TerrainSampler';
import { Section } from '@/ui/common/Panel';
import styles from './Inspector.module.css';

/** Values of the terrain at the point picked with the inspect tool (Terrain Editing Mode). */
export function TerrainInspector() {
  const t = useT();
  const probe = useEditorStore((s) => s.terrainProbe);
  const terrain = useWorldStore((s) => s.doc.terrain);
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
  return (
    <Section title={t('terrain.inspector.title')}>
      <div className={styles.liveGrid} data-testid="terrain-inspector">
        {rows.map(([k, v]) => (
          <FragmentRow key={k} label={k} value={v} />
        ))}
      </div>
      <div className={styles.note}>{t('terrain.approx')}</div>
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
