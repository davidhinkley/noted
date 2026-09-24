# architecture.md

NOTED's shared mental model. Read this when `AGENTS.md` isn't enough. It explains *why*, points at what is deliberately out of scope, and records decisions so they don't get re-litigated.

## 1. Overview

NOTED is a personal Markdown notes app that runs **entirely in the browser**. It is local-first: the browser is the primary source of truth, all reads and writes go to local storage first, and the network exists only to *deliver the app* — never to serve data. The app works fully offline, deploys as static files to any shared web host, and keeps no account, no server, and no database outside the user's device.

The original brief is preserved as `NOTED_plan.md` (read-only reference; it is the source of the local-first mandate and the storage/host analysis, not a working document).

## 2. Principles

1. **Local-first.** Core functionality never depends on the network. If the host disappears, the app still works and the data is still on the device.
2. **Buildless.** No compiler, no bundler, no transpilation. Source files are the shipped files. This is a deliberate constraint, not a limitation — see D2 and *Migration triggers*.
3. **Static-hostable.** The artifact is a directory of static files with no server-side requirements.
4. **Content is opaque.** Note bodies are uninterpreted bytes at the storage boundary. The DB layer never parses them. This is what keeps encryption and format changes possible later without a rewrite.
5. **Editor is swappable.** The editor is a UI component, not an architecture decision. Today it is a CodeMirror 6 view behind `js/ui/editor.js` (D8); `body` is raw Markdown, so any editor can produce it.
6. **Subdirectory-relative by default.** Paths resolve relative to the app directory so the same build works at `/`, `/notes/`, or `/<repo>/`.

## 3. System overview

```
┌──────────────────────────────────────────────────────────────┐
│  Browser — the only runtime                                  │
│                                                              │
│  index.html                                                  │
│    └─ Alpine components (js/ui/*)                            │
│         │            │                        │              │
│         │      router.js                  search.js          │
│         │   #/  #/note/:id  #/tag/:tag     (Fuse.js index)   │
│         │            │                        │              │
│         └────────────┴───────────┬────────────┘              │
│                                ▼                            │
│                          db.js (Dexie)                       │
│                                │                            │
│                    ┌───────────┴───────────┐                │
│                    ▼                       ▼                │
│              IndexedDB              sw.js + manifest.json    │
│              notes[] (folders: T24) (offline shell cache)     │
│                                                              │
│   io/export.js ──► *.json / *.md      io/import.js ◄── *.json │
└──────────────────────────────────────────────────────────────┘

   Static host ── serves files only ── never touches data
```

Data flow is one-directional from UI to Dexie and back. There is no server in the loop at any point.

## 4. Technology decisions

| Concern | Choice | Rejected alternatives |
| --- | --- | --- |
| Storage | **IndexedDB via Dexie.js** | Raw IndexedDB (verbose, error-prone); localStorage (5MB, synchronous, strings only); SQLite WASM (~1–2MB binary, same persistence underneath) |
| UI | **Alpine.js via CDN** | React (build step + bundle overhead); Vue/Svelte (excellent, but build step is premature — see D2); vanilla-only (fine but harder to maintain) |
| Search | **Fuse.js** | Full-text indexes in IndexedDB (overkill pre-scale) |
| Markdown | **marked + DOMPurify** | Storing rendered HTML (breaks portability); react-markdown (pulls in React) |
| Routing | **Hash router** | History API + `404.html` fallback (host-specific coupling) |
| Styling | **Vanilla CSS** | CSS-in-JS and preprocessors (build step; framework lock-in) |
| Deployment | **Static files, subdirectory-relative** | SSR (violates local-first); root-absolute paths (breaks under a subpath) |

Full rationale for each is in **Decisions** at the end of this file.

## 5. Data model

### Dexie schema (v1 → v2 → v3)

```js
db.version(1).stores({
  notes: 'id, title, folderId, updatedAt, deletedAt, *tags'
});

db.version(2).stores({
  notes: 'id, title, folderId, updatedAt, deletedAt, *tags',
  folders: 'id, name, updatedAt'
}).upgrade(async (tx) => {
  // Backfill (T24): normalize notes that bypassed the creator
  // (hand-edited / future-dated imports) to folderId: null.
  await tx.table('notes').toCollection().modify((note) => {
    if (typeof note.folderId !== 'string') note.folderId = null;
  });
});

db.version(3).stores({
  notes: 'id, title, folderId, updatedAt, deletedAt, pinned, *tags',
  folders: 'id, name, updatedAt'
}).upgrade(async (tx) => {
  // Backfill (T26): notes that predate pinning default to unpinned.
  await tx.table('notes').toCollection().modify((note) => {
    if (typeof note.pinned !== 'boolean') note.pinned = false;
  });
});
```

- `id` is the primary key. It is **not** auto-increment — records carry client-generated UUIDv4.
- `*tags` is a multi-entry index, enabling `where('tags').equals('foo')` without scanning.
- `deletedAt` is indexed so the list query can exclude soft-deleted rows cheaply.
- `folders` is new in v2 (T24); `folderId` was already reserved and indexed on notes in v1, so the schema change is additive and no note rows move.
- `pinned` is new in v3 (T26): a boolean flag, indexed for future queries. List queries order pinned-first as a base, and the UI's sort control re-sorts client-side (a dedicated "Pinned first" option reproduces the pinned ordering explicitly).

### Note record

| Field | Type | Purpose / constraint |
| --- | --- | --- |
| `id` | string (UUIDv4) | Primary key. Client-generated. Never reused, never recycled. |
| `title` | string | Display only; may be empty. Derived from the first heading or line. |
| `body` | string | **Raw Markdown.** Opaque at the storage boundary. |
| `tags` | string[] | Multi-entry index. Lowercased on write. |
| `folderId` | string \| null | Optional grouping. A `folders` table arrives in Dexie v2 (T24). |
| `pinned` | boolean | Pin to top. Arrives in Dexie v3 (T26); backfilled `false`. Import preserves it (`normalize` keeps `pinned === true`). |
| `createdAt` | number (ms) | Immutable after creation. |
| `updatedAt` | number (ms) | Bumped on every write. |
| `deletedAt` | number \| null | Soft delete. Set, never removed except by *restore*. |
| `attachments` | string[] | **Reserved.** References future attachment IDs. Always `[]` in MVP. |

### Folder record

| Field | Type | Purpose / constraint |
| --- | --- | --- |
| `id` | string (UUIDv4) | Primary key. Client-generated. |
| `name` | string | Display. Trimmed and non-empty on write. |
| `createdAt` | number (ms) | Immutable after creation. |
| `updatedAt` | number (ms) | Bumped on rename. |

Deleting a folder **unassigns** its notes back to "All notes" (`folderId: null`) in the same transaction — folders are organizational metadata, notes are content, so a folder action never deletes notes. Folders themselves have no trash; list/rename/delete live behind the `#/folders` view.

### Why this shape

- **UUIDv4 + `createdAt`/`updatedAt` + soft deletes** are the three prerequisites for any future sync. Without them, adding sync means a data migration and an ID collision problem. With them, it is a protocol problem.
- **Opaque `body`** is what makes encryption a storage-boundary concern rather than an app-wide one: swap Dexie's write path to encrypt and the read path to decrypt, and nothing else changes.
- **`attachments: []` reserved** keeps blobs out of the notes table. Binary blobs belong in a separate store or OPFS, referenced by ID.
- **No auto-increment IDs.** They collide on day one of sync and make export/import non-idempotent.

## 6. Module boundaries

| Module | Owns | Must not do |
| --- | --- | --- |
| `js/db.js` | Dexie schema, versions, migrations, CRUD | Never parse or transform `body`. Never touch the DOM. |
| `js/search.js` | Building and querying the Fuse index | Never write to the DB. |
| `js/router.js` | Hash parsing, route table, view switching | Never contain view logic. |
| `js/ui/*` | Alpine components, rendering, events | Never issue raw IndexedDB calls — go through `db.js`. |
| `js/ui/editor.js` | The CodeMirror 6 wrapper; owns editor lifecycle (`createMarkdownEditor`) | Never touch storage or rendering — hands raw Markdown to the app via `onDocChange`. The only module allowed to import CodeMirror. |
| `js/ui/settings.js` | App settings (theme, editor font size, default preview) in the single `noted.settings` localStorage key | Never store note data — localStorage is settings-only (see `TODO.md` T23). Never touch the DOM directly except `data-theme` / one CSS var via `applySettings`. |
| `js/pwa.js` | Service-worker registration | Never contain cache logic (that lives in `sw.js`). |
| `js/io/*` | Serialization and import validation | Never mutate notes directly — hand results to `db.js`. |
| `sw.js` | Fetch interception, cache strategy, invalidation | Never reach into IndexedDB. |

**Index update strategy.** Rebuilding the Fuse index on every keystroke will not survive a real notes collection, so: rebuild **on route change** into `#/` or `#/tag/:tag`, and rebuild on a **debounced (~300ms) trailing edge** after a mutation while already on a list view. Incremental insert/remove is not worth the duplicated state at this scale — revisit alongside T33 when notes exceed ~2,000.

## 7. Routing

| Route | View |
| --- | --- |
| `#/` | Note list, sorted by `updatedAt` desc |
| `#/note/:id` | Editor + Markdown preview |
| `#/tag/:tag` | List filtered to one tag |
| `#/trash` | Soft-deleted notes — **v1** (T21), not MVP |
| `#/folder/:id` | List filtered to one folder — **v1** (T24) |
| `#/folders` | Folder management (create/rename/delete) — **v1** (T24) |

Everything after the `#` is invisible to a static server, so no rewrite rules, no `404.html` hack, and no host-specific configuration. The cost is uglier URLs; the trade is that the app works on any static host unchanged. See D3.

## 8. PWA strategy

Without a service worker, "runs in the browser" is false advertising: offline, the browser cannot even load the HTML, despite the data sitting safely in IndexedDB. So the service worker ships in the MVP.

- **`manifest.json`** — relative paths only: `"start_url": "./"`, `"scope": "./"`, `icons[].src` relative. Relative values resolve against the manifest's own URL, so `/notes/manifest.json` with `"./"` resolves to `/notes/` — which is what makes a subpath install work.
- **`sw.js` lives at the app-directory root**, beside `index.html`. A worker's scope is derived from its location; burying it in `js/` would restrict it to `js/`.
- **Registration:** `navigator.serviceWorker.register('sw.js', { scope: './' })` — both arguments relative to the registering page.
- **Cache URLs resolved against scope, never against `/`:**
  ```js
  const base = self.registration.scope; // ends with '/'
  const urlsToCache = [base, new URL('index.html', base).href, new URL('css/style.css', base).href];
  ```
- **Strategy:** precache **same-origin shell files only** on `install` (`index.html`, `css/style.css`, `js/*`, icons); serve them cache-first. Handle CDN library URLs **opportunistically** — stale-while-revalidate on `fetch`, network falling back to cache, never precached on `install`.
  - *Why the split:* CDN responses are **cross-origin and opaque**. You cannot read their status, and cache-first on an opaque response can serve a broken library offline — a known footgun that costs a day to debug. Same-origin precache is safe; cross-origin belongs in the runtime path where a network failure degrades gracefully.
  - *Fallback:* if runtime CDN caching proves flaky, self-host the CDN libraries under `vendor/` (same-origin, precacheable). Not needed yet.
- **Invalidation:** there is no content hashing without a build step, so a `CACHE_VERSION` constant in `sw.js` is the release mechanism — bump it, and `activate` deletes the old cache. **Every release must bump it.**

## 9. Data portability and security

- **Export** ships two formats: **JSON** (all notes, one file, lossless) and **Markdown** (one `.md` per note). Per-note `.md` download is MVP; bulk `.md` (a zip) is deferred to v1 since it needs a second CDN dependency. See `TODO.md` **T12/T26**.
- **Import** accepts the JSON format. Validate `schemaVersion` and reject unrecognized versions; **ignore unrecognized fields** rather than erroring, so a future export format imports cleanly into an older app (forward compatibility). Rejecting unknown fields would break v1 imports the day `folderId` is added in v2.
- **Encryption is out of scope for now**, but `body` opacity means it lands cleanly later: derive a key from a passphrase with the Web Crypto API, and wrap only the Dexie read/write path in AES-256-GCM. Note the real cost is UX — a lost passphrase is unrecoverable data.

## 10. Deployment

**Default layout: the app is served from a subdirectory.** All paths are relative to the app directory.

| Host | Notes |
| --- | --- |
| GitHub Pages (project site) | Base path is `/<repo>/`. Relative paths need no configuration. Deploy by pushing static files to the Pages branch, or a copy-to-Pages workflow. |
| Shared hosting (subdirectory) | Upload to the target directory via FTP/rsync. Same relative-path assumptions. |
| Shared hosting (domain root) | Relative paths still work unchanged; the subdirectory prefix simply isn't there. |

Assuming subdirectory-first is strictly more portable: moving root → subpath requires touching the manifest, the service worker, and every asset path; moving subpath → root requires nothing. No `<base>` tag — it is one deployment-specific edit that silently desyncs the service worker's scope if forgotten.

Host-specific commands live in `docs/deployment.md` (not yet written — `TODO.md` **T16**).

## 11. Limits and non-functional concerns

- **Search scale.** Fuse.js is fast to roughly 2,000–5,000 notes. Past that, move index building into a Web Worker (T33).
- **Storage quota.** IndexedDB offers ~1GB typically per origin (browsers report more, e.g. 8GB in Chromium), but browsers can evict it under disk pressure. Since T25 the settings view surfaces `navigator.storage.estimate()` as a read-only "% of quota" row so the user can see runway; export/import is the backup story, not a nice-to-have. The topbar also shows an **Offline** badge while `navigator.onLine` is false — offline is the core promise, so the state is never silent.
- **No `file://` support.** IndexedDB requires a secure context (`http(s)` or `localhost`). Use `pnpm dev`.
- **Browser support.** Evergreen browsers only: IndexedDB, service workers, ES modules.
- **Accessibility and keyboard navigation** are v1 (T22), not MVP. This is a deliberate deferral, not an oversight: the MVP exists to validate the storage boundary, routing, and offline story before the surface grows. That said, for a text-heavy app keyboard navigation is arguably core rather than polish — T22 should be treated as early-v1, not late-v1, and must not slip past it.

## 12. Out of scope

| Feature | Why it is out | What keeps the door open |
| --- | --- | --- |
| End-to-end encryption | UX burden (passphrase, unrecoverable data) and key migration for existing notes | `body` is opaque at the boundary; encrypt/decrypt wraps Dexie only |
| Attachments / binary files | Blob storage, upload/download UI, size limits, export complexity | `attachments: []` reserved; separate store or OPFS, never blobs in `notes` |
| Cross-device sync | Conflict resolution, auth, a server — the hardest local-first problem | UUIDv4 IDs, `createdAt`/`updatedAt`, soft deletes |
| Clean URLs | Host-specific `404.html` coupling | Hash routing |
| Bulk Markdown export (zip) | Needs a second CDN dependency before it is proven necessary | JSON export is lossless; per-note `.md` covers the common case |
| Lint / tests / CI | Premature tooling on an unvalidated product | `package.json` dev-deps only; `AGENTS.md` names the gaps explicitly |

## 13. Migration triggers

The buildless Alpine approach is a starting bet, not a life sentence. Migrate to Vue 3 or Svelte + Vite when **any** of these is true:

- An Alpine component exceeds roughly 200 lines of `x-` directives and becomes unreadable.
- You need more than two third-party UI libraries that have **no CDN build** (an ESM-with-import-map counts as a CDN build — CodeMirror 6 ships this way, see D8, and does **not** trip this trigger).
- You need real lint, typecheck, or test tooling integrated into the workflow.
- The un-bundled CDN payload measurably hurts first load.

At that point the product is validated and the build complexity is justified. **Add React to the table only if a specific ecosystem dependency demands it** (e.g., TipTap) — for a notes app its bundle and build overhead are not worth it on a static host.

---

## Decisions

An inlined decision log. Same format as an ADR, just not yet split into files.

### D1. Storage: IndexedDB via Dexie.js
- **Status:** accepted
- **Date:** 2026-09-23
- **Context:** Need structured, queryable, high-capacity local storage for notes with tags and timestamps.
- **Decision:** Use Dexie.js over raw IndexedDB, localStorage, SQLite WASM, and OPFS.
- **Consequences:** Adds a ~20KB CDN dependency. Schema versioning and transactions are handled. Complex relational queries would outgrow it, but the data model is deliberately flat.

### D2. UI: Alpine.js via CDN, no build step
- **Status:** accepted
- **Date:** 2026-09-23
- **Context:** Need reactivity without committing to build infrastructure on a static host.
- **Decision:** Alpine.js loaded from CDN; no bundler, compiler, or CI.
- **Consequences:** Source is the artifact — deployment is a file copy. Component size and lack of tree-shaking are the ceilings; see *Migration triggers*.

### D3. Routing: hash-based
- **Status:** accepted
- **Date:** 2026-09-23
- **Context:** Static host with no server-side rewrites.
- **Decision:** Use `#/note/:id` hash routes; no History API, no `404.html` fallback.
- **Consequences:** Ugly URLs, but zero host configuration and identical behavior everywhere.

### D4. Content format: raw Markdown, opaque at the boundary
- **Status:** accepted
- **Date:** 2026-09-23
- **Context:** Notes need a portable, future-proof content format.
- **Decision:** Store raw Markdown in `body`; the DB layer never parses it; rendering uses `marked` + `DOMPurify`.
- **Consequences:** Export is a byte copy. Encryption becomes a storage-boundary concern. Rendered HTML is never persisted, so a rendering bug cannot corrupt data.

### D5. Identity: UUIDv4, timestamps, soft deletes
- **Status:** accepted
- **Date:** 2026-09-23
- **Context:** Sync and multi-device are future possibilities, not current requirements.
- **Decision:** UUIDv4 primary keys, immutable `createdAt`, monotonic `updatedAt`, `deletedAt` soft deletes.
- **Consequences:** Slightly more storage than integers; makes sync and import idempotent. Hard deletes exist only as an explicit trash-view action.

### D6. PWA: minimal service worker from day one, subdirectory-relative
- **Status:** accepted
- **Date:** 2026-09-23
- **Context:** Offline is the core promise; retrofitting a service worker under a subpath is painful.
- **Decision:** Ship `manifest.json` + `sw.js` in the MVP; all paths relative, scoped to the app directory; `CACHE_VERSION` bump is the invalidation mechanism; precache same-origin shell only, with cross-origin CDN URLs handled by stale-while-revalidate at fetch time.
- **Consequences:** Every release must bump `CACHE_VERSION`. Users get stale-but-functional shell rather than a 404. Opaque cross-origin responses are deliberately kept out of the precache list; self-hosting under `vendor/` is the fallback if runtime CDN caching proves flaky.

### D7. Deployment: subdirectory-relative paths, host-agnostic
- **Status:** accepted
- **Date:** 2026-09-23
- **Context:** Target hosts include GitHub Pages project sites and shared hosting, both of which may serve under a path.
- **Decision:** No leading slashes in same-origin paths; no `<base>` tag; resolve service-worker URLs against `self.registration.scope`.
- **Consequences:** Works at `/`, `/notes/`, and `/<repo>/` with no per-target edits. The trade is that relative paths in JavaScript must be written carefully.

### D8. Editor: CodeMirror 6 via a pinned import map, behind `js/ui/editor.js`
- **Status:** accepted
- **Date:** 2026-09-23
- **Context:** The MVP shipped a `<textarea>` to validate the storage boundary before the surface grew. That is done (T01–T17); a notes app now needs real editing. CodeMirror 6 is ESM-first with dozens of small packages and **no single-file CDN build**.
- **Decision:** Replace the textarea with CodeMirror 6 Markdown mode. Ship it as ES modules via an `<script type="importmap">` in `index.html` that pins every bare specifier in the `@codemirror/*` + `@lezer/*` graph (21 packages, all resolved versions) so each package has exactly one shared module instance. All CodeMirror imports stay confined to `js/ui/editor.js`, which exposes a tiny surface — `createMarkdownEditor(parent, { getDoc, onDocChange }) → { view, setDoc, destroy }` — so the editor remains swappable and the rest of the app sees only raw Markdown strings.
- **Rationale — why not jsdelivr's `/+esm` bundles:** `/+esm` rewrites bare imports into independent bundle URLs. Each bundle would re-import its dependencies separately, giving the browser *multiple module instances* of `@codemirror/state` etc. CodeMirror's view and state identify themselves by instance; duplicated instances silently break editor behavior. A hand-pinned import map forces one instance per package and, bonus, makes the exact delivered versions auditable in `index.html`.
- **Consequences:** Any future CodeMirror dependency must add its exact version to the import map in the same commit (derive it from the graph: fetch each package's own imports). The SW's offline guarantee now depends on 21 runtime-cached cross-origin URLs (stale-while-revalidate, same as before). Bumping CodeMirror means bumping several pinned versions together — not a per-release chore. The editor is still swappable: swap `js/ui/editor.js` for another provider and nothing else changes.

### D9. Settings in localStorage, behind `js/ui/settings.js`
- **Status:** accepted
- **Date:** 2026-09-24
- **Context:** T23 adds user settings (theme, editor font size, default preview state). AGENTS.md forbids a second storage layer without a recorded decision.
- **Decision:** Persist settings in localStorage under a single key `noted.settings`, validated on load (unknown values fall back to defaults; unknown *keys* are ignored, the same forward-compat stance as import). Note data stays exclusively in Dexie.
- **Rationale:** Settings are trivial, non-relational, and browser-local; a Dexie table for three scalars is overhead, and settings must survive a note-store reset (or a future encryption passphrase change) without being entangled with note data. localStorage's 5MB cap and synchronous API are irrelevant at this size.
- **Consequences:** The one sanctioned exception to "Dexie only." Any new localStorage key needs a decision entry here first. Settings are never part of export/import — they are device preferences, not content.

### D10. Bulk zip export via JSZip `+esm`, not a pinned dist URL- **Status:** accepted
- **Date:** 2026-09-24
- **Context:** T26 needs client-side zip creation. JSZip ships a UMD `dist` bundle with no ESM exports, so a pinned dist URL in the import map would resolve `default` to `undefined`.
- **Decision:** Map `jszip` to jsdelivr's `+esm` build (`https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm`) and resolve defensively (`mod.default ?? mod.JSZip ?? window.JSZip`, throw if missing).
- **Rationale — why this doesn't violate D8:** D8 bans `+esm` for CodeMirror because its packages share module *instances* across bare imports. JSZip's dist bundle is self-contained (no bare imports), so the `+esm` wrapper is a single re-export with no duplication hazard. Hand-pinning the UMD file would look consistent but be silently broken.
- **Consequences:** `exportMarkdownZip` stays lazy-loadable and offline-tolerant (runtime-cached like all CDN URLs); a load failure surfaces as an alert, never a silent no-op.

### D11. Vault encryption at the Dexie boundary, key in memory only
- **Status:** accepted
- **Date:** 2026-09-24
- **Context:** T30 encrypts note bodies with AES-256-GCM, key derived from a passphrase via PBKDF2-SHA256 (600k iterations). AGENTS.md requires a decision entry before any new storage layer.
- **Decision:** Ciphertext envelopes (`ENC1.<iv>.<data>`) live in the existing `body` field — no Dexie schema change, so no version bump. Salt + verifier live in localStorage under one key (`noted.crypto`); the key itself lives in memory only and is never persisted, exported, or logged. Reads decrypt-or-keep (a forged envelope fails closed); when locked, list/search work on body-blanked copies so ciphertext never leaks into the Fuse index or excerpts, and the editor is unreachable.
- **Rationale:** Envelope-in-`body` keeps every existing query, index, migration, and the export/import roundtrip working unchanged — export stays lossless (ciphertext preserved), import passes envelopes through as opaque strings. A separate encrypted store would have doubled the migration surface for zero security gain.
- **Consequences:** Enabling/disabling encrypts/decrypts every row (trash included) and bumps `updatedAt` via the normal write path, so the list re-sorts once. Titles, tags, folders, and timestamps stay plaintext (searchable metadata by design). Forgetting the passphrase is unrecoverable — the UI warns at setup. No passphrase change flow yet (disable + re-enable covers it).

### D12. Attachments: Dexie table, not OPFS
- **Status:** accepted
- **Date:** 2026-09-24
- **Context:** T31 needs file attachments linked via `note.attachments[]` (reserved since v1). Candidates: a Dexie `attachments` table holding Blobs, or OPFS files keyed by id.
- **Decision:** Dexie v4 adds `attachments: 'id, noteId, createdAt'` with the Blob in the record. All link maintenance (add/remove/purge) runs in read-write transactions spanning `notes` + `attachments`, so a blob and its link cannot disagree. Purge cascades — a hard-deleted note takes its blobs with it in the same transaction; soft-delete keeps them (restore keeps working).
- **Rationale:** IndexedDB stores Blobs natively, so there is no encoding tax at rest; the table is indexed, transactional, and rides the existing export/import backup story (base64 inside export v2) with no new subsystem to operate. OPFS would add manual GC, unindexed lookups, and a second backup path for no gain at note-attachment scale.
- **Consequences:** A 25MB per-file cap protects the shared origin quota (one giant blob must not evict the vault). Attachment *bytes* follow the vault when it is on (AES-GCM binary envelope, `enc` flag on the record, app-layer encrypt/decrypt — the store stays dumb); titles/types/sizes stay plaintext metadata. Export `SCHEMA_VERSION` goes 1→2; import accepts v1 (no attachments key) and v2.

### Split trigger

When this section exceeds ~5 decisions or one screen — or the first time a decision already recorded here is re-litigated in a PR — split it into `docs/decisions/NNNN-short-title.md` and replace it with a link list. Add `0001-record-architecture-decisions.md` (the meta-ADR documenting the decision to use ADRs) at that point, not before.
