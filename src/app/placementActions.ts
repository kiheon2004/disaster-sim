/**
 * Disaster placement actions (Phase 35.5). A click on the map creates an ordinary experiment instance (the same model the
 * experiment list, the commands and the saved plan use) at the clicked point — moved there by the phenomenon's placement
 * policy (src/phenomena/catalog.ts) — and, in "run now" mode, runs just that instance through runSimulation, i.e. the same
 * SimulationController.addEvent path as every other way of starting a disaster.
 */
import { phenomena } from '@/phenomena/registry';
import { catalogOf, placeable } from '@/phenomena/catalog';
import { resolveSchedule } from '@/phenomena/schedule';
import type { PhenomenonInstance } from '@/phenomena/types';
import type { EventSpec } from '@/events/specs';
import { useWorldStore } from '@/world/worldStore';
import { useEditorStore } from '@/editor/editorStore';
import { simulationController } from '@/simulation/SimulationController';
import { usePlacementStore, type PlacementOp } from '@/ui/placement/placementStore';
import { useUiStore } from '@/ui/uiStore';
import { useViewStore } from '@/rendering/viewStore';
import { toast } from '@/ui/common/toast';
import { t } from '@/i18n/i18n';
import { addPhenomenon, phenomenonContext, removePhenomenon, runSimulation, updatePhenomenon } from './actions';

const P = () => usePlacementStore.getState();
const instances = () => useWorldStore.getState().doc.scenario.experiment?.instances ?? [];
const find = (id: string) => instances().find((i) => i.id === id);

/** Half size of the map (m) — the edge policy picks the nearest side of it. */
export function mapHalf(): number {
  const tr = useWorldStore.getState().doc.terrain;
  return ((tr.nx - 1) * tr.cellSize) / 2;
}

/** Keys of the instances already in the current run (started or scheduled). */
export function runningKeys(): Set<string> {
  return useEditorStore.getState().mode === 'simulation' && simulationController.isLoaded() ? new Set(simulationController.instances().map((i) => i.key)) : new Set();
}

/** Start placing a phenomenon (library card). Global phenomena (map-wide wind …) are added at once instead. */
export function armPlacement(type: string): void {
  const def = phenomena.implemented(type);
  if (!def) return;
  P().noteRecent(type);
  useUiStore.getState().setRightTab('phenomena');
  // One map-click owner at a time: the older single-instance pickers are cancelled.
  useViewStore.getState().setGroundPick(null);
  useViewStore.getState().setDeformPick(null);
  const spec = def.defaults();
  if (!placeable(type, spec)) {
    const id = addPhenomenon(type, spec);
    if (id) {
      P().record({ kind: 'add', inst: find(id)! });
      P().select(id);
      if (P().runMode === 'now') void runInstance(id);
    }
    return;
  }
  P().arm(type, spec);
}

export function disarmPlacement(): void {
  P().disarm();
}

/** Place the armed phenomenon at a map point (x, z). Returns the new instance id. */
export function placeAt(p: [number, number]): string | null {
  const { type, template, runMode, continuous } = P();
  const entry = type ? catalogOf(type) : undefined;
  if (!type || !template || !entry) return null;
  const spec = entry.placement.set(template, p, mapHalf());
  const id = addPhenomenon(type, spec, { quiet: true });
  if (!id) return null;
  const inst = find(id)!;
  P().record({ kind: 'add', inst });
  P().select(id);
  toast('info', { key: 'place.placed', params: { name: t(phenomena.get(type)!.labelKey), id, x: Math.round(p[0]), z: Math.round(p[1]) } });
  if (runMode === 'now') void runInstance(id);
  if (!continuous) P().disarm();
  return id;
}

/**
 * Run ONE instance now (it starts at the current simulation time, its own delay kept when it is "at" a time > 0 in editor
 * mode). Enters the simulation if needed. Instances already in the run are not added again.
 */
export async function runInstance(id: string): Promise<void> {
  const inst = find(id);
  if (!inst || !inst.enabled) return;
  if (runningKeys().has(id)) return;
  const inSim = useEditorStore.getState().mode === 'simulation';
  const base = inSim ? simulationController.getTime() : 0;
  const alone: PhenomenonInstance = { ...inst, start: 'at' in inst.start && !inSim ? inst.start : { at: 0 } };
  const sched = resolveSchedule([alone], phenomenonContext(), base);
  if (!sched.items.length) {
    for (const issue of sched.issues) toast('warn', { key: `exp.issue.${issue.problem}`, params: { id: issue.id } });
    return;
  }
  // Undo of placements covers edits before a run only.
  P().clearHistory();
  await runSimulation([sched.items[0].spec], [id]);
}

/** Move a placed instance (drag / exact coordinates). Refused once it is part of the run. */
export function moveInstance(id: string, p: [number, number]): boolean {
  const inst = find(id);
  const entry = inst ? catalogOf(inst.type) : undefined;
  if (!inst || !entry) return false;
  if (runningKeys().has(id)) {
    toast('warn', { key: 'place.lockedRunning' });
    return false;
  }
  const to = entry.placement.set(inst.spec, p, mapHalf());
  P().record({ kind: 'move', id, from: inst.spec, to });
  updatePhenomenon(id, { spec: to });
  return true;
}

/** Delete a placed instance: from the plan, and — when it is in the run — cancel it (pending) or stop it (sustained). */
export function deleteInstance(id: string): void {
  const all = instances();
  const index = all.findIndex((i) => i.id === id);
  if (index < 0) return;
  if (runningKeys().has(id)) {
    const st = simulationController.instances().find((i) => i.key === id);
    if (st?.status === 'pending') simulationController.controlEvent(id, 'cancel');
    else if ((st?.status === 'active' || st?.status === 'paused') && st.stop) simulationController.controlEvent(id, 'stop');
  }
  P().record({ kind: 'remove', inst: all[index], index });
  removePhenomenon(id);
  if (P().selected === id) P().select(null);
}

/** Copy of an instance 6 m east (a new independent instance). */
export function duplicateInstance(id: string): string | null {
  const inst = find(id);
  const entry = inst ? catalogOf(inst.type) : undefined;
  if (!inst) return null;
  const at = entry?.placement.get(inst.spec);
  const spec = at && entry ? entry.placement.set(inst.spec, [at[0] + 6, at[1]], mapHalf()) : inst.spec;
  const nid = addPhenomenon(inst.type, { ...spec, startTime: 'at' in inst.start ? inst.start.at : 0 } as EventSpec, { quiet: true });
  if (nid) {
    P().record({ kind: 'add', inst: find(nid)! });
    P().select(nid);
  }
  return nid;
}

function setInstances(list: PhenomenonInstance[]) {
  useWorldStore.getState().setExperiment({ instances: list });
}

function invert(op: PlacementOp): PlacementOp {
  if (op.kind === 'add') return { kind: 'remove', inst: op.inst, index: instances().findIndex((i) => i.id === op.inst.id) };
  if (op.kind === 'remove') return { kind: 'add', inst: op.inst };
  return { kind: 'move', id: op.id, from: op.to, to: op.from };
}

function applyOp(op: PlacementOp): boolean {
  const list = instances();
  if (op.kind === 'add') {
    if (list.some((i) => i.id === op.inst.id)) return false;
    setInstances([...list, op.inst]);
    return true;
  }
  if (op.kind === 'remove') {
    if (runningKeys().has(op.inst.id)) return false;
    setInstances(list.filter((i) => i.id !== op.inst.id));
    if (P().selected === op.inst.id) P().select(null);
    return true;
  }
  if (!list.some((i) => i.id === op.id) || runningKeys().has(op.id)) return false;
  updatePhenomenon(op.id, { spec: op.to });
  return true;
}

/** Ctrl/⌘+Z on placements (before they run). */
export function undoPlacement(): boolean {
  const { undo, redo } = P();
  const op = undo[undo.length - 1];
  if (!op) return false;
  const inv = invert(op);
  // Re-inserting a removed instance keeps its place in the list.
  if (op.kind === 'remove') {
    const list = instances();
    if (list.some((i) => i.id === op.inst.id)) return false;
    const next = [...list];
    next.splice(Math.min(op.index, next.length), 0, op.inst);
    setInstances(next);
  } else if (!applyOp(inv)) {
    toast('warn', { key: 'place.undoBlocked' });
    return false;
  }
  usePlacementStore.setState({ undo: undo.slice(0, -1), redo: [...redo, op] });
  return true;
}

/** Ctrl/⌘+Shift+Z. */
export function redoPlacement(): boolean {
  const { undo, redo } = P();
  const op = redo[redo.length - 1];
  if (!op) return false;
  if (!applyOp(op.kind === 'remove' ? { kind: 'remove', inst: op.inst, index: op.index } : op)) return false;
  usePlacementStore.setState({ undo: [...undo, op], redo: redo.slice(0, -1) });
  return true;
}
