// tools/check-shell.mjs — Tier 1 of D15, zero‑dependency check for precache consistency
// Compares statically imported JS files against SHELL_FILES in sw.js.
// Also checks that CACHE_VERSION heuristic works.

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// Project root is one level up from tools/
const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// Load sw.js from project root
const swText = fs.readFileSync(path.join(PROJECT_ROOT, 'sw.js'), 'utf8');

// Extract CACHE_VERSION
const cvMatch = swText.match(/CACHE_VERSION\s*=\s*['"`]([^'"`]+)['"`]/);
if (!cvMatch) { console.error('FATAL: cannot find CACHE_VERSION'); process.exit(1); }
const CURR_VERSION = cvMatch[1];
console.log('CACHE_VERSION:', CURR_VERSION);

// Extract SHELL_FILES array
const shellMatch = swText.match(/SHELL_FILES\s*=\s*\[([\s\S]*?)\];/);
if (!shellMatch) { console.error('FATAL: cannot find SHELL_FILES'); process.exit(1); }
// Extract all quoted strings
const shellFiles = [...shellMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
console.log('SHELL_FILES:', shellFiles.length);

// === Walk project and collect all .js files ===
const jsFiles = [];
function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === '.git') continue;
      walk(full);
    } else if (/\.(js|mjs)$/i.test(entry.name)) {
      jsFiles.push(full);
    }
  }
}
walk(PROJECT_ROOT);
console.log('Total .js/.mjs files:', jsFiles.length);

// === Entry points: modules loaded directly from index.html ===
// These are roots of the graph, not imported by another module, so an
// "is it imported?" check alone would flag them as missing.
const htmlText = fs.readFileSync(path.join(PROJECT_ROOT, 'index.html'), 'utf8');
const srcRe = /<script[^>]*\bsrc\s*=\s*['"]([^'"]+)['"]/gi;
const htmlRoots = new Set();
let srcMatch;
while ((srcMatch = srcRe.exec(htmlText)) !== null) {
  const src = srcMatch[1];
  if (!/^(https?:)?\/\//.test(src) && /\.(js|mjs)$/i.test(src)) {
    htmlRoots.add(src.replace(/^\.?\//, ''));
  }
}
console.log('HTML module roots:', [...htmlRoots].join(', ') || '(none)');

// === Parse static imports from all js files ===
// Matches both binding imports (`import x from './y.js'`) and side-effect
// imports (`import './y.js'`). The latter has no `from`, and missing it was a
// real blind spot: an unreferenced module imported only for side effects
// slipped straight through the precache check.
const imports = new Set(); // resolved paths relative to project root
const IMPORT_RE = /import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+?)['"]/g;
for (const file of jsFiles) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = IMPORT_RE.exec(content)) !== null) {
      const imp = match[1];
      if (imp.startsWith('.') || imp.startsWith('../')) {
        // Resolve relative to this file's directory
        const srcDir = path.dirname(file);
        const absPath = path.resolve(srcDir, imp);
        if (fs.existsSync(absPath) && /\.(js|mjs)$/i.test(absPath)) {
          imports.add(path.relative(PROJECT_ROOT, absPath));
        }
      }
    }
  } catch (e) {
    console.warn('Error reading', file, ':', e.message);
  }
}
console.log('Resolved JS imports:', imports.size);

// === Separate shell files into JS files and static assets ===
const shellJsFiles = new Set();
const shellStaticAssets = new Set();

for (const f of shellFiles) {
  if (/\.(js|mjs)$/i.test(f)) {
    shellJsFiles.add(f);
  } else {
    shellStaticAssets.add(f);
  }
}
console.log('Shell JS files:', shellJsFiles.size);
console.log('Shell static assets:', shellStaticAssets.size);

// === Check 1: Every shell JS file must be reachable ===
// Reachable means imported by another module, or loaded directly from
// index.html as a module entry point.
const reachable = (f) => imports.has(f) || htmlRoots.has(f);
const unreachableJs = [...shellJsFiles].filter((f) => !reachable(f));
if (unreachableJs.length > 0) {
  console.error('FAIL: shell JS files that are neither imported nor HTML roots:');
  unreachableJs.forEach((f) => console.error('  -', f));
  process.exit(1);
}
console.log('PASS: Every shell JS file is imported or an HTML root');

// === Check 2: Every imported file must be in shell ===
const extraImports = [...imports].filter((f) => !shellJsFiles.has(f));
if (extraImports.length > 0) {
  console.error('FAIL: The following imported files are not in SHELL_FILES:');
  extraImports.forEach((f) => console.error('  -', f));
  process.exit(1);
}
console.log('PASS: All imported JS files are listed in SHELL_FILES');

// === Check 3: Every HTML module root must be in shell ===
const extraRoots = [...htmlRoots].filter((f) => !shellJsFiles.has(f));
if (extraRoots.length > 0) {
  console.error('FAIL: HTML module roots not listed in SHELL_FILES:');
  extraRoots.forEach((f) => console.error('  -', f));
  process.exit(1);
}
console.log('PASS: All HTML module roots are listed in SHELL_FILES');

// === CACHE_VERSION drift check ===
// sw.js is the only cache-invalidation mechanism the app has, so a change to
// a precached file without a version bump ships returning users a stale shell
// and no error. Compare against git rather than package.json: package.json is
// unrelated dev tooling and comparing to it warns on every run, which is the
// "check nobody trusts" failure this decision exists to prevent.
function gitLines(cmd) {
  try {
    return execSync(cmd, { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

const shellPaths = new Set(shellFiles);
const drift = [];

// (a) Uncommitted edits: precached file changed but sw.js untouched.
const dirty = gitLines('git status --porcelain');
if (dirty) {
  const changed = dirty.map((line) => line.replace(/^\s*\S+\s+/, '').replace(/^\S+\s+/, '').trim());
  const touchedShell = changed.filter((f) => shellPaths.has(f));
  const touchedSw = changed.includes('sw.js');
  if (touchedShell.length > 0 && !touchedSw) {
    drift.push({ scope: 'uncommitted', files: touchedShell });
  }
}

// (b) The HEAD commit itself changed a precached file without sw.js.
const headFiles = gitLines('git show --name-only --pretty=format: HEAD');
if (headFiles) {
  const headShell = headFiles.filter((f) => shellPaths.has(f));
  if (headShell.length > 0 && !headFiles.includes('sw.js')) {
    drift.push({ scope: 'HEAD', files: headShell });
  }
}

if (drift.length > 0) {
  console.warn('WARNING: CACHE_VERSION drift — precached files changed without a version bump:');
  for (const d of drift) {
    console.warn('  [' + d.scope + '] ' + d.files.join(', '));
  }
  console.warn('  Current CACHE_VERSION is ' + CURR_VERSION + '. Bump it in sw.js if these changes ship.');
} else {
  console.log('PASS: No precache drift detected (CACHE_VERSION ' + CURR_VERSION + ')');
}

console.log('=== check-shell.mjs completed ===');