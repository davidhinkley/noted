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
import { createMarkdownEditor } from './editor.js';
import { loadSettings, saveSettings, applySettings, DEFAULT_SETTINGS, FONT_SIZES } from './settings.js';

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
    editor: null, // CodeMirror wrapper (ui/editor.js); null outside the note route
    settings: null, // loaded in init(); see ui/settings.js (T23)

    init() {
      this.settings = loadSettings();
      applySettings(this.settings);
      startRouter(async (route) => {
        // Flush pending edits before leaving the editor.
        if (this.route.name === 'note' && route.name !== 'note') {
          await this.saveNow();
        }
        if (route.name !== 'note' && this.editor) {
          this.editor.destroy();
          this.editor = null;
        }
        if (route.name === 'note') this.query = '';
        this.route = route;
        await this.loadRoute();
      });
      document.addEventListener('keydown', (e) => this.onKeydown(e));
    },

    // The editor is swappable (AGENTS.md). This is where the CodeMirror wrapper
    // is mounted onto the DOM; storage never sees the editor itself.
    mountEditor(el) {
      if (this.editor && this.editor.view.dom.parentElement === el) return;
      if (this.editor) this.editor.destroy();
      this.editor = createMarkdownEditor(el, {
        getDoc: () => (this.note ? this.note.body : ''),
        onDocChange: (doc) => {
          if (!this.note) return;
          this.note.body = doc;
          this.touch();
        },
      });
    },

    // Keyboard shortcuts (T22): Ctrl/Cmd+N new, +S save, +E preview, +K search.
    onKeydown(e) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'n') {
        e.preventDefault();
        this.newNote();
      } else if (key === 's') {
        e.preventDefault();
        this.saveNow();
      } else if (key === 'e') {
        e.preventDefault();
        this.togglePreview();
      } else if (key === 'k') {
        e.preventDefault();
        this.focusSearch();
      }
    },

    focusSearch() {
      if (this.route.name === 'note') return;
      const el = this.$root.querySelector('.search');
      if (el) el.focus();
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

    // Settings (T23). Called from the settings view on every control change;
    // normalizes each value before it touches the page or localStorage.
    applySettings() {
      const s = this.settings;
      if (!['light', 'dark', 'system'].includes(s.theme)) s.theme = DEFAULT_SETTINGS.theme;
      s.editorFontSize = FONT_SIZES.includes(Number(s.editorFontSize)) ? Number(s.editorFontSize) : DEFAULT_SETTINGS.editorFontSize;
      if (s.defaultPreview !== 'edit' && s.defaultPreview !== 'preview') {
        s.defaultPreview = DEFAULT_SETTINGS.defaultPreview;
      }
      this.settings = { ...s };
      applySettings(this.settings);
      saveSettings(this.settings);
    },

    get rendered() {
      if (!this.note) return '';
      const html = marked.parse(this.note.body, { async: false, gfm: true, breaks: true });
      return DOMPurify.sanitize(html);
    },

    async loadRoute() {
      if (this.route.name === 'note') {
        await this.openNote(this.route.params.id);
      } else if (this.route.name === 'settings') {
        // Settings is a static view; the list index is unnecessary here.
        this.note = null;
        this.preview = false;
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
          : this.route.name === 'trash'
            ? await db.listTrashedNotes()
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
      this.preview = this.settings.defaultPreview === 'preview';
      this.saveState = 'saved';
      // If the editor is already mounted (note→note navigation, e.g. Ctrl+N),
      // swap its document in place. A fresh mount reads getDoc() instead.
      if (this.editor) this.editor.setDoc(this.note.body || '');
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

    async restore(id) {
      await db.restoreNote(id);
      await this.refreshList();
    },

    async purge(id) {
      if (!window.confirm('Delete this note forever? This cannot be undone.')) return;
      await db.hardDelete(id);
      await this.refreshList();
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
