# AMO reviewer notes - Fingerprint Damper v1.2.0

Short, factual notes for reviewers. Nothing here changes the shipped code; see the
linked files for detail.

## What the extension does, in one paragraph

Fingerprint Damper installs page-level JavaScript wrappers that return crowd-blended,
origin-stable values instead of the browser's identifying ones (GPU/model via WebGL, canvas
hashes, battery level, CPU cores, optional audio/locale/timezone/etc.), and offers two
additional tiers: user-opted-in network blocking via `declarativeNetRequest` (ships disabled)
and a default-off "global lockdown" tier that applies browser-enforced CSP/header rules. It
has no server, collects no data, and stores only local settings plus a per-browser-session
salt used to derive stable damping seeds.

## Why `<all_urls>` and MAIN-world injection are required

The API wrappers must be installed at `document_start`, before ordinary page
scripts read the affected JavaScript APIs. The optional lockdown tier operates
separately through browser-managed declarativeNetRequest rules, which must be
configured before the relevant requests and document responses occur.

- The API patches (`src/inject.js`) must run in the page's own JavaScript realm
  (`"world": "MAIN"`) to replace `Navigator`/`CanvasRenderingContext2D`/etc. behaviour that
  page scripts read. There is no non-MAIN-world way to patch page-visible getters.
- The lockdown tier (`src/lockdown.js`, background-only) configures
  `declarativeNetRequest` rules evaluated by the browser on document responses and
  subrequests; broad host access is required for header modification on any
  HTTP(S) document the user visits.

Host permissions are `<all_urls>` (required for MAIN-world injection on any page and for
DNR header modification); Firefox automatically excludes restricted contexts. No browsing
history is collected; per-origin state is limited to the user's own pause/allowlist entries
in `storage.local`.

## The `tabs` permission

`tabs` is used to (a) resolve the active tab's origin for the per-site API pause toggle and
(b) re-push configuration to already-open tabs after settings change. The extension does not
read tab titles, URLs beyond the origin used for pause, favicons, or browsing history, and
transmits nothing. Narrowing this permission is planned once it can be verified against a
real Firefox; removing it without native testing risks breaking the documented pause flow.

## Data handling / privacy

- All settings storage is local (`storage.local` for persistent settings, `storage.session`
  for the session salt - the background is the only context that touches the salt;
  content/script pages never get `storage.session` access).
- No analytics, telemetry, remote filter updates, or network calls originate from the
  extension. The only network effect is the user-enabled DNR blocking rules.
- `manifest.json` declares `"data_collection_permissions": {"required": ["none"]}`.
- `scripts/amocheck.sh` enforces an allowlist of shipped files and rejects telemetry/
  analytics/dynamic-code patterns; `package.sh` reproduces the XPI byte-for-byte (sorted
  entry order, normalized timestamps). Reviewers can verify by building twice and comparing
  SHA-256.

## Known, documented limitations (see README "Main limitations")

Conservative listing wording:

> Reduces passive fingerprinting by ordinary scripts. Page-level JavaScript wrappers are
> detectable and can be bypassed or switched to pass-through by adversarial page code.

Additional honest caveats:

- Wrappers are installed for the document lifetime; the per-site pause switches them to
  pass-through rather than uninstalling them.
- Settings propagation is asynchronous at `document_start`; until the bridge response lands,
  shipped defaults apply. This is documented, not claimed otherwise.
- Workers/worklets are not patched (content scripts cannot run there); the lockdown tier can
  block new workers but does not normalize worker APIs.
- The global lockdown tier is explicitly labelled experimental and is **off by default**; it
  uses browser-enforced CSP/DNR rules (no spoofed responses) and documents its breakage.

## Experimental features disclaimer

"Block ad service workers", "Reduce Math precision", and the whole global lockdown tier are
marked experimental in the UI and docs. None are enabled by default.

## Reproducible packaging

`package.sh` stages exactly the shipped file set, normalizes timestamps
(`SOURCE_DATE_EPOCH` → last commit epoch → fixed epoch fallback), sorts entries and zips with
`-X`, so two builds of the same tree produce identical bytes. No transpilation or minification:
the packaged files are the source files. `./package.sh --verify` prints a one-block release
report (version, XPI name, SHA-256, file count, web-ext lint counts, test counts, git tag
agreement). Where Info-ZIP is unavailable (e.g. Windows/Git Bash), a Python zipfile writer is
used automatically with the same sorted entries and normalized timestamps.

## Source availability

GPL-3.0-or-later; repository `https://github.com/3spress0/fingerprint-damper`, source tree
included in the source archive (same tree - no build step).
