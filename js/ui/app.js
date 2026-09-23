/* ui/app.js — the root Alpine component + bootstrap.
 *
 * Alpine is imported here (ESM build) rather than loaded as a UMD script tag,
 * because the UMD build auto-starts on a microtask before later module scripts
 * execute, and our component must be registered before Alpine.start() runs.
 */

import Alpine from 'https://cdn.jsdelivr.net/npm/alpinejs@3.14.8/dist/module.esm.js';
import * as db from '../db.js';
import { buildIndex, search } from '../search.js';
import { startRouter, navigate } from '../router.js';
import { exportJSON, exportMarkdown } from '../io/export.js';
import { importJSON } from '../io/import.js';

const SAVE_DEBOUNCE_MS = 400;

function deriveTitle(body) {
  for (const line of body.split('\n')) {
    const t = line.replace(/^#+\s*/, '').trim();
    if (t) return t.slice(0, 200);
  }
  return '';
}

function parseTags(text) {
  return [...new Set(text.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))];
}

function excerpt(body, max = 160) {
  const text = body.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

document.addEventListener('alpine:init', () => {
  Alpine.data('app', () => ({
    route: { name: 'list', params: {} },
    notes: [],
    query: '',
    note: null, // editor draft: { id, title, body, tagsInput, createdAt, updatedAt }
    preview: false,
    saveState: 'saved', // 'saved' | 'dirty' | 'saving'
    _saveTimer: null,

    init() {
      startRouter(async (route) => {
        // Flush pending edits before leaving the editor.
        if (this.route.name === 'note' && route.name !== 'note') {
          await this.saveNow();
        }
        if (route.name === 'note') this.query = '';
        this.route = route;
        await this.loadRoute();
      });
    },

    get visibleNotes() {
      const q = this.query.trim();
      // Always read this.notes (even in the query branch) so Alpine's x-for
      // effect subscribes to list changes, not just to the search input.
      // Fuse holds its own snapshot; without this dependency the list would
      // keep showing stale cards after a route change while a query is active.
      const notes = this.notes;
      if (!q) return notes;
      const results = search(q);
      return results ? results.map((r) => r.item) : [];
    },

    get saveLabel() {
      return { saved: 'Saved', dirty: 'Unsaved changes', saving: 'Saving…' }[this.saveState];
    },

    get rendered() {
      if (!this.note) return '';
      const html = marked.parse(this.note.body, { async: false, gfm: true, breaks: true });
      return DOMPurify.sanitize(html);
    },

    async loadRoute() {
      if (this.route.name === 'note') {
        await this.openNote(this.route.params.id);
      } else {
        this.note = null;
        this.preview = false;
        await this.refreshList();
      }
    },

    async refreshList() {
      this.notes =
        this.route.name === 'tag'
          ? await db.listByTag(this.route.params.tag)
          : await db.listActiveNotes();
      buildIndex(this.notes);
    },

    async openNote(id) {
      if (this.note && this.note.id === id) return;
      const n = await db.getNote(id);
      if (!n || n.deletedAt != null) {
        navigate('#/');
        return;
      }
      this.note = {
        id: n.id,
        title: n.title,
        body: n.body,
        tagsInput: n.tags.join(', '),
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
      };
      this.preview = false;
      this.saveState = 'saved';
    },

    open(id) {
      navigate(`#/note/${id}`);
    },

    async newNote() {
      const n = await db.createNote();
      navigate(`#/note/${n.id}`);
      return n;
    },

    touch() {
      this.saveState = 'dirty';
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => this.saveNow(), SAVE_DEBOUNCE_MS);
    },

    async saveNow() {
      if (!this.note || this.saveState === 'saved') return;
      clearTimeout(this._saveTimer);
      const id = this.note.id;
      this.saveState = 'saving';
      const title = this.note.title.trim() || deriveTitle(this.note.body);
      const updated = await db.updateNote(id, {
        title,
        body: this.note.body,
        tags: parseTags(this.note.tagsInput),
      });
      // The note may have been switched while the write was in flight.
      if (this.note && this.note.id === id) {
        this.note.updatedAt = updated.updatedAt;
        this.saveState = 'saved';
      }
    },

    togglePreview() {
      this.preview = !this.preview;
    },

    async goBack() {
      await this.saveNow();
      navigate('#/');
    },

    async removeNote() {
      if (!this.note) return;
      if (!window.confirm('Delete this note? It stays in the trash until the trash is emptied.')) return;
      clearTimeout(this._saveTimer);
      const id = this.note.id;
      this.note = null;
      await db.softDelete(id);
      navigate('#/');
    },

    async exportAll() {
      exportJSON(await db.listAllNotes());
    },

    exportMD() {
      if (!this.note) return;
      exportMarkdown({ title: this.note.title.trim() || deriveTitle(this.note.body), body: this.note.body });
    },

    triggerImport() {
      this.$refs.importFile.click();
    },

    async onImportFile(event) {
      const file = event.target.files[0];
      event.target.value = '';
      if (!file) return;
      try {
        const result = await importJSON(await file.text());
        window.alert(
          `Imported ${result.imported} note${result.imported === 1 ? '' : 's'}` +
            (result.skipped ? `, skipped ${result.skipped} invalid record${result.skipped === 1 ? '' : 's'}.` : '.'),
        );
        await this.refreshList();
      } catch (err) {
        window.alert(`Import failed: ${err.message}`);
      }
    },

    fmtDate,
    excerpt,
  }));
});

// Register-then-start; the ESM build does not auto-start.
Alpine.start();
