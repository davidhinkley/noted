/* media.js — the `attachment:<id>` reference scheme (D14).
 *
 * D12 decided where attachment bytes live. D14 decided how a note *names* one:
 * the body holds `attachment:<uuid>`, a name rather than a URL, so note.body
 * stays valid Markdown that round-trips, greps, and survives export/import.
 *
 * This module is the only place that knows the scheme exists. It is deliberately
 * one-directional at the boundary: the database never learns that a reference
 * exists, and the editors never learn how a blob is fetched. Everything else
 * (render, serialize, export) goes through the helpers here.
 *
 * Resolution is a two-way map, and both directions matter:
 *   ref  -> blob:  so an <img> in the rendered document can actually display
 *   blob -> ref   so serializing a rendered <img> back to Markdown puts the
 *                  reference in note.body instead of an ephemeral blob: URL
 * The reverse direction is what makes the WYSIWYG editor safe. Without it, a
 * repaint would serialize a live blob: URL into the document and the Markdown
 * would be corrupted within one debounce.
 */

import { listAttachments } from './db.js';
import { decryptBlob } from './crypto.js';

// The scheme prefix. Kept in one place so a future change is a one-line edit
// plus a note in architecture.md, not a find-and-replace across the app.
export const ATTACHMENT_SCHEME = 'attachment:';

/** True when a URL/src is a reference this module is responsible for. */
export function isAttachmentRef(src) {
  return typeof src === 'string' && src.startsWith(ATTACHMENT_SCHEME);
}

/** The attachment id a reference points at, or null. */
export function refId(ref) {
  if (!isAttachmentRef(ref)) return null;
  const id = ref.slice(ATTACHMENT_SCHEME.length);
  return id || null;
}

/** Build the reference Markdown should use for an attachment id. */
export function toRef(id) {
  return ATTACHMENT_SCHEME + id;
}

/** Every attachment id the given Markdown body references, in first-seen order. */
export function refsIn(body) {
  const found = [];
  const re = new RegExp(ATTACHMENT_SCHEME + '([0-9a-fA-F-]{36})', 'g');
  let m;
  while ((m = re.exec(String(body || '')))) {
    if (!found.includes(m[1])) found.push(m[0]);
  }
  return found;
}

/**
 * A per-note resolution table. Holds the two maps plus the object URLs minted
 * for this note, so they can all be released together.
 */
export function createMediaResolver() {
  // ref -> blob: URL
  const byRef = new Map();
  // blob: URL -> ref
  const byUrl = new Map();

  return {
    /** Replace every `attachment:<id>` src in rendered HTML with a blob: URL. */
    resolveHtml(html) {
      let out = String(html || '');
      for (const [ref, url] of byRef) {
        // Both quoting styles marked can emit, plus the no-quote form.
        out = out.split(`"${ref}"`).join(`"${url}"`);
        out = out.split(`'${ref}'`).join(`'${url}'`);
        out = out.split(`=${ref}"`).join(`="${url}"`);
      }
      return out;
    },

    /** The reference a rendered src maps back to, or null if it is not ours. */
    refForSrc(src) {
      return byUrl.get(src) || null;
    },

    /**
     * Mint blob: URLs for every reference in `body` that has a resolvable,
     * readable attachment. Missing, deleted or still-encrypted attachments are
     * skipped rather than throwing, so one bad reference cannot blank a note.
     */
    async resolve(noteId, body, { vaultKey = null, vaultUnlocked = false } = {}) {
      this.release();
      const refs = refsIn(body);
      if (!refs.length) return;
      const wanted = new Set(refs.map(refId));
      let records = [];
      try {
        records = await listAttachments(noteId);
      } catch {
        return; // no attachments store, or the note is gone
      }
      for (const att of records) {
        if (!att || !wanted.has(att.id)) continue;
        let blob = att.data;
        if (att.enc) {
          if (!vaultUnlocked || !vaultKey) continue; // stays broken while locked
          try {
            blob = await decryptBlob(vaultKey, att.data, att.type);
          } catch {
            continue; // failed authentication: leave the reference broken
          }
        }
        if (!(blob instanceof Blob)) continue;
        const url = URL.createObjectURL(blob);
        const ref = toRef(att.id);
        byRef.set(ref, url);
        byUrl.set(url, ref);
      }
    },

    /** True when every reference in the body resolved. Used for the warning. */
    missing(noteId, body) {
      const refs = refsIn(body);
      return refs.filter((ref) => !byRef.has(ref));
    },

    /** Revoke every object URL minted for this note. */
    release() {
      for (const url of byRef.values()) URL.revokeObjectURL(url);
      byRef.clear();
      byUrl.clear();
    },

    get size() {
      return byRef.size;
    },
  };
}

/**
 * DOMPurify drops any src whose scheme is not on its allowlist, which would
 * strip `attachment:` before the resolver ever sees it. Widening the regexp is
 * the fix; it stays a regexp we control rather than turning sanitization off.
 */
export function sanitizeForNotes(html) {
  return DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|attachment|blob|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  });
}
