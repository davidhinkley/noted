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
import { exportJSON, exportMarkdown, exportMarkdownZip } from '../io/export.js';
import {
  vaultEnabled,
  isEnvelope,
  setupVault,
  openVault,
  clearVaultConfig,
  encryptBody,
  decryptBody,
  encryptBlob,
  decryptBlob,
} from '../crypto.js';
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
    folders: [], // folder records (T24); loaded on demand for the folders view + editor select
    folderCounts: {}, // { [folderId]: noteCount } for the folders view
    online: navigator.onLine, // net indicator (T25); updated by window events
    storageUsage: null, // { usage, quota } bytes from navigator.storage.estimate() (T25)
    vault: { enabled: false, unlocked: false }, // vault encryption (T30); key in _vaultKey only
    _vaultKey: null, // CryptoKey in memory only — never persisted, never in export
    attachments: [], // current note's attachment records (T31); blobs stay in the DB until download
    sortBy: 'updatedAt-desc', // T26: sort options
    sortOptions: [
      { value: 'updatedAt-desc', label: 'Updated ↓' },
      { value: 'updatedAt-asc', label: 'Updated ↑' },
      { value: 'createdAt-desc', label: 'Created ↓' },
      { value: 'createdAt-asc', label: 'Created ↑' },
      { value: 'title-asc', label: 'Title A–Z' },
      { value: 'title-desc', label: 'Title Z–A' },
      { value: 'pinned-first', label: 'Pinned first' },
    ],

    init() {
      this.settings = loadSettings();
      applySettings(this.settings);
      this.vault.enabled = vaultEnabled();
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
      window.addEventListener('online', () => (this.online = true));
      window.addEventListener('offline', () => (this.online = false));
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

    // Markdown formatting toolbar (D4/D8). The app never touches CodeMirror
    // directly; the wrapper owns the buffer mutation and we just name an action.
    // The resulting edit flows back through onDocChange, so save/undo are normal.
    formatAction(name) {
      if (!this.editor) return;
      this.editor.runAction(name);
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
      let notes = this.notes;
      if (q) {
        const results = search(q);
        notes = results ? results.map((r) => r.item) : [];
      }
      // Apply sort (T26)
      switch (this.sortBy) {
        case 'updatedAt-asc':
          notes = [...notes].sort((a, b) => a.updatedAt - b.updatedAt);
          break;
        case 'createdAt-desc':
          notes = [...notes].sort((a, b) => b.createdAt - a.createdAt);
          break;
        case 'createdAt-asc':
          notes = [...notes].sort((a, b) => a.createdAt - b.createdAt);
          break;
        case 'title-asc':
          notes = [...notes].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
          break;
        case 'title-desc':
          notes = [...notes].sort((a, b) => (b.title || '').localeCompare(a.title || ''));
          break;
        case 'pinned-first':
          notes = [...notes].sort((a, b) => (b.pinned === a.pinned ? b.updatedAt - a.updatedAt : (b.pinned ? 1 : -1)));
          break;
        case 'updatedAt-desc':
        default:
          notes = [...notes].sort((a, b) => b.updatedAt - a.updatedAt);
          break;
      }
      return notes;
    },

    get saveLabel() {
      return { saved: 'Saved', dirty: 'Unsaved changes', saving: 'Saving…' }[this.saveState];
    },

    // Settings (T23). Called from the settings view on every control change;
    // normalizes each value before it touches the page or localStorage.
    applySettings() {
      const s = this.settings;
      if (!['light', 'dark', 'system'].includes(s.theme)) s.theme = DEFAULT_SETTINGS.theme;
      s.editorFontSize = FONT_SIZES.includes(Number(s.editorFontSize))
        ? String(Number(s.editorFontSize))
        : DEFAULT_SETTINGS.editorFontSize;
      if (s.defaultPreview !== 'edit' && s.defaultPreview !== 'preview') {
        s.defaultPreview = DEFAULT_SETTINGS.defaultPreview;
      }
      this.settings = { ...s };
      applySettings(this.settings);
      saveSettings(this.settings);
    },

    // Storage estimate (T25). Read-only — surfaces navigator.storage.estimate
    // in the settings view so users see how close they are to the quota.
    async loadStorageInfo() {
      try {
        if (!navigator.storage?.estimate) {
          this.storageUsage = null;
          return;
        }
        this.storageUsage = await navigator.storage.estimate();
      } catch {
        this.storageUsage = null;
      }
    },

    formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes < 0) return '—';
      if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
      if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
      if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(1)} KB`;
      return `${Math.round(bytes)} B`;
    },

    get rendered() {
      if (!this.note) return '';
      const html = marked.parse(this.note.body, { async: false, gfm: true, breaks: true });
      return DOMPurify.sanitize(html);
    },

    async loadRoute() {
      if (this.route.name === 'note') {
        await this.openNote(this.route.params.id);
        return;
      }
      this.note = null;
      this.attachments = [];
      this.preview = false;
      if (this.route.name === 'settings') {
        await this.loadStorageInfo();
        return;
      }
      if (this.route.name === 'folders') {
        await this.refreshFolders();
        return;
      }
      // The folder view's title reads this.folders; the editor select needs it too.
      if (this.route.name === 'folder' && !this.folders.length) {
        this.folders = await db.listFolders();
      }
      await this.refreshList();
    },

    async refreshList() {
      const fetched =
        this.route.name === 'tag'
          ? await db.listByTag(this.route.params.tag)
          : this.route.name === 'trash'
            ? await db.listTrashedNotes()
            : this.route.name === 'folder'
              ? await db.listByFolder(this.route.params.id)
              : await db.listActiveNotes();
      this.notes = await this.decipherNotes(fetched);
      buildIndex(this.notes);
    },

    // Vault (T30). When unlocked, envelopes decrypt in place (decrypt-or-keep
    // fallback: a forged envelope fails closed and keeps its raw form).
    // When locked, envelope bodies are blanked so the search index and
    // excerpts never leak ciphertext — titles stay visible for navigation.
    async decipherNotes(notes) {
      if (!this.vault.enabled) return notes;
      if (this.vault.unlocked && this._vaultKey) {
        await Promise.all(
          notes.map(async (n) => {
            if (!isEnvelope(n.body)) return;
            try {
              n.body = await decryptBody(this._vaultKey, n.body);
            } catch {
              /* keep the envelope */
            }
          }),
        );
        return notes;
      }
      return notes.map((n) => (isEnvelope(n.body) ? { ...n, body: '' } : n));
    },

    async refreshFolders() {
      this.folders = await db.listFolders();
      this.folderCounts = await db.folderNoteCounts(this.folders.map((f) => f.id));
    },

    async openNote(id) {
      if (this.note && this.note.id === id) return;
      const n = await db.getNote(id);
      if (!n || n.deletedAt != null) {
        navigate('#/');
        return;
      }
      if (isEnvelope(n.body) && !(this.vault.unlocked && this._vaultKey)) {
        window.alert('This note is encrypted. Unlock the vault to read it.');
        navigate('#/');
        return;
      }
      if (!this.folders.length) this.folders = await db.listFolders();
      this.note = {
        id: n.id,
        title: n.title,
        body: n.body,
        tagsInput: n.tags.join(', '),
        folderId: typeof n.folderId === 'string' ? n.folderId : null,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
      };
      this.preview = this.settings.defaultPreview === 'preview';
      this.saveState = 'saved';
      // The draft holds plaintext in memory; the envelope stays in the DB.
      if (isEnvelope(this.note.body) && this.vault.unlocked && this._vaultKey) {
        try {
          this.note.body = await decryptBody(this._vaultKey, this.note.body);
        } catch {
          /* keep the envelope */
        }
      }
      // If the editor is already mounted (note→note navigation, e.g. Ctrl+N),
      // swap its document in place. A fresh mount reads getDoc() instead.
      if (this.editor) this.editor.setDoc(this.note.body || '');
      this.attachments = await db.listAttachments(id);
    },

    open(id) {
      navigate(`#/note/${id}`);
    },

    async newNote() {
      if (this.vault.enabled && !(this.vault.unlocked && this._vaultKey)) {
        window.alert('The vault is locked. Unlock it to write a new note.');
        return null;
      }
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
      if (this.vault.enabled && !(this.vault.unlocked && this._vaultKey)) {
        window.alert('The vault is locked. Unlock it to save changes.');
        this.saveState = 'dirty';
        return;
      }
      clearTimeout(this._saveTimer);
      const id = this.note.id;
      this.saveState = 'saving';
      const title = this.note.title.trim() || deriveTitle(this.note.body);
      const body =
        this.vault.enabled && this.vault.unlocked && this._vaultKey
          ? await encryptBody(this._vaultKey, this.note.body)
          : this.note.body;
      const updated = await db.updateNote(id, {
        title,
        body,
        tags: parseTags(this.note.tagsInput),
        folderId: this.note.folderId || null,
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

    // ---- attachments (T31) ----

    // 25MB per file: IndexedDB quota is shared with notes, so one giant
    // blob must not be able to evict the whole vault (see D12).
    // Keep in sync with any UI hint text.
    get maxAttachmentBytes() {
      return 25 * 1024 * 1024;
    },

    triggerAttach() {
      this.$refs.attachFile.click();
    },

    async onAttachFiles(event) {
      const files = [...(event.target.files || [])];
      event.target.value = '';
      if (!this.note || !files.length) return;
      if (this.vault.enabled && !(this.vault.unlocked && this._vaultKey)) {
        window.alert('The vault is locked. Unlock it to attach files.');
        return;
      }
      for (const f of files) {
        if (f.size > this.maxAttachmentBytes) {
          window.alert(`"${f.name}" is over 25MB and was skipped.`);
          continue;
        }
        let data = f;
        let enc = false;
        if (this.vault.enabled && this.vault.unlocked && this._vaultKey) {
          data = await encryptBlob(this._vaultKey, f);
          enc = true;
        }
        await db.addAttachment(this.note.id, { name: f.name, type: f.type, data, enc });
      }
      this.attachments = await db.listAttachments(this.note.id);
    },

    async downloadAttachment(id) {
      const att = this.attachments.find((a) => a.id === id) || (await db.getAttachment(id));
      if (!att) return;
      let blob = att.data;
      if (att.enc) {
        if (!(this.vault.unlocked && this._vaultKey)) {
          window.alert('Unlock the vault to download this attachment.');
          return;
        }
        try {
          blob = await decryptBlob(this._vaultKey, att.data, att.type);
        } catch {
          window.alert('This attachment failed authentication.');
          return;
        }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = att.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },

    async removeAttachment(id) {
      if (!window.confirm('Remove this attachment?')) return;
      await db.removeAttachment(id);
      if (this.note) this.attachments = await db.listAttachments(this.note.id);
    },

    // ---- folders (T24) ----

    folderTitle() {
      if (this.route.name !== 'folder') return '';
      const f = this.folders.find((x) => x.id === this.route.params.id);
      return f ? f.name : 'Folder';
    },

    folderCountLabel(id) {
      const c = this.folderCounts[id] || 0;
      return `${c} note${c === 1 ? '' : 's'}`;
    },

    async createFolder() {
      const name = window.prompt('New folder name:');
      if (!name || !name.trim()) return;
      try {
        await db.createFolder(name);
      } catch (err) {
        window.alert(err.message);
        return;
      }
      await this.refreshFolders();
    },

    async renameFolder(id) {
      const current = this.folders.find((f) => f.id === id);
      const name = window.prompt('Rename folder:', current ? current.name : '');
      if (!name || !name.trim()) return;
      try {
        await db.renameFolder(id, name);
      } catch (err) {
        window.alert(err.message);
        return;
      }
      await this.refreshFolders();
    },

    async deleteFolder(id) {
      const current = this.folders.find((f) => f.id === id);
      const name = current ? current.name : 'this folder';
      if (!window.confirm(`Delete "${name}"? Its notes move back to All notes — nothing is lost.`)) return;
      await db.deleteFolder(id);
      if (this.route.name === 'folder' && this.route.params.id === id) {
        navigate('#/folders');
        return;
      }
      await this.refreshFolders();
    },

    async togglePin(id) {
      await db.togglePin(id);
      await this.refreshList();
    },

    async exportZip() {
      try {
        await exportMarkdownZip(await db.listActiveNotes());
      } catch (err) {
        window.alert(`Zip export failed: ${err.message}`);
      }
    },

    // ---- vault encryption (T30, D11) ----

    async enableEncryption() {
      if (this.vault.enabled) return;
      const p1 = window.prompt(
        'Set a vault passphrase (at least 8 characters).\nIt is never stored — forget it and encrypted notes stay locked.',
      );
      if (!p1) return;
      if (p1.length < 8) {
        window.alert('Passphrase must be at least 8 characters.');
        return;
      }
      const p2 = window.prompt('Repeat the passphrase:');
      if (p1 !== p2) {
        window.alert('Passphrases do not match.');
        return;
      }
      const key = await setupVault(p1);
      // Encrypt every plaintext body, trash included — content is content.
      // updateNote bumps updatedAt on each row; the list re-sorts once.
      const all = await db.listAllNotes();
      for (const n of all) {
        if (!isEnvelope(n.body)) {
          await db.updateNote(n.id, { body: await encryptBody(key, n.body) });
        }
      }
      this._vaultKey = key;
      this.vault = { enabled: true, unlocked: true };
      await this.refreshList();
      window.alert('Encryption is on. Your passphrase exists only in your memory.');
    },

    async unlockVault() {
      if (!this.vault.enabled || this.vault.unlocked) return;
      const p = window.prompt('Vault passphrase:');
      if (!p) return;
      try {
        this._vaultKey = await openVault(p);
      } catch {
        window.alert('Wrong passphrase.');
        return;
      }
      this.vault.unlocked = true;
      await this.refreshList();
    },

    async lockVault() {
      if (!this.vault.enabled || !this.vault.unlocked) return;
      this._vaultKey = null;
      this.vault.unlocked = false;
      if (this.route.name === 'note') navigate('#/');
      else await this.refreshList();
    },

    async disableEncryption() {
      if (!this.vault.enabled || !this.vault.unlocked || !this._vaultKey) {
        window.alert('Unlock the vault first.');
        return;
      }
      if (!window.confirm('Decrypt every note and turn encryption off?')) return;
      const key = this._vaultKey;
      const all = await db.listAllNotes();
      for (const n of all) {
        if (!isEnvelope(n.body)) continue;
        try {
          await db.updateNote(n.id, { body: await decryptBody(key, n.body) });
        } catch {
          /* forged envelope: leave it */
        }
      }
      clearVaultConfig();
      this._vaultKey = null;
      this.vault = { enabled: false, unlocked: false };
      await this.refreshList();
    },

    excerptOf(n) {
      if (this.vault.enabled && !this.vault.unlocked && !n.body) {
        return '🔒 Encrypted — unlock the vault to read';
      }
      return excerpt(n.body);
    },

    async purge(id) {
      if (!window.confirm('Delete this note forever, with its attachments? This cannot be undone.')) return;
      await db.purgeNote(id);
      await this.refreshList();
    },

    async exportAll() {
      await exportJSON(await db.listAllNotes(), await db.listAllAttachments());
    },

    exportMD() {
      if (!this.note) return;
      exportMarkdown({ title: this.note.title.trim() || deriveTitle(this.note.body), body: this.note.body });
    },

    // Import mode split (T32, D13): the topbar Import merges (lossless sync
    // default); true backup restore lives in Settings as a destructive action.
    _importMode: 'merge',

    triggerImport(mode = 'merge') {
      this._importMode = mode;
      this.$refs.importFile.click();
    },

    async onImportFile(event) {
      const file = event.target.files[0];
      event.target.value = '';
      if (!file) return;
      try {
        const result = await importJSON(await file.text(), { mode: this._importMode });
        const m = result.merged;
        window.alert(
          m
            ? `Sync merge: ${m.added} added, ${m.updated} updated, ${m.kept} kept` +
              (m.attachmentsAdded ? `, ${m.attachmentsAdded} attachment${m.attachmentsAdded === 1 ? '' : 's'} added` : '') +
              (result.skipped ? `, skipped ${result.skipped} invalid record${result.skipped === 1 ? '' : 's'}.` : '.')
            : `Restored ${result.imported} note${result.imported === 1 ? '' : 's'}` +
              (result.attachments ? ` and ${result.attachments} attachment${result.attachments === 1 ? '' : 's'}` : '') +
              (result.skipped ? `, skipped ${result.skipped} invalid record${result.skipped === 1 ? '' : 's'}.` : '.'),
        );
        await this.refreshList();
      } catch (err) {
        window.alert(`Import failed: ${err.message}`);
      }
    },

    async restoreBackup() {
      if (
        !window.confirm(
          'Restore replaces every conflicting note with the backup copy. Local edits newer than the backup will be lost. Continue?',
        )
      )
        return;
      this.triggerImport('replace');
    },

    fmtDate,
    excerpt,
  }));
});

// Register-then-start; the ESM build does not auto-start.
Alpine.start();
