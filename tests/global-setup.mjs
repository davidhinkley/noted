// tests/global-setup.mjs — fail the run if the test server is stale.
//
// A reused or lingering `serve` process can hand the browser files that do
// not match disk. A green suite against stale code is the exact false
// confidence D15 exists to end, so the run aborts here rather than testing
// the wrong app. Zero dependencies; plain Node (Node 22 has global fetch).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function shellFiles() {
  const sw = readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const m = sw.match(/SHELL_FILES\s*=\s*\[([\s\S]*?)\]/);
  if (!m) throw new Error('global-setup: could not parse SHELL_FILES from sw.js');
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
}

export default async function globalSetup(config) {
  const base = config?.webServer?.url || 'http://127.0.0.1:8799';
  const files = shellFiles();
  const bad = [];
  for (const f of files) {
    const disk = readFileSync(path.join(ROOT, f));
    let served;
    try {
      const r = await fetch(base + '/' + f);
      if (!r.ok) {
        bad.push(`${f}: HTTP ${r.status}`);
        continue;
      }
      served = Buffer.from(await r.arrayBuffer());
    } catch (e) {
      bad.push(`${f}: fetch failed (${e.message})`);
      continue;
    }
    if (!disk.equals(served)) bad.push(`${f}: served bytes differ from disk`);
  }
  if (bad.length) {
    throw new Error(
      `global-setup: the test server is serving stale files (run aborted, not green):\n  - ` +
        bad.join('\n  - ') +
        `\nKill any lingering 'serve' process and re-run.`,
    );
  }
  console.log(`global-setup: ${files.length} shell files match disk; server is fresh.`);
}
