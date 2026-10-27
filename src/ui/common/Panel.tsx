import { useState, type ReactNode } from 'react';
import styles from './Panel.module.css';

export function Panel(props: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span>{props.title}</span>
        {props.actions && <div className={styles.actions}>{props.actions}</div>}
      </div>
      <div className={styles.body}>{props.children}</div>
    </div>
  );
}

export function Section(props: {
  title: ReactNode;
  aside?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? true);
  return (
    <div className={styles.section}>
      <button className={styles.sectionHeader} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`${styles.chev} ${open ? styles.open : ''}`}>▸</span>
        {props.title}
        {props.aside !== undefined && <span className={styles.sectionAside}>{props.aside}</span>}
      </button>
      {open && <div className={styles.sectionBody}>{props.children}</div>}
    </div>
  );
}
