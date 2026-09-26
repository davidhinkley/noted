# AGENTS.md

NOTED is a local-first Markdown notes app: a **buildless static SPA**. The browser is the source of truth. There is no server. This file is the operating manual — read it at the start of every session.

## Stack (fixed)

- **Alpine.js 3** — UI reactivity (CDN)
- **Dexie.js** — IndexedDB wrapper (CDN)
- **Fuse.js** — client-side fuzzy search (CDN)
- **marked** — Markdown → HTML (CDN)
- **DOMPurify** — sanitize rendered Markdown (CDN)
- **CodeMirror 6** — Markdown editor, ES modules via a pinned import map (CDN)
- **Vanilla CSS**, hash routing, ES modules

The app ships **zero npm dependencies**. Every library loads from a CDN. `package.json` holds dev-only tooling and never reaches production.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm install` | Install dev-only tooling. |
| `pnpm dev` | Serve the app locally. **Required** — IndexedDB needs an http(s) origin; `file://` will not work. |

- `pnpm deploy` — rsync the app shell to a shared host subdirectory via `deploy.sh` (see `docs/deployment.md`). Requires `DEPLOY_HOST` and `DEPLOY_DIR` env vars.

### What does not exist

- **No build step.** Do not add Vite, webpack, Rollup, esbuild, or TypeScript compilation. An `<script type="importmap">` is **not** a build step — it is declarative CDN wiring; never replace it with a bundler.
- **No lint step.** Do not add eslint, prettier, or htmlhint without raising it in a PR first.
- **No test suite.** Do not add vitest, jest, or playwright without raising it in a PR first.
- **No CI pipeline.** Deployment is documented in `docs/deployment.md` (`TODO.md` **T16**).

Naming these gaps is deliberate. The default failure mode of a coding agent is to add infrastructure that "should" be there. It isn't.

## Hard rules

### Data

- Note IDs are **UUIDv4**. Generate with the built-in `crypto.randomUUID()` — do not add a `uuid` library via CDN. Never auto-increment, never timestamp-derived.
- Store **raw Markdown** in `note.body`. Never store rendered HTML in the database.
- `note.body` is **opaque at the storage boundary**. The DB layer never parses, transforms, or inspects content.
- **Soft-delete only.** Set `deletedAt`. Never hard-delete except from the trash view (`TODO.md` **T21**).
- Use Dexie. Do not add a second storage layer (localStorage for note data, OPFS) without adding an entry to `architecture.md` → **Decisions** first.
- Every schema change **bumps the Dexie version** and ships a migration.
- Attachments are referenced from the body as `attachment:<uuid>` (D14). `js/media.js` owns the scheme; resolution happens at render time only. Never write a `blob:` or `data:` URL into `note.body`.
- **Exports inline attachments.** `.md` and `.zip` downloads rewrite `attachment:<id>` to a `data:` URI (`inlineAttachments()` in `js/io/export.js`), because an exported note is read outside NOTED where the scheme resolves to nothing. This is the one sanctioned exception to "keep the body clean", and it lives in the exporter — never in the body or the DB.
  - The exporter never imports `db.js`. Callers pass an async **getter** (`attachmentsFor(id)`) and the note must carry its **`id`** — attachments are looked up by note id, so a note passed without one exports with unresolvable refs.
  - Both entry points must hand `inlineAttachments()`'s **return value** to `download`/`zip.file`. Computing the inlined text and then passing the original is the bug to watch for: `exportMarkdownZip` did exactly that, so `.md` exported clean while every note in the `.zip` kept a bare ref. Test the entry points, not just `inlineAttachments`.
  - A ref whose attachment is missing, or still encrypted, is **left in place** rather than dropped — the user must be able to see what did not resolve.

### Routing

- All routes are hash routes: `#/`, `#/note/:id`, `#/tag/:tag`. Never use the History API. Never add clean-path routes.

### Paths

- The app is served from a **subdirectory** (e.g. `/notes/` on a shared host, `/<repo>/` on GitHub Pages).
- **Never use a leading `/`** in any same-origin path: HTML assets, manifest fields, icon `src`, service-worker registration.
- **Do not add a `<base>` tag.** Relative paths are sufficient.
- Resolve cached URLs in the service worker against `self.registration.scope`, never against `/`.

### UI

- The editor is **swappable**. Today it is a CodeMirror 6 view behind `js/ui/editor.js` — the **only** file allowed to import CodeMirror. Never couple storage, rendering, or export to a specific editor component.
- The Markdown **formatting toolbar** lives in `index.html` and delegates to `formatAction(name)` in `js/ui/app.js`, which forwards to `wysiwyg.runAction(name)` in Edit mode or `editor.runAction(name)` in Code mode. All buffer mutation stays inside the editor wrappers; in the source editor, toolbar actions dispatch annotated `userEvent` edits so the normal debounced save and undo history apply. The toolbar is visible in both modes.
- The **view mode** is `mode: 'edit' | 'code'` in `js/ui/app.js`, toggled via `togglePreview()` (Ctrl+E). **Edit** is the WYSIWYG surface (`js/ui/wysiwyg.js`): a contenteditable that renders the note and emits raw Markdown on every settled edit, so `note.body` stays raw Markdown and the database never sees HTML (D4). **Code** is the raw-Markdown source editor (CodeMirror). The setting is persisted as `defaultView` in localStorage.

### The Edit-mode editor (`js/ui/wysiwyg.js`)

Edit mode mounts a contenteditable that renders the note via `marked` + `DOMPurify` and serializes back to Markdown via `Turndown` (+ the gfm bundle for tables, task lists, strikethrough) on every settled edit. It hands the rest of the app nothing but a Markdown string, exactly like the CodeMirror wrapper, so storage, search, and export stay editor-agnostic.

- Two editors share one buffer, so **both** hand-offs are explicit in `setMode`. Leaving Edit flushes the pending edit and pushes the Markdown into CodeMirror (`setDoc`); entering Edit pulls CodeMirror's buffer back in (`setBody`), without which edits made in Code mode are invisible when you switch back. Either way `ensureCaret()` re-places the caret, because the surface painted while hidden.
- Turndown's backslash-escaping of Markdown metacharacters is undone on serialize, so typing `**bold**` yields real bold. The cost is that a genuinely literal metacharacter can no longer be written.
- `note.body` is written through `onBodyChange` → `touch()`, so the normal debounced save applies. Nothing here bypasses the storage boundary.
- The round-trip is **lossy where Markdown is ambiguous** (trailing "  " hard breaks, setext headings, reference links). Formatting survives; exact bytes do not. This is a known, documented limitation, not a bug to chase.
- Undo is the module's own snapshot stack: re-rendering wipes the browser's contenteditable history.
- The surface is the mount element itself (as in `editor.js`), **not** a wrapper div — a nested div would make `querySelector('.wysiwyg-host')` resolve to the wrong node and swallow every keystroke.
- The note pane is behind `x-if`, so the surface mounts at a point Alpine chooses — it can land **during** `openNote`'s `await`, after it, or after a note arrives. Every event that changes what the surface should show therefore calls the one idempotent `syncWysiwyg()` (mount, `openNote`, `setMode`) instead of a local `if (this.wysiwyg) setBody(...)` guard. Per-caller guards only work in one order, and the wrong one silently mounts the surface blank; **add a new call site to `syncWysiwyg`, never a new guard.**
- Attachment resolution is cached on the **set of references** in the body, never on the body text. Derive that key with `refSetKey(noteId, body)` in `js/media.js` — it lives beside the scheme because deriving it by hand is the one thing two callers must not do differently. `mediaKey()` in `js/ui/app.js` only delegates to it; a body-keyed guard is invalidated by every keystroke, so every debounced settle would repaint the surface and throw the caret (D14).

### Process

- Rules go in this file. **Rationale goes in `architecture.md`.** Never duplicate the why here.
- Docs that go stale are worse than no docs. If you change behavior, update this file in the same commit.

## Repo layout (target)

The files below do not all exist yet — `TODO.md` builds toward this layout. Files that exist today: `NOTED_plan.md`, `AGENTS.md`, `architecture.md`, `TODO.md`.

```
index.html        Entry point; loads CDN libs, registers Alpine components
css/style.css     All styles
js/
  db.js           Dexie schema, note record, CRUD
  search.js       Fuse.js index build + query
  router.js       Hash router + route table
  pwa.js          Service-worker registration
  ui/             Alpine components (list, editor, preview, settings)
  io/export.js    JSON + Markdown export
  io/import.js    JSON + Markdown import
manifest.json     PWA manifest (relative paths only)
sw.js             Service worker (app-dir root, relative scope)
NOTED_plan.md     Original project brief (read-only reference)
architecture.md   The "why" — read when this file is not enough
TODO.md           Prioritized work queue
docs/deployment.md  Host-specific deploy instructions (planned — T16)
```

## Where things live

- **What to build next** → `TODO.md`
- **Why it is built that way** → `architecture.md`
- **How to ship it** → `docs/deployment.md` (planned)
