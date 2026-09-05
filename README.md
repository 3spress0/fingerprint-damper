<p align="center">
  <img src="icons/icon.svg" alt="Fingerprint Damper logo" width="80" height="80">
</p>

<h1 align="center">Fingerprint Damper</h1>

<p align="center">
  <em>API-level anti-fingerprinting for Firefox.<br>Stable spoofing, not random noise.</em>
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

**Status:** `web-ext lint` → 0 errors, 0 warnings, 0 notices. Packaged zip lives in `package/`
(filename tracks `manifest.json`'s version — check there rather than here, this line has gone
stale before).

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

There is a small deliberate overlap: a `declarativeNetRequest` ruleset blocking the specific
PropellerAds/RTMark hosts found in the teardown, since fresh operator domains often aren't on
filter lists yet.

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

**2. Blend into the biggest crowd.** The GPU string is reported as `Mozilla` — exactly what
Firefox's own `resistFingerprinting` reports. Inventing a unique fake GPU would make you a
population of one.

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
| GPU masking | `UNMASKED_RENDERER_WEBGL` / `UNMASKED_VENDOR_WEBGL` → `Mozilla`. This was the single highest-entropy item the SDK collected. |
| Audio noise | ~32 samples perturbed by 1e-7 in `AudioBuffer.getChannelData` and `AnalyserNode`. Inaudible. A `WeakSet` prevents repeated reads from accumulating drift. |
| Window geometry | `screenX`/`screenY` → 0, `outerWidth/Height` → inner, `availWidth/Height` → full, colour depth → 24. Leaks OS, theme, toolbar count and monitor layout; needed by nothing. |
| CPU cores | `hardwareConcurrency` → 8. |
| Battery | `getBattery()` → always full and charging. Level plus discharge time is a startlingly good short-term cross-site correlator. |
| Push guard | `Notification.requestPermission()` resolves `"default"` with **no dialog**; service workers matching known ad patterns are refused. |
| Network block | DNR rules for `9hito.com`, `zdzhk.com`, `kbvcd.com`, `rtmark.net`, `dulotadtor.com`, `abunownon.com`, `dawac.com`, `10zon.com`, `kocmg.com`, `blxwnnw.com` (from the original teardown), plus `lzrikate.com`, `pheegoab.click`, `phenver.com`, `pushno.com`, sourced from [LanikSJ/ubo-filters' PropellerAds Domains Filter List](https://github.com/LanikSJ/ubo-filters) (MIT). |

Note `requestPermission` returns `"default"`, not `"denied"`. "Denied" is a sticky, distinguishable
state; "default" reads as *the user dismissed it*, which is both commonplace and unremarkable.

Also note the blocklist **excludes `etacloud.org` and `tubeapi.org`** — those are the actual
conversion backend. Blocking them would break the site's real function. The ad layer is cut; the
feature keeps working. That's the "doesn't hurt UX" line.

### Opt-in (off by default)

| Protection | Behaviour and trade-off |
|---|---|
| Hide speech voice list | `getVoices()` returns an empty array. Native default speech remains available, but voice pickers and some accessibility flows may break. No fake voices are created. |
| Hide media device list | Successful `enumerateDevices()` calls return an empty array, hiding enumerated labels, counts and IDs. Native errors and capture APIs remain unchanged. Camera/microphone/speaker pickers may break; this does **not** block capture. |
| Mask passive permission states | Native `PermissionStatus.state` reads report `prompt`; `Notification.permission` reports `default`. Real grants, explicit request results, query support/errors and events stay native. Sites may show redundant permission UI or disable features. |
| Reduce Math precision (experimental) | Rounds 12 low fraction bits of eligible transcendental/root/power results (added relative error roughly at most 4.55e-13). Special values, integers and subnormals stay native. Can break exact identities or numerical code; not a faithful or complete cross-engine Math replacement. Native Math functions are left untouched until opted in. |
| ClientRects damping | Stable sub-pixel changes to `Element` and `Range` `getBoundingClientRect()` / `getClientRects()`. Native `DOMRect`/`DOMRectList` objects, zero dimensions, and bounding/fragment relationships are preserved (within floating-point precision). No DOM layout is changed, but callers using these measurements for positioning, selection or hit-testing may break. |
| Default to `en-US` language / locale | Sets navigator language and normalises default locale selection in available `Intl` formatters, numeric/date `toLocale*` methods, string collation and locale-sensitive casing. Supported explicit locale choices and Unicode extensions remain native; empty/unsupported requests fall back to `en-US`. Sites may stop showing your language. |
| Default to UTC timezone | Uses UTC for default `Intl.DateTimeFormat` and date `toLocale*` formatting, plus zero timezone offsets. Output and `resolvedOptions()` agree. Explicit time zones remain native. Can break calendars, bookings and delivery estimates; other local-time `Date` APIs are not masked. |
| WebRTC IP filtering | Filters host/STUN ICE candidates. May break peer-to-peer applications without a TURN fallback. |

Locale/timezone settings affect **new formatters** and subsequent `toLocale*` calls. Already-created
formatter objects and already-returned measurement snapshots keep their values; reload after a
settings change to clear a site's cached objects. These controls reduce particular observations,
not all ways of inferring a machine's fonts, locale, or time zone. Previously returned voice/device
lists remain readable too. See [coverage and trust boundaries](docs/coverage.md) for the exact Math
surface, passive-API caveats and worker policy. TLS/HTTP-stack normalization remains out of scope;
selected HTTP headers can now be removed with the separate lockdown tier.

---

## Global lockdown — experimental, extreme breakage

All **eight controls are off by default**, separate from the existing API options:

- Block site JavaScript (inline and external) instead of trying to emulate every API.
- Force a browser **opaque-origin document sandbox**, without script/same-origin escape tokens.
- Block new workers and service-worker registrations on covered documents.
- Block embedded frame/object loads.
- Block fetch/XHR, new WebSockets, beacons, pings and CSP reports.
- Text-only loading: block eligible secondary requests, scripts, media/fonts and external styling.
- Strip outgoing/incoming network cookies, without clearing existing browser data.
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
`xpinstall.signatures.required` to `false` in `about:config`, then install the zip in `package/`
matching `manifest.json`'s version, from `about:addons` → gear → *Install Add-on From File*.
Release Firefox enforces signing with no override; for that you'd need to submit it to AMO
(self-distribution signing is free and doesn't require public listing).

Requires **Firefox 142+** (`world: "MAIN"` content scripts landed in 128;
`data_collection_permissions` in 140; Android parity in 142).

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
remaining manual checks. The self-test includes Element/Range hashes, actual locale output,
voice/device counts, passive permission states, Math hashes, and window/worker comparisons.
Local-font and worker probes are explicitly labelled **unprotected**. Worker loading may require
a local HTTP server; a failure or matching value is not proof of protection. The notification
request test now requires an explicit button click rather than running automatically.

For lockdown, use the separate [HTTP fixture/checklist](test/README.md#global-lockdown-http-integration).
A file-based or JS-driven self-test cannot prove that scripts were blocked before execution.

---

## Using it

Toolbar badge shows how many fingerprint reads were intercepted on the current page. Click for a
breakdown and a **Pause API patches on this site** button (per-origin, persists, reloads the tab).
The badge counts page API reports, not DNR/network blocks.

API pause never disables the global ad-network switch or global lockdown. If lockdown breaks a
site, turn off the relevant global switch or use **Turn off all lockdown**, then reload. If removal
fails, disable the extension in `about:addons`; the UI reports failures rather than claiming success.

---

## Honest limitations

- **Startup race.** The page-world script can't read `browser.storage`, so it applies protective
  defaults at `document_start` and reconciles with your settings asynchronously via `bridge.js`.
  An allowlisted site can briefly see protective defaults before restoration; an opt-in surface
  can be read before its setting arrives. Early reads or saved native references can bypass
  protection. This is a real seam, not an atomic browser policy.
- **The extension is detectable.** Native-looking function strings do not make wrappers invisible.
  Empty lists, rounded Math results and other behaviour changes can identify protections or a
  settings combination. These controls reduce particular observations, not guarantee anonymity.
- **Page-world channels are not a security boundary.** The configuration and stats events are
  page-visible; hostile page code can spoof configuration events or replace hooks. Turning off
  *Count activity* reduces stats traffic, but does not make those API hooks tamper-proof. The new
  browser-enforced lockdown rules are separate; page events cannot change them.
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
- **Math rounding is experimental, not engine standardisation.** Exact identities and numerical
  algorithms can change. Arithmetic operators, WebAssembly, unpatched globals and rounding-boundary
  differences remain available to probes. It is deliberately off by default.
- **TLS/HTTP-stack fingerprinting remains outside scope.** Optional removal of selected HTTP
  headers is not transport normalization. Page-world hooks cannot control the TLS
  ClientHello or HTTP/2 stack/header order. An ordinary pass-through VPN/SOCKS/CONNECT proxy does not
  replace the browser's TLS handshake. No proxy, CA trust or certificate-validation changes are
  made; see [the transport boundary](docs/coverage.md#tls--http-no-implementation-in-this-layer).

---

## Layout

```
manifest.json                 MV3, Firefox event page (not a service worker)
rules/adnets.json             declarativeNetRequest blocklist
src/inject.js                 MAIN world, document_start — all API patches
src/bridge.js                 ISOLATED world — the only link to browser.*
src/background.js             settings, API allowlist, network-policy lifecycle, badge
src/lockdown.js               pure global DNR/CSP policy definitions (extension pages only)
src/popup.html|js             per-page activity + pause toggle
src/options.html|js           feature switches
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
package/                      built .zip
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