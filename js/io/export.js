/* io/export.js — serialization for download. Never touches the DB directly. */

import { refsIn, refId } from '../media.js';

export const SCHEMA_VERSION = 2;

function download(filename, text, mime) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp() {
  return new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').slice(0, 12);
}

function slug(title) {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'note';
}

/**
 * One JSON file with every note, including soft-deleted ones —
 * the export is the backup story, so it must be lossless.
 * Attachments ride along as base64 (T31); v1 files simply omit the key.
 */
export async function exportJSON(notes, attachments = []) {
  const encoded = await Promise.all(
    attachments.map(async (a) => ({
      id: a.id,
      noteId: a.noteId,
      name: a.name,
      type: a.type,
      size: a.size,
      enc: a.enc === true,
      createdAt: a.createdAt,
      data: await blobToB64(a.data),
    })),
  );
  const payload = {
    app: 'noted',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    notes,
    attachments: encoded,
  };
  download(`noted-export-${stamp()}.json`, JSON.stringify(payload), 'application/json');
}

/**
 * Inline every `attachment:<id>` reference in the exported Markdown as a
 * `data:` URI (D14). An exported note is read outside NOTED, where the
 * scheme resolves to nothing, so a note exported with bare references would
 * show broken images. This is the deliberate exception to "keep the body
 * clean": the body itself is untouched, and only the download is rewritten.
 *
 * A reference whose attachment is missing or unreadable is left in place
 * rather than silently rewritten -- the user can see what is broken.
 */
export async function inlineAttachments(text, attachments) {
  if (!text || !attachments || !attachments.length) return text;
  const refs = refsIn(text);
  if (!refs.length) return text;
  const byId = new Map(attachments.map((a) => [a.id, a]));
  let out = text;
  for (const ref of refs) {
    const att = byId.get(refId(ref));
    if (!att || !att.data) continue;
    const dataUri = await blobToDataUri(att.data, att.type);
    out = out.split(ref).join(dataUri);
  }
  return out;
}

async function blobToDataUri(blob, type) {
  const b64 = await blobToB64(blob);
  const mime = String(type || 'application/octet-stream')
    .split(';')[0]
    .trim() || 'application/octet-stream';
  return `data:${mime};base64,${b64}`;
}

function blobToB64(blob) {
  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  });
}

/**
 * One note → one .md download.
 *
 * D14: `attachment:<id>` means nothing outside NOTED, so referenced images
 * are inlined as `data:` URIs. The getter is the caller's only route to the
 * attachment bytes — this module must not import db.js.
 */
export async function exportMarkdown(note, getAttachments = null) {
  const title = note.title.trim();
  const body = note.body || '';
  const text = title && !body.startsWith('#') ? `# ${title}\n\n${body}` : body;
  const atts = getAttachments && note.id ? await getAttachments(note.id) : [];
  const inlined = await inlineAttachments(text, atts);
  download(`${slug(title)}.md`, inlined, 'text/markdown');
}

/**
 * All live notes → one .zip with individual .md files (T26).
 * JSZip arrives as an ES module through the import map (`+esm` build —
 * the dist UMD bundle has no ESM exports, so a bare dist URL would
 * resolve `default` to undefined).
 */
export async function exportMarkdownZip(notes, getAttachments = null) {
  const mod = await import('jszip');
  const JSZip = mod.default ?? mod.JSZip ?? window.JSZip;
  if (!JSZip) throw new Error('zip library failed to load');
  const zip = new JSZip();
  const used = new Set();
  for (const n of notes) {
    const title = (n.title || '').trim() || 'Untitled';
    const body = n.body || '';
    const text = title && !body.startsWith('#') ? `# ${title}\n\n${body}` : body;
    const atts = getAttachments ? await getAttachments(n.id) : [];
    const inlined = await inlineAttachments(text, atts);
    let fname = `${slug(title)}.md`;
    for (let i = 1; used.has(fname); i += 1) fname = `${slug(title)}-${i}.md`;
    used.add(fname);
    zip.file(fname, inlined);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `noted-md-${stamp()}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
