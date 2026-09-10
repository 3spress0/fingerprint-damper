#!/bin/sh
# Fingerprint Damper - AMO-sensitive pattern gate (finding: "automated checks").
#
# Fails when runtime source introduces patterns that are red flags or outright
# banned at AMO review: eval / new Function / remote dynamic imports / remote
# <script> insertion / executable code built from downloaded strings / any
# network endpoint the code itself calls. It is a regression tripwire, not a
# security analysis.
#
# Usage:
#   scripts/amocheck.sh [DIR]     # scan DIR (default: repository root)
#
# The final section compares the file set against the manifest-derived
# allowlist (content scripts, background scripts, pages, icons, rules,
# LICENSE, NOTICE), so a stray file cannot ride into the XPI.
set -eu

ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT"

# ---- 1. forbidden runtime constructs ---------------------------------------
if grep -RInE \
    'eval[[:space:]]*\(|new[[:space:]]+Function|import[[:space:]]*\([^)]*https?://' \
    manifest.json src rules 2>/dev/null; then
  echo "FAIL: forbidden runtime construct found (eval/new Function/remote import)" >&2
  exit 1
fi

if grep -RIInE \
    'document[.]write|<script[^>]+src=[[:space:]]*["'"'"']https?://|new[[:space:]]+WebSocket[[:space:]]*\(|WebSocket[[:space:]]*\([^)]*https?://' \
    src 2>/dev/null; then
  echo "FAIL: remote script insertion or remote socket construction found" >&2
  exit 1
fi

# ---- 2. no unapproved network endpoints (baseline: none at all) -------------
if grep -RIInE 'fetch[[:space:]]*\(|XMLHttpRequest|navigator[.]sendBeacon' src 2>/dev/null; then
  echo "FAIL: unapproved network endpoint call found (extension must make none)" >&2
  exit 1
fi

# ---- 3. packaged file allowlist ---------------------------------------------
# The staged package (no README.md) must contain exactly the manifest-derived
# file set. A dev checkout has extra files by design, so a root scan stops
# after the source checks above.
if [ -f "$ROOT/README.md" ]; then
  echo "amocheck: source scan clean (dev checkout; file-set check runs on the package stage)"
  exit 0
fi

node - "$ROOT" <<'EOF'
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

const allowed = new Set();
const add = (v) => { if (typeof v === 'string') allowed.add(v); };
const addMany = (v) => { if (Array.isArray(v)) v.forEach(add); };

for (const cs of manifest.content_scripts || []) addMany(cs.js);
for (const s of (manifest.background && manifest.background.scripts) || []) add(s);
if (manifest.background && manifest.background.service_worker) add(manifest.background.service_worker);
if (manifest.options_ui) add(manifest.options_ui.page);
if (manifest.action) add(manifest.action.default_popup);
if (manifest.page_action) add(manifest.page_action.default_popup);
for (const v of Object.values(manifest.icons || {})) add(v);
const addIcon = (icon) => {
  if (typeof icon === 'string') add(icon);
  else for (const v of Object.values(icon || {})) add(v);
};
addIcon(manifest.action && manifest.action.default_icon);
addIcon(manifest.page_action && manifest.page_action.default_icon);
for (const r of (manifest.declarative_net_request && manifest.declarative_net_request.rule_resources) || []) add(r.path);
// Files referenced from packaged HTML pages (e.g. options.html -> options.js).
const pages = [];
const collect = (v) => { if (typeof v === 'string') pages.push(v); };
for (const cs of manifest.content_scripts || []) for (const v of cs.js || []) collect(v);
for (const s of (manifest.background && manifest.background.scripts) || []) collect(s);
collect(manifest.options_ui && manifest.options_ui.page);
collect(manifest.action && manifest.action.default_popup);
for (const page of pages) {
  if (!page.endsWith('.html')) continue;
  const html = fs.readFileSync(path.join(root, page), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const ref = match[1];
    if (!ref || ref.startsWith('#') || /^[a-z]+:/i.test(ref)) continue;   // skip anchors/URLs
    add(path.posix.join(path.posix.dirname(page), ref));
  }
}
add('manifest.json');
add('LICENSE');
add('rules/NOTICE.md');

const actual = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, e);
    const rel = path.relative(root, p).split(path.sep).join('/');
    if (fs.statSync(p).isDirectory()) { walk(p); continue; }
    if (rel.startsWith('.git') || rel.startsWith('test') || rel.startsWith('docs') ||
        rel === 'package.sh' || rel === 'web-ext-config.cjs' || rel.startsWith('scripts/')) continue;
    actual.push(rel);
  }
})(root);

const missing = [...allowed].filter(f => !actual.includes(f)).sort();
const extra = actual.filter(f => !allowed.has(f)).sort();
if (missing.length || extra.length) {
  console.error('FAIL: packaged file set differs from the manifest allowlist');
  if (missing.length) console.error('--- allowed but missing ---\n' + missing.join('\n'));
  if (extra.length) console.error('--- present but not allowed ---\n' + extra.join('\n'));
  process.exit(1);
}
console.log('amocheck: clean (' + actual.length + ' files match the manifest allowlist)');
EOF
