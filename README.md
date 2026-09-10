<p align="center">
  <img src="icons/icon.svg" alt="Fingerprint Damper logo" width="80" height="80">
</p>

<h1 align="center">Fingerprint Damper</h1>

<p align="center">
  <em>API-level anti-fingerprinting for Firefox.<br>Stable, deterministic damping rather than per-call randomization.</em>
</p>

<p align="center">
  <img alt="Firefox 142+" src="https://img.shields.io/badge/Firefox-142%2B-FF7139?logo=firefoxbrowser&logoColor=white">
  <img alt="Manifest V3" src="https://img.shields.io/badge/Manifest-V3-2b5fd9">
  <img alt="web-ext lint" src="https://img.shields.io/badge/web--ext%20lint-0%20errors%200%20warnings-3fb950">
  <img alt="No dependencies" src="https://img.shields.io/badge/runtime%20deps-none-3fb950">
  <img alt="Data collection" src="https://img.shields.io/badge/data%20collected-none-3fb950">
  <img alt="License GPL-3.0-or-later" src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue">
</p>

---

Ad blockers work at the **network layer** — they stop a request being made. This works at the
**API layer** by default — it changes what a script reads once it is running. An additional,
**default-off global lockdown tier** uses browser-enforced network/CSP rules to deny execution
and requests rather than spoof values.

That gap is not theoretical. It came out of a live teardown of a YouTube-converter site whose
deobfuscated PropellerAds SDK was found reading GPU model, battery level, screen geometry,
timezone and window position through ordinary DOM calls — none of which an ad blocker can prevent
once the script has loaded. This extension targets exactly those surfaces.

**v1.2.0 status:** hardening release. The page/extension config channel validates message
structure, seals its initial salt and never uninstalls hooks; pause is a pass-through flag
(because the channel stays page-visible, hostile page code can still request native pass-through
on its own page — see Honest limitations). Cryptographic per-browser-session salt stored in
`storage.session` (background-only), settings reconciled through a runtime round trip at
`document_start`, safer defaults (audio, geometry, notification blocking, service-worker blocking
and network blocking are now opt-in), byte-reproducible packaging (`./package.sh`, gated by
`scripts/amocheck.sh`). Run `node --test test/*.test.cjs` — 107/107 tests pass. The packaged XPI
lives at the repo root (filename tracks `manifest.json`'s version; `*.xpi` is git-ignored).

---

## Why this isn't redundant with uBlock Origin + Privacy Badger

A script gets through your blockers all the time: because it's first-party, because it isn't on a
filter list yet, because the operator rotated to a fresh domain, or because you allowlisted the
site to make it work. At that point the network layer has had its say and the fingerprint is taken
anyway. This picks up from there.

The three are complementary:

| Layer | Tool | Job |
|---|---|---|
| Network | uBlock Origin | Blocks known ad/tracker requests from a curated list |
| Network | Privacy Badger | Heuristically learns third parties that track across sites |
| **API** | **this** | **Changes what a script that got through is able to read** |

There is a small deliberate overlap: a `declarativeNetRequest` ruleset blocks the specific
PropellerAds/RTMark hosts found in the teardown plus a reviewed snapshot of public ad-network
lists. It is deliberately much narrower than a general-purpose ad blocker and keeps the
source-derived entries third-party-only to limit breakage.

---

## The design rules

Naive anti-fingerprinting breaks the web and, worse, makes you *more* identifiable. Four rules
keep this usable:

**1. Consistency, not randomness.** Values derive from a seed of `origin + date + session salt`, so
a site sees one stable persona. Randomising per call breaks image editors and audio tools, and a
value that changes on every read is itself a loud, unique signal. Verified:

```
site A, reload 1       806dd20d
site A, reload 2       806dd20d   <- stable, as intended
site B, same session   b8589a2d   <- cross-site linking broken
site A, next session   18a9f38d   <- rotates, long-term linking broken
real canvas            ada5b8c5
```

**2. Blend into the biggest crowd.** WebGL vendor/renderer/version fields are reported as
`Mozilla` / the matching WebGL version, and its debug-renderer extension is withheld — following
the broad persona Firefox's own `resistFingerprinting` uses. Inventing a unique fake GPU would
make you a population of one.

**3. Some things are deliberately left alone.** `navigator.plugins` and `maxTouchPoints` are
untouched. The SDK we analysed used `plugins.length === 0` as a *headless-bot* signal — emptying it
would flag you as a bot and get you served differently. Screen resolution stays real too, because
quantising it is a genuine responsive-layout breakage risk. Restraint is a feature.

**4. Higher-breakage protections are opt-in.** ClientRects, locale/timezone changes, WebRTC,
passive-list/state masking, and experimental Math rounding are off by default and carry warnings.
Even the default protections can affect some sites; the per-site pause is the escape hatch.

---

## What it does

### On by default (low breakage risk)

| Protection | Behaviour |
|---|---|
| Canvas / text metric noise | Up to 32 RGB low-bit flips on pixel readback/serialization (max channel delta 1/255), including main-thread `OffscreenCanvas`. The noise step is O(32); serialization needs a copy and skips canvases over 4 MP. `measureText()` fields get stable <0.01px jitter. This changes exact hashes, not reliable font-availability tests. |
| WebGL identity / readback | Vendor, renderer and matching version strings → `Mozilla` / `WebGL 1.0` or `2.0`; `WEBGL_debug_renderer_info` is hidden. Standard RGBA/UNSIGNED_BYTE `readPixels()` receives stable, low-bit RGB noise. Other WebGL capabilities, shader behavior, non-byte formats and PBO readback remain native. |
| Hardware capacity | `hardwareConcurrency` → 8 and, only if the browser already exposes it, `deviceMemory` → 8. No API is invented; worker navigators remain native. |
| Battery | `getBattery()` reports full and charging while keeping the native `BatteryManager` shell when its getters are patchable; native failures remain failures. Level plus discharge time is a startlingly good short-term cross-site correlator. |

Everything else in this extension is opt-in (below). Since v1.2.0 the shipped profile only
includes fingerprint damping with a low breakage risk; controls that touch application data,
prompts, workers or the network must be switched on explicitly.

### Opt-in (off by default)

| Protection | Behaviour and trade-off |
|---|---|
| Audio noise | ~32 samples perturbed by 1e-7 in `AudioBuffer.getChannelData` and `AnalyserNode`. That array is the buffer's real backing store, so audio apps that read or export those samples see tiny drift. Inaudible; defeats AudioContext hashing. Off by default for that reason. |
| Window geometry | `screenX`/`screenY` → 0, `outerWidth/Height` → inner, `availWidth/Height` → full, colour depth → 24. Leaks OS, theme, toolbar count and monitor layout; needed by nothing. Off by default. |
| Block notification permission prompts | `Notification.requestPermission()` resolves `"default"` with **no dialog** — but only for requests that do not follow transient user activation; requests made right after a deliberate click still prompt normally. `"default"` reads as *the user dismissed it*, which is commonplace and unremarkable. Off by default. |
| Block ad service workers (experimental) | Rejects service-worker registrations whose host labels or script path match known ad-SDK patterns. Boundary-aware matching (host labels / path tokens), never raw substring tests. Off by default; pattern matching can hit unrelated apps — use the per-site pause as a bypass. |
| Network block | Static DNR blocks 78 known ad/push-network request domains: 10 original teardown hosts plus 68 unique entries from nine public [LanikSJ/ubo-filters](https://github.com/LanikSJ/ubo-filters) lists (MIT; four overlap). The 64 newly added source-derived domains apply only to third-party requests. See [source notice and pinned snapshot](rules/NOTICE.md). Off by default since v1.2.0. The blocklist **excludes `etacloud.org` and `tubeapi.org`** — those are the actual conversion backend in the y2mate teardown. |
| Hide speech voice list | `getVoices()` returns an empty array. Native default speech remains available, but voice pickers and some accessibility flows may break. No fake voices are created. |
| Hide media device list | Successful `enumerateDevices()` calls return an empty array, hiding enumerated labels, counts and IDs. Native errors and capture APIs remain unchanged. Camera/microphone/speaker pickers may break; this does **not** block capture. |
| Mask passive permission states | Native `PermissionStatus.state` reads report `prompt`; `Notification.permission` reports `default`. Real grants, explicit request results, query support/errors and events stay native. Sites may show redundant permission UI or disable features. |
| Reduce Math precision (experimental) | Rounds 12 low fraction bits of eligible transcendental/root/power results (added relative error roughly at most 4.55e-13). Special values, integers and subnormals stay native. Can break exact identities or numerical code; not a faithful or complete cross-engine Math replacement. Native Math functions are left untouched until opted in. |
| ClientRects damping | Stable sub-pixel changes to `Element` and `Range` `getBoundingClientRect()` / `getClientRects()`. Native `DOMRect`/`DOMRectList` objects, zero dimensions, and bounding/fragment relationships are preserved (within floating-point precision). No DOM layout is changed, but callers using these measurements for positioning, selection or hit-testing may break. |
| Default to `en-US` language / locale | Sets navigator language and normalises default locale selection in available `Intl` formatters, numeric/date `toLocale*` methods, string collation and locale-sensitive casing. Supported explicit locale choices and Unicode extensions remain native; empty/unsupported requests fall back to `en-US`. Sites may stop showing your language. |
| Default to UTC timezone | Uses UTC for default `Intl.DateTimeFormat` and date `toLocale*` formatting, plus zero timezone offsets. Output and `resolvedOptions()` agree. Explicit time zones remain native. Can break calendars, bookings and delivery estimates; other local-time `Date` APIs are not masked. |
| WebRTC address filtering | Withholds host, server-reflexive and peer-reflexive ICE candidates from events, SDP creation/local-description reads and local candidate stats; relay (TURN) paths stay available. While enabled, `getStats()` resolves to a map-shaped sanitized copy. May break peer-to-peer applications without TURN and changes diagnostics. |

Locale/timezone settings affect **new formatters** and subsequent `toLocale*` calls. Already-created
formatter objects and already-returned measurement snapshots keep their values; reload after a
settings change to clear a site's cached objects. These controls reduce particular observations,
not all ways of inferring a machine's fonts, locale, or time zone. Previously returned voice/device
lists remain readable too. See [coverage and trust boundaries](docs/coverage.md) for the exact Math
surface, passive-API caveats and worker policy. TLS/HTTP-stack normalization remains out of scope;
selected HTTP headers can now be removed with the separate lockdown tier.

---

## Global lockdown — experimental, extreme breakage

All **nine controls are off by default**, separate from the existing API options:

- Block site JavaScript (inline and external) instead of trying to emulate every API.
- Force a browser **opaque-origin document sandbox**, with no script/same-origin escape tokens and explicit anti-framing policy.
- Block new workers and service-worker registrations on covered documents.
- Block embedded frame/object loads.
- Block fetch/XHR, new WebSockets, beacons, pings and CSP reports.
- Text-only loading: block eligible secondary requests, scripts, media/fonts and external styling.
- Strip outgoing/incoming network cookies, without clearing existing browser data.
- Disable new HTTP cache writes and remove ETag/Last-Modified validators; it does not clear old or service-worker caches.
- Remove selected identity headers (UA, language, referrer, known UA client hints).

These are **global kill switches**, including on API-paused sites. Settings has a confirmed
**Enable all lockdown controls** preset; Settings and the popup both have **Turn off all lockdown**.
Reload affected tabs (bypass cache) to apply/release CSP. No automatic tab reloads or data deletion.

The browser enforces eligible rules outside the spoofable page-world event channel. Server CSP is
appended to, never replaced or weakened. This does **not** promise that a website gets nothing:
the initial request/IP/TLS, URLs, old contexts, stored data and cached/service-worker responses
remain concerns. It is not an OS sandbox, proxy or transport firewall. Use a fresh test profile.
See [lockdown controls, limits and recovery](docs/lockdown.md). **Native Firefox validation is pending.**

---

## Install

Not signed, so pick one:

**Temporary (survives until restart, no config change):**
1. `about:debugging#/runtime/this-firefox`
2. *Load Temporary Add-on…*
3. Select `manifest.json` in this folder.

**Permanent:** requires Firefox Developer Edition, Nightly, or ESR. Set
`xpinstall.signatures.required` to `false` in `about:config`, then install the `.xpi` at the repo
root matching `manifest.json`'s version, from `about:addons` → gear → *Install Add-on From File*.
Release Firefox enforces signing with no override; for that you'd need to submit it to AMO
(self-distribution signing is free and doesn't require public listing).

Requires **Firefox 142+** (`world: "MAIN"` content scripts landed in 128;
`data_collection_permissions` in 140; Android parity in 142).

### Build the XPI

From the repository root, run `./package.sh`. It stages exactly the shipped file set
(`manifest.json`, `src/`, `rules/`, `icons/`, `LICENSE`), runs the AMO-sensitive pattern gate
(`scripts/amocheck.sh`), and writes `fingerprint-damper-<version>.xpi` next to the manifest.
Output is byte-reproducible: entries are added in sorted order and staged timestamps are
normalised to `SOURCE_DATE_EPOCH` (or the release commit time, or a fixed epoch). Verify with:
build, `sha256sum` the XPI, delete it, build again, compare.
No transpilation, bundling, minification or code generation: the packaged files are the source
files. `./package.sh --check` additionally runs `npx web-ext lint` on the *staged* package. For a
quick local reload, `npx web-ext run` still works via `web-ext-config.cjs`.

---

## Verify it works

Open `test/selftest.html` directly (`file://`) once with the extension off and once on, and compare.
It reads the same surfaces the ad SDK did and tags each one damped/exposed.

The important check is subtle: **reload twice with it on — the hashes must stay identical.** A hash
that changes every reload means the noise is per-call, which is worse than no protection.

For dependency-free automated regression tests (Node.js 18+), run
`node --test test/*.test.cjs`. These use DOM doubles, real Node Intl/Math, and isolated Node harnesses
for the diagnostic worker scripts (not Firefox's worker loader/CSP).
The new rule/settings/UI tests use mocked extension APIs, not native DNR enforcement.
`test/browser-regression.html` exercises the patches against real browser APIs with native
references captured first; open it with the installed extension **disabled**. See
[test/README.md](test/README.md) for locale-matrix commands, font-probe interpretation and the
remaining manual checks. The self-test includes WebGL byte readback, Element/Range hashes, actual
locale output, hardware capacity, voice/device counts, passive permission states, Math hashes, and
window/worker comparisons. Local-font and worker probes are explicitly labelled **unprotected**.
Worker loading may require
a local HTTP server; a failure or matching value is not proof of protection. The notification
request test now requires an explicit button click rather than running automatically.

For lockdown, use the separate [HTTP fixture/checklist](test/README.md#global-lockdown-http-integration).
A file-based or JS-driven self-test cannot prove that scripts were blocked before execution.

---

## Using it

Toolbar badge shows how many fingerprint reads were intercepted on the current page. Click for a
breakdown and a **Pause API patches on this site** button (per-origin, persists). Since v1.2.0,
pausing and resuming apply **live** to open pages: hooks stay installed and simply pass through to
native behaviour while paused — no tab reload is forced. A reload only helps if a page cached
earlier values. The badge counts page API reports, not DNR/network blocks. Settings also has a
**Paused sites** list: resume one origin, or confirm **Resume API patches on all sites**.

API pause never disables the global ad-network switch or global lockdown. The Paused sites controls
only change that per-origin API list; they do not make global network/CSP rules permissive. If
lockdown breaks a site, turn off the relevant global switch or use **Turn off all lockdown**, then
reload. If removal fails, disable the extension in `about:addons`; the UI reports failures rather
than claiming success.

---

## Honest limitations

- **Startup race.** The background stores the cryptographic browser-session salt in
  `storage.session`, preserving it across event-page restarts (Firefox supports `storage.session`
  in trusted extension contexts since 115; it does NOT expose it to content scripts, so there is
  no session-storage fast path). At `document_start`, the isolated bridge requests the current
  salt, settings and pause state from the background via a runtime message. Shipped defaults
  remain active until that asynchronous response arrives, so very early page reads may precede
  configuration reconciliation. This is a real seam, not an atomic browser policy.
- **The extension is detectable.** Wrappers look wrapped: the v1.2.0 release removed the
  `Function.prototype.toString` override and the `window.__fpdCloak` global. Empty lists, rounded
  Math results and other behaviour changes can identify protections or a settings combination.
  These controls reduce particular observations, not guarantee anonymity.
- **Page-world channels are not a security boundary.** The configuration and stats events are
  page-visible. The configuration listener validates message structure (known boolean keys only),
  seals its initial salt and never uninstalls hooks. Because it remains page-visible, hostile
  page code can still request native pass-through behavior on its own page by dispatching the
  config event with `allowlisted: true`; it cannot uninstall hooks, recover saved native
  references, or reach privileged storage/network rules. Noise values are deterministic from
  origin + date + salt; the salt rides the page-visible channel, so a page that knows the
  algorithm can in principle subtract the noise. Damping defeats fingerprinters that don't know
  about the extension, not adversarial page code. Also note: content scripts never run in worker
  globals, so canvas/audio fingerprinting performed inside a Web Worker is not damped at all.
  Turning off *Count activity* reduces stats traffic, but does not make those API hooks
  tamper-proof. The browser-enforced lockdown rules are separate; page events cannot change them.
- **Not a substitute for Tor Browser or full `resistFingerprinting`.** Those give a far larger
  anonymity set at a far higher usability cost. If you want the strongest available option in
  Firefox itself, `privacy.resistFingerprinting` exists — it will break more, and this extension
  is largely redundant alongside it.
- **Installed-font availability is not hidden.** `FontFace`/CSS `local()` loading and ordinary
  font selection remain native. `document.fonts` iterates document-managed faces, not the whole
  installed-font list; `check()` can return `true` for nonexistent families, so it is not itself
  an installed-font oracle. [1](https://developer.mozilla.org/en-US/docs/Web/API/FontFaceSet/check)
  Tiny text-metric/ClientRects jitter changes exact hashes, but rounding, tolerance-based probes,
  and other layout measurements can still identify fonts. The diagnostics do not imply protection.
- **Intl engine data is not standardised.** The locale option changes default locale selection,
  not ICU/CLDR versions, `Intl.Locale`, static capability queries or results for supported explicit
  locales. Native local-time `Date` methods such as `toString()` and `getHours()` can still reveal
  the time zone even when the UTC option is on.
- **Worker and worklet globals are unprotected.** Content scripts run in window realms, not
  dedicated/shared/service workers or worklets. Any relevant API exposed in those globals — for
  example OffscreenCanvas/WebGL, worker font APIs, Intl or worker navigator fields — bypasses the
  window patches. The default remains native execution, but the new opt-in CSP worker/script
  blocks can deny new workers on covered documents; they do not normalize worker APIs or stop
  existing workers. Not every window API exists in a worker. No `Worker` constructor shim is used:
  a partial bootstrap would not close the gap and could break CSP, module loading or worker
  identity/lifecycle semantics. Broader coverage needs a different architecture or browser-level
  protections, not another window-prototype patch.
- **Passive masking is not capability control.** Voice/device lists can be hidden, but cached
  objects, native change-event timing, real capture/track APIs and explicit permission outcomes
  remain available. Permission support/errors remain observable. The Push guard controls
  notification requests independently from passive permission-state masking.
- **Battery masking is value masking, not battery isolation.** Where the browser exposes patchable
  `BatteryManager` getters, the native manager identity/events remain so compatibility is preserved;
  event timing and saved native getters can still reveal changes. Native rejections stay rejections.
  With the battery switch off, `getBattery()` returns its native result instead of an extension-made
  error.
- **WebGL and capacity masking are partial.** The standard byte-array `readPixels()` path is damped,
  but shader precision, limits, extensions other than debug-renderer info, non-byte/PBO readback and
  worker/OffscreenCanvas WebGL remain native. `deviceMemory` is masked only when it already exists;
  no worker navigator is altered.
- **WebRTC filtering is page-world compatibility masking, not transport isolation.** It cannot
  retract an address exposed before injection or through a saved native reference, block browser
  transport itself, or make latency/network characteristics anonymous. The opt-in sanitizes local
  candidate fields in returned stats but changes `getStats()` report identity; remote candidates and
  the broader WebRTC API remain native.
- **Math rounding is experimental, not engine standardisation.** Exact identities and numerical
  algorithms can change. Arithmetic operators, WebAssembly, unpatched globals and rounding-boundary
  differences remain available to probes. It is deliberately off by default.
- **Cache lockdown is not storage cleanup or a service-worker bypass.** It removes validators and
  sets `Cache-Control: no-store` only on eligible responses after the rule is active. Existing HTTP
  cache entries, BFCache, service-worker caches and URL identifiers remain outside its control.
- **TLS/HTTP-stack fingerprinting remains outside scope.** Optional removal of selected HTTP
  headers is not transport normalization. Page-world hooks cannot control the TLS
  ClientHello or HTTP/2 stack/header order. An ordinary pass-through VPN/SOCKS/CONNECT proxy does not
  replace the browser's TLS handshake. No proxy, CA trust or certificate-validation changes are
  made; see [the transport boundary](docs/coverage.md#tls--http-no-implementation-in-this-layer).

---

## Layout

```
manifest.json                 MV3, Firefox event page (not a service worker)
web-ext-config.cjs            package destination + excludes Node/browser test artifacts
rules/adnets.json             declarativeNetRequest blocklist
rules/NOTICE.md               public source provenance and license notice
src/inject.js                 MAIN world, document_start — all API patches
src/bridge.js                 ISOLATED world — the only link to browser.*
src/background.js             settings, API allowlist, network-policy lifecycle, badge
src/lockdown.js               pure global DNR/CSP policy definitions (extension pages only)
src/popup.html|js             per-page activity + pause toggle
src/options.html|js           feature switches and paused-site recovery
test/selftest.html|js         before/after verification page
test/font-probes.js           local-font diagnostics (not a protection)
test/probe-values.js          shared passive window/worker diagnostic values
test/worker-probe*            worker entries/driver (not production protection)
test/*.test.cjs               dependency-free regression tests
test/browser-regression.*     native-browser regression fixture
test/README.md                verification instructions and coverage limits
test/lockdown-server.cjs      repository-only HTTP fixture for native lockdown checks
docs/coverage.md             passive/Math coverage, workers and transport boundaries
docs/lockdown.md             global kill switches, enforcement limits and recovery
package.sh                    deterministic XPI packaging (repo root)
scripts/amocheck.sh           AMO pattern gate + packaged-file allowlist
fingerprint-damper-*.xpi      built XPI (git-ignored)
LICENSE                       GNU GPL v3
```

`inject.js` keeps every original descriptor in a `restore[]` array, so allowlisting genuinely hands
the site its native page API descriptors back. That is separate from global lockdown/CSP and
network rules, which are not removed by API allowlisting.

---

## License

**GNU General Public License v3.0 or later** (`GPL-3.0-or-later`). Full text in [LICENSE](LICENSE).

This is a strong-copyleft license, chosen deliberately. Anyone may use, study, modify and
redistribute this — but if they distribute a modified version, or build something on top of it,
**they must release their source under the same license too.** A privacy tool whose derivatives can
be closed up is a privacy tool waiting to be quietly turned into its opposite; the whole point of
this extension is that you can read exactly what it does to your browser.

Copyright (C) 2026 Fingerprint Damper contributors.