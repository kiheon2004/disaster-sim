import { Fragment } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { WorldObject } from '@/core/model';
import { useSimStore } from '@/simulation/simStore';
import { simulationController } from '@/simulation/SimulationController';
import { useViewStore } from '@/rendering/viewStore';
import { graphOf } from '@/structure/graph';
import { CONNECTION_KEYS, MEMBER_STATE_KEYS, MS, OVERLOAD, FAIL_CAUSES } from '@/structure/types';
import { TIER_GROUND, TIER_MERGED, TIER_SOIL } from '@/structure/solver';
import { ACCOUNTS } from '@/structure/ledger';
import type { CollapseModel } from '@/structure/collapse';
import { MEMBER_TYPES } from '@/buildings/types';
import { Section } from '@/ui/common/Panel';
import { ModelBadge } from '@/ui/common/ModelBadge';
import { fmt } from '@/ui/format';
import styles from './Building.module.css';

const SEQUENCE_ROWS = 40;

/**
 * Structural state of a modular building in the simulation (Phase 25): everything here is read from
 * the collapse engine's computed state; approximations are labelled (model badges).
 */
export function StructureSection({ obj }: { obj: WorldObject }) {
  const t = useT();
  useSimStore((s) => s.time);
  const e = simulationController.getRuntime()?.entities.get(obj.id);
  const mr = e?.modular;
  if (!e || !mr) return null;
  const st = mr.structure;
  const m = st?.model;
  if (!m) {
    const g = graphOf(mr.design, mr.scale);
    let damaged = 0;
    for (let i = 0; i < g.n; i++) if (mr.damage[i] >= 0.3 && !g.absent[i]) damaged++;
    return (
      <Section title={t('struct.title')} defaultOpen={false}>
        <div className={styles.summary} data-testid="structure-state">
          <span>{t('struct.level')}</span><span>{t(damaged ? 'struct.level.damaged' : 'struct.level.intact')}</span>
          <span>{t('struct.members')}</span><span>{g.n}</span>
          <span>{t('struct.damaged')}</span><span>{damaged}</span>
          <span>{t('struct.connections')}</span><span>{g.edges}</span>
        </div>
        <div className={styles.note} style={{ marginTop: 6 }}>{t('struct.untouched')}</div>
      </Section>
    );
  }
  const g = m.g;
  const level = st!.level ?? m.collapseLevel();
  const ids = mr.design.members;
  const failedByType: Record<string, number> = {};
  let damaged = 0, severe = 0, transfer = 0, alive = 0, lostGround = 0, reducedGround = 0, edgesFailed = 0;
  let minCap = 1, maxU = 0, gov = -1;
  for (let i = 0; i < m.n; i++) {
    const s = m.state[i];
    if (s === MS.ABSENT) continue;
    if (s > MS.SEVERE) { if (g.structural[i] || g.type[i] >= 4) failedByType[ids[i].type] = (failedByType[ids[i].type] ?? 0) + 1; continue; }
    alive++;
    if (s === MS.DAMAGED) damaged++;
    if (s === MS.SEVERE) severe++;
    const tier = m.s.tier[i];
    if (tier === 1 || tier === 2 || tier === TIER_MERGED) transfer++;
    if ((g.ground[i] || g.soilFallback[i]) && (tier === TIER_GROUND || tier === TIER_SOIL)) {
      if (m.s.groundFactor[i] < 0.05) lostGround++;
      else if (m.s.groundFactor[i] < 0.999) reducedGround++;
    }
    if (g.structural[i]) {
      minCap = Math.min(minCap, m.s.capFactor[i]);
      if (m.s.util[i] > maxU) { maxU = m.s.util[i]; gov = i; }
    }
  }
  for (let k = 0; k < m.s.edgeAlive.length; k++) if (!m.s.edgeAlive[k]) edgesFailed++;
  const causes: Record<string, number> = {};
  const hazards: Record<string, number> = {};
  for (const r of m.records) {
    if (r.cause === 'facade') continue;
    causes[r.cause] = (causes[r.cause] ?? 0) + 1;
    const h = r.hazard || 'original';
    hazards[h] = (hazards[h] ?? 0) + 1;
  }
  const structural = m.records.filter((r) => r.cause !== 'facade');
  const L = m.ledger;
  const integrity = m.superMass > 0 ? m.standingMass() / m.superMass : 1;
  return (
    <>
      <Section title={t('struct.title')}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
          <ModelBadge id="structureLoadPath" />
          <ModelBadge id="structureCollapse" />
        </div>
        <div className={styles.summary} data-testid="structure-state">
          <span>{t('struct.level')}</span><span data-testid="structure-level">{t(`struct.level.${level}` as MessageKey)}</span>
          <span>{t('struct.integrity')}</span><span>{fmt(integrity * 100, 1)} %</span>
          <span>{t('struct.failed')}</span><span>{MEMBER_TYPES.filter((k) => failedByType[k]).map((k) => `${t(`member.type.${k}` as MessageKey)} ${failedByType[k]}`).join(' · ') || '0'}</span>
          <span>{t('struct.damaged')}</span><span>{damaged} / {severe}</span>
          <span>{t('struct.loadPath')}</span><span>{t('struct.loadPathValue', { alive, transfer })}</span>
          <span>{t('struct.connectionsFailed')}</span><span>{edgesFailed} / {g.edges}</span>
          <span>{t('struct.foundation')}</span><span>{t('struct.foundationValue', { lost: lostGround, reduced: reducedGround })}</span>
          <span>{t('struct.residual')}</span><span>{fmt(minCap * 100, 0)} %</span>
          <span>{t('struct.maxUtil')}</span><span>{fmt(maxU, 2)} / {OVERLOAD}{gov >= 0 ? ` (${ids[gov].id})` : ''}</span>
          <span>{t('struct.causes')}</span><span>{Object.entries(causes).map(([c, n]) => `${t(`struct.cause.${c}` as MessageKey)} ${n}`).join(' · ') || '—'}</span>
          <span>{t('struct.hazards')}</span><span>{Object.entries(hazards).map(([h, n]) => `${t(`hazardName.${h}` as MessageKey)} ${n}`).join(' · ') || '—'}</span>
          <span>{t('struct.blocks')}</span><span>{m.blocks.filter((b) => b.active).length} / {m.blocks.length}</span>
        </div>
        <div className={styles.note} style={{ marginTop: 6 }}>{t('struct.computedNote')}</div>
      </Section>
      <Section title={t('struct.sequence')} defaultOpen={structural.length > 0 && structural.length < 60}>
        {structural.length === 0 ? <div className={styles.note}>{t('struct.noFailures')}</div> : (
          <table className={styles.compare} data-testid="collapse-sequence">
            <thead><tr><th>t s</th><th>{t('struct.col.member')}</th><th>{t('struct.col.cause')}</th><th>{t('struct.col.trigger')}</th><th>{t('struct.col.hazard')}</th></tr></thead>
            <tbody>
              {structural.slice(0, SEQUENCE_ROWS).map((r) => (
                <tr key={r.seq}>
                  <td>{fmt(r.time, 2)}</td>
                  <td>{ids[r.i].id}</td>
                  <td>{t(`struct.cause.${r.cause}` as MessageKey)}{r.secondary ? ' *' : ''}</td>
                  <td>{r.trigger >= 0 ? ids[r.trigger].id : '—'}</td>
                  <td>{t(`hazardName.${r.hazard || 'original'}` as MessageKey)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {structural.length > SEQUENCE_ROWS && <div className={styles.note}>{t('struct.moreRows', { n: structural.length - SEQUENCE_ROWS })}</div>}
        <div className={styles.note} style={{ marginTop: 4 }}>{t('struct.secondaryNote')}</div>
      </Section>
      <Section title={t('struct.ledger')} defaultOpen={false}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}><ModelBadge id="rubblePile" /><ModelBadge id="collapseDust" /></div>
        <div className={styles.summary} data-testid="mass-ledger">
          {ACCOUNTS.map((a) => (
            <Fragment key={a}><span>{t(`struct.account.${a}` as MessageKey)}</span><span>{fmt(L.mass[a] / 1000, 2)} t</span></Fragment>
          ))}
          <span>{t('struct.residualMass')}</span><span>{L.residual().toExponential(1)} kg</span>
          <span>{t('struct.energy')}</span><span>{fmt(L.energy.released / 1e6, 2)} MJ → {fmt(L.energy.collision / 1e6, 2)} / {fmt(L.energy.absorbed / 1e6, 2)} / {fmt(L.energy.ground / 1e6, 2)}</span>
          <span>{t('struct.momentum')}</span><span>{fmt(L.momentum.inherited / 1000, 1)} / {fmt(L.momentum.impulse / 1000, 1)} t·m/s</span>
        </div>
        <div className={styles.note} style={{ marginTop: 6 }}>{t('struct.ledgerNote')}</div>
      </Section>
      <MemberSection obj={obj} model={m} />
    </>
  );
}

/** The member picked in the viewport (simulation mode): its computed state, demand and connections. */
function MemberSection({ obj, model: m }: { obj: WorldObject; model: CollapseModel }) {
  const t = useT();
  const pick = useViewStore((s) => s.simMember);
  if (!pick || pick.owner !== obj.id || pick.member >= m.n) return null;
  const i = pick.member;
  const g = m.g, s = m.s;
  const mem = obj.building!.members[i];
  const rec = m.records.find((r) => r.i === i);
  const ids = obj.building!.members;
  const edges: number[] = [];
  for (let e2 = g.eStart[i]; e2 < g.eStart[i + 1]; e2++) edges.push(e2);
  const kN = (v: number) => (v === Infinity ? '—' : fmt(v / 1000, 1));
  return (
    <Section title={t('struct.member', { id: mem.id })}>
      <div className={styles.summary} data-testid="member-structure">
        <span>{t('struct.member.state')}</span><span>{t(`struct.state.${MEMBER_STATE_KEYS[m.state[i]]}` as MessageKey)}</span>
        <span>{t('struct.member.damage')}</span><span>{fmt(Math.min(1, m.damage[i]) * 100, 0)} %</span>
        <span>{t('struct.member.capacity')}</span><span>{fmt(s.capFactor[i] * 100, 0)} %</span>
        <span>{t('struct.member.load')}</span><span>{kN(s.load[i])} kN</span>
        <span>{t('struct.member.util')}</span><span>{fmt(s.uN[i], 2)} / {fmt(s.uM[i], 2)} / {fmt(s.uV[i], 2)}</span>
        <span>{t('struct.member.capacities')}</span><span>{kN(g.capN[i])} kN · {kN(g.capM[i])} kN·m · {kN(g.capV[i])} kN</span>
        <span>{t('struct.member.tier')}</span><span>{t(`struct.tier.${s.tier[i]}` as MessageKey)}</span>
        {(g.ground[i] || g.soilFallback[i]) ? <><span>{t('struct.member.ground')}</span><span>{fmt(s.groundFactor[i] * 100, 0)} %</span></> : null}
        {rec && <><span>{t('struct.member.failure')}</span><span>{fmt(rec.time, 2)} s · {t(`struct.cause.${rec.cause}` as MessageKey)} · {t(`hazardName.${rec.hazard || 'original'}` as MessageKey)}</span></>}
        {rec && rec.trigger >= 0 && <><span>{t('struct.member.chain')}</span><span>{ids[rec.trigger].id} ← … {ids[rec.root].id} ({rec.depth})</span></>}
        {rec?.secondary && <><span>{t('struct.member.striker')}</span><span>{rec.secondary.striker} ({rec.secondary.sourceMember ?? rec.secondary.source})</span></>}
      </div>
      {edges.length > 0 && (
        <table className={styles.compare} style={{ marginTop: 6 }} data-testid="member-connections">
          <thead><tr><th>{t('struct.col.connection')}</th><th>{t('struct.col.support')}</th><th>kN</th><th>{t('struct.col.capacity')}</th></tr></thead>
          <tbody>
            {edges.map((e2) => (
              <tr key={e2} className={s.edgeAlive[e2] ? '' : styles.worse}>
                <td>{t(`struct.conn.${CONNECTION_KEYS[g.eKind[e2]]}` as MessageKey)} T{g.eTier[e2]}</td>
                <td>{ids[g.eTo[e2]].id}</td>
                <td>{kN(s.share[e2])}</td>
                <td>{s.edgeAlive[e2] ? kN(g.eCap[e2]) : t('struct.conn.failed')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className={styles.note} style={{ marginTop: 6 }}>{t('struct.member.note')}</div>
    </Section>
  );
}

export { FAIL_CAUSES };
