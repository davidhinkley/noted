# AGENTS.md

NOTED is a local-first Markdown notes app: a **buildless static SPA**. The browser is the source of truth. There is no server. This file is the operating manual — read it at the start of every session.

## Stack (fixed)

- **Alpine.js 3** — UI reactivity (CDN)
- **Dexie.js** — IndexedDB wrapper (CDN)
- **Fuse.js** — client-side fuzzy search (CDN)
- **marked** — Markdown → HTML (CDN)
- **DOMPurify** — sanitize rendered Markdown (CDN)
- **Vanilla CSS**, hash routing, ES modules

The app ships **zero npm dependencies**. Every library loads from a CDN. `package.json` holds dev-only tooling and never reaches production.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm install` | Install dev-only tooling. |
| `pnpm dev` | Serve the app locally. **Required** — IndexedDB needs an http(s) origin; `file://` will not work. |

- `pnpm deploy` — not defined yet. Target: `docs/deployment.md` (see `TODO.md` **T16**).

### What does not exist

- **No build step.** Do not add Vite, webpack, Rollup, esbuild, or TypeScript compilation.
- **No lint step.** Do not add eslint, prettier, or htmlhint without raising it in a PR first.
- **No test suite.** Do not add vitest, jest, or playwright without raising it in a PR first.
- **No CI pipeline.** Deployment is documented in `docs/deployment.md` (not yet written — `TODO.md` **T16**).

Naming these gaps is deliberate. The default failure mode of a coding agent is to add infrastructure that "should" be there. It isn't.

## Hard rules

### Data

- Note IDs are **UUIDv4**. Generate with the built-in `crypto.randomUUID()` — do not add a `uuid` library via CDN. Never auto-increment, never timestamp-derived.
- Store **raw Markdown** in `note.body`. Never store rendered HTML in the database.
- `note.body` is **opaque at the storage boundary**. The DB layer never parses, transforms, or inspects content.
- **Soft-delete only.** Set `deletedAt`. Never hard-delete except from the trash view (`TODO.md` **T21**).
- Use Dexie. Do not add a second storage layer (localStorage for note data, OPFS) without adding an entry to `architecture.md` → **Decisions** first.
- Every schema change **bumps the Dexie version** and ships a migration.

### Routing

- All routes are hash routes: `#/`, `#/note/:id`, `#/tag/:tag`. Never use the History API. Never add clean-path routes.

### Paths

- The app is served from a **subdirectory** (e.g. `/notes/` on a shared host, `/<repo>/` on GitHub Pages).
- **Never use a leading `/`** in any same-origin path: HTML assets, manifest fields, icon `src`, service-worker registration.
- **Do not add a `<base>` tag.** Relative paths are sufficient.
- Resolve cached URLs in the service worker against `self.registration.scope`, never against `/`.

### UI

- The editor is **swappable**. Today it is a plain `<textarea>`. Never couple storage, rendering, or export to a specific editor component.

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
