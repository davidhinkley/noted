/* db.js — Dexie schema, note record, CRUD.
 *
 * This module is the storage boundary: it never parses, transforms, or
 * inspects note bodies. Raw Markdown in, raw Markdown out.
 */

const db = new Dexie('noted');

db.version(1).stores({
  notes: 'id, title, folderId, updatedAt, deletedAt, *tags',
});

function freshTimestamps() {
  const t = Date.now();
  return { createdAt: t, updatedAt: t };
}

/** Create a note. `partial` may pre-fill any field except id/timestamps. */
export async function createNote(partial = {}) {
  const note = {
    id: crypto.randomUUID(),
    title: '',
    body: '',
    tags: [],
    folderId: null,
    deletedAt: null,
    attachments: [],
    ...partial,
    ...freshTimestamps(),
  };
  await db.notes.add(note);
  return note;
}

export function getNote(id) {
  return db.notes.get(id);
}

/** Patch a note. Silently drops attempts to rewrite id/createdAt. */
export async function updateNote(id, patch) {
  const clean = { ...patch };
  delete clean.id;
  delete clean.createdAt;
  clean.updatedAt = Date.now();
  await db.notes.update(id, clean);
  return db.notes.get(id);
}

/** Soft-delete only. There is no hard delete here on purpose (see T21). */
export function softDelete(id) {
  return updateNote(id, { deletedAt: Date.now() });
}

/** All live notes, most recently updated first. */
export function listActiveNotes() {
  return db.notes
    .orderBy('updatedAt')
    .reverse()
    .filter((n) => n.deletedAt == null)
    .toArray();
}

/** Live notes carrying one tag, most recently updated first. */
export async function listByTag(tag) {
  const notes = await db.notes
    .where('tags')
    .equals(tag)
    .filter((n) => n.deletedAt == null)
    .toArray();
  notes.sort((a, b) => b.updatedAt - a.updatedAt);
  return notes;
}

/** Everything, including soft-deleted — the lossless backup for export. */
export function listAllNotes() {
  return db.notes.orderBy('updatedAt').reverse().toArray();
}

/** Upsert validated notes (import path only). */
export function bulkImport(notes) {
  return db.notes.bulkPut(notes).then(() => notes.length);
}
