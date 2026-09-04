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
</p>

---

Ad blockers work at the **network layer** — they stop a request being made. This works at the
**API layer** — it changes what a script is able to read once it is already running.

That gap is not theoretical. It came out of a live teardown of a YouTube-converter site whose
deobfuscated PropellerAds SDK was found reading GPU model, battery level, screen geometry,
timezone and window position through ordinary DOM calls — none of which an ad blocker can prevent
once the script has loaded. This extension targets exactly those surfaces.

**Status:** `web-ext lint` → 0 errors, 0 warnings, 0 notices. Packaged at
`package/fingerprint_damper-1.0.0.zip`.

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

**4. Anything that breaks sites is opt-in.** Timezone and language spoofing are off by default and
carry a warning in the settings UI.

---

## What it does

### On by default (low breakage risk)

| Protection | Behaviour |
|---|---|
| Canvas noise | Flips the low bit of 32 pixels on `toDataURL` / `toBlob` / `getImageData`. Measured impact: **0.17% of subpixels, max delta 1/255** — invisible. O(32) regardless of canvas size, so no game-loop tax. Canvases over 4 MP are skipped. |
| GPU masking | `UNMASKED_RENDERER_WEBGL` / `UNMASKED_VENDOR_WEBGL` → `Mozilla`. This was the single highest-entropy item the SDK collected. |
| Audio noise | ~32 samples perturbed by 1e-7 in `AudioBuffer.getChannelData` and `AnalyserNode`. Inaudible. A `WeakSet` prevents repeated reads from accumulating drift. |
| Window geometry | `screenX`/`screenY` → 0, `outerWidth/Height` → inner, `availWidth/Height` → full, colour depth → 24. Leaks OS, theme, toolbar count and monitor layout; needed by nothing. |
| CPU cores | `hardwareConcurrency` → 8. |
| Battery | `getBattery()` → always full and charging. Level plus discharge time is a startlingly good short-term cross-site correlator. |
| Push guard | `Notification.requestPermission()` resolves `"default"` with **no dialog**; service workers matching known ad patterns are refused. |
| Network block | DNR rules for `9hito.com`, `zdzhk.com`, `kbvcd.com`, `rtmark.net`, `dulotadtor.com`, `abunownon.com`, `dawac.com`, `10zon.com`, `kocmg.com`, `blxwnnw.com`. |

Note `requestPermission` returns `"default"`, not `"denied"`. "Denied" is a sticky, distinguishable
state; "default" reads as *the user dismissed it*, which is both commonplace and unremarkable.

Also note the blocklist **excludes `etacloud.org` and `tubeapi.org`** — those are the actual
conversion backend. Blocking them would break the site's real function. The ad layer is cut; the
feature keeps working. That's the "doesn't hurt UX" line.

### Opt-in (off by default)

Force UTC timezone, force `en-US` language. Both break real things — calendars, bookings, delivery
estimates, localisation.

---

## Install

Not signed, so pick one:

**Temporary (survives until restart, no config change):**
1. `about:debugging#/runtime/this-firefox`
2. *Load Temporary Add-on…*
3. Select `manifest.json` in this folder.

**Permanent:** requires Firefox Developer Edition, Nightly, or ESR. Set
`xpinstall.signatures.required` to `false` in `about:config`, then install
`package/fingerprint_damper-1.0.0.zip` from `about:addons` → gear → *Install Add-on From File*.
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

---

## Using it

Toolbar badge shows how many fingerprint reads were intercepted on the current page. Click for a
breakdown and a **Pause on this site** button (per-origin, persists, reloads the tab).

If a site misbehaves, pause it there rather than disabling a protection globally.

---

## Honest limitations

- **Startup race.** The page-world script can't read `browser.storage`, so it applies protective
  defaults instantly at `document_start` and reconciles with your real settings a few ms later via
  `bridge.js`. Consequence: on an allowlisted site, protections are briefly live before being
  restored. Harmless in practice — fingerprinting scripts run well after this — but it is a real
  seam, not something I'm papering over.
- **The extension is detectable.** Any extension that patches page APIs is. `Function.prototype.toString`
  is cloaked so patched functions still report `[native code]`, but a determined script can detect
  the behaviour change. The goal here is to make you *non-unique*, not invisible.
- **The stats channel adds detectability.** Counting activity for the popup needs a page-visible
  event channel. Turn off *Count activity* in settings for a quieter profile.
- **Not a substitute for Tor Browser or full `resistFingerprinting`.** Those give a far larger
  anonymity set at a far higher usability cost. If you want the strongest available option in
  Firefox itself, `privacy.resistFingerprinting` exists — it will break more, and this extension
  is largely redundant alongside it.
- **Fonts, `Intl` locale data, and TLS/HTTP-level fingerprinting are untouched.**

---

## Layout

```
manifest.json                 MV3, Firefox event page (not a service worker)
rules/adnets.json             declarativeNetRequest blocklist
src/inject.js                 MAIN world, document_start — all API patches
src/bridge.js                 ISOLATED world — the only link to browser.*
src/background.js             settings, allowlist, session salt, badge
src/popup.html|js             per-page activity + pause toggle
src/options.html|js           feature switches
test/selftest.html|js         before/after verification page
package/                      built .zip
```

`inject.js` keeps every original descriptor in a `restore[]` array, so allowlisting genuinely hands
the site its real browser back rather than layering more lies on top.
