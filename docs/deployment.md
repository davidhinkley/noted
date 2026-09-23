# Deployment

How to ship NOTED. The source is the artifact — no build step, deployment is a file copy plus a version bump.

**Chosen target (T17, 2026-09-23): shared host, subdirectory.** Deploy via `deploy.sh` / `pnpm deploy`.

## The release ritual — every release, no exceptions

1. **Bump `CACHE_VERSION` in `sw.js`.** This is the only invalidation mechanism — no content hashes exist without a build step. `activate` deletes every cache that isn't the current version. Forget this and returning users run the old shell forever. (*architecture.md* D6.)
2. **Sanity-check paths.** No leading `/` in any same-origin path — HTML assets, `manifest.json` fields, icon `src`, service-worker registration. All relative.
3. **Verify locally first** (below), then `pnpm deploy`.

## Verify before deploying

Serve from a subpath exactly like the target host, then verify:

```sh
mkdir -p /tmp/subpath-test/NOTED
cp index.html sw.js manifest.json icon.svg css/ js/ icons/ /tmp/subpath-test/NOTED/
npx serve -l 3100 /tmp/subpath-test
```

- Open `http://localhost:3100/NOTED/?sw=1` (`?sw=1` forces SW registration; plain localhost skips it in dev — see `js/pwa.js`).
- DevTools → Application → Service Workers: one worker, **scope** must end in `/NOTED/`.
- Application → Cache Storage → `noted-v<version>`: `index.html`, `css/style.css`, every `js/*`, `manifest.json`, icons all present under `/NOTED/`.
- Kill the server. Reload. The shell must render from cache; create, edit, search, tag must all work (IndexedDB is origin-local, unaffected by the network).
- Re-verify whenever the SW, manifest, or path layout changes. A regression here ships a broken offline story. (*architecture.md* §8, TODO **T14/T15**.)

## Host: shared hosting (subdirectory or domain root) — chosen

Upload the app files by rsync. Relative paths work unchanged at a subpath **or** the domain root — moving root → subpath requires touching the manifest, SW, and every asset path; moving subpath → root requires nothing. (*architecture.md* §10.) Target: a subdirectory named for the app (e.g. `~/www/noted`).

Deploy with `pnpm deploy` (defined in `package.json`, script at repo root `deploy.sh`):

```sh
DEPLOY_HOST=user@example.com DEPLOY_DIR=~/www/noted pnpm deploy
```

`deploy.sh` rsyncs **exactly the files that ship** — `index.html`, `manifest.json`, `sw.js`, `icon.svg`, `css/`, `js/`, `icons/` — with `--delete`. Docs, tooling, and git internals never leave the repo. Credentials travel via env vars only. It also reminds you to bump `CACHE_VERSION` on every run.

> If `deploy.sh` ships a different file set than `sw.js` precaches, offline breaks in the field: add the new shell file to **both** the rsync list and `SHELL_FILES`. Re-verify with the checklist below after any change to either list.

**First-time and every-release verification** — mirror the target layout locally, then re-run the *Verify before deploying* checklist against it before pushing. A regression here ships a broken offline story. (*architecture.md* §8, TODO **T14/T15**.)

Alternative hosts that work unchanged (relative paths need no config):

| Host | Notes |
| --- | --- |
| GitHub Pages (project site) | Base path `/<repo>/`. Manual: push the app files to a `gh-pages` branch at repo root, e.g. `git subtree push --prefix . origin gh-pages`. An Actions workflow is the automation option if ever needed. |
| Shared hosting (domain root) | Same rsync; the subdirectory prefix simply isn't there. |