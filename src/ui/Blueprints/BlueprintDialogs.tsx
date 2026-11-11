/**
 * Phase 20 dialogs, mounted once at the app root: import preview (validation result, migration
 * notes, duplicate handling), "save world as template", and the world creation wizard
 * (name → template → seed → preview → create → build mode).
 */
import { useEffect, useMemo, useState } from 'react';
import { isImeKey } from '@/editor/input/keys';
import { useT, type MessageKey } from '@/i18n/i18n';
import { useBlueprintStore } from '@/editor/blueprintStore';
import { useEditorStore } from '@/editor/editorStore';
import { useWorldStore } from '@/world/worldStore';
import { useLibraryStore, type LibraryEntry } from '@/blueprints/library';
import { confirmImport, ensureThumbnail, entryName, initLibrary, saveWorldTemplate, templateWorld } from '@/app/blueprintActions';
import { countsOf } from '@/templates/template';
import { worldThumbnail } from './minimap';
import { Icon } from '@/ui/common/Icon';
import { ToggleField } from '@/ui/common/fields';
import { toast } from '@/ui/common/toast';
import { randomSeed } from '@/core/random';
import type { WorldDocument } from '@/core/model';
import styles from './Blueprints.module.css';

export function BlueprintDialogs() {
  const importCheck = useBlueprintStore((s) => s.importCheck);
  const tpl = useBlueprintStore((s) => s.templateDialog);
  const wizard = useBlueprintStore((s) => s.wizardOpen);
  return (
    <>
      {importCheck && <ImportDialog />}
      {tpl && <TemplateDialog />}
      {wizard && <WorldWizard />}
    </>
  );
}

function Modal({ title, onClose, children, footer, small, testId }: { title: string; onClose: () => void; children: React.ReactNode; footer: React.ReactNode; small?: boolean; testId: string }) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div className={`${styles.dialog} ${small ? styles.small : ''}`} role="dialog" aria-modal="true" aria-label={title} data-testid={testId} onMouseDown={(e) => e.stopPropagation()}>
        <div className={styles.dHead}>{title}<button className={styles.x} onClick={onClose} aria-label={t('common.close')}><Icon name="x" /></button></div>
        <div className={styles.dBody}>{children}</div>
        <div className={styles.dFoot}>{footer}</div>
      </div>
    </div>
  );
}

// ── Import ──────────────────────────────────────────────────────────────────

function ImportDialog() {
  const t = useT();
  const c = useBlueprintStore((s) => s.importCheck)!;
  const close = () => useBlueprintStore.getState().setImportCheck(null);
  if (!c.ok) {
    return (
      <Modal title={t('bp.import.title')} onClose={close} small testId="bp-import-dialog" footer={<button onClick={close}>{t('bp.import.cancel')}</button>}>
        <div className={styles.errorBox} data-testid="bp-import-error">{t('bp.import.invalid')} — {t(`bp.import.err.${c.code}` as MessageKey)}<div className={styles.mono}>{c.detail}</div></div>
        <div className={styles.note}>{t('bp.import.safe')}</div>
      </Modal>
    );
  }
  const name = c.kind === 'blueprint' ? c.blueprint.meta.name || t('bp.untitled') : c.template.meta.name;
  const counts = c.kind === 'blueprint' ? c.blueprint.preview.counts : c.template.preview.counts;
  const thumb = c.kind === 'blueprint' ? c.blueprint.preview.thumbnail : c.template.preview.thumbnail;
  const dup = c.duplicate;
  const notes: string[] = [];
  if (c.kind === 'blueprint') {
    const r = c.report;
    if (r.migratedFrom) notes.push(t('bp.import.migrated', { from: r.migratedFrom }));
    if (r.newerVersion) notes.push(t('bp.import.newer', { v: r.newerVersion }));
    if (r.unsupported.length || r.unsupportedObjects || r.unsupportedFeatures) notes.push(t('bp.import.unsupported', { list: [...r.unsupported, ...(r.unsupportedObjects ? [`objects × ${r.unsupportedObjects}`] : []), ...(r.unsupportedFeatures ? [`features × ${r.unsupportedFeatures}`] : [])].join(', ') }));
    if (r.droppedMembers || r.repairedMembers) notes.push(t('bp.import.members', { d: r.droppedMembers, r: r.repairedMembers }));
    if (r.clamped) notes.push(t('bp.import.clamped', { n: r.clamped }));
  } else if (c.skipped) notes.push(t('bp.import.skipped', { n: c.skipped }));
  return (
    <Modal title={`${t('bp.import.title')} — ${t(`bp.import.kind.${c.kind}`)}`} onClose={close} testId="bp-import-dialog"
      footer={
        <>
          <button onClick={close}>{t('bp.import.cancel')}</button>
          {dup && !dup.existing.builtin && <button data-testid="bp-import-replace" onClick={() => void confirmImport('replace')}>{t('bp.import.replace')}</button>}
          <button className={styles.primary} data-testid="bp-import-add" onClick={() => void confirmImport('copy')}>{dup ? t('bp.import.copy') : t('bp.import.add')}</button>
        </>
      }>
      <div className={styles.previewRow}>
        {thumb ? <img src={thumb} alt="" /> : <div className={styles.ph} />}
        <div className={styles.stack}>
          <b>{name}</b>
          <span className={styles.label}>{t('bp.lib.bytes', { kb: Math.max(1, Math.round(c.bytes / 1024)) })}</span>
          <span className={styles.label}>{c.kind === 'blueprint'
            ? t('bp.lib.counts', { buildings: counts.buildings ?? 0, objects: (counts.objects ?? 0) - (counts.buildings ?? 0), vegetation: (counts as Record<string, number>).vegetation ?? 0, roads: counts.roads ?? 0, features: counts.features ?? 0 })
            : t('bp.lib.worldCounts', { objects: counts.objects ?? 0, buildings: counts.buildings ?? 0, trees: (counts as Record<string, number>).trees ?? 0, roads: counts.roads ?? 0, features: counts.features ?? 0 })}</span>
          {c.kind === 'blueprint' && c.blueprint.meta.description && <span className={styles.desc}>{c.blueprint.meta.description}</span>}
          {notes.map((n) => <span key={n} className={styles.note}>• {n}</span>)}
          {dup && <span className={styles.label} data-testid="bp-import-dup">⚠ {t(dup.sameContent ? 'bp.import.dupSame' : 'bp.import.dupId', { name: entryName(dup.existing) })}</span>}
          <span className={styles.note}>{t('bp.import.safe')}</span>
        </div>
      </div>
    </Modal>
  );
}

// ── Save as template ────────────────────────────────────────────────────────

function TemplateDialog() {
  const t = useT();
  const docName = useWorldStore((s) => s.doc.meta.name);
  const [name, setName] = useState(docName);
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [experiment, setExperiment] = useState(false);
  const close = () => useBlueprintStore.getState().setTemplateDialog(false);
  return (
    <Modal title={t('bp.tpl.title')} onClose={close} small testId="bp-template-dialog"
      footer={<><button onClick={close}>{t('bp.capture.cancel')}</button><button className={styles.primary} data-testid="bp-template-save" onClick={() => void initLibrary().then(() => saveWorldTemplate(name, description, tags, experiment))}>{t('bp.tpl.save')}</button></>}>
      <div className={styles.note}>{t('bp.tpl.contents')}</div>
      <label className={styles.stack}><span className={styles.label}>{t('bp.field.name')}</span><input className={styles.input} value={name} data-testid="bp-template-name" placeholder={t('bp.tpl.defaultName')} onChange={(e) => setName(e.target.value)} /></label>
      <label className={styles.stack}><span className={styles.label}>{t('bp.field.description')}</span><textarea className={styles.input} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <label className={styles.stack}><span className={styles.label}>{t('bp.field.tags')}</span><input className={styles.input} value={tags} onChange={(e) => setTags(e.target.value)} /></label>
      <ToggleField label={t('bp.tpl.includeExperiment')} checked={experiment} onChange={setExperiment} />
    </Modal>
  );
}

// ── World creation wizard ───────────────────────────────────────────────────

const STEPS = ['name', 'template', 'seed', 'preview', 'create'] as const;
type Step = (typeof STEPS)[number];

function WorldWizard() {
  const t = useT();
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState('builtin-tpl-smallTown');
  const [seed, setSeed] = useState(1);
  const [preview, setPreview] = useState<{ doc: WorldDocument; img: string | null; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = useLibraryStore((s) => s.ready);
  const entries = useLibraryStore((s) => s.entries);
  const thumbs = useLibraryStore((s) => s.builtinThumbs);
  useEffect(() => { void initLibrary(); }, []);
  const templates = useMemo(() => (ready ? useLibraryStore.getState().all().filter((e) => e.kind === 'world') : []), [ready, entries, thumbs]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = templates.find((e) => e.id === templateId) ?? null;
  const close = () => useBlueprintStore.getState().setWizardOpen(false);
  const key = `${templateId}#${seed}`;
  // Preview: generate the world (built-ins) or read it (saved templates) when that step opens.
  useEffect(() => {
    if (step !== 'preview' && step !== 'create') return;
    if (preview?.key === key) return;
    let live = true;
    setBusy(true);
    setTimeout(() => {
      void templateWorld(templateId, seed).then((r) => {
        if (!live) return;
        setBusy(false);
        if (!r) { toast('error', { key: 'bp.toast.loadFailed' }); return; }
        setPreview({ doc: r.doc, img: worldThumbnail(r.doc, 240), key });
      });
    }, 20);
    return () => { live = false; };
  }, [step, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const i = STEPS.indexOf(step);
  const tplName = chosen ? entryName(chosen) : '';
  const finalName = name.trim() || tplName;
  const create = () => {
    if (!preview) return;
    const doc = preview.doc;
    useEditorStore.getState().setSelection([]);
    useWorldStore.getState().replaceDocument({ ...doc, meta: { ...doc.meta, name: finalName, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    void useLibraryStore.getState().markUsed(templateId);
    // Enter build mode: edit mode, select tool, ready to change anything.
    const ed = useEditorStore.getState();
    if (ed.mode !== 'editor') ed.setMode('editor');
    ed.setTool('select');
    close();
    toast('success', { key: 'bp.toast.worldOpened', params: { name: finalName } });
  };
  const builtin = templates.filter((e) => e.builtin);
  const mine = templates.filter((e) => !e.builtin);
  const c = preview ? countsOf(preview.doc) : null;
  return (
    <Modal title={t('wiz.title')} onClose={close} testId="world-wizard"
      footer={
        <>
          <button disabled={i === 0} onClick={() => setStep(STEPS[i - 1])} data-testid="wiz-back">{t('wiz.back')}</button>
          {step !== 'create'
            ? <button className={styles.primary} disabled={(step === 'template' && !chosen) || (step === 'preview' && (busy || !preview))} onClick={() => setStep(STEPS[i + 1])} data-testid="wiz-next">{t('wiz.next')}</button>
            : <button className={styles.primary} disabled={busy || !preview} onClick={create} data-testid="wiz-create">{t('wiz.create')}</button>}
        </>
      }>
      <div className={styles.steps}>
        {STEPS.map((s, k) => <span key={s} className={`${styles.stepChip} ${s === step ? styles.on : k < i ? styles.done : ''}`}>{k + 1}. {t(`wiz.step.${s}`)}</span>)}
      </div>
      {step === 'name' && (
        <>
          <label className={styles.stack}><span className={styles.label}>{t('wiz.name')}</span>
            <input className={styles.input} autoFocus value={name} data-testid="wiz-name" placeholder={t('app.untitled')} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => !isImeKey(e) && e.key === 'Enter' && setStep('template')} /></label>
          <div className={styles.stack}><span className={styles.label}>{t('wiz.size')}</span><span>{t('wiz.size.value')}</span></div>
        </>
      )}
      {step === 'template' && (
        <>
          <span className={styles.label}>{t('wiz.builtinTemplates')}</span>
          <div className={styles.tplGrid}>{builtin.map((e) => <TemplateCard key={e.id} e={e} on={e.id === templateId} onPick={() => setTemplateId(e.id)} />)}</div>
          {mine.length > 0 && <><span className={styles.label}>{t('wiz.userTemplates')}</span><div className={styles.tplGrid}>{mine.map((e) => <TemplateCard key={e.id} e={e} on={e.id === templateId} onPick={() => setTemplateId(e.id)} />)}</div></>}
        </>
      )}
      {step === 'seed' && (
        <>
          <div className={styles.stack}>
            <span className={styles.label}>{t('bp.tpl.seed')}</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <input className={styles.input} type="number" min={0} max={999999} value={seed} data-testid="wiz-seed" disabled={!chosen?.builtin} onChange={(e) => setSeed(Math.max(0, Math.min(999999, Math.round(Number(e.target.value) || 0))))} />
              <button disabled={!chosen?.builtin} onClick={() => setSeed(randomSeed() % 1_000_000)}><Icon name="dice" size={13} /> {t('wiz.random')}</button>
            </div>
          </div>
          <div className={styles.note}>{chosen?.builtin ? t('wiz.seedHint') : t('wiz.seedUser')}</div>
        </>
      )}
      {(step === 'preview' || step === 'create') && (
        <div className={styles.previewRow} data-testid="wiz-preview">
          {preview?.img && preview.key === key ? <img src={preview.img} alt="" /> : <div className={styles.ph} style={{ display: 'grid', placeItems: 'center' }}>{t('wiz.generating')}</div>}
          <div className={styles.stack}>
            <b>{t('wiz.summary', { name: finalName || t('app.untitled'), template: tplName, seed: chosen?.builtin ? seed : '—' })}</b>
            {c && <span className={styles.label} data-testid="wiz-stats">{t('bp.lib.worldCounts', { ...c })}</span>}
            {chosen?.experiment && <span className={styles.label}>⚗ {t('bp.lib.experiment')}</span>}
            <span className={styles.desc}>{chosen?.builtinKey ? t(`${chosen.builtinKey}.desc` as MessageKey) : chosen?.description}</span>
            <span className={styles.note}>{t('wiz.size.value')}</span>
            {step === 'create' && <><span className={styles.note}>⚠ {t('wiz.replaceNote')}</span><span className={styles.note}>{t('wiz.enterBuild')}</span></>}
          </div>
        </div>
      )}
    </Modal>
  );
}

function TemplateCard({ e, on, onPick }: { e: LibraryEntry; on: boolean; onPick: () => void }) {
  const t = useT();
  useEffect(() => { if (!e.thumbnail) { const id = setTimeout(() => void ensureThumbnail(e.id), 50); return () => clearTimeout(id); } }, [e.id, e.thumbnail]);
  return (
    <button className={`${styles.tplCard} ${on ? styles.on : ''}`} aria-pressed={on} data-template={e.id} onClick={onPick}>
      {e.thumbnail ? <img className={styles.thumb} src={e.thumbnail} alt="" /> : <div className={styles.thumb}><Icon name="globe" size={20} /></div>}
      <b>{entryName(e)}</b>
      <span className={styles.tplDesc}>{e.builtinKey ? t(`${e.builtinKey}.desc` as MessageKey) : e.description}</span>
    </button>
  );
}
