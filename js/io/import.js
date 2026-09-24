/* io/import.js — JSON import with validation. Hands results to db.js. */

import { SCHEMA_VERSION } from './export.js';
import { bulkImport } from '../db.js';

/**
 * Validates an export file and upserts its notes (idempotent by id).
 * Unknown top-level fields are ignored so future export formats import
 * cleanly; records without a string `body` are skipped.
 */
export async function importJSON(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('the file is not valid JSON');
  }

  if (!data || typeof data !== 'object') {
    throw new Error('the file is not a notes export');
  }
  if (data.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `unsupported schemaVersion "${String(data.schemaVersion)}" (this version of NOTED imports v${SCHEMA_VERSION})`,
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

  await bulkImport(notes);
  return { imported: notes.length, skipped };
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
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
