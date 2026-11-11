/**
 * Phase 37 (§14, Phase 36 §26) — the viewport's right-click menu: "Place here …" / "Disaster here …" put a command
 * with the position filled in into the command bar (the same plan path as a typed command — nothing runs from the
 * menu). A right CLICK opens it (press and release less than 5 px apart); a right drag stays the camera pan.
 *
 * The ground point is the session's cursor (kept by the viewport from pointer moves); while it is not known the
 * entries are shown disabled. Esc closes the menu before anything else (menu → plan → bar); a press elsewhere closes it.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '@/i18n/i18n';
import { proposeCommand } from '@/app/commandActions';
import { useEditorStore } from '@/editor/editorStore';
import { useBuildStore } from '@/editor/buildStore';
import { phenomena } from '@/phenomena/registry';
import { usePlacementStore } from '@/ui/placement/placementStore';
import { useCommandSession } from './commandSession';
import { focusCommandBar, useBarStore, type ContextMenuState } from './barStore';
import { disasterCommand, disasterTypes, formatPoint, isRightClick, placeCommand, placeKinds, type PointerAt } from './menuEntries';
import styles from './CommandBar.module.css';

/**
 * Pointer handlers for the viewport CONTAINER (not the canvas: the camera controls own that). Only presses on the
 * canvas itself count — the overlays (toolbar, HUD panels) keep their own right-click behaviour.
 */
export function useContextMenuTrigger() {
  const down = useRef<PointerAt | null>(null);
  const onCanvas = (e: React.PointerEvent) => (e.target as HTMLElement | null)?.tagName === 'CANVAS';
  return {
    onPointerDown: (e: React.PointerEvent) => {
      down.current = e.button === 2 && onCanvas(e) ? { x: e.clientX, y: e.clientY, button: e.button } : null;
    },
    onPointerUp: (e: React.PointerEvent) => {
      const was = down.current;
      down.current = null;
      if (!onCanvas(e) || !isRightClick(was, { x: e.clientX, y: e.clientY, button: e.button })) return;
      useBarStore.getState().openMenu({ x: e.clientX, y: e.clientY, point: useCommandSession.getState().cursor });
    },
  };
}

export function CommandContextMenu() {
  const menu = useBarStore((s) => s.menu);
  // (keyed by the position: a right click elsewhere opens a new menu, with its own listeners and focus)
  return menu ? <Menu key={`${menu.x},${menu.y}`} menu={menu} /> : null;
}

function Menu({ menu }: { menu: ContextMenuState }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const mode = useEditorStore((s) => s.mode);
  const recent = useBuildStore((s) => s.recent);
  const favorites = usePlacementStore((s) => s.favorites);
  const recentDisasters = usePlacementStore((s) => s.recent);
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ left: Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4)) });
  }, [menu.x, menu.y]);

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const close = () => useBarStore.getState().closeMenu();
    // Capture phase: Esc closes the menu and goes no further (the open plan, the bar and the editor's Esc chain come after).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
      before?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('wheel', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('wheel', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, []);

  const choose = (command: string) => {
    useBarStore.getState().closeMenu();
    proposeCommand(command);
    focusCommandBar(false);
  };

  /** ↑ / ↓ / Home / End walk the entries (the usual keys of a menu). */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const to = e.key === 'ArrowDown' ? (at + 1) % items.length : e.key === 'ArrowUp' ? (at - 1 + items.length) % items.length : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    e.stopPropagation();
    items[to].focus();
  };

  const p = menu.point;
  const kinds = mode === 'editor' ? placeKinds(recent) : [];
  const disasters = disasterTypes(favorites, recentDisasters);

  return createPortal(
    <div ref={ref} className={styles.menu} role="menu" aria-label={t('cmd37.ui.menu.title')} data-testid="context-menu" style={pos} onKeyDown={onKeyDown} onContextMenu={(e) => e.preventDefault()}>
      <div className={styles.menuHead} data-testid="context-point">
        {p ? t('cmd37.ui.menu.at', { point: formatPoint(p).replace(',', ', ') }) : t('cmd37.ui.menu.noPoint')}
      </div>
      {kinds.length > 0 && <div className={styles.menuLabel}>{t('cmd37.ui.menu.place')}</div>}
      {kinds.map((k) => {
        const command = p ? placeCommand(k, p) : '';
        return (
          <button key={k.key} role="menuitem" disabled={!p} aria-disabled={!p} data-testid="context-place" data-command={command} onClick={() => choose(command)}>
            {t(k.item.labelKey)} <span className={`${styles.mono} ${styles.dim}`}>{k.key}</span>
          </button>
        );
      })}
      {mode !== 'editor' && <div className={styles.menuNote}>{t('cmd37.ui.menu.simulating')}</div>}
      {disasters.length > 0 && <div className={styles.menuLabel}>{t('cmd37.ui.menu.disaster')}</div>}
      {disasters.map((type) => {
        const command = p ? disasterCommand(type, p) : '';
        const def = phenomena.implemented(type);
        return (
          <button key={type} role="menuitem" disabled={!p} aria-disabled={!p} data-testid="context-disaster" data-command={command} onClick={() => choose(command)}>
            {def ? t(def.labelKey) : type} <span className={`${styles.mono} ${styles.dim}`}>{type}</span>
          </button>
        );
      })}
      <div className={styles.menuNote}>{t('cmd37.ui.menu.note')}</div>
    </div>,
    document.body,
  );
}
