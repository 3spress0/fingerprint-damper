#!/bin/sh
# Fingerprint Damper - reproducible packaging.
#
# Produces the XPI that is submitted to AMO, containing exactly the reviewed
# source files. No transpilation, bundling, minification or code generation:
# the packaged files ARE the source files.
#
# Byte-reproducibility: entries are added in sorted (LC_ALL=C) order and all
# staged timestamps are normalised before zipping. The normalisation stamp is
# SOURCE_DATE_EPOCH if set, else the release commit's Unix time, else a fixed
# epoch. Same source + same epoch => same XPI bytes:
#
#   ./package.sh && sha256sum fingerprint-damper-*.xpi
#   rm fingerprint-damper-*.xpi && ./package.sh && sha256sum fingerprint-damper-*.xpi
#
# Usage:
#   ./package.sh            # builds fingerprint-damper-<version>.xpi
#   ./package.sh --check    # also lints the staged package (needs web-ext or npx)
#   ./package.sh --verify   # full release verification: tests + build + file
#                           # count + lint + SHA-256 + version/tag agreement
#
# Windows: run from Git Bash or WSL. If Info-ZIP is not installed, a Python
# zipfile fallback is used automatically (python3 or python on PATH).
set -eu

MODE="${1:-}"
ROOT="$(pwd)"

VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' manifest.json | head -n1)"
[ -n "$VERSION" ] || { echo "cannot read version from manifest.json" >&2; exit 1; }

OUTPUT="fingerprint-damper-${VERSION}.xpi"
ENTRIES="manifest.json src rules icons LICENSE"
EXPECTED_COUNT=13
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Stage exactly the files that ship, so the zip has a stable, reviewable set.
stage() {
  for entry in $ENTRIES; do
    [ -e "$entry" ] || { echo "missing expected entry: $entry" >&2; exit 1; }
    cp -R "$entry" "$STAGE/"
  done
  [ -f rules/NOTICE.md ] || { echo "missing rules/NOTICE.md" >&2; exit 1; }
  # Run the AMO-sensitive-pattern gate over the staged content.
  "$(dirname "$0")/scripts/amocheck.sh" "$STAGE"
}

# Lint the staged package itself (what AMO receives), not the dev checkout.
lint_human() {
  if command -v web-ext >/dev/null 2>&1; then
    web-ext lint --source-dir "$STAGE"
  elif command -v npx >/dev/null 2>&1; then
    npx --yes web-ext lint --source-dir "$STAGE"
  else
    echo "web-ext lint: unavailable (install web-ext or Node/npx)" >&2
  fi
}

# Machine-readable lint counts: "E W N", or "unavailable" if web-ext is absent.
lint_counts() {
  RUNNER=""
  if command -v web-ext >/dev/null 2>&1; then RUNNER="web-ext";
  elif command -v npx >/dev/null 2>&1; then RUNNER="npx --yes web-ext"; fi
  if [ -z "$RUNNER" ]; then echo "unavailable"; return 0; fi
  JSON="$($RUNNER lint --source-dir "$STAGE" --output json 2>/dev/null)" || { echo "unavailable"; return 0; }
  printf '%s' "$JSON" | "$(command -v python3 || command -v python)" -c '
import json, sys
d = json.load(sys.stdin)
print(len(d.get("errors", [])), len(d.get("warnings", [])), len(d.get("notices", [])))'
}

# Normalise timestamps for byte-reproducible output. Precedence:
# SOURCE_DATE_EPOCH > release commit time (UTC) > fixed epoch.
normalise() {
  EPOCH="${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct 2>/dev/null || true)}"
  [ -n "$EPOCH" ] || EPOCH=1767225600   # 2026-01-01T00:00:00Z
  STAMP="$(date -u -d "@$EPOCH" +%Y%m%d%H%M.%S)"
  STAMP_DASH="$(date -u -d "@$EPOCH" +%Y-%m-%d-%H-%M-%S)"
  find "$STAGE" -exec touch -t "$STAMP" {} +
}

# Zip the staged tree. Prefers Info-ZIP (zip -X); falls back to a Python
# zipfile writer so Windows/Git-Bash checkouts work without extra tools.
make_zip() {
  rm -f "$OUTPUT"
  if command -v zip >/dev/null 2>&1; then
    (cd "$STAGE" && find $ENTRIES -type f -print |
      LC_ALL=C sort | TZ=UTC zip -X -q "$ROOT/$OUTPUT" -@)
  else
    PY="$(command -v python3 || command -v python || true)"
    [ -n "$PY" ] || { echo "need either 'zip' or python3 on PATH to build" >&2; exit 1; }
    echo "note: 'zip' not found; using Python zipfile fallback" >&2
    "$PY" - "$STAGE" "$ROOT/$OUTPUT" "$STAMP_DASH" <<'PYEOF'
import os, sys, zipfile
stage, out, stamp = sys.argv[1], sys.argv[2], tuple(int(x) for x in sys.argv[3].split('-'))
names = []
for root, _dirs, files in os.walk(stage):
    for name in files:
        names.append(os.path.relpath(os.path.join(root, name), stage).replace(os.sep, '/'))
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for name in sorted(names):
        info = zipfile.ZipInfo(name, date_time=stamp)
        info.external_attr = 0
        with open(os.path.join(stage, name), 'rb') as fh:
            z.writestr(info, fh.read())
PYEOF
  fi
}

build() {
  normalise
  make_zip
  echo "built $OUTPUT (entries normalised to $STAMP)"
  echo "contents: $(cd "$STAGE" && find $ENTRIES -type f | sort | wc -l) files"
}

if [ "$MODE" = "--verify" ]; then
  stage
  # Tests (do not abort the report on failure; surface the counts instead).
  TEST_OUT="$(node --test test/*.test.cjs 2>/dev/null || true)"
  TESTS_PASS="$(printf '%s\n' "$TEST_OUT" | sed -n 's/^[[:space:]]*ℹ[[:space:]]*pass[[:space:]]*//p' | head -n1)"
  TESTS_FAIL="$(printf '%s\n' "$TEST_OUT" | sed -n 's/^[[:space:]]*ℹ[[:space:]]*fail[[:space:]]*//p' | head -n1)"
  build >/dev/null
  if command -v unzip >/dev/null 2>&1; then
    ACTUAL_COUNT="$(unzip -Z1 "$OUTPUT" | wc -l | tr -d ' ')"
  else
    ACTUAL_COUNT="$("$(command -v python3 || command -v python)" -c \
      'import sys, zipfile; print(len(zipfile.ZipFile(sys.argv[1]).namelist()))' "$OUTPUT")"
  fi
  LINT="$(lint_counts)"
  SHA="$(sha256sum "$OUTPUT" | cut -d' ' -f1)"
  if git rev-parse "v$VERSION" >/dev/null 2>&1; then TAG_STATUS="v$VERSION present"; else TAG_STATUS="v$VERSION MISSING (run: git tag -f v$VERSION <sha>)"; fi
  if [ "$LINT" = "unavailable" ]; then LINT_LINE="unavailable (web-ext not found)"; else
    set -- $LINT
    LINT_LINE="$1 errors, $2 warnings, $3 notices"
  fi
  echo ""
  echo "Version:       $VERSION"
  echo "XPI:           $OUTPUT"
  echo "SHA-256:       $SHA"
  echo "Files:         ${ACTUAL_COUNT}/${EXPECTED_COUNT} expected"
  echo "web-ext lint:  $LINT_LINE"
  echo "Tests:         ${TESTS_PASS:-0} passed, ${TESTS_FAIL:-0} failed"
  echo "Git tag:       $TAG_STATUS"
  echo ""
  [ "$ACTUAL_COUNT" = "$EXPECTED_COUNT" ] || { echo "file count mismatch" >&2; exit 1; }
  [ "${TESTS_FAIL:-1}" = "0" ] || { echo "tests failed" >&2; exit 1; }
  exit 0
fi

stage

if [ "$MODE" = "--check" ]; then
  lint_human
fi

build
