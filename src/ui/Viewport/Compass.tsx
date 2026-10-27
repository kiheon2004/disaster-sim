import type { ReactNode } from 'react';
import { useViewStore } from '@/rendering/viewStore';
import { useT } from '@/i18n/i18n';
import styles from './Compass.module.css';

const LETTERS = [
  { key: 'viewport.compass.n', deg: 0, cls: styles.n },
  { key: 'viewport.compass.e', deg: 90 },
  { key: 'viewport.compass.s', deg: 180 },
  { key: 'viewport.compass.w', deg: 270 },
] as const;

/** Compass that rotates with the camera; top of the dial = camera view direction. */
export function Compass({ children }: { children?: ReactNode }) {
  const az = useViewStore((s) => s.azimuthDeg);
  const t = useT();
  return (
    <div className={styles.compass}>
      <div className={styles.dial} style={{ transform: `rotate(${-az}deg)` }}>
        <div className={styles.tick} />
        {LETTERS.map((l) => {
          const r = (l.deg * Math.PI) / 180;
          const x = Math.sin(r) * 22;
          const y = -Math.cos(r) * 22;
          return (
            <span
              key={l.key}
              className={`${styles.letter} ${'cls' in l ? l.cls : ''}`}
              style={{ transform: `translate(${x}px, ${y}px) rotate(${az}deg)` }}
            >
              {t(l.key)}
            </span>
          );
        })}
        {children}
      </div>
      <div className={styles.center} />
    </div>
  );
}
