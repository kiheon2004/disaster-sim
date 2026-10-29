import { useMemo } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { BuildingDesign } from '@/buildings/types';
import { useMemberStore } from '@/editor/memberStore';
import { graphOf } from '@/structure/graph';
import { StructuralSolver } from '@/structure/solver';
import { CONNECTION_KEYS, OVERLOAD } from '@/structure/types';
import { removalPreview } from '@/structure/preview';
import { Section } from '@/ui/common/Panel';
import { ModelBadge } from '@/ui/common/ModelBadge';
import { fmt } from '@/ui/format';
import styles from './Building.module.css';

/** Original-world solution of a design (connections' loads / capacities in the editor). */
const solved = new WeakMap<BuildingDesign, StructuralSolver>();
function solverOf(d: BuildingDesign) {
  let s = solved.get(d);
  if (!s) { s = new StructuralSolver(graphOf(d)); s.init(); solved.set(d, s); }
  return s;
}

/**
 * Structure of the selected member(s) in the building editor (Phase 25): its load-transfer
 * connections in the original world (load, capacity, utilization) and the REMOVAL PREVIEW — the
 * simulation's collapse model run with these members removed suddenly (alternate-path check):
 * which members follow, and whether the collapse stays local, partial or global.
 */
export function StructurePreview({ design, ids }: { design: BuildingDesign; ids: string[] }) {
  const t = useT();
  const preview = useMemberStore((s) => s.preview);
  const setPreview = useMemberStore((s) => s.setPreview);
  const s = useMemo(() => solverOf(design), [design]);
  const g = s.g;
  const idx = ids.map((id) => design.members.findIndex((m) => m.id === id)).filter((i) => i >= 0);
  const current = preview && preview.design === design && preview.result.removed.join() === ids.join() ? preview.result : null;
  const one = idx.length === 1 ? idx[0] : -1;
  const edges: number[] = [];
  if (one >= 0) for (let e = g.eStart[one]; e < g.eStart[one + 1]; e++) edges.push(e);
  const kN = (v: number) => (v === Infinity ? '—' : fmt(v / 1000, 1));
  return (
    <Section title={t('struct.edit.title')} defaultOpen={false}>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}><ModelBadge id="structureLoadPath" /><ModelBadge id="structureCollapse" /></div>
      {one >= 0 && (
        <>
          <div className={styles.summary} data-testid="member-demand">
            <span>{t('struct.member.util')}</span><span>{fmt(s.uN[one], 2)} / {fmt(s.uM[one], 2)} / {fmt(s.uV[one], 2)} ({t('struct.edit.limit', { u: OVERLOAD })})</span>
            <span>{t('struct.member.capacities')}</span><span>{kN(g.capN[one])} kN · {kN(g.capM[one])} kN·m · {kN(g.capV[one])} kN</span>
          </div>
          {edges.length > 0 ? (
            <table className={styles.compare} style={{ marginTop: 6 }} data-testid="member-connections-edit">
              <thead><tr><th>{t('struct.col.connection')}</th><th>{t('struct.col.support')}</th><th>kN</th><th>{t('struct.col.capacity')}</th></tr></thead>
              <tbody>
                {edges.map((e) => (
                  <tr key={e} className={s.eUtil[e] > 1 ? styles.worse : ''}>
                    <td>{t(`struct.conn.${CONNECTION_KEYS[g.eKind[e]]}` as MessageKey)} T{g.eTier[e]}</td>
                    <td>{design.members[g.eTo[e]].id}</td>
                    <td>{kN(s.share[e])}</td>
                    <td>{kN(g.eCap[e])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className={styles.note}>{t(g.ground[one] ? 'struct.edit.onGround' : 'struct.edit.noConnections')}</div>}
          <div className={styles.note} style={{ marginTop: 4 }}>{t('struct.edit.tiers')}</div>
        </>
      )}
      <div className={styles.row} style={{ marginTop: 8 }}>
        <button data-testid="removal-preview" disabled={!idx.length} onClick={() => setPreview({ design, result: removalPreview(design, ids) })}>{t('struct.edit.preview', { n: idx.length })}</button>
        {current && <button onClick={() => setPreview(null)}>{t('struct.edit.clear')}</button>}
      </div>
      {current && (
        <div style={{ marginTop: 6 }} data-testid="removal-result">
          <div className={styles.summary}>
            <span>{t('struct.level')}</span><span className={current.level === 'partial' || current.level === 'global' ? styles.worse : ''}>{t(`struct.level.${current.level}` as MessageKey)}</span>
            <span>{t('struct.edit.followers')}</span><span>{current.failed.length}</span>
            <span>{t('struct.edit.fallen')}</span><span>{fmt(current.fallen / 1000, 1)} t ({fmt(current.share * 100, 1)} %)</span>
            <span>{t('struct.edit.impacts')}</span><span>{current.impacts} / {current.arrests}</span>
            <span>{t('struct.edit.time')}</span><span>{fmt(current.seconds, 1)} s · {fmt(current.ms, 0)} ms</span>
          </div>
          {current.failed.length > 0 && (
            <div className={styles.note} style={{ marginTop: 4 }}>
              {current.failed.slice(0, 12).map((f) => `${f.id} (${t(`struct.cause.${f.cause}` as MessageKey)})`).join(', ')}{current.failed.length > 12 ? ' …' : ''}
            </div>
          )}
          <div className={styles.note} style={{ marginTop: 4 }}>{t('struct.edit.previewNote')}</div>
        </div>
      )}
    </Section>
  );
}
