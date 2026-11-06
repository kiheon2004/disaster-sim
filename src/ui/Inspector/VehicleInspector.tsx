import { Fragment } from 'react';
import { isMessageKey, useT, type MessageKey, type TFunction } from '@/i18n/i18n';
import type { EntityId } from '@/core/types';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { VEHICLE_DAMAGE } from '@/simulation/vehicle/state';
import { vehicleRow, type VehicleCarEntity } from '@/simulation/vehicle/summary';
import { useWorldStore } from '@/world/worldStore';
import { Section } from '@/ui/common/Panel';
import { displayName, fmt } from '@/ui/format';
import { VehicleControlSection } from './VehicleControls';
import styles from './Inspector.module.css';

/** Damage level colours (neutral → violet; an educational index, not a crash rating). */
export const DAMAGE_COLORS = ['#8a8f98', '#e6d14a', '#f5973b', '#ef4d4d', '#c43bd6'] as const;
export const damageColor = (l: string) => DAMAGE_COLORS[Math.max(0, VEHICLE_DAMAGE.indexOf(l as (typeof VEHICLE_DAMAGE)[number]))];
const DEG = 180 / Math.PI;

function Rows({ rows, testId }: { rows: [string, React.ReactNode][]; testId: string }) {
  return (
    <div className={styles.liveGrid} data-testid={testId}>
      {rows.map(([k, v], i) => (
        <Fragment key={`${k}:${i}`}>
          <span>{k}</span>
          <span>{v}</span>
        </Fragment>
      ))}
    </div>
  );
}

/** Translated label of a key family with a fallback key (an id is never shown as a raw i18n key). */
function label(t: TFunction, prefix: string, id: string | null | undefined, fallback: MessageKey): string {
  if (id === null || id === undefined) return t('vehicleUi.notComputed');
  const k = `${prefix}.${id}`;
  return isMessageKey(k) ? t(k) : t(fallback);
}
export const damageLabel = (t: TFunction, l: string) => label(t, 'vehicleUi.damage', l, 'vehicleUi.other');
export const rolloverLabel = (t: TFunction, s: string) => label(t, 'vehicleUi.roll', s, 'vehicleUi.other');
export const occupantLabel = (t: TFunction, s: string) => label(t, 'vehicleUi.occ', s, 'vehicleUi.other');
export const seatLabel = (t: TFunction, s: string) => label(t, 'vehicleUi.seat', s, 'vehicleUi.other');
export const sourceLabel = (t: TFunction, s: string) => label(t, 'vehicleUi.src', s, 'vehicleUi.other');
export const driveLabel = (t: TFunction, d: string) => label(t, 'vehicleUi.drive', d, 'vehicleUi.other');
export const tireLabel = (t: TFunction, m: string) => label(t, 'vehicleUi.tire', m, 'vehicleUi.other');
export const levelLabel = (t: TFunction, l: string) => label(t, 'vehicleUi.level', l, 'vehicleUi.other');
export const variantLabel = (t: TFunction, v: string) => label(t, 'vehicleUi.variant', v, 'vehicleUi.other');
export const partnerLabel = (t: TFunction, p: string) => label(t, 'vehicleUi.partner', p, 'vehicleUi.other');
/** Driver-limit cause: 'noDriver' / 'physical', or the physiology causes ('thermal+gas') / the combined capacity level. */
export function driverCauseLabel(t: TFunction, cause: string | null): string {
  if (!cause) return t('vehicleUi.none');
  return cause.split('+').map((c) => {
    for (const k of [`vehicleUi.cause.${c}`, `physioUi.comp.${c}`, `physioUi.cap.${c}`]) if (isMessageKey(k)) return t(k);
    return t('vehicleUi.cause.other');
  }).join(' · ');
}

/** Value with unit, or "not computed" (never 0 for a missing value). */
export const vval = (t: TFunction, x: number | null, d: number, unit = '') => (x === null || !Number.isFinite(x) ? t('vehicleUi.notComputed') : `${fmt(x, d)}${unit ? ` ${unit}` : ''}`);
const pct = (x: number) => `${fmt(x * 100, 0)} %`;
const kJ = (t: TFunction, x: number | null) => vval(t, x === null ? null : x / 1000, 1, 'kJ');

/**
 * Vehicle of the selected car (Phase 35, live; vehicle-dynamics runs): mass properties, motion in body axes, the effective
 * inputs and where they come from, powertrain, per-wheel contact / load / slip / suspension / spin, damage, rollover state with
 * the load-transfer ratio, the capability limits (damage, driver) with their cause, occupants, the energy ledger and its
 * residual, then the live control section. Only values the model computes are shown — "not computed" otherwise.
 */
export function VehicleObjectSection({ id }: { id: EntityId }) {
  const t = useT();
  useSimStore((s) => s.time);
  const objects = useWorldStore((s) => s.doc.objects);
  const e = simulationController.getRuntime()?.entities.get(id);
  if (!e || !e.vehicle) return null;
  const r = vehicleRow(e as VehicleCarEntity, simulationController.getPhysics());
  const v = e.vehicle;
  const nc = t('vehicleUi.notComputed');
  const yn = (b: boolean) => (b ? t('vehicleUi.yes') : t('vehicleUi.no'));
  const name = (hid: string) => (objects[hid] ? displayName(objects[hid], t) : hid);
  const rows: [string, React.ReactNode][] = [
    [t('vehicleUi.inspect.model'), `${levelLabel(t, r.level)} · ${variantLabel(t, r.variant)}`],
    [t('vehicleUi.inspect.drive'), r.level === 'vehicle' ? `${driveLabel(t, r.drive)} · ${tireLabel(t, r.tire)} · ABS ${r.abs ? t('vehicleUi.on') : t('vehicleUi.off')}` : nc],
    [t('vehicleUi.inspect.mass'), `${fmt(r.mass, 0)} kg`],
    [t('vehicleUi.inspect.com'), t('vehicleUi.inspect.comLine', { x: fmt(r.com[0], 2), y: fmt(r.com[1], 2), z: fmt(r.com[2], 2) })],
    [t('vehicleUi.inspect.geometry'), t('vehicleUi.inspect.geometryLine', { wb: fmt(r.wheelbase, 2), tr: fmt(r.track, 2), f: fmt(r.frontShare * 100, 0) })],
    [t('vehicleUi.inspect.inertia'), `${fmt(r.inertia[0], 0)} / ${fmt(r.inertia[1], 0)} / ${fmt(r.inertia[2], 0)} kg·m²`],
    [t('vehicleUi.inspect.speed'), r.speed === null ? nc : `${fmt(r.speed, 2)} m/s (${fmt(r.speed * 3.6, 1)} km/h)`],
    [t('vehicleUi.inspect.accel'), r.accelLong === null ? nc : t('vehicleUi.inspect.accelLine', { a: fmt(r.accelLong, 2), l: fmt(r.accelLat ?? NaN, 2) })],
    [t('vehicleUi.inspect.yawRate'), r.yawRate === null ? nc : `${fmt(r.yawRate * DEG, 1)} °/s`],
    [t('vehicleUi.inspect.rollPitch'), `${fmt(r.roll * DEG, 1)}° / ${fmt(r.pitch * DEG, 1)}°`],
    // A rigid (Level 1) car takes no inputs: the vehicle system never resolves its controls.
    [t('vehicleUi.inspect.inputs'), r.level !== 'vehicle' ? nc : t('vehicleUi.inspect.inputsLine', { th: fmt(r.throttle * 100, 0), br: fmt(r.brake * 100, 0), st: fmt(r.steer, 2), g: r.gearSelector })],
    [t('vehicleUi.inspect.handbrake'), r.level !== 'vehicle' ? nc : yn(r.handbrake)],
    [t('vehicleUi.inspect.source'), r.level !== 'vehicle' ? nc : sourceLabel(t, r.controlSource)],
    [t('vehicleUi.inspect.gear'), r.gear === null ? nc : t('vehicleUi.inspect.gearLine', { g: r.gear, rpm: fmt(r.engineRpm!, 0), tq: fmt(r.engineTorque!, 0) })],
    [t('vehicleUi.inspect.steerAngle'), r.steerAngle === null ? nc : `${fmt(r.steerAngle * DEG, 1)}°`],
    [t('vehicleUi.inspect.torque'), r.driveTorque === null ? nc : t('vehicleUi.inspect.torqueLine', { d: fmt(r.driveTorque, 0), b: fmt(r.brakeTorque!, 0) })],
    [t('vehicleUi.inspect.damage'), <span key="dm" style={{ color: damageColor(r.damageLevel) }}>{damageLabel(t, r.damageLevel)} · {fmt(r.damageIndex, 2)}</span>],
    [t('vehicleUi.inspect.peakDv'), `${fmt(r.peakDv, 1)} m/s`],
    [t('vehicleUi.inspect.rollover'), rolloverLabel(t, r.rollover)],
    [t('vehicleUi.inspect.ltr'), r.ltr === null ? nc : t('vehicleUi.inspect.ltrLine', { l: fmt(r.ltr, 2), p: fmt(r.peakLtr ?? NaN, 2) })],
    [t('vehicleUi.inspect.avail'), t('vehicleUi.inspect.availLine', { d: pct(r.availDrive), s: pct(r.availSteer), b: pct(r.availBrake) })],
    [t('vehicleUi.inspect.driver'), `${pct(r.availDriver)} · ${driverCauseLabel(t, r.driverCause)}`],
    [t('vehicleUi.inspect.collisions'), String(r.collisions)],
  ];
  if (r.airborne) rows.push([t('vehicleUi.inspect.airborne'), t('vehicleUi.yes')]);
  if (r.stalled) rows.push([t('vehicleUi.inspect.stalled'), t('vehicleUi.yes')]);
  if (r.frozen) rows.push([t('vehicleUi.inspect.frozen'), t('vehicleUi.yes')]);
  if (r.autopilot) rows.push([t('vehicleUi.inspect.autopilot'), r.autopilot.done ? t('vehicleUi.ap.done') : t('vehicleUi.ap.active', { k: r.autopilot.target + 1, n: r.autopilot.points, v: fmt(r.autopilot.speed, 1) }) + (r.autopilot.obstacle !== null ? ` · ${t('vehicleUi.ap.obstacle', { d: fmt(r.autopilot.obstacle, 1) })}` : '')]);
  const occ: [string, React.ReactNode][] = v.occupants.map((o) => [name(o.human), t('vehicleUi.inspect.occLine', {
    seat: seatLabel(t, o.seat), belt: o.restrained ? t('vehicleUi.restrained') : t('vehicleUi.unrestrained'), state: occupantLabel(t, o.state), dv: fmt(o.peakDv, 1), a: fmt(o.peakAccel, 0),
  })]);
  const energy: [string, React.ReactNode][] = [
    [t('vehicleUi.energy.ke'), kJ(t, r.ke)],
    [t('vehicleUi.energy.pe'), kJ(t, r.pe)],
    [t('vehicleUi.energy.spring'), kJ(t, r.spring)],
    [t('vehicleUi.energy.total'), r.E === null ? nc : t('vehicleUi.energy.totalLine', { e: fmt(r.E / 1000, 1), e0: fmt(r.E0! / 1000, 1) })],
    [t('vehicleUi.energy.drive'), kJ(t, r.ledgerDrive)],
    [t('vehicleUi.energy.brake'), kJ(t, r.ledgerBrake)],
    [t('vehicleUi.energy.rolling'), kJ(t, r.ledgerRolling)],
    [t('vehicleUi.energy.slip'), kJ(t, r.ledgerSlip)],
    [t('vehicleUi.energy.damper'), kJ(t, r.ledgerDamper)],
    [t('vehicleUi.energy.aero'), kJ(t, r.ledgerAero)],
    [t('vehicleUi.energy.collision'), kJ(t, r.ledgerCollision)],
    [t('vehicleUi.energy.residual'), kJ(t, r.residual)],
  ];
  const th = { textAlign: 'right', fontWeight: 400, color: 'var(--text-2)', padding: '1px 3px' } as const;
  const td = { textAlign: 'right', fontFamily: 'var(--font-mono)', padding: '1px 3px' } as const;
  return (
    <Section title={t('vehicleUi.inspect.title')}>
      <Rows testId="vehicle-object" rows={rows} />
      {r.wheels ? (
        <Section title={t('vehicleUi.inspect.wheels')}>
          <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }} data-testid="vehicle-wheels">
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left' }} />
                <th style={th}>{t('vehicleUi.wheel.contact')}</th><th style={th}>Fz kN</th><th style={th}>κ</th><th style={th}>α °</th>
                <th style={th}>{t('vehicleUi.wheel.compression')} mm</th><th style={th}>ω rad/s</th><th style={th}>{t('vehicleUi.wheel.torque')} N·m</th>
              </tr>
            </thead>
            <tbody>
              {r.wheels.map((w) => (
                <tr key={w.wheel}>
                  <td style={{ ...td, textAlign: 'left', fontFamily: 'inherit' }}>{t(`vehicleUi.wheel.${w.wheel}` as MessageKey)}</td>
                  <td style={td}>{w.contact ? (w.locked ? t('vehicleUi.wheel.locked') : w.sliding ? t('vehicleUi.wheel.sliding') : w.abs ? 'ABS' : t('vehicleUi.yes')) : t('vehicleUi.no')}</td>
                  <td style={td}>{fmt(w.Fz / 1000, 2)}</td>
                  <td style={td}>{w.kappa === null ? '–' : fmt(w.kappa, 3)}</td>
                  <td style={td}>{w.alpha === null ? '–' : fmt(w.alpha * DEG, 1)}</td>
                  <td style={td}>{fmt(w.compression * 1000, 0)}</td>
                  <td style={td}>{fmt(w.omega, 1)}</td>
                  <td style={td}>{fmt(w.driveT, 0)} / {fmt(w.brakeT, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className={styles.note}>{t('vehicleUi.inspect.wheelsNote')}</div>
        </Section>
      ) : (
        <div className={styles.note}>{t('vehicleUi.inspect.rigidNote')}</div>
      )}
      {occ.length > 0 && (
        <Section title={t('vehicleUi.inspect.occupants')}>
          <Rows testId="vehicle-occupants" rows={occ} />
          <div className={styles.note}>{t('vehicleUi.inspect.occNote')}</div>
        </Section>
      )}
      <Section title={t('vehicleUi.inspect.energy')} defaultOpen={false}>
        <Rows testId="vehicle-energy" rows={energy} />
        <div className={styles.note}>{t('vehicleUi.energy.note')}</div>
      </Section>
      <VehicleControlSection id={id} />
      <div className={styles.note} data-testid="vehicle-levels">{t('vehicleUi.levels')}</div>
      <div className={styles.note} data-testid="vehicle-limitation">{t('vehicleUi.limitation')}</div>
    </Section>
  );
}
