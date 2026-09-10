#!/bin/sh
# Fingerprint Damper - deterministic packaging (finding: "packaging script").
#
# Produces the XPI that is submitted to AMO, containing exactly the reviewed
# source files. No transpilation, bundling, minification or code generation:
# the packaged files ARE the source files.
#
# Usage:
#   ./package.sh            # builds fingerprint-damper-<version>.xpi
#   ./package.sh --check    # lint first, then build (needs npx + web-ext)
set -eu

VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' manifest.json | head -n1)"
[ -n "$VERSION" ] || { echo "cannot read version from manifest.json" >&2; exit 1; }

OUTPUT="fingerprint-damper-${VERSION}.xpi"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

if [ "${1:-}" = "--check" ]; then
  command -v npx >/dev/null 2>&1 || { echo "npx required for --check" >&2; exit 1; }
  npx web-ext lint --source-dir .
fi

# Stage exactly the files that ship, so the zip has a stable, reviewable set.
for entry in manifest.json src rules icons LICENSE; do
  [ -e "$entry" ] || { echo "missing expected entry: $entry" >&2; exit 1; }
  cp -R "$entry" "$STAGE/"
done
[ -f rules/NOTICE.md ] || { echo "missing rules/NOTICE.md" >&2; exit 1; }

# Run the AMO-sensitive-pattern gate over the staged content.
"$(dirname "$0")/scripts/amocheck.sh" "$STAGE"

rm -f "$OUTPUT"
(cd "$STAGE" && zip -X -r -q "$OLDPWD/$OUTPUT" manifest.json src rules icons LICENSE)
echo "built $OUTPUT"
echo "contents: $(cd "$STAGE" && find manifest.json src rules icons LICENSE -type f | sort | wc -l) files"
