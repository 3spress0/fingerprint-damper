<p align="center">
  <img src="icons/icon.svg" alt="Fingerprint Damper logo" width="80" height="80">
</p>

<h1 align="center">Fingerprint Damper</h1>

<p align="center">
  <em>API-level fingerprint damping for Firefox.<br>Stable, deterministic damping rather than per-call randomization.</em>
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

## Purpose

Ad blockers work at the **network layer** — they stop a request being made. This works at the
**API layer** — it changes what a script reads once it is running. That gap is not theoretical:
it came out of a live teardown of a YouTube-converter site whose deobfuscated PropellerAds SDK
read GPU model, battery level, screen geometry, timezone and window position through ordinary DOM
calls — none of which an ad blocker can prevent once the script has loaded.

This reduces passive fingerprinting by ordinary scripts. The page-level wrappers are detectable
and can be bypassed or switched to pass-through by adversarial page code — see
[Main limitations](#main-limitations). A separate, **default-off global lockdown tier** uses
browser-enforced network/CSP rules instead of spoofed values.

| Layer | Tool | Job |
|---|---|---|
| Network | uBlock Origin | Blocks known ad/tracker requests from a curated list |
| Network | Privacy Badger | Heuristically learns third parties that track across sites |
| **API** | **this** | **Changes what a script that got through is able to read** |

**Design rules:** (1) one stable persona per origin per day — per-call randomness is itself a
signal; (2) blend into the biggest crowd rather than inventing unique fake values; (3) leave
bot-detection surfaces like `navigator.plugins` alone — emptying them flags you; (4) anything with
real breakage risk is opt-in. Full rationale and per-surface detail:
[docs/coverage.md](docs/coverage.md).

---

## Default protections (on by default)

| Protection | Behaviour |
|---|---|
| Canvas / text metric noise | Up to 32 RGB low-bit flips on pixel readback/serialization, plus stable <0.01px `measureText()` jitter, including main-thread `OffscreenCanvas`. Changes exact hashes, not reliable font-availability tests. |
| WebGL identity / readback | Vendor/renderer/version → `Mozilla` / matching WebGL version; `WEBGL_debug_renderer_info` hidden; stable low-bit noise on standard byte `readPixels()`. Other capability surfaces remain native. |
| Hardware capacity | `hardwareConcurrency` → 8 and, only where already exposed, `deviceMemory` → 8. No API is invented. |
| Battery | `getBattery()` reports full and charging while keeping the native `BatteryManager` shell. |

## Optional protections (off by default)

Everything below must be switched on explicitly in Settings; each carries a breakage warning.

| Protection | One-line trade-off |
|---|---|
| Count activity for the popup | Toolbar badge counts. Adds a page-visible event channel; slightly easier to detect. Off by default for a quieter profile. |
| Audio noise | Perturbs ~32 samples (1e-7) in `AudioBuffer.getChannelData`/`AnalyserNode`. Touches the buffer's real backing store; inaudible, but audio apps see tiny drift. |
| Window geometry | Zeroes window position, flattens colour depth, outer = inner size. |
| Block notification permission prompts | Unsolicited `requestPermission()` resolves `"default"` (dismissed); requests after a deliberate click still prompt. |
| Block ad service workers (experimental) | Boundary-aware host/path pattern blocks on `ServiceWorkerContainer.register()`. Can hit unrelated apps; per-site pause is the bypass. |
| Network block | Static DNR blocks 78 known ad/push-network domains (third-party-only for source-derived entries). Provenance: [rules/NOTICE.md](rules/NOTICE.md). |
| Hide speech voice list | `getVoices()` returns empty; voice pickers may break. |
| Hide media device list | `enumerateDevices()` returns empty; pickers may break. Does not block capture. |
| Mask passive permission states | `PermissionStatus.state` → `prompt`, `Notification.permission` → `default`. Real grants stay real. |
| Reduce Math precision (experimental) | Rounds 12 low fraction bits of transcendental/root/power results. Can break exact identities. |
| ClientRects damping | Stable sub-pixel noise on `Element`/`Range` rects. Positioning/hit-testing may break. |
| Default to `en-US` language / locale | Normalises default locale selection; explicit locales stay native. Sites may lose your language. |
| Default to UTC timezone | UTC for default date formatting; explicit zones stay native. Calendars/bookings may misdate. |
| WebRTC address filtering | Withholds non-relay ICE candidates from events/SDP/local stats; TURN paths remain. P2P without TURN may fail. |

Per-surface behaviour, caveats and exact boundaries: [docs/coverage.md](docs/coverage.md).

## Global lockdown — experimental, extreme breakage

Nine **default-off** browser-enforced network/CSP kill switches (block scripts, opaque-origin
sandbox, block workers/embeds/connections, text-only loading, strip cookies, disable cache
validators, remove identity headers). They apply globally — including on API-paused sites — are
not an OS sandbox or transport firewall, and make many sites blank or static. Details, limits and
recovery: [docs/lockdown.md](docs/lockdown.md). **Native Firefox validation is pending.**

---

## Install

Requires **Firefox 142+**.

- **Normal permanent installation:** install a Mozilla-signed XPI. Signing is available through
  AMO for either public listing or self-distribution (self-distribution is free and does not
  require a public listing).
- **Unsigned development installation:** Firefox Developer Edition, Nightly, or ESR may permit
  unsigned extensions after setting `xpinstall.signatures.required` to `false` in `about:config`,
  then installing this folder's `manifest.json` or the repo-root `.xpi` via `about:addons` →
  gear → *Install Add-on From File*. This path is intended for development and testing.
- **Temporary** (survives until restart): `about:debugging#/runtime/this-firefox` → *Load
  Temporary Add-on…* → select `manifest.json` in this folder.

## Build and test

```bash
# Regression suite (dependency-free; Node 18+)
node --test test/*.test.cjs

# Build the AMO-ready XPI (stages the shipped file set, runs the AMO gate)
./package.sh            # or: ./package.sh --check  (also runs web-ext lint)
```

Packaging is byte-reproducible: sorted entry order, normalised timestamps
(`SOURCE_DATE_EPOCH` → commit time → fixed epoch), no transpilation/bundling/minification — the
packaged files are the source files. Verify by building twice and comparing `sha256sum`.
Testing methodology and native-browser checklists: [test/README.md](test/README.md).

## Privacy statement

The extension collects and transmits **no data**. Settings and paused-site origins are stored
locally (`storage.local`); the browser-session salt lives in `storage.session`. There are no
analytics, telemetry, remote filter downloads or network calls from the extension itself; the
only network effect is the user-enabled DNR blocking rules. `manifest.json` declares `"data_collection_permissions": {"required": ["none"]}`.

## Using it

- Toolbar badge (opt-in via *Count activity*): intercepted fingerprint reads on the current page.
- Popup: per-page breakdown and **Pause/Resume API patches on this site** (per-origin, persists,
  applies live to open pages). Settings → **Paused sites** manages the same list.
- API pause never disables the network block or global lockdown; those are separate switches.
- If anything breaks a site: pause that origin first; for lockdown, use **Turn off all lockdown**,
  then reload. The UI reports failures rather than claiming success.

## Main limitations

- **Startup race:** the bridge fetches salt/settings/pause state from the background at
  `document_start`; shipped defaults apply until that asynchronous response arrives, so very early
  reads can precede reconciliation. Not an atomic browser policy.
- **Detectable:** wrappers look wrapped; empty lists, rounded Math and behaviour changes can
  identify the extension or a settings combination.
- **Page code can bypass it:** hostile page code can dispatch the config event and switch hooks
  into pass-through mode on its own page (it cannot uninstall hooks, recover saved native
  references, or touch storage/network rules). Damping defeats fingerprinters that don't know
  about the extension, not adversarial page code.
- **Workers are unprotected:** content scripts never run in worker/worklet globals, so
  fingerprinting performed inside a Web Worker (e.g. `OffscreenCanvas`) is not damped.
- **Not Tor Browser / not `resistFingerprinting`:** those give a far larger anonymity set at a far
  higher usability cost.
- Installed fonts, ICU/CLDR data, TLS/HTTP-stack behaviour and cached/saved references are out of
  scope. The complete list: [docs/coverage.md](docs/coverage.md).

## Layout

```
manifest.json                 MV3, Firefox event page (not a service worker)
web-ext-config.cjs            package destination + excludes Node/browser test artifacts
rules/adnets.json             declarativeNetRequest blocklist (ships disabled)
rules/NOTICE.md               public source provenance and license notice
src/inject.js                 MAIN world, document_start — all API patches
src/bridge.js                 ISOLATED world — the only link to browser.*
src/background.js             settings, API allowlist, session salt, network-policy lifecycle, badge
src/lockdown.js               pure global DNR/CSP policy definitions (extension pages only)
src/popup.html|js             per-page activity + pause toggle
src/options.html|js           feature switches and paused-site recovery
test/*                        regression tests, fixtures and verification docs
docs/coverage.md              per-surface coverage, boundaries and limitations
docs/lockdown.md              global kill switches, enforcement limits and recovery
docs/amo-review-notes.md      AMO reviewer notes
package.sh                    reproducible XPI packaging (repo root)
scripts/amocheck.sh           AMO pattern gate + packaged-file allowlist
fingerprint-damper-*.xpi      built XPI (git-ignored)
LICENSE                       GNU GPL v3
```

`inject.js` keeps its wrappers installed for the lifetime of the document. Pausing API patches
sets a pass-through flag, so subsequent calls use the captured native behavior without restoring
page descriptors. Resuming re-arms the existing wrappers. This is separate from global
lockdown/CSP and network rules, which API pausing never disables.

## License

**GNU General Public License v3.0 or later** (`GPL-3.0-or-later`). Full text in [LICENSE](LICENSE).
Strong copyleft, chosen deliberately: anyone may use, study, modify and redistribute this — but
derivatives must ship their source under the same license. A privacy tool whose derivatives can be
closed up is a privacy tool waiting to be quietly turned into its opposite.
