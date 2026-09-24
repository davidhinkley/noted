# TODO.md

Prioritized work queue. One line per item, verb-first. No rationale here — see `architecture.md` → **Decisions**. Prune aggressively: a stale TODO is worse than no TODO.

## MVP — P0

A shippable local-first Markdown notes app.

- [x] **T01** Add `package.json` with dev-only deps (`serve`); document `pnpm dev` in `AGENTS.md`.
- [x] **T02** Write `index.html` loading Alpine, Dexie, Fuse.js, marked, DOMPurify from CDN.
- [x] **T03** Define Dexie schema v1 in `js/db.js` (`'id, title, folderId, updatedAt, deletedAt, *tags'`).
- [x] **T04** Implement note CRUD: create, read, update, soft-delete (`deletedAt`). *DoD: no UI path issues a hard delete.* Tag entry is a single comma-separated text field in the editor (split on comma, trim, lowercase on write); see T07.
- [x] **T05** Implement list view sorted by `updatedAt` desc, excluding soft-deleted notes.
- [x] **T06** Implement Fuse.js search over title + body + tags. *DoD: title matches rank above body matches — this requires explicit `keys` weights, e.g. `keys: [{ name: 'title', weight: 2 }, { name: 'body', weight: 1 }, { name: 'tags', weight: 1 }]`; Fuse.js does not infer this by default.*
- [x] **T07** Implement tag filter via the multi-entry index, plus the `#/tag/:tag` route.
- [x] **T08** Implement Markdown preview with `marked`, sanitized through DOMPurify. *DoD: raw Markdown remains the only thing written to the DB.*
- [x] **T09** Implement hash router with the route table: `#/`, `#/note/:id`, `#/tag/:tag`.
- [x] **T10** Add `manifest.json` (relative `start_url`/`scope`, maskable icons), link it from `index.html`, and create `js/pwa.js` registering the worker (`register('sw.js', { scope: './' })`), called from `index.html`. *Registration is a separate file from `sw.js` — never put `register()` inside `sw.js` itself.*
- [x] **T11** Write `sw.js` at the app root; precache **same-origin shell files only** (`index.html`, `css/style.css`, `js/*`, icons) on `install`; stale-while-revalidate on `fetch` for cross-origin CDN URLs — **do not precache CDN URLs**, their responses are opaque and cache-first on them can serve broken libraries offline. `CACHE_VERSION` bump is the release step. *Fallback if runtime CDN caching is flaky: self-host the libs under `vendor/`.*
- [x] **T12** Implement JSON export (all notes, one file) and per-note Markdown export (one `.md` download).
- [x] **T13** Implement JSON import; validate `schemaVersion` and reject unrecognized versions, but **ignore unrecognized fields** so future export formats import cleanly.
- [x] **T14** Verify offline: kill the network, reload, confirm list + edit + search all work. *Verified headlessly (agent-browser, 2026-09-23): SW-served shell reload with server dead; create/edit/search/tag all function offline.*
- [x] **T15** Verify subpath deploy: serve from a subdirectory, confirm assets, manifest install, and SW scope all resolve. *Verified at `/NOTED/` (agent-browser, 2026-09-23): worker active, scope `/NOTED/`, all 14 shell files incl. `icon.svg` precached.*
- [x] **T16** Write `docs/deployment.md` for the chosen host (GitHub Pages workflow **or** `deploy.sh` rsync script). *Written host-agnostic; sizing decision left open for T17.*
- [x] **T17** Deploy the MVP and verify it live. — target chosen: GitHub Pages + custom subdomain `noted.360481025.xyz` (CNAME pairing, branch publish from `main`, Enforce HTTPS). *Live 2026-09-23 (agent-browser): SW scope `https://noted.360481025.xyz/`, cache `noted-v3` with all 14 shell files, hard-offline create/edit verified; Enforce HTTPS active.*

## v1 — P1

- [x] **T20** Replace the `<textarea>` with CodeMirror 6 (Markdown mode). *DoD: zero changes to the data model.* Verified (agent-browser, 2026-09-24): mounts on `#/note/:id`, typing persists via the debounced save, preview toggles and re-mounts cleanly, note→note `setDoc` swap works; no DB schema or record-shape change.
- [x] **T21** Add trash view (`#/trash`) with restore, and hard-delete from trash only. *Verified: `db.hardDelete` reachable only from the trash view; restore is the sole way to clear `deletedAt`.*
- [x] **T22** Add keyboard shortcuts (new note, save, focus search, toggle preview). *Ctrl/Cmd+N new, +S save, +E preview, +K search; hints on controls.*
- [x] **T23** Add settings persisted to localStorage (theme, font size, default preview state). *The only sanctioned localStorage use — settings, never note data.* Verified (agent-browser, 2026-09-24): single `noted.settings` key, validated on load; theme switch flips `data-theme` (+ `prefers-color-scheme` fallback), font size drives `--editor-font-size`, default preview makes `#/note/:id` open in preview; `#/settings` route + view.
- [x] **T24** Add folders: new `folders` table via Dexie v2 with a migration backfill. *Verified (agent-browser, 2026-09-24): create → assign via the editor select → `#/folder/:id` listing with live counts → rename → delete unassigns notes back to All notes (single transaction); backfill normalizes missing `note.folderId` to null.*
- [ ] **T25** Add offline/online indicator and an IndexedDB storage-usage estimate.
- [ ] **T26** Add note pinning and sort options; add bulk Markdown export as a zip (requires a CDN zip dependency).

## Later — P2

- [ ] **T30** Encrypt note bodies (AES-256-GCM, passphrase-derived key via Web Crypto) at the Dexie boundary.
- [ ] **T31** Add attachments: separate `attachments` store or OPFS blobs, linked via `note.attachments[]`.
- [ ] **T32** Add cross-device sync (conflict resolution + auth + a server).
- [ ] **T33** Move Fuse.js index building into a Web Worker once notes exceed ~2,000.
- [ ] **T34** Migrate to Vue 3 or Svelte + Vite if a migration trigger in `architecture.md` fires.
- [ ] **T35** Optionally add clean URLs via a `404.html` fallback, if a host supports it.

## Blocked / out of scope

These are decisions, not unfinished work. Do not pick them up; argue against them in `architecture.md` → **Decisions** instead.

- ~~React migration~~ — only if a required ecosystem library (e.g., TipTap) has no CDN build.
- ~~Any server-side data path~~ — violates local-first; the network only delivers files.
- ~~localStorage for note data~~ — 5MB, synchronous, strings only. Settings only.
- ~~`<base>` tag for subpath support~~ — relative paths are sufficient and less brittle.
- ~~Clean URLs~~ — host-specific `404.html` coupling; see D3.
- ~~Lint / test / CI infrastructure~~ — premature on an unvalidated product; `AGENTS.md` names the gaps.

## Done

- **MVP P0** — T01–T17 complete. Deployed to `noted.360481025.xyz` (GitHub Pages).
- **v1** — T20 (CodeMirror 6 editor), T21 (trash view), T22 (keyboard shortcuts), T23 (settings), T24 (folders, v1→v2 migration). Next: T25 (offline indicator + storage estimate) / T26 (pinning, sort, bulk Markdown zip).
