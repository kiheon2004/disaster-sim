import { useEffect, useReducer, useState } from 'react';
import { useT } from '@/i18n/i18n';
import type { EntityId } from '@/core/types';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { clearLiveInput, drivable, enableLiveInput, GEARS, setLiveInput, startAutopilot, stopAutopilot } from '@/simulation/vehicle/control';
import type { ControlInput } from '@/vehicle/settings';
import type { Gear } from '@/vehicle/powertrain';
import { Section } from '@/ui/common/Panel';
import { FieldRow, NumberField, SliderField, ToggleField } from '@/ui/common/fields';
import { Segmented } from '@/ui/common/Segmented';
import { fmt } from '@/ui/format';
import { isTyping } from '@/editor/input/keys';
import styles from './Inspector.module.css';

/**
 * Keyboard driving (Phase 35): physical key codes (layout / IME independent) → one input axis each. Space stays play / pause,
 * F stays camera focus, Esc deselects (which unmounts the control section and releases every key).
 */
export const DRIVE_KEYS = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  handbrake: ['KeyX'],
} as const;
export const GEAR_KEYS: Record<string, Gear> = { Digit1: 'P', Digit2: 'R', Digit3: 'N', Digit4: 'D' };
const ALL_KEYS = new Set<string>([...Object.values(DRIVE_KEYS).flat(), ...Object.keys(GEAR_KEYS)]);

/** Input of the held keys for the axes a key belongs to (pressed = full input, released = 0). */
export function keyInput(held: ReadonlySet<string>, code: string): ControlInput {
  const has = (ks: readonly string[]) => ks.some((k) => held.has(k));
  if ((DRIVE_KEYS.throttle as readonly string[]).includes(code)) return { throttle: has(DRIVE_KEYS.throttle) ? 1 : 0 };
  if ((DRIVE_KEYS.brake as readonly string[]).includes(code)) return { brake: has(DRIVE_KEYS.brake) ? 1 : 0 };
  if ((DRIVE_KEYS.left as readonly string[]).includes(code) || (DRIVE_KEYS.right as readonly string[]).includes(code)) return { steer: (has(DRIVE_KEYS.left) ? 1 : 0) - (has(DRIVE_KEYS.right) ? 1 : 0) };
  if ((DRIVE_KEYS.handbrake as readonly string[]).includes(code)) return { handbrake: has(DRIVE_KEYS.handbrake) };
  return {};
}

/**
 * Drive the car with the keyboard while its live control is on (simulation mode — this hook lives in the simulation
 * inspector). keydown / keyup set and release an axis; window blur, a hidden tab and unmount release every held key, so a key
 * can never stick. Inputs go through the same live-input API as the sliders.
 */
export function useDriveKeys(id: EntityId, changed: () => void) {
  useEffect(() => {
    const held = new Set<string>();
    const write = (code: string) => {
      if (!drivable(simulationController, id)?.live) return;
      setLiveInput(simulationController, id, keyInput(held, code));
      changed();
    };
    const down = (e: KeyboardEvent) => {
      if (!ALL_KEYS.has(e.code) || e.ctrlKey || e.metaKey || e.altKey || isTyping(e)) return;
      const v = drivable(simulationController, id);
      if (!v?.live) return;
      e.preventDefault();
      if (e.code in GEAR_KEYS) { setLiveInput(simulationController, id, { gear: GEAR_KEYS[e.code] }); changed(); return; }
      if (held.has(e.code)) return;
      held.add(e.code);
      write(e.code);
    };
    const up = (e: KeyboardEvent) => {
      if (!held.delete(e.code)) return;
      write(e.code);
    };
    const releaseAll = () => {
      const codes = [...held];
      held.clear();
      for (const c of codes) write(c);
    };
    const hidden = () => { if (document.visibilityState !== 'visible') releaseAll(); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', releaseAll);
      document.removeEventListener('visibilitychange', hidden);
      releaseAll();
    };
  }, [id, changed]);
}

/**
 * Live control of the selected wheeled car (Phase 35): live control on / off, throttle / brake / steering sliders, parking
 * brake, gear P / R / N / D, neutral, the autopilot (stop, restart the configured path, or drive to a typed point) and the
 * keyboard. Paused: inputs are stored and act from the next step.
 */
export function VehicleControlSection({ id }: { id: EntityId }) {
  const t = useT();
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useSimStore((s) => s.status);
  useDriveKeys(id, bump);
  const [target, setTarget] = useState<{ x: number; z: number; speed: number } | null>(null);
  const rt = simulationController.getRuntime();
  const e = rt?.entities.get(id);
  const v = drivable(simulationController, id);
  if (!e || !v) return null;
  const live = v.live;
  const on = live !== null;
  const c = v.controls;
  const set = (input: ControlInput) => { setLiveInput(simulationController, id, input); bump(); };
  const configured = !!rt?.vehicles?.settings.cars?.[id]?.autopilot;
  // Default target: 30 m ahead of the car.
  const q = e.pose.quaternion, p = e.pose.position;
  const fx = 1 - 2 * (q[1] * q[1] + q[2] * q[2]), fz = 2 * (q[0] * q[2] - q[3] * q[1]);
  const tg = target ?? { x: Math.round(p[0] + 30 * fx), z: Math.round(p[2] + 30 * fz), speed: 8 };
  const value = (k: 'throttle' | 'brake' | 'steer') => live?.[k] ?? c[k];
  return (
    <Section title={t('vehicleUi.ctl.title')}>
      <div data-testid="vehicle-control" style={{ display: 'contents' }}>
        <ToggleField label={t('vehicleUi.ctl.enable')} checked={on} hint={t('vehicleUi.ctl.enable.hint')}
          onChange={(b) => { if (b) enableLiveInput(simulationController, id); else clearLiveInput(simulationController, id); bump(); }} />
        <SliderField label={t('vehicleUi.ctl.throttle')} value={value('throttle')} min={0} max={1} step={0.05} precision={2} disabled={!on} onChange={(x) => set({ throttle: x })} />
        <SliderField label={t('vehicleUi.ctl.brake')} value={value('brake')} min={0} max={1} step={0.05} precision={2} disabled={!on} onChange={(x) => set({ brake: x })} />
        <SliderField label={t('vehicleUi.ctl.steer')} value={value('steer')} min={-1} max={1} step={0.05} precision={2} disabled={!on} onChange={(x) => set({ steer: x })} />
        <ToggleField label={t('vehicleUi.ctl.handbrake')} checked={live?.handbrake ?? c.handbrake} disabled={!on} onChange={(b) => set({ handbrake: b })} />
        <FieldRow label={t('vehicleUi.ctl.gear')}>
          {on ? (
            <Segmented size="small" value={live?.gear ?? c.gear} ariaLabel={t('vehicleUi.ctl.gear')} onChange={(g) => set({ gear: g })}
              options={GEARS.map((g) => ({ value: g, label: g, title: t(`vehicleUi.gear.${g}`) }))} />
          ) : <span style={{ fontFamily: 'var(--font-mono)' }}>{c.gear}</span>}
        </FieldRow>
        {on && <button className={styles.linkBtn} data-testid="vehicle-neutral" onClick={() => set({ throttle: 0, brake: 0, steer: 0 })}>{t('vehicleUi.ctl.neutral')}</button>}
        <div className={styles.note}>{t('vehicleUi.ctl.keys')}</div>
        <div className={styles.note}>{t('vehicleUi.ctl.paused')}</div>
        <Section title={t('vehicleUi.ap.title')} defaultOpen={!!v.autopilot}>
          <div data-testid="vehicle-autopilot" style={{ display: 'contents' }}>
            <div className={styles.note}>
              {v.autopilot ? (v.autopilot.done ? t('vehicleUi.ap.done') : t('vehicleUi.ap.active', { k: v.autopilot.target + 1, n: v.autopilot.path.length, v: fmt(v.autopilot.speed, 1) })) : t('vehicleUi.ap.none')}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              {v.autopilot && <button className={styles.linkBtn} data-testid="vehicle-ap-stop" onClick={() => { stopAutopilot(simulationController, id); bump(); }}>{t('vehicleUi.ap.stop')}</button>}
              {configured && <button className={styles.linkBtn} data-testid="vehicle-ap-restart" onClick={() => { startAutopilot(simulationController, id); bump(); }}>{t('vehicleUi.ap.restart')}</button>}
            </div>
            <NumberField label={t('vehicleUi.ap.targetX')} value={tg.x} step={1} precision={1} unit="m" onChange={(x) => setTarget({ ...tg, x })} />
            <NumberField label={t('vehicleUi.ap.targetZ')} value={tg.z} step={1} precision={1} unit="m" onChange={(z) => setTarget({ ...tg, z })} />
            <NumberField label={t('vehicleUi.ap.speed')} value={tg.speed} min={0} max={60} step={1} precision={1} unit="m/s" onChange={(s) => setTarget({ ...tg, speed: s })} />
            <button className={styles.linkBtn} data-testid="vehicle-ap-go" onClick={() => { startAutopilot(simulationController, id, tg); bump(); }}>{t('vehicleUi.ap.go')}</button>
            <div className={styles.note}>{t('vehicleUi.ap.note')}</div>
          </div>
        </Section>
      </div>
    </Section>
  );
}
