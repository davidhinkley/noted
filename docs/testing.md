# Proposal: one repeatable check, no test framework

This raises `AGENTS.md` → **"No test suite. Do not add vitest, jest, or playwright
without raising it in a PR first."** The question is narrow: *should NOTED get a
regression check, and if so, what is the smallest thing that actually catches the
bugs that have shipped?*

Recommendation: **yes, but not a test framework.** Add a single zero-dependency
check script that drives a real browser through the real entry points, and
register it as a `pnpm` script. No vitest, no jest, no playwright, no CI.

## Why this is being raised now

Four defects shipped in a single day. All four produced **no error** — they
produced output that looked fine:

| Defect | Why nothing caught it |
| --- | --- |
| `exportMarkdown` never called `inlineAttachments` | Exported a clean `.md` with a bare `attachment:<id>` ref. Valid-looking file, broken outside NOTED. |
| `exportMarkdownZip` computed `inlined`, passed `text` | Identical symptom, opposite entry point. The dead variable read as intentional. |
| `exportMD` passed `{title, body}`, dropping `id` | Getter was called with `undefined`; resolved nothing; no throw. |
| `js/media.js`, `js/ui/wysiwyg.js` missing from `SHELL_FILES` | `install` succeeded. Only an offline launch failed, and only on a real device. |

Each was found by *reading*, not by running. The export bugs were reported as
"verified" at one point in this work — the test exercised the `inlineAttachments`
helper while both callers were broken. That is the failure mode worth spending
tooling on: **a check of the wrong unit looks exactly like a passing test.**

## Why the obvious answers are wrong

**A unit-test framework is the wrong shape.** These bugs are not logic errors in
isolation. They live at the seam between a module, the DOM, IndexedDB, and a
blob URL. A unit test of `exportMarkdown` with a mocked `download()` asserts the
mock was called with the right string — which is precisely the assumption that was
false three times. The bug was in *what got handed to the sink*, not in the
computation.

**A pure-node test cannot run this code at all.** `js/ui/app.js` touches
`document`, `navigator.serviceWorker`, and `URL.createObjectURL` at import time;
`export.js` builds a Blob and clicks an anchor. There is no meaningful way to test
the entry points without a browser. A node-only check would have to stop at
`inlineAttachments` — the exact unit that already gave a false green.

**CI is a separate decision.** `AGENTS.md` forbids it too, and nothing here
requires it. This proposal adds a command a human or agent runs before shipping.
CI can be raised later once there is a check worth gating on.

## What is proposed

A single file, `tools/check.mjs`, plus one entry in `package.json`. It launches a
headless browser via the Chrome DevTools Protocol over a WebSocket — using only
`node:http`, `node:child_process`, and Node's built-in `WebSocket` (Node 22+). No
new dependency, no lockfile change, no vendored binary.

It runs four assertions against the **real** entry points, in a real browser,
against real IndexedDB:

1. **Export `.md` inlines.** Paste a real PNG through the real paste handler,
   click Save `.md`, intercept the object URL, and assert the downloaded text
   contains `data:image/…;base64,` and **no** `attachment:<uuid>`.
2. **Export `.zip` inlines.** Unzip the captured archive in-page; assert every
   entry is inlined and no bare ref survives.
3. **`.md` without attachments is byte-identical.** Guards the inliner against
   corrupting plain notes.
4. **Precache covers the import graph.** Statically diff the module graph reachable
   from `index.html` against `SHELL_FILES` in `sw.js`. This is the check that would
   have caught the offline bug at commit time.

Plus the two invariants that were fixed this session, since they regressed twice:

5. Typing N characters produces the exact expected body (no caret throw).
6. `refSetKey` is stable across ordinary body edits and changes on a new ref.

`AGENTS.md` would be amended to say: *no framework; `pnpm check` exists and must
pass before a change to `js/io/`, `js/media.js`, or `js/ui/` is considered done.*

## Honest cost

Roughly 150–250 lines of CDP plumbing, which is real complexity for a buildless
project whose defining constraint is "zero npm dependencies." The WebSocket client
is the part that will rot — Node's built-in one is still settling, and the
CDP surface is a browser API, not a stable contract.

A **much cheaper alternative**, if the full version is judged too heavy: assert
only #4 (the static precache/import-graph diff) plus #6 (`refSetKey`, pure
function, no browser). That catches the offline bug and the caret-key regression
in about 40 lines of plain node, with no browser at all. It does **not** catch the
export bugs, which are the ones that bit hardest.

## Decision requested

- Accept the full `tools/check.mjs`, or
- take the cheap static subset, or
- decline and rely on manual browser verification.

No framework is proposed under any option. If the answer is no, the export
entry points stay untested, and the next person to change them will be relying on
a comment that says they work — which is how all four of these shipped.
