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
import { importJSON, importMarkdownFile } from '../io/import.js';
import { createMarkdownEditor } from './editor.js';
import { createWysiwygEditor, setMediaResolver } from './wysiwyg.js';
import { createMediaResolver, refsIn, toRef } from '../media.js';
import { loadSettings, saveSettings, applySettings, DEFAULT_SETTINGS, FONT_SIZES, VIEW_MODES } from './settings.js';
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
    mode: 'edit', // see ui/settings.js VIEW_MODES: 'edit' (WYSIWYG) | 'code' (raw Markdown)
    saveState: 'saved', // 'saved' | 'dirty' | 'saving'
    _saveTimer: null,
    editor: null, // CodeMirror wrapper (ui/editor.js); null outside the note route
    wysiwyg: null, // Edit-mode wrapper (ui/wysiwyg.js); null outside the note route
    media: null, // attachment resolver for the current note (D14); one per note
    _mediaKey: '', // guards redundant re-resolves while typing
    _reconcileTimer: null, // debounces the post-paste re-resolve
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
        // Flush pending edits before leaving the editor. Write mode debounces
        // its own commits, so it has to be drained before the save reads the body.
        if (this.route.name === 'note' && route.name !== 'note') {
          if (this.wysiwyg) this.wysiwyg.flush();
          await this.saveNow();
        }
        if (route.name !== 'note' && this.editor) {
          this.editor.destroy();
          this.editor = null;
        }
        if (route.name !== 'note' && this.wysiwyg) {
          this.wysiwyg.destroy();
          this.wysiwyg = null;
        }
        if (route.name !== 'note' && this.media) {
          // Object URLs are session-scoped; leaving them alive leaks a blob per
          // attachment per note visit (D14).
          this.media.release();
          this.media = null;
          this._mediaKey = '';
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

    // WYSIWYG surface (T36): the second implementation behind the swappable-editor
    // seam. It owns a contenteditable and round-trips to Markdown, so the rest
    // of the app sees the same `body` string the source editor produces. It is
    // mounted alongside the source editor and stays hidden in the other modes,
    // which is why its buffer is handed over explicitly on the way out (setMode).
    /**
     * Store a pasted/dropped image and return the `attachment:<id>`
     * reference to insert at the caret. Vault-encrypted when the vault
     * is enabled (D14).
     */
    async onAttachImage(file) {
      if (!this.note) throw new Error('no note');
      const data = file; // File is a Blob; addAttachment accepts Blob
      const enc = !!(this.vault.enabled && this.vault.unlocked && this._vaultKey);
      const att = await db.addAttachment(this.note.id, {
        name: file.name || 'image',
        type: file.type || 'image/png',
        data,
        enc,
      });
      this.attachments = await db.listAttachments(this.note.id);
      return toRef(att.id);
    },

    /**
     * Identity of the resolution work: the note plus the set of attachment
     * references it contains. Keying on the REFERENCE SET, not the body text,
     * is what keeps resolution off the typing path. A body-keyed guard is
     * invalidated by every keystroke, so every settle would re-resolve and
     * repaint the whole surface mid-sentence and throw the caret.
     */
    mediaKey() {
      return this.note.id + '|' + refsIn(this.note.body || '').join(',');
    },

    /**
     * Build the per-note resolution table (D14). Missing, deleted, or
     * still-encrypted attachments are skipped rather than throwing, so one
     * bad reference cannot blank a note. The `_mediaKey` guard prevents
     * re-resolving when nothing about the references has changed.
     */
    async resolveMedia() {
      if (!this.note) return;
      if (!this.media) this.media = createMediaResolver();
      // Install synchronously and unconditionally. The surface may already be
      // mounted and painting; leaving the module-level resolver null or stale
      // here is what made the first paint drop the attachment `src`.
      setMediaResolver(this.media);
      // Note id is part of the key: two notes with byte-identical bodies would
      // otherwise hit the early return and inherit the previous note's object
      // URLs, showing an image the note does not actually reference.
      const key = this.mediaKey();
      if (key === this._mediaKey) return;
      this._mediaKey = key;
      await this.media.resolve(this.note.id, this.note.body, {
        vaultKey: this._vaultKey,
        vaultUnlocked: this.vault.unlocked,
      });
      // Warn once if any reference could not be resolved.
      const missing = this.media.missing(this.note.id, this.note.body);
      if (missing.length) {
        console.warn('[noted] unresolved attachment refs:', missing);
      }
    },

    /**
     * A pasted image is stored first and its reference lands in the body a
     * moment later, so the reference arrives AFTER the resolver has already
     * run. Without this, a freshly pasted image stays an unresolvable
     * reference until the note is reopened. The guard is the reference set
     * (see `mediaKey`), so ordinary keystrokes do not alter it and no repaint
     * is scheduled -- only a genuinely new or removed reference is.
     */
    reconcileMedia() {
      if (!this.note) return;
      if (this.mediaKey() === this._mediaKey) return;
      if (this._reconcileTimer) clearTimeout(this._reconcileTimer);
      this._reconcileTimer = setTimeout(async () => {
        this._reconcileTimer = null;
        await this.resolveMedia();
        // Only repaint if the surface is the one on screen; otherwise the
        // editor does this itself the next time the mode is entered.
        if (this.wysiwyg && this.mode === 'edit') this.wysiwyg.refresh();
      }, 120);
    },

    mountWysiwyg(el) {
      if (this.wysiwyg) return;
      this.wysiwyg = createWysiwygEditor(el, {
        getBody: () => (this.note ? this.note.body : ''),
        onBodyChange: (body) => {
          if (!this.note) return;
          this.note.body = body;
          this.touch();
          this.reconcileMedia();
        },
        onAttachImage: (file) => this.onAttachImage(file),
      });
      setMediaResolver(this.media);
      this.syncWysiwyg();
    },

    /**
     * Point the Edit surface at the current note. Idempotent, and called by
     * every event that can change what the surface should show: mount, note
     * load, and mode switch.
     *
     * This is one function rather than a guard in each caller because the
     * note pane is behind an x-if, so whether the surface mounts before or
     * after `openNote` is a detail of Alpine's scheduler. The first version of
     * this put an `if (this.wysiwyg) setBody(...)` guard in openNote and a
     * mirror-image one here, which meant BOTH had to be right in the right
     * order; the guards silently did nothing on one of the two orders and the
     * surface mounted blank. Encoding the ordering in a comment is not the
     * same as enforcing it — so nothing depends on the order now.
     */
    syncWysiwyg() {
      if (!this.wysiwyg || !this.note) return;
      this.wysiwyg.setBody(this.note.body || '');
    },

    // Markdown formatting toolbar (D4/D8). The app never touches an editor
    // directly; each wrapper owns the buffer mutation and we just name an action.
    // The resulting edit flows back through the wrapper's change callback, so
    // save is normal. Write mode maps the same action names onto the
    // contenteditable, so one toolbar serves both editors.
    formatAction(name) {
      if (this.mode === 'edit') {
        if (this.wysiwyg) this.wysiwyg.runAction(name);
        return;
      }
      if (this.editor) this.editor.runAction(name);
    },

    // Keyboard shortcuts (T22): Ctrl/Cmd+N new, +S save, +E view mode, +K search.
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
      if (!VIEW_MODES.includes(s.defaultView)) {
        s.defaultView = DEFAULT_SETTINGS.defaultView;
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

    async loadRoute() {
      if (this.route.name === 'note') {
        await this.openNote(this.route.params.id);
        return;
      }
      this.note = null;
      this.attachments = [];
      this.mode = 'edit';
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
      this.mode = this.settings.defaultView;
      this.saveState = 'saved';
      // The draft holds plaintext in memory; the envelope stays in the DB.
      if (isEnvelope(this.note.body) && this.vault.unlocked && this._vaultKey) {
        try {
          this.note.body = await decryptBody(this._vaultKey, this.note.body);
        } catch {
          /* keep the envelope */
        }
      }
      this.attachments = await db.listAttachments(id);
      // Resolve the attachment refs BEFORE either surface is given the body.
      // The Edit-mode surface renders Markdown on setBody, so a resolver that
      // arrives afterwards is too late: the image is already painted without a
      // src and nothing re-renders it. Order is load-bearing (D14).
      await this.resolveMedia();
      // If the editor is already mounted (note→note navigation, e.g. Ctrl+N),
      // swap its document in place. A fresh mount reads getDoc() instead.
      if (this.editor) this.editor.setDoc(this.note.body || '');
      // The Edit-mode surface is mounted once and survives note→note
      // navigation, so it needs the same explicit body swap.
      this.syncWysiwyg();
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

    // View modes (T37). 'edit' is the WYSIWYG surface, 'code' the raw-Markdown
    // source editor. Two editors share one buffer, so every hand-off is explicit
    // rather than inferred: leaving the WYSIWYG side drains its debounced edit
    // and pushes the result into CodeMirror, which has been sitting on a stale
    // buffer for as long as the WYSIWYG surface was mounted.
    setMode(mode) {
      if (!VIEW_MODES.includes(mode)) return;
      if (mode === this.mode) return;
      // Leaving the WYSIWYG surface: commit, then hand the Markdown over.
      if (this.mode === 'edit' && this.wysiwyg) {
        this.wysiwyg.flush();
        if (this.editor) this.editor.setDoc(this.note ? this.note.body : '');
      }
      // Entering it: pull CodeMirror's buffer back in. The WYSIWYG surface is
      // mounted once and stays alive across mode switches, so it is still
      // holding whatever it last painted — without this, edits made in Code
      // mode do not appear when you switch back.
      if (mode === 'edit') this.syncWysiwyg();
      this.mode = mode;
      this.$nextTick(() => {
        // A hidden CodeMirror view has no layout, so it needs a re-measure
        // before it can paint or take focus.
        if (this.editor) this.editor.view.requestMeasure();
        // The WYSIWYG surface paints while hidden, so its caret was never
        // placed. Re-place it now that it is visible, or execCommand has
        // nothing to act on and the first keystroke is lost.
        if (mode === 'edit' && this.wysiwyg) this.wysiwyg.ensureCaret();
      });
    },

    // Ctrl+E toggles the two surfaces.
    togglePreview() {
      this.setMode(VIEW_MODES[(VIEW_MODES.indexOf(this.mode) + 1) % VIEW_MODES.length]);
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
        await exportMarkdownZip(await db.listActiveNotes(), (id) => this.attachmentsFor(id));
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

    /**
     * Attachments for export, decrypted on demand. Export is the one place
     * where the bytes must leave the app, so an encrypted attachment is
     * decrypted here and inlined as a plaintext data: URI in the download.
     * A reference whose attachment is still encrypted (vault locked) is left
     * in place rather than silently dropped -- the user can see what is broken.
     */
    async attachmentsFor(noteId) {
      const atts = await db.listAttachments(noteId);
      if (!this.vault.enabled || !(this.vault.unlocked && this._vaultKey)) return atts;
      const out = [];
      for (const a of atts) {
        if (a.enc) {
          try { out.push({ ...a, data: await decryptBlob(this._vaultKey, a.data, a.type), enc: false }); }
          catch { out.push(a); }
        } else {
          out.push(a);
        }
      }
      return out;
    },

    exportMD() {
      if (!this.note) return;
      // D14: an exported .md is read outside NOTED, where `attachment:<id>`
      // resolves to nothing, so referenced images are inlined as data: URIs
      // here. The note.body itself is untouched.
      exportMarkdown(
        { title: this.note.title.trim() || deriveTitle(this.note.body), body: this.note.body },
        (id) => this.attachmentsFor(id),
      );
    },

    // Import mode split (T32, D13): the topbar Import merges (lossless sync
    // default); true backup restore lives in Settings as a destructive action.
    _importMode: 'merge',

    /**
     * Open a .md/.txt file as a new note (T26). Distinct from the JSON backup
     * import: this is "open a document to edit", not "sync a library", so it
     * creates one note with a fresh id and jumps straight into it.
     */
    async onOpenFile(event) {
      const file = event.target.files[0];
      event.target.value = '';
      if (!file) return;
      try {
        const note = await importMarkdownFile(await file.text(), file.name);
        await this.refreshList();
        this.open(note.id);
      } catch (err) {
        window.alert(`Could not open the file: ${err.message}`);
      }
    },

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
