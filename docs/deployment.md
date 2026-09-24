# Deployment

How to ship NOTED. The source is the artifact — no build step, deployment is a file push plus a version bump.

**Chosen target (T17, 2026-09-23): GitHub Pages (project site) behind a custom subdomain** — `noted.360481025.xyz` maps to `davidhinkley.github.io`. Branch-based publishing from `main`, no Actions workflow, no CI.

**Status (release-ritual verified 2026-09-24):** SW active with scope `https://noted.360481025.xyz/`, cache `noted-v9` holding all shell files, CDN libs runtime-cached, hard-offline create/edit working. *Enforce HTTPS* active (`http://` → 301 → `https://`). Live spot-check: pin toggle + reorder, sort control, zip export path.

## The release ritual — every release, no exceptions

1. **Bump `CACHE_VERSION` in `sw.js`.** This is the only invalidation mechanism — no content hashes exist without a build step. `activate` deletes every cache that isn't the current version. Forget this and returning users run the old shell forever. (*architecture.md* D6.)
2. **Sanity-check paths.** No leading `/` in any same-origin path — HTML assets, `manifest.json` fields, icon `src`, service-worker registration. All relative.
3. **Verify locally first** (below), then push and let Pages rebuild.

## Verify locally before pushing

Mirror the layout you are about to ship — root **or** subpath both work (relative paths), then verify:

```sh
mkdir -p /tmp/subpath-test/NOTED
cp index.html sw.js manifest.json icon.svg css/ js/ icons/ /tmp/subpath-test/NOTED/
npx serve -l 3100 /tmp/subpath-test
```

- Open `http://localhost:3100/NOTED/?sw=1` (`?sw=1` forces SW registration; plain localhost skips it in dev — see `js/pwa.js`).
- DevTools → Application → Service Workers: one worker, **scope** must end in `/NOTED/`.
- Application → Cache Storage → `noted-v<version>`: `index.html`, `css/style.css`, every `js/*`, `manifest.json`, icons are all present under `/NOTED/`.
- Kill the server. Reload. The shell must render from cache; create, edit, search, tag must all work (IndexedDB is origin-local, unaffected by the network).
- Re-verify whenever the SW, manifest, or path layout changes. A regression here ships a broken offline story. (*architecture.md* §8, TODO **T14/T15**.)

## Host: GitHub Pages + custom subdomain — chosen

`noted.360481025.xyz` is a `CNAME` to `davidhinkley.github.io`, so Pages serves the site at the domain **root**, not at `/<repo>/`. Procedure (verified 2026-09-23 on the `noted` repo; mirrors the earlier `py-course` deploy):

1. **Push first.** Make sure `.nojekyll` is committed (Pages would otherwise run Jekyll and mangle raw static files) and `CNAME` contains `noted.360481025.xyz`. Then `git push origin main`.
2. **Enable Pages.** Settings → Pages → *Deploy from a branch*: branch `main`, `/(root)`, Save. The site appears at `https://davidhinkley.github.io/noted/` — confirm the shell loads there before touching the domain (project path first, subdomain second).
3. **Point DNS.** In Cloudflare add a `CNAME` record `noted` → `davidhinkley.github.io` with **proxy OFF (DNS only)** — GitHub Pages has its own Let's Encrypt certificate and must see the origin record directly, never a Cloudflare proxy. A DNS-only subdomain CNAME resolves to GitHub Pages' addresses (`185.199.108.153` *et al.*).
4. **Claim the domain.** Same Pages screen → *Custom domain*: `noted.360481025.xyz`, Save. GitHub validates DNS against the repo's `CNAME` record; wait for the green "DNS check successful" state.
5. **Enforce HTTPS.** Once the certificate provisions (minutes–hours), tick *Enforce HTTPS*. GitHub Pages issues and renews Let's Encrypt certificates automatically for the custom domain.

Notes:

- The committed `CNAME` file is the mapping; GitHub also rewrites it when you save the custom domain in the UI. Keep it in sync.
- Do **not** configure anything on the `davidhinkley.github.io` (user site) repo — every repo owns its own Pages settings.
- Branch publishing serves the **whole repo root** publicly (`docs/`, `package.json`, `deploy.sh` are raw URLs). Acceptable for this repo; converting to a GitHub Actions artifact build that uploads only the shell is the option if that ever matters.

## Alternative: shared host rsync (legacy)

`deploy.sh` / `pnpm deploy` rsync the shell to a shared-host subdirectory. Kept because relative paths work at root **or** subpath, and its file list is the same contract as `sw.js` `SHELL_FILES`. No longer the chosen target for NOTED; superseded by GitHub Pages.

```sh
DEPLOY_HOST=user@example.com DEPLOY_DIR=~/www/noted pnpm deploy
```

`deploy.sh` rsyncs **exactly the files that ship** — `index.html`, `manifest.json`, `sw.js`, `icon.svg`, `css/`, `js/`, `icons/` — with `--delete`. Docs, tooling, and git internals never leave the repo. Credentials travel via env vars only.

> Whichever mechanism ships the app, if the ship file set diverges from `sw.js` `SHELL_FILES`, offline breaks in the field: add the new shell file to **both** the deployment list and `SHELL_FILES`, then re-run the *Verify locally* checklist.