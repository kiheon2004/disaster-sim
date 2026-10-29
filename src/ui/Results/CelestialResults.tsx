import type { MessageKey, TFunction } from '@/i18n/i18n';
import { useSimStore, type CelestialLive } from '@/simulation/simStore';
import { simulationController } from '@/simulation/SimulationController';
import { energyText } from '@/thermal/units';
import { Icon } from '@/ui/common/Icon';
import { fmt } from '@/ui/format';
import { sci } from '@/ui/Viewport/CelestialHud';
import { symEigenvalues } from '@/celestial/tidal';
import styles from './ResultsPanel.module.css';

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Card({ label, value, unit, sub }: { label: string; value: string; unit?: string; sub?: string }) {
  return (
    <div className={styles.card}>
      <span className={styles.cardLabel} title={label}>{label}</span>
      <span className={styles.cardValue}>{value}{unit && <span style={{ fontSize: 11, color: 'var(--text-2)', marginLeft: 3 }}>{unit}</span>}</span>
      {sub && <span className={styles.cardSub} title={sub}>{sub}</span>}
    </div>
  );
}

const COLORS = ['#7ff0c0', '#ffb35c', '#7fb6ff', '#e98bff'];

/** One time-series chart (linear axes printed at both ends; NaN = the series is absent there, e.g. captured). */
function Chart({ title, unit, series, t, testId, log }: { title: string; unit: string; series: (number[] | undefined)[]; t: number[]; testId: string; log?: boolean }) {
  const vals = series.flatMap((s) => (s ?? []).filter(Number.isFinite));
  if (t.length < 2 || !vals.length) return null;
  const tr = (v: number) => (log ? Math.log10(Math.max(1e-30, Math.abs(v))) : v);
  let lo = Math.min(...vals.map(tr)), hi = Math.max(...vals.map(tr));
  if (hi - lo < 1e-12) { hi += 0.5; lo -= 0.5; }
  const x = (k: number) => ((t[k] - t[0]) / Math.max(1e-9, t[t.length - 1] - t[0])) * 200;
  const y = (v: number) => 46 - ((tr(v) - lo) / (hi - lo)) * 42;
  const label = (v: number) => (log ? `10^${v.toFixed(1)}` : sci(v));
  return (
    <div style={{ flex: '1 1 46%', minWidth: 220 }} data-testid={testId}>
      <div style={{ fontSize: 11, color: 'var(--text-2)', display: 'flex', justifyContent: 'space-between' }}><span>{title}</span><span>{label(hi)} {unit}</span></div>
      <svg width="100%" viewBox="0 0 200 50" preserveAspectRatio="none" style={{ height: 60, background: 'rgba(255,150,110,0.05)', borderRadius: 4 }}>
        {series.map((s, i) => s && (
          <polyline key={i} points={s.map((v, k) => (Number.isFinite(v) ? `${x(k)},${y(v)}` : '')).filter(Boolean).join(' ')} fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth={1.3} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <div style={{ fontSize: 10, color: 'var(--text-3)', display: 'flex', justifyContent: 'space-between' }}><span>{fmt(t[0], 1)} s</span><span>{label(lo)} {unit}</span><span>{fmt(t[t.length - 1], 1)} s</span></div>
    </div>
  );
}

/** Dynamic bodies under the celestial field (results CSV / JSON): distance to the nearest source, field, tide. */
export function celestialObjects() {
  const env = simulationController.getEnvironment(), f = env.gravity.field, ph = simulationController.getPhysics();
  if (!f || !ph || !f.points.live.length) return undefined;
  const g: [number, number, number] = [0, 0, 0];
  const T = new Float64Array(9);
  return [...(simulationController.getRuntime()?.entities.values() ?? [])].filter((e) => e.dynamic || e.flags.captured).map((e) => {
    const p = e.pose.position;
    const near = f.points.nearest(p[0], p[1], p[2]);
    f.sample(p[0], p[1], p[2], g);
    const v = e.body !== null ? ph.getLinearVelocity(e.body) : [NaN, NaN, NaN];
    return { object: e.id, type: e.source.type, mass_kg: e.source.physics.mass, state: e.flags.captured ? 'captured' : 'free', distance_m: +near.d.toFixed(3), g_ms2: +Math.hypot(...g).toFixed(4), tidal_s2: +symEigenvalues(f.gradient(p[0], p[1], p[2], T))[0].toExponential(4), speed_ms: +Math.hypot(v[0], v[1], v[2]).toFixed(4), x: +p[0].toFixed(3), y: +p[1].toFixed(3), z: +p[2].toFixed(3) };
  });
}

/**
 * Celestial experiment results (Phase 32): cards, the time-series charts (distance, speed, acceleration, energy,
 * angular momentum of the probes; tidal stretch, captured mass, source mass, structural failures), CSV with units,
 * model, scope and the reason of every missing value; the JSON carries the live summary.
 */
export function CelestialSummary({ t, name }: { t: TFunction; name: string }) {
  const c = useSimStore((x) => x.celestial);
  if (!c) return null;
  const s = c.stats, L = c.ledger;
  const ts = c.series.map((p) => p.t);
  const nP = Math.min(4, c.probes.length);
  const per = (k: 'r' | 'v' | 'a' | 'e' | 'l') => Array.from({ length: nP }, (_, i) => c.series.map((p) => p[k][i]));
  const exportCsv = () => download(`${name || 'simulation'}-celestial.csv`, celestialCsv(c), 'text/csv');
  return (
    <div className={styles.box} data-testid="celestial-results">
      <div className={styles.boxTitle} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {t('results.celestial.title')}
        <button className={styles.btn} style={{ marginLeft: 'auto' }} onClick={exportCsv} data-testid="celestial-csv"><Icon name="save" size={13} /> {t('results.celestial.csv')}</button>
      </div>
      {c.experiments.some((e) => e.scale === 'educational') && <div style={{ fontSize: 11, color: '#ffd29a', fontWeight: 600 }}>{t('celestial.lim.scaled')}</div>}
      <div className={styles.cards}>
        <Card label={t('results.celestial.sources')} value={String(s.sources.length)} sub={s.sources.map((q) => `M ${sci(q.mass)} kg`).join(' · ')} />
        <Card label={t('results.celestial.accel')} value={sci(s.maxAccel)} unit="m/s²" sub={t('results.celestial.tidalSub', { l: sci(s.maxTidal, 2) })} />
        <Card label={t('results.celestial.captured')} value={String(L.count)} sub={t('results.celestial.capturedSub', { m: fmt(L.mass / 1000, 3), r: L.massResidual.toExponential(1) })} />
        <Card label={t('results.celestial.momentum')} value={fmt(Math.hypot(...L.constraintImpulse) / 1000, 2)} unit="kN·s" sub={t('results.celestial.momentumSub', { w: energyText(L.constraintWork) })} />
        <Card label={t('results.celestial.energy')} value={energyText(L.unresolved)} sub={t('results.celestial.energySub', { k: energyText(L.kinetic), u: energyText(L.potential) })} />
        <Card label={t('results.celestial.structures')} value={String(c.structures.failures)} sub={t('results.celestial.structuresSub', { u: c.structures.loadedUnits, p: c.structures.uplifted, a: fmt(c.structures.peakLateral, 2) })} />
        <Card label={t('results.celestial.integrator')} value={String(s.maxSubsteps)} sub={t('results.celestial.integratorSub', { a: s.meanSubsteps.toFixed(1), c: s.capped })} />
        <Card label={t('results.celestial.limit')} value={t(`celestialHud.limit.${s.limit}` as MessageKey)} sub={s.limitReason ? t(`celestialHud.reason.${s.limitReason}` as MessageKey) : t('results.celestial.noLimit')} />
      </div>
      {c.probes.length > 0 && (
        <div style={{ fontSize: 11, marginTop: 4 }} data-testid="celestial-probe-table">
          {c.probes.map((p) => (
            <div key={p.id} className="mono">{p.id}: {t(`celestial.probeState.${p.state}` as MessageKey)} · r {fmt(p.diag.rMin, 2)}–{fmt(p.diag.rMax, 2)} m · {p.diag.conserved ? t('celestial.inspect.errors') : t('celestial.inspect.changes')} ΔE/E {p.diag.maxErr.toExponential(1)} · ΔL/L {p.diag.lErr.toExponential(1)}{Number.isFinite(p.diag.period) ? ` · T ${fmt(p.diag.period, 3)} s` : ''}</div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }} data-testid="celestial-charts">
        <Chart title={t('results.celestial.ch.r')} unit="m" series={per('r')} t={ts} testId="celestial-chart-r" />
        <Chart title={t('results.celestial.ch.v')} unit="m/s" series={per('v')} t={ts} testId="celestial-chart-v" />
        <Chart title={t('results.celestial.ch.a')} unit="m/s²" series={per('a')} t={ts} testId="celestial-chart-a" log />
        <Chart title={t('results.celestial.ch.e')} unit="J/kg" series={per('e')} t={ts} testId="celestial-chart-e" />
        <Chart title={t('results.celestial.ch.l')} unit="m²/s" series={per('l')} t={ts} testId="celestial-chart-l" />
        <Chart title={t('results.celestial.ch.tidal')} unit="s⁻²" series={[c.series.map((p) => p.maxTidal)]} t={ts} testId="celestial-chart-tidal" log />
        <Chart title={t('results.celestial.ch.captured')} unit="kg" series={[c.series.map((p) => p.capturedMass)]} t={ts} testId="celestial-chart-captured" />
        <Chart title={t('results.celestial.ch.mass')} unit="kg" series={c.series[0]?.sourceMass.map((_, i) => c.series.map((p) => p.sourceMass[i])) ?? []} t={ts} testId="celestial-chart-mass" />
        <Chart title={t('results.celestial.ch.failures')} unit="" series={[c.series.map((p) => p.failures)]} t={ts} testId="celestial-chart-failures" />
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>{t('results.celestial.note')}</div>
    </div>
  );
}

/** CSV of a celestial run: experiments, model and scope, sources, ledgers, captures, probes, bodies, history. */
export function celestialCsv(c: CelestialLive): string {
  const num = (v: number, why = 'not-defined') => (Number.isFinite(v) ? String(v) : why);
  const L = c.ledger, s = c.stats;
  return [
    '# model: Newtonian point masses with Plummer softening (real G); capture radius = educational parameter; no general relativity',
    '# scope: speeds < 0.1 c, substeps <= 256 per 1/60 s; KDK for free bodies, Rapier first order in contact steps; sources held on prescribed paths (no N-body)',
    '# celestial experiments (spec, SI units: kg, m, s)', 'name,scenario,scale,start_s,duration_s,end,sources,probes,particles,tidal,lensing_visual,disc_visual,limitPolicy',
    ...c.experiments.map((e) => [e.name, e.scenario, e.scale, e.start, e.duration, e.end, e.sources, e.probes, e.particles, e.tidal, e.lensing, e.disc, e.limitPolicy].join(',')), '',
    '# sources now', 'owner,index,mass_kg,mu_m3s2,rs_reference_m,softening_m,capture_m,x,y,z,policy,moving',
    ...s.sources.map((q) => [q.owner, q.index, q.mass, q.mu, q.rs, q.eps, q.capture, q.x, q.y, q.z, q.policy, q.moving].join(',')), '',
    '# capture ledger', 'quantity,value,unit', `count,${L.count},`, `mass,${L.mass},kg`, `grown,${L.grown},kg`, `stored,${L.stored},kg`, `massResidual,${L.massResidual},kg`,
    `momentum,${L.momentum.join(';')},kg·m/s`, `constraintImpulse,${L.constraintImpulse.join(';')},N·s`, `constraintWork,${L.constraintWork},J`, `kinetic,${L.kinetic},J`, `kineticRelative,${L.kineticRel},J`, `potential,${L.potential},J`, `unresolvedEnergy,${L.unresolved},J (no radiation / heating model)`,
    ...Object.entries(L.byKind).map(([k, v]) => `byKind.${k},${v.n};${v.m},count;kg`),
    `particles.placed,${L.particles.placed},kg`, `particles.flying,${L.particles.flying},kg`, `particles.captured,${L.particles.captured},kg`, `particles.landed,${L.particles.landed},kg`, `particles.left,${L.particles.left},kg`, `particles.dissipated,${L.particles.dissipated},J`, `particles.residual,${L.particles.residual},kg`, `probesLeft,${L.probesLeft},kg`, '',
    '# captures (last 50)', 't_s,kind,id,mass_kg,px,py,pz,Jx,Jy,Jz,constraintWork_J,kinetic_J,kineticRel_J,potential_J,massBefore_kg,massAfter_kg,policy',
    ...L.records.map((r) => [r.t.toFixed(3), r.kind, r.id, r.mass, ...r.momentum, ...r.constraintImpulse, r.constraintWork, r.kinetic, r.kineticRel, r.potential, r.massBefore, r.massAfter, r.policy].join(',')), '',
    '# integrator', 'quantity,value,unit', `maxSubsteps,${s.maxSubsteps},`, `meanSubsteps,${s.meanSubsteps},`, `cappedSteps,${s.capped},`, `limit,${s.limit},`, `limitReason,${s.limitReason || 'none'},`, `stop,${c.stop ? `${c.stop.reason}@${c.stop.time}` : 'none'},`, '',
    '# structures', 'quantity,value,unit', `failures,${c.structures.failures},`, `upliftedMembers,${c.structures.uplifted},`, `laterallyLoadedUnits,${c.structures.loadedUnits},`, `peakLateralField,${c.structures.peakLateral},m/s²`, '',
    '# probes (orbit diagnostics; errors when the field is static and central, otherwise changes)', 'id,state,mass_kg,r_m,rMin_m,rMax_m,v_ms,a_ms2,E0_Jkg,E_Jkg,maxRelErrE,relErrL,revolutions,period_s,conserved',
    ...c.probes.map((p) => [p.id, p.state, p.mass, p.diag.r, p.diag.rMin, p.diag.rMax, p.diag.v, p.diag.a, p.diag.e0, p.diag.e, p.diag.maxErr, p.diag.lErr, p.diag.revs, num(p.diag.period, 'fewer-than-two-revolutions'), p.diag.conserved].join(',')), '',
    '# bodies', 'object,type,mass_kg,state,distance_m,g_ms2,tidal_s2,speed_ms,x,y,z', ...(celestialObjects() ?? []).map((o) => Object.values(o).map((v) => (typeof v === 'number' && !Number.isFinite(v) ? 'captured-no-body' : v)).join(',')), '',
    '# history (probe columns: first four probes; "absent" = captured / left / not spawned)', `t_s,${[0, 1, 2, 3].map((i) => `r${i}_m,v${i}_ms,a${i}_ms2,E${i}_Jkg,L${i}_m2s`).join(',')},maxTidal_s2,capturedMass_kg,sourceMass_kg,failures`,
    ...c.series.map((p) => [p.t.toFixed(2), ...[0, 1, 2, 3].flatMap((i) => [p.r[i], p.v[i], p.a[i], p.e[i], p.l[i]].map((v) => (v === undefined || !Number.isFinite(v) ? 'absent' : v.toPrecision(8)))), p.maxTidal, p.capturedMass, p.sourceMass.join(';'), p.failures].join(',')),
  ].join('\n');
}
