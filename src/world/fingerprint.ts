import type { WorldDocument } from '@/core/model';
import { serializeDocument } from './serialization';

/**
 * Content fingerprint of a world (Phase 16): everything that defines the experiment's initial
 * conditions — objects, terrain layers, settings, scenario — but not the save timestamp.
 * Two documents with the same fingerprint start a simulation identically.
 */
export function worldFingerprint(doc: WorldDocument): string {
  const json = serializeDocument({ ...doc, meta: { ...doc.meta, updatedAt: '' } }, false);
  // Two independent 32-bit FNV-1a lanes → 16 hex digits.
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 13);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
