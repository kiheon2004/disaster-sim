import { useMemo } from 'react';
import { useT } from '@/i18n/i18n';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { useRoadStore } from '@/editor/roadStore';
import { Section } from '@/ui/common/Panel';
import { NumberField, ToggleField } from '@/ui/common/fields';
import { minRadius } from '@/roads/curve';
import { naturalOf, nodeElevation, segmentSlopes } from '@/roads/bake';
import { degree, networkWarnings, segmentLine } from '@/roads/network';
import { intersectionsOf } from '@/roads/intersections';
import { DRAIN_SPACING, INLET_CAPACITY, roadPhysics } from '@/roads/materials';
import type { RoadNetwork, RoadSegment } from '@/roads/types';
import { deleteRoadSegments, linkedObjects, mergeRoadsAt, setRoadNodeElevation, updateRoadProfile } from '@/app/roadActions';
import { ProfileFields } from './RoadPanel';
import styles from '@/ui/Inspector/Inspector.module.css';

/** Storm-drain inlets of a segment: both curbs, one per spacing (subgrid sinks in the flood model). */
export function inletCount(n: RoadNetwork, s: RoadSegment): number {
  const spacing = DRAIN_SPACING[s.profile.drainage];
  if (!spacing) return 0;
  return Math.max(1, Math.floor(segmentLine(n, s).length / spacing)) * 2;
}

function Rows({ rows }: { rows: [string, string, 'computed' | 'approx' | null][] }) {
  const t = useT();
  return (
    <div className={styles.liveGrid}>
      {rows.map(([k, v, tag]) => (
        <FragmentRow key={k} label={k} value={tag ? `${v}  · ${t(tag === 'computed' ? 'road.computed' : 'road.approx')}` : v} />
      ))}
    </div>
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

/** Right panel in Road Editing Mode: the selected road(s) / node (KO/EN). */
export function RoadInspector() {
  const t = useT();
  const selection = useRoadStore((s) => s.selection);
  const roads = useWorldStore((s) => s.doc.roads);
  const terrain = useWorldStore((s) => s.doc.terrain);
  const editing = useEditorStore((s) => s.mode) === 'editor';
  useWorldStore((s) => s.doc.objects);
  const segs = selection.segments.map((id) => roads.segments[id]).filter((s): s is RoadSegment => !!s);
  const warnings = useMemo(() => networkWarnings(roads), [roads]);
  const node = selection.node ? roads.nodes[selection.node] : null;

  if (!segs.length && !node) {
    return (
      <div className={styles.empty} data-testid="road-inspector">
        <div className={styles.emptyTitle}>{t('road.inspector.title')}</div>
        {t('road.selection.none')}
      </div>
    );
  }
  const nat = naturalOf(terrain, roads);
  return (
    <div data-testid="road-inspector">
      {segs.length > 0 && (() => {
        const s = segs[0];
        const line = segmentLine(roads, s);
        const slopes = segmentSlopes(terrain, nat, roads, s);
        const phys = roadPhysics(s.profile.material);
        const inlets = segs.reduce((a, x) => a + inletCount(roads, x), 0);
        const totalLen = segs.reduce((a, x) => a + segmentLine(roads, x).length, 0);
        const ints = intersectionsOf(roads);
        const r = minRadius(line);
        const segWarn = warnings.filter((w) => w.segment && selection.segments.includes(w.segment));
        const ixWarn = [s.a, s.b].flatMap((nd) => ints.get(nd)?.warnings ?? []);
        const rows: [string, string, 'computed' | 'approx' | null][] = [
          [t('road.inspector.length'), `${(segs.length > 1 ? totalLen : line.length).toFixed(1)} m`, 'computed'],
          [t('road.width'), `${s.profile.width.toFixed(1)} m · ${t('road.lanes')} ${s.profile.lanes}${s.profile.oneWay ? ` · ${t('road.oneWay')}` : ''}`, null],
          [t('road.material'), t(`road.material.${s.profile.material}`), null],
          [t('road.elevation'), t(`road.elevation.${s.profile.elevation}`), null],
          [t('road.inspector.grade'), `${(slopes.grade * 100).toFixed(1)} %`, 'computed'],
          [t('road.inspector.crossSlope'), `${(slopes.crossSlope * 100).toFixed(1)} %`, 'computed'],
          [t('road.inspector.cutFill'), `${slopes.cutFill.toFixed(2)} m`, 'computed'],
          [t('road.inspector.minRadius'), Number.isFinite(r) ? `${r.toFixed(0)} m` : '∞', 'computed'],
          [t('road.inspector.connections'), t('road.inspector.connectionsVal', { a: degree(roads, s.a) - 1, b: degree(roads, s.b) - 1 }), null],
          [t('road.drainage'), t(`road.drainage.${s.profile.drainage}`), null],
          [t('road.inspector.inlets'), t('road.inspector.inletsVal', { n: inlets, q: (inlets * INLET_CAPACITY).toFixed(3) }), 'approx'],
          [t('road.inspector.friction'), phys.friction.toFixed(2), 'approx'],
          [t('road.inspector.permeability'), phys.permeability.toFixed(2), 'approx'],
          [t('road.inspector.condition'), `${Math.round((1 - (s.condition ?? 0)) * 100)} %`, null],
          [t('road.inspector.linked'), String(linkedObjects(selection.segments).length), null],
        ];
        return (
          <>
            <Section title={segs.length > 1 ? t('road.selection.n', { n: segs.length }) : `${t('road.inspector.title')} ${s.id}`}>
              <Rows rows={rows} />
              {(segWarn.length > 0 || ixWarn.length > 0) && (
                <div className={styles.note} data-testid="road-warnings">
                  {t('road.inspector.warnings')}: {[...segWarn.map((w) => t(`road.issue.${w.code}`, { v: (w.value ?? 0).toFixed(0) })), ...ixWarn.map((w) => t(`road.issue.${w}`, { v: '' }))].join(' · ')}
                </div>
              )}
              <div className={styles.note}>{t('road.inspector.approxNote')}</div>
            </Section>
            <Section title={t('road.profile')}>
              <ProfileFields value={s.profile} disabled={!editing} onChange={(p) => updateRoadProfile(selection.segments, p)} />
              <button disabled={!editing} data-testid="road-delete" onClick={() => deleteRoadSegments(selection.segments)}>{t('road.delete')}</button>
            </Section>
          </>
        );
      })()}
      {node && (
        <Section title={`${t('road.node')} ${node.id}`}>
          <Rows rows={[
            ['x, z', `${node.x.toFixed(1)}, ${node.z.toFixed(1)}`, null],
            [t('road.node.elevation'), `${nodeElevation(terrain, nat, node).toFixed(2)} m`, node.y === null ? 'computed' : null],
            [t('road.inspector.connections'), t('road.node.degree', { n: degree(roads, node.id) }), null],
          ]} />
          <ToggleField label={t('road.node.fixed')} checked={node.y !== null} disabled={!editing}
            onChange={(v) => setRoadNodeElevation(node.id, v ? Math.round(nodeElevation(terrain, nat, node) * 100) / 100 : null)} />
          {node.y !== null && (
            <NumberField label={t('road.node.elevation')} value={node.y} min={-40} max={80} step={0.1} precision={2} unit="m" disabled={!editing}
              onChange={(v, live) => !live && setRoadNodeElevation(node.id, v)} />
          )}
          {degree(roads, node.id) === 2 && <button disabled={!editing} onClick={() => mergeRoadsAt(node.id)}>{t('road.merge')}</button>}
        </Section>
      )}
    </div>
  );
}
