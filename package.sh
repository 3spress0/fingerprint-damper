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
#   ./package.sh --check    # additionally runs npx web-ext lint on the staged
#                           # package (needs npx + web-ext)
set -eu

VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' manifest.json | head -n1)"
[ -n "$VERSION" ] || { echo "cannot read version from manifest.json" >&2; exit 1; }

OUTPUT="fingerprint-damper-${VERSION}.xpi"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Stage exactly the files that ship, so the zip has a stable, reviewable set.
for entry in manifest.json src rules icons LICENSE; do
  [ -e "$entry" ] || { echo "missing expected entry: $entry" >&2; exit 1; }
  cp -R "$entry" "$STAGE/"
done
[ -f rules/NOTICE.md ] || { echo "missing rules/NOTICE.md" >&2; exit 1; }

# Run the AMO-sensitive-pattern gate over the staged content.
"$(dirname "$0")/scripts/amocheck.sh" "$STAGE"

# Lint the staged package itself (what AMO receives), not the dev checkout.
if [ "${1:-}" = "--check" ]; then
  command -v npx >/dev/null 2>&1 || { echo "npx required for --check" >&2; exit 1; }
  npx web-ext lint --source-dir "$STAGE"
fi

# Normalise timestamps for byte-reproducible output. Precedence:
# SOURCE_DATE_EPOCH > release commit time (UTC) > fixed epoch.
EPOCH="${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct 2>/dev/null || true)}"
[ -n "$EPOCH" ] || EPOCH=1767225600   # 2026-01-01T00:00:00Z
STAMP="$(date -u -d "@$EPOCH" +%Y%m%d%H%M.%S)"
find "$STAGE" -exec touch -t "$STAMP" {} +

rm -f "$OUTPUT"
(cd "$STAGE" && find manifest.json src rules icons LICENSE -type f -print |
  LC_ALL=C sort | TZ=UTC zip -X -q "$OLDPWD/$OUTPUT" -@)
echo "built $OUTPUT (entries normalised to $STAMP)"
echo "contents: $(cd "$STAGE" && find manifest.json src rules icons LICENSE -type f | sort | wc -l) files"
