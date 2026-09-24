/* db.js — Dexie schema, note record, CRUD.
 *
 * This module is the storage boundary: it never parses, transforms, or
 * inspects note bodies. Raw Markdown in, raw Markdown out.
 */

const db = new Dexie('noted');

db.version(1).stores({
  notes: 'id, title, folderId, updatedAt, deletedAt, *tags',
});

// v2 (T24): adds the `folders` table. `folderId` was already reserved on
// notes in v1 (the creator always sets it), so the backfill only defends
// records that bypassed the creator — hand-edited or future-dated imports.
// Any note without a string folderId normalizes to null ("All notes").
db.version(2).stores({
  notes: 'id, title, folderId, updatedAt, deletedAt, *tags',
  folders: 'id, name, updatedAt',
}).upgrade(async (tx) => {
  await tx.table('notes').toCollection().modify((note) => {
    if (typeof note.folderId !== 'string') note.folderId = null;
  });
});

// v3 (T26): adds `pinned` boolean to notes. Default false for existing notes.
db.version(3).stores({
  notes: 'id, title, folderId, updatedAt, deletedAt, pinned, *tags',
  folders: 'id, name, updatedAt',
}).upgrade(async (tx) => {
  await tx.table('notes').toCollection().modify((note) => {
    if (typeof note.pinned !== 'boolean') note.pinned = false;
  });
});

// v4 (T31): separate `attachments` table (Blobs stored natively in
// IndexedDB). note.attachments[] — reserved since v1 — now holds attachment
// ids. No backfill: the table starts empty, no note rows move.
db.version(4).stores({
  notes: 'id, title, folderId, updatedAt, deletedAt, pinned, *tags',
  folders: 'id, name, updatedAt',
  attachments: 'id, noteId, createdAt',
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
    pinned: false,
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

/** Toggle the pinned flag. Bumps updatedAt. */
export function togglePin(id) {
  return db.notes.get(id).then((n) => {
    if (!n) return Promise.reject(new Error('note not found'));
    return updateNote(id, { pinned: !n.pinned });
  });
}

/** All live notes, most recently updated first; pinned first. */
export function listActiveNotes() {
  return db.notes
    .orderBy('updatedAt')
    .reverse()
    .filter((n) => n.deletedAt == null)
    .toArray()
    .then((notes) => notes.sort((a, b) => (b.pinned === a.pinned ? b.updatedAt - a.updatedAt : (b.pinned ? 1 : -1))));
}

/** Live notes carrying one tag, most recently updated first; pinned first. */
export async function listByTag(tag) {
  const notes = await db.notes
    .where('tags')
    .equals(tag)
    .filter((n) => n.deletedAt == null)
    .toArray();
  notes.sort((a, b) => (b.pinned === a.pinned ? b.updatedAt - a.updatedAt : (b.pinned ? 1 : -1)));
  return notes;
}

/** Soft-deleted notes only, most recently updated first; pinned first. */
export function listTrashedNotes() {
  return db.notes
    .orderBy('updatedAt')
    .reverse()
    .filter((n) => n.deletedAt != null)
    .toArray()
    .then((notes) => notes.sort((a, b) => (b.pinned === a.pinned ? b.updatedAt - a.updatedAt : (b.pinned ? 1 : -1))));
}

/** Restore: the only sanctioned way to clear deletedAt. Bumps updatedAt. */
export function restoreNote(id) {
  return updateNote(id, { deletedAt: null });
}

/**
 * Permanently delete. THE ONLY hard delete in the app — the trash view
 * (T21) is the sole caller, via purgeNote so attachments die with the note.
 * Everything else soft-deletes on purpose.
 */
export function hardDelete(id) {
  return db.notes.delete(id);
}

/** Everything, including soft-deleted — the lossless backup for export. */
export function listAllNotes() {
  return db.notes.orderBy('updatedAt').reverse().toArray();
}

/** Every attachment in the vault — the lossless backup for export. */
export function listAllAttachments() {
  return db.attachments.orderBy('createdAt').toArray();
}

// ---- attachments (T31) ----

/**
 * Store one attachment Blob and link its id into note.attachments[].
 * One transaction so the blob and the link cannot disagree. `data` is a
 * Blob as-is — callers encrypt the bytes first when the vault demands it
 * (the record carries `enc: true` in that case); the store stays dumb.
 */
export async function addAttachment(noteId, { name, type, data, enc = false }) {
  const att = {
    id: crypto.randomUUID(),
    noteId,
    name: String(name || 'file'),
    type: String(type || 'application/octet-stream'),
    size: data.size,
    enc: enc === true,
    createdAt: Date.now(),
    data,
  };
  await db.transaction('rw', db.notes, db.attachments, async () => {
    await db.attachments.add(att);
    const n = await db.notes.get(noteId);
    if (n) await db.notes.update(noteId, { attachments: [...(n.attachments || []), att.id] });
  });
  return att;
}

/** Attachments of one note, oldest first. */
export function listAttachments(noteId) {
  return db.attachments.where('noteId').equals(noteId).sortBy('createdAt');
}

export function getAttachment(id) {
  return db.attachments.get(id);
}

/** Delete one attachment and unlink its id. Empties nothing else. */
export async function removeAttachment(id) {
  const att = await db.attachments.get(id);
  if (!att) return;
  await db.transaction('rw', db.notes, db.attachments, async () => {
    await db.attachments.delete(id);
    const n = await db.notes.get(att.noteId);
    if (n) await db.notes.update(att.noteId, { attachments: (n.attachments || []).filter((a) => a !== id) });
  });
}

/**
 * Hard-delete a note with all its attachments — the trash purge path (T21).
 * One transaction so no orphaned blobs survive the note.
 */
export async function purgeNote(id) {
  await db.transaction('rw', db.notes, db.attachments, async () => {
    await db.attachments.where('noteId').equals(id).delete();
    await db.notes.delete(id);
  });
}

/** Upsert validated attachments (import path only). */
export function bulkImportAttachments(attachments) {
  return db.attachments.bulkPut(attachments).then(() => attachments.length);
}

// ---- folders (T24) ----

/** Create a folder. Rejects an empty/whitespace name. */
export async function createFolder(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('folder name must not be empty');
  const folder = { id: crypto.randomUUID(), name: trimmed, ...freshTimestamps() };
  await db.folders.add(folder);
  return folder;
}

export function getFolder(id) {
  return db.folders.get(id);
}

export async function renameFolder(id, name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('folder name must not be empty');
  await db.folders.update(id, { name: trimmed, updatedAt: Date.now() });
  return db.folders.get(id);
}

/**
 * Delete a folder. Its notes are unassigned back to "All notes" — notes are
 * never deleted by a folder action. One transaction so the two writes cannot
 * leave orphaned folderId references behind.
 */
export async function deleteFolder(id) {
  await db.transaction('rw', db.notes, db.folders, async () => {
    await db.notes.where('folderId').equals(id).modify({ folderId: null });
    await db.folders.delete(id);
  });
}

/** All folders, alphabetical. */
export function listFolders() {
  return db.folders.orderBy('name').toArray();
}

/** Live notes in one folder, most recently updated first; pinned first. */
export async function listByFolder(folderId) {
  const notes = await db.notes
    .where('folderId')
    .equals(folderId)
    .filter((n) => n.deletedAt == null)
    .toArray();
  notes.sort((a, b) => (b.pinned === a.pinned ? b.updatedAt - a.updatedAt : (b.pinned ? 1 : -1)));
  return notes;
}

/** One indexed query: note counts per folder, soft-deleted excluded. */
export async function folderNoteCounts(ids) {
  const counts = Object.fromEntries(ids.map((id) => [id, 0]));
  await db.notes.where('folderId').anyOf(ids).each((n) => {
    if (n.deletedAt != null) return;
    counts[n.folderId] = (counts[n.folderId] || 0) + 1;
  });
  return counts;
}

/** Upsert validated notes (import path only). */
export function bulkImport(notes) {
  return db.notes.bulkPut(notes).then(() => notes.length);
}

/**
 * Merge validated notes + attachments for file-relay sync (T32, D13).
 * Per-id compare in a single transaction: incoming updatedAt greater than
 * local replaces, lesser keeps local, equal is a no-op — except
 * delete-vs-edit ties at equal timestamps, where the live side wins so an
 * edit is never silently discarded. IDs on only one side are added.
 * Attachments are immutable blobs: add-if-absent by id.
 */
export function mergeImport(notes, atts) {
  return db.transaction('rw', db.notes, db.attachments, async () => {
    let added = 0;
    let updated = 0;
    let kept = 0;
    for (const incoming of notes) {
      const local = await db.notes.get(incoming.id);
      if (!local) {
        await db.notes.add(incoming);
        added += 1;
      } else if (incoming.updatedAt > local.updatedAt) {
        await db.notes.put(incoming);
        updated += 1;
      } else if (incoming.updatedAt === local.updatedAt && isLive(incoming) !== isLive(local)) {
        // Same timestamp, disagree on deletion: the live side wins.
        // An edit is never silently discarded by a concurrent delete.
        if (isLive(incoming)) {
          await db.notes.put(incoming);
          updated += 1;
        } else {
          kept += 1;
        }
      } else {
        kept += 1;
      }
    }
    let attachmentsAdded = 0;
    for (const att of atts) {
      if (!(await db.attachments.get(att.id))) {
        await db.attachments.add(att);
        attachmentsAdded += 1;
      }
    }
    return { added, updated, kept, attachmentsAdded };
  });
}

function isLive(note) {
  return note.deletedAt == null;
}
