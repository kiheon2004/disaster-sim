/**
 * Committing a stamp (Phase 37 §17): duplicate of several objects, paste, Blueprint placement. A stamp adds copies under
 * NEW ids — known only after `applyEdit` — and the car settings its data carries (`Blueprint.cars`,
 * `UnifiedBlueprint.cars`: src/vehicle/carCopies.ts) must be written under those ids in the SAME undo step. The UI
 * actions and the Phase 37 commands both commit stamps through this function.
 */
import type { EntityId } from '@/core/types';
import { addCarSettings, carSettingsOfCopies, type CarSettingsMap } from '@/vehicle/carCopies';
import type { WorldEdit, WorldState } from './worldStore';

/**
 * Apply `edit` (which adds the copies) and give the copied cars their settings — ONE undo step: undo removes the
 * copies and their settings, redo brings both back.
 *
 *   cars     the settings the stamp carries, by the stamp's own keys (undefined / empty = none)
 *   keys[k]  the key of `edit.add[k]` — `applyEdit` returns the new ids in the order of `add`, so `keys[k]` ↔ `ids[k]`
 *
 * Nothing to copy (no entry for any added object, or the document has no vehicle settings — legacy cars) → plain
 * `applyEdit`, exactly as before Phase 37. Otherwise the edit and the settings go through `batch`: an exception inside
 * rolls everything back and is thrown on (callers report it as they report an `applyEdit` failure). Returns the new
 * ids, or null when the stamp was REFUSED and nothing changed: the document is locked, or a brush stroke / object
 * transaction is open (the stamp could not be one step then). Inside an open batch (a command) it joins that batch.
 */
export function applyStamp(store: { getState: () => WorldState }, edit: WorldEdit, cars: CarSettingsMap | undefined, keys: readonly string[]): EntityId[] | null {
  const W = store.getState;
  const carried = cars && keys.some((k) => Object.hasOwn(cars, k) && cars[k]);
  if (!carried || !W().doc.settings.simulation.vehicles) return W().applyEdit(edit);
  const r = W().batch(() => {
    const ids = W().applyEdit(edit);
    const settings = addCarSettings(W().doc.settings, carSettingsOfCopies(cars, ids.map((id, k) => [keys[k], id] as const)));
    if (settings !== W().doc.settings) W().applyEdit({ settings });
    return ids;
  });
  if (r.ok) return r.value;
  if (r.reason === 'error') throw r.error;
  return null;
}
