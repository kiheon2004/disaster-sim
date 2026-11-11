import { useMemo, useSyncExternalStore } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import { useEditorStore } from '@/editor/editorStore';
import { useBuildStore } from '@/editor/buildStore';
import { getPaletteItem } from '@/objects/palette';
import { useSimStore } from '@/simulation/simStore';
import { useGhostWarnings } from '@/editor/tools/PlaceTool';
import { applyAreaSession, planArea } from '@/editor/tools/BulkTools';
import { useWorldStore } from '@/world/worldStore';
import { BUILD_TOOLS } from './ViewportToolbar';
import { snapHint } from '@/editor/snap/snapHint';
import styles from './ViewportContainer.module.css';

/** Viewport hint for the Phase 16 build tools (+ the place ghost's warnings). */
export function BuildHint({ fallback }: { fallback: string }) {
  const t = useT();
  const tool = useEditorStore((s) => s.tool);
  const item = getPaletteItem(useEditorStore((s) => s.placeItemId));
  const count = useEditorStore((s) => s.selectedIds.length);
  const warnings = useSyncExternalStore(useGhostWarnings.subscribe, useGhostWarnings.get);
  const snapped = useSyncExternalStore(snapHint.subscribe, snapHint.get);
  const space = useEditorStore((s) => s.transformSpace);
  const lock = useEditorStore((s) => s.axisLock);
  const name = item ? t(item.labelKey) : '';
  const toolLabel = BUILD_TOOLS.find((b) => b.tool === tool)?.label;
  let text = fallback;
  if (tool === 'paste') text = t('viewport.hint.paste');
  else if ((tool === 'brush' || tool === 'line' || tool === 'area') && !item) text = t('viewport.hint.needItem', { tool: toolLabel ? t(toolLabel) : '' });
  else if (tool === 'brush' || tool === 'line' || tool === 'area') text = t(`viewport.hint.${tool}`, { name });
  else if (tool === 'place' && !item) text = t('viewport.hint.needItem', { tool: t('build.tool.place') });
  else if (tool === 'select' && count > 1) text = t('viewport.hint.multi', { count });
  return (
    <>
      {text}
      {tool === 'select' && count > 0 && (space === 'local' || lock) && (
        <span className={styles.snapTag} style={{ marginLeft: 8 }} data-testid="gizmo-state">
          {space === 'local' ? t('ed36.gizmo.local') : ''}{space === 'local' && lock ? ' · ' : ''}{lock ? t('ed36.gizmo.lock', { axis: lock.toUpperCase() }) : ''}
        </span>
      )}
      {snapped && (
        <span className={styles.snapTag} style={{ marginLeft: 8 }} data-testid="snap-hint" data-kind={snapped}>
          ⌖ {t('snap.label')}: {t(`snap.kind.${snapped}` as MessageKey)}
        </span>
      )}
      {tool === 'place' && warnings.length > 0 && (
        <span className={styles.warn} style={{ marginLeft: 8 }} data-testid="ghost-warning">
          ⚠ {warnings.map((w) => t(`warn.${w}` as MessageKey)).join(' · ')}
        </span>
      )}
    </>
  );
}

/** Area tool: preview summary + Apply / Cancel (Enter / Esc). */
export function AreaApplyBar() {
  const t = useT();
  const session = useBuildStore((s) => s.areaSession);
  const area = useBuildStore((s) => s.area);
  const placement = useBuildStore((s) => s.placement);
  const randomize = useEditorStore((s) => s.randomize);
  const itemId = useEditorStore((s) => s.placeItemId);
  const objects = useWorldStore((s) => s.doc.objects);
  const summary = useMemo(() => {
    const item = getPaletteItem(itemId);
    if (!item || !session.shape || session.dragging) return null;
    const plan = planArea(item, session.shape, { ...placement, variation: placement.variation && randomize });
    const ok = plan.filter((p) => p.ok).length;
    return { ok, skip: plan.length - ok };
  }, [itemId, session, area, placement, randomize, objects]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!summary) return null;
  return (
    <div className={`${styles.overlay} ${styles.bottomCenter}`}>
      <div className={styles.applyBar} data-testid="area-apply">
        <span>{t('opts.area.preview', { ok: summary.ok, skip: summary.skip })}</span>
        <button className={styles.primary} disabled={!summary.ok} onClick={() => applyAreaSession()}>{t('opts.area.apply')} (Enter)</button>
        <button onClick={() => useBuildStore.getState().setAreaSession({ shape: null, dragging: false })}>{t('opts.area.cancel')} (Esc)</button>
      </div>
    </div>
  );
}

/** Simulation mode: the original world is preserved (fingerprint of the experiment's start). */
export function OriginalWorldBadge() {
  const t = useT();
  const base = useSimStore((s) => s.baseline);
  if (!base) return null;
  return (
    <span className={styles.orig} data-testid="original-world" title={t('sim.original.title', { hash: base.hash.slice(0, 8), count: base.objects })}>
      ✓ {t('sim.original')}
    </span>
  );
}
