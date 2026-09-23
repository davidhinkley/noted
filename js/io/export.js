/* io/export.js — serialization for download. Never touches the DB directly. */

export const SCHEMA_VERSION = 1;

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
 */
export function exportJSON(notes) {
  const payload = {
    app: 'noted',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    notes,
  };
  download(`noted-export-${stamp()}.json`, JSON.stringify(payload, null, 2), 'application/json');
}

/** One note → one .md download. */
export function exportMarkdown(note) {
  const title = note.title.trim();
  const body = note.body || '';
  const text = title && !body.startsWith('#') ? `# ${title}\n\n${body}` : body;
  download(`${slug(title)}.md`, text, 'text/markdown');
}
