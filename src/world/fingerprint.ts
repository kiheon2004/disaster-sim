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

function fnv(json: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 13);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/**
 * Fingerprint of a world with the object and group ids taken out (Phase 37). Object ids and group ids are random
 * (core/id.ts): the same edits made twice — a command script run again, in another session or language — give other
 * ids and another `worldFingerprint`. Here every object is named by its type and running number (`building#3`), every
 * group by the order its first member comes in, the objects are listed in that order, and every other mention of an
 * object id in the document (car settings, occupants, fire targets) is renamed the same way; creation and save times
 * are left out. Two worlds with this fingerprint are the same world up to those names.
 */
export function canonicalFingerprint(doc: WorldDocument): string {
  const objs = Object.values(doc.objects).sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) || a.serial - b.serial || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const label = new Map<string, string>();
  const used = new Set<string>();
  for (const o of objs) {
    let name = `${o.type}#${o.serial}`;
    for (let k = 2; used.has(name); k++) name = `${o.type}#${o.serial}~${k}`;
    used.add(name);
    label.set(o.id, name);
  }
  const groups = new Map<string, string>();
  for (const o of objs) if (o.group && !groups.has(o.group)) groups.set(o.group, `group#${groups.size + 1}`);
  const objects = Object.fromEntries(objs.map((o) => [label.get(o.id)!, { ...o, id: label.get(o.id)!, ...(o.group ? { group: groups.get(o.group)! } : {}) }]));
  const copy: WorldDocument = { ...doc, objects, meta: { ...doc.meta, createdAt: '', updatedAt: '' } };
  if (doc.groups) {
    // Names of groups that still have members, under their canonical ids, in that order.
    const named = [...groups.entries()].filter(([id]) => doc.groups![id]).map(([id, l]) => [l, doc.groups![id]] as const);
    if (named.length) copy.groups = Object.fromEntries(named);
    else delete copy.groups;
  }
  let json = serializeDocument(copy, false);
  // Longest ids first, so that an id that is a prefix of another does not eat it.
  for (const [id, name] of [...label.entries()].sort((a, b) => b[0].length - a[0].length)) if (json.includes(id)) json = json.split(id).join(name);
  return fnv(json);
}

/**
 * Hash of every per-vertex array of the world — final terrain (heights, ground, soil) and all landscape layers, the
 * derived ones included (the serialized document recomputes those on load, so `worldFingerprint` does not see them).
 * "Bit-identical after undo" is this hash plus the fingerprint.
 */
export function terrainBitsHash(doc: WorldDocument): string {
  const t = doc.terrain, l = doc.landscape;
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (const arr of [t.heights, t.ground, t.soil, l.base.heights, l.base.ground, l.sculpt, l.paint, l.natural.heights, l.natural.ground, l.natural.culvert, l.natural.roadBase]) {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    for (let i = 0; i < bytes.length; i++) {
      a = Math.imul(a ^ bytes[i], 0x01000193);
      b = Math.imul(b ^ bytes[i], 0x5bd1e995) ^ (b >>> 13);
    }
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0') + ':' + JSON.stringify(t.settings);
}

