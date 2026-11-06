import { useState } from 'react';
import type { TFunction } from '@/i18n/i18n';
import { useSimStore } from '@/simulation/simStore';
import { simulationController } from '@/simulation/SimulationController';
import { VEHICLE_DAMAGE, type VehicleEntity } from '@/simulation/vehicle/state';
import { aggregateVehicles, vehicleCsv, vehicleEntities, vehicleJson, vehicleRow, vehicleSeriesOf } from '@/simulation/vehicle/summary';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { Icon } from '@/ui/common/Icon';
import { displayName, fmt } from '@/ui/format';
import { damageColor, damageLabel, levelLabel, rolloverLabel, variantLabel } from '@/ui/Inspector/VehicleInspector';
import { Chart } from './PhysiologyResults';
import styles from './ResultsPanel.module.css';

const TABLE_ROWS = 200;
const NUM_TH = { textAlign: 'right' } as const;
const DEG = 180 / Math.PI;

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

/** Vehicle block of the results JSON (schema-versioned; undefined without vehicle dynamics). */
export function vehicleResultsJson() {
  const rt = simulationController.getRuntime();
  return rt ? vehicleJson(rt.entities.values(), useSimStore.getState().damageEvents, rt.vehicles, simulationController.getPhysics()) : undefined;
}

/** Vehicle CSV of the current run ('' without one). */
export function vehicleResultsCsv() {
  const rt = simulationController.getRuntime();
  return rt ? vehicleCsv(rt.entities.values(), useSimStore.getState().damageEvents, simulationController.getTime(), simulationController.getPhysics()) : '';
}

const nz = (x: number | null, d: number) => (x === null || !Number.isFinite(x) ? '–' : fmt(x, d));
const deg = (v: number[]) => v.map((x) => x * DEG);

/**
 * Vehicle results (Phase 35, vehicle-dynamics runs only): aggregate cards (cars, collisions, damage levels, rollovers, the
 * largest speed / Δv / load transfer, the largest energy-ledger residual, occupants), the cars table, a car's charts (time
 * axis s, units; NaN = gap — not computed, never drawn as 0) and the vehicle CSV.
 */
export function VehicleSummary({ t, name }: { t: TFunction; name: string }) {
  useSimStore((s) => Math.floor(s.time));
  useSimStore((s) => s.damageEvents.length);
  const objects = useWorldStore((s) => s.doc.objects);
  const selected = useEditorStore((s) => s.selectedId);
  const [pick, setPick] = useState<string | null>(null);
  const rt = simulationController.getRuntime();
  if (!rt?.vehicles) return null;
  const cars = vehicleEntities(rt.entities.values());
  if (!cars.length) return null;
  const physics = simulationController.getPhysics();
  const a = aggregateVehicles(cars, physics);
  const label = (id: string) => (objects[id] ? displayName(objects[id], t) : id);
  const charted = cars.filter((e) => e.vehicle.series && e.vehicle.series.t.length > 1);
  const who = charted.find((e) => e.id === pick) ?? charted.find((e) => e.id === selected) ?? charted[0];
  const s = who?.vehicle.series ?? null;
  const exportCsv = () => download(`${name || 'simulation'}-vehicles.csv`, vehicleResultsCsv(), 'text/csv');
  const rows = cars.slice(0, TABLE_ROWS).map((e) => vehicleRow(e, physics));
  const damaged = a.vehicles - a.damage.intact;
  const damageSub = VEHICLE_DAMAGE.filter((k) => k !== 'intact' && a.damage[k] > 0).map((k) => `${damageLabel(t, k)} ${a.damage[k]}`).join(' · ');
  const rolled = a.rollover.onSide + a.rollover.onRoof;
  const nc = t('vehicleUi.notComputed');
  const ser = (v: VehicleEntity, k: Parameters<typeof vehicleSeriesOf>[1], n: string, f?: (x: number[]) => number[]) => ({ name: n, v: f ? f(vehicleSeriesOf(v, k)) : vehicleSeriesOf(v, k) });
  return (
    <div className={styles.box} data-testid="vehicle-results">
      <div className={styles.boxTitle} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {t('vehicleUi.results.title')}
        <button className={styles.btn} style={{ marginLeft: 'auto' }} onClick={exportCsv} data-testid="vehicle-csv"><Icon name="save" size={13} /> {t('vehicleUi.results.csv')}</button>
      </div>
      <div style={{ fontSize: 11, color: '#ffd29a', fontWeight: 600 }}>{t('vehicleUi.limitation')}</div>
      <div className={styles.cards}>
        <Card label={t('vehicleUi.results.vehicles')} value={String(a.vehicles)} sub={t('vehicleUi.results.vehiclesSub', { w: a.wheeled, r: a.rigid })} />
        <Card label={t('vehicleUi.results.collisions')} value={String(a.collisions)} />
        <Card label={t('vehicleUi.results.damaged')} value={String(damaged)} sub={damageSub || damageLabel(t, 'intact')} />
        <Card label={t('vehicleUi.results.rollover')} value={String(rolled)} sub={t('vehicleUi.results.rolloverSub', { n: a.rollover.twoWheels })} />
        <Card label={t('vehicleUi.results.maxSpeed')} value={nz(a.maxSpeed, 1)} unit={a.maxSpeed === null ? '' : 'm/s'} sub={a.maxSpeed === null ? nc : `${fmt(a.maxSpeed * 3.6, 0)} km/h`} />
        <Card label={t('vehicleUi.results.maxDv')} value={nz(a.maxPeakDv, 1)} unit={a.maxPeakDv === null ? '' : 'm/s'} />
        <Card label={t('vehicleUi.results.maxLtr')} value={nz(a.maxPeakLtr, 2)} sub={t('vehicleUi.results.maxLtrSub')} />
        <Card label={t('vehicleUi.results.residual')} value={a.maxResidual === null ? '–' : fmt(a.maxResidual / 1000, 1)} unit={a.maxResidual === null ? '' : 'kJ'} sub={t('vehicleUi.results.residualSub')} />
        <Card label={t('vehicleUi.results.occupants')} value={String(a.occupantsSeated)} sub={t('vehicleUi.results.occupantsSub', { n: a.occupantsEjected })} />
        <Card label={t('vehicleUi.results.stalled')} value={String(a.stalled)} />
      </div>
      <div style={{ maxHeight: 260, overflow: 'auto', marginTop: 8 }}>
        <table className={styles.table} data-testid="vehicle-table">
          <thead>
            <tr>
              <th>{t('vehicleUi.results.col.car')}</th><th>{t('vehicleUi.results.col.model')}</th>
              <th className={styles.num} style={NUM_TH}>{t('vehicleUi.results.col.speed')}</th><th>{t('vehicleUi.results.col.damage')}</th>
              <th className={styles.num} style={NUM_TH}>{t('vehicleUi.results.col.peakDv')}</th><th>{t('vehicleUi.results.col.rollover')}</th>
              <th className={styles.num} style={NUM_TH}>{t('vehicleUi.results.col.peakLtr')}</th><th className={styles.num} style={NUM_TH}>{t('vehicleUi.results.col.collisions')}</th>
              <th className={styles.num} style={NUM_TH}>{t('vehicleUi.results.col.occupants')}</th><th className={styles.num} style={NUM_TH}>{t('vehicleUi.results.col.residual')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} onClick={() => setPick(r.id)} style={r.id === who?.id ? { background: 'var(--accent-soft)' } : undefined}>
                <td>{label(r.id)}</td>
                <td>{levelLabel(t, r.level)} · {variantLabel(t, r.variant)}</td>
                <td className={styles.num}>{nz(r.speed, 2)}</td>
                <td style={{ color: damageColor(r.damageLevel) }}>{damageLabel(t, r.damageLevel)}</td>
                <td className={styles.num}>{fmt(r.peakDv, 1)}</td>
                <td>{rolloverLabel(t, r.rollover)}</td>
                <td className={styles.num}>{nz(r.peakLtr, 2)}</td>
                <td className={styles.num}>{r.collisions}</td>
                <td className={styles.num}>{r.occupantsSeated}{r.occupantsEjected ? ` / ${r.occupantsEjected}` : ''}</td>
                <td className={styles.num}>{r.residual === null ? '–' : fmt(r.residual / 1000, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {cars.length > TABLE_ROWS && <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('vehicleUi.results.more', { n: cars.length - TABLE_ROWS })}</div>}
      </div>
      {who && s ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 11.5 }}>
            <span style={{ color: 'var(--text-2)' }}>{t('vehicleUi.results.chartsOf')}</span>
            <select value={who.id} onChange={(ev) => setPick(ev.target.value)} aria-label={t('vehicleUi.results.chartsOf')} data-testid="vehicle-chart-car" style={{ fontSize: 11.5 }}>
              {charted.map((e) => <option key={e.id} value={e.id}>{label(e.id)}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }} data-testid="vehicle-charts">
            <Chart title={t('vehicleUi.ch.speed')} unit="m/s" t={s.t} empty={nc} testId="vehicle-chart-speed"
              series={[ser(who.vehicle, 'speed', t('vehicleUi.ch.body')), ser(who.vehicle, 'wheelSpeed', t('vehicleUi.ch.wheels'))]} />
            <Chart title={t('vehicleUi.ch.accel')} unit="m/s²" t={s.t} empty={nc} testId="vehicle-chart-accel"
              series={[ser(who.vehicle, 'accelLong', t('vehicleUi.ch.long')), ser(who.vehicle, 'accelLat', t('vehicleUi.ch.lat'))]} />
            <Chart title={t('vehicleUi.ch.yawRate')} unit="rad/s" t={s.t} empty={nc} testId="vehicle-chart-yaw" series={[ser(who.vehicle, 'yawRate', '')]} />
            <Chart title={t('vehicleUi.ch.attitude')} unit="°" t={s.t} empty={nc} testId="vehicle-chart-attitude"
              series={[ser(who.vehicle, 'roll', t('vehicleUi.ch.roll'), deg), ser(who.vehicle, 'pitch', t('vehicleUi.ch.pitch'), deg)]} />
            <Chart title={t('vehicleUi.ch.slip')} unit="" t={s.t} empty={nc} testId="vehicle-chart-slip" series={[ser(who.vehicle, 'slip', '')]} />
            <Chart title={t('vehicleUi.ch.ltr')} unit="" t={s.t} empty={nc} testId="vehicle-chart-ltr" series={[ser(who.vehicle, 'load', '')]} />
            <Chart title={t('vehicleUi.ch.torque')} unit="N·m" t={s.t} empty={nc} testId="vehicle-chart-torque"
              series={[ser(who.vehicle, 'drive', t('vehicleUi.ch.drive')), ser(who.vehicle, 'brake', t('vehicleUi.ch.brake'))]} />
            <Chart title={t('vehicleUi.ch.damage')} unit="" t={s.t} empty={nc} testId="vehicle-chart-damage" series={[ser(who.vehicle, 'damage', '')]} />
            <Chart title={t('vehicleUi.ch.residual')} unit="J" t={s.t} empty={nc} testId="vehicle-chart-residual" series={[ser(who.vehicle, 'energy', '')]} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>{t('vehicleUi.results.chartNote')}</div>
        </>
      ) : (
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>{t('vehicleUi.results.noSeries')}</div>
      )}
    </div>
  );
}
