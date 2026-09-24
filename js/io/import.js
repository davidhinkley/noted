/* io/import.js — JSON import with validation. Hands results to db.js. */

import { SCHEMA_VERSION } from './export.js';
import { bulkImport, bulkImportAttachments, mergeImport } from '../db.js';

/**
 * Validates an export file and upserts its notes (idempotent by id).
 * Unknown top-level fields are ignored so future export formats import
 * cleanly; records without a string `body` are skipped. Accepts v1 files
 * (no attachments key) and v2 files (base64 attachments, T31).
 *
 * Two modes (T32 — file-relay sync, D13):
 * - 'merge' (default, lossless): per-id compare. Incoming updatedAt greater
 *   than local replaces; lesser keeps local; equal is a no-op. IDs on only
 *   one side are added. Delete-vs-edit ties go to the live side — an edit
 *   is never silently discarded. Attachments are add-if-absent by id
 *   (blobs are immutable). The whole merge runs in one transaction.
 * - 'replace' (backup restore): blind bulkPut, exactly the pre-T32 behavior.
 */
export async function importJSON(text, { mode = 'merge' } = {}) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('the file is not valid JSON');
  }

  if (!data || typeof data !== 'object') {
    throw new Error('the file is not a notes export');
  }
  if (data.schemaVersion !== SCHEMA_VERSION && data.schemaVersion !== 1) {
    throw new Error(
      `unsupported schemaVersion "${String(data.schemaVersion)}" (this version of NOTED imports v1–v${SCHEMA_VERSION})`,
    );
  }
  if (!Array.isArray(data.notes)) {
    throw new Error('the export has no "notes" array');
  }

  const notes = [];
  let skipped = 0;
  for (const raw of data.notes) {
    const note = normalize(raw);
    if (note) notes.push(note);
    else skipped += 1;
  }

  const atts = [];
  if (Array.isArray(data.attachments)) {
    for (const raw of data.attachments) {
      const att = normalizeAttachment(raw);
      if (att) atts.push(att);
    }
  }

  let merged = null;
  if (mode === 'replace') {
    await bulkImport(notes);
    if (atts.length) await bulkImportAttachments(atts);
  } else {
    merged = await mergeImport(notes, atts);
  }
  return { imported: notes.length, skipped, attachments: atts.length, merged };
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function b64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** Validates a v2 attachment record; the note link rides on noteId + the note's own attachments[] ids. */
function normalizeAttachment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.noteId !== 'string' || !raw.noteId) return null;
  if (typeof raw.data !== 'string' || !raw.data) return null;
  try {
    return {
      id: raw.id,
      noteId: raw.noteId,
      name: typeof raw.name === 'string' ? raw.name : 'file',
      type: typeof raw.type === 'string' ? raw.type : 'application/octet-stream',
      size: isNum(raw.size) ? raw.size : 0,
      enc: raw.enc === true,
      createdAt: isNum(raw.createdAt) ? raw.createdAt : Date.now(),
      data: b64ToBlob(raw.data, typeof raw.type === 'string' ? raw.type : undefined),
    };
  } catch {
    return null;
  }
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.body !== 'string') return null;
  const now = Date.now();
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID(),
    title: typeof raw.title === 'string' ? raw.title : '',
    body: raw.body,
    tags: Array.isArray(raw.tags)
      ? [...new Set(raw.tags.map((t) => String(t).trim().toLowerCase()).filter((t) => /[a-z0-9]/.test(t)))]
      : [],
    folderId: typeof raw.folderId === 'string' ? raw.folderId : null,
    pinned: raw.pinned === true,
    createdAt: isNum(raw.createdAt) ? raw.createdAt : now,
    updatedAt: isNum(raw.updatedAt) ? raw.updatedAt : now,
    deletedAt: isNum(raw.deletedAt) ? raw.deletedAt : null,
    attachments: [],
  };
}
