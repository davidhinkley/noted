/* io/export.js — serialization for download. Never touches the DB directly. */

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

function blobToB64(blob) {
  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  });
}

/** One note → one .md download. */
export function exportMarkdown(note) {
  const title = note.title.trim();
  const body = note.body || '';
  const text = title && !body.startsWith('#') ? `# ${title}\n\n${body}` : body;
  download(`${slug(title)}.md`, text, 'text/markdown');
}

/**
 * All live notes → one .zip with individual .md files (T26).
 * JSZip arrives as an ES module through the import map (`+esm` build —
 * the dist UMD bundle has no ESM exports, so a bare dist URL would
 * resolve `default` to undefined).
 */
export async function exportMarkdownZip(notes) {
  const mod = await import('jszip');
  const JSZip = mod.default ?? mod.JSZip ?? window.JSZip;
  if (!JSZip) throw new Error('zip library failed to load');
  const zip = new JSZip();
  const used = new Set();
  for (const n of notes) {
    const title = (n.title || '').trim() || 'Untitled';
    const body = n.body || '';
    const text = title && !body.startsWith('#') ? `# ${title}\n\n${body}` : body;
    let fname = `${slug(title)}.md`;
    for (let i = 1; used.has(fname); i += 1) fname = `${slug(title)}-${i}.md`;
    used.add(fname);
    zip.file(fname, text);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `noted-md-${stamp()}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
