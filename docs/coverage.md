# Coverage and trust boundaries

The opt-in API controls described below are **off by default**; this document also records
compatibility/trust boundaries for default protections where implementation details matter. These
controls reduce specific page-visible observations; they do not establish an undetectable browser
persona or replace browser-level privacy policies. They add no extension permissions and make no
proxy, certificate, capture or grant changes. Page-world configuration/statistics channels are
observable and configuration events can be spoofed by hostile page code. These hooks are not a
tamper-proof security boundary.

## Battery API compatibility and limits

When `navigator.getBattery()` is available, the default battery control still invokes the native
method first. This preserves native receiver validation and a browser's real rejection path rather
than inventing an `"unavailable"` error. If all four configurable `BatteryManager` value getters are
available, the returned native manager keeps its identity and `EventTarget` behavior while
`charging`, `chargingTime`, `dischargingTime`, and `level` read as full/charging values. The control
checks its setting again when the native promise settles, so a live disable can return the native
manager instead.

An unusual partial Battery API falls back to one stable plain manager-shaped value after a successful
native promise rather than leaking a partially masked manager. This fallback is less compatible and
is deliberately not presented as a native object. In either implementation, existing native getter
references, battery-event timing, early page code, and any unpatched realm remain potential signals.
With the battery setting disabled, `getBattery()` returns the exact native promise/result.

## Passive window APIs

| Control | What changes | What does not change / compatibility cost |
|---|---|---|
| Hide speech voice list | `SpeechSynthesis.getVoices()` returns a fresh empty array after the native receiver check. | No synthetic voice objects. `speak()` and already obtained voice objects remain native. `voiceschanged` timing remains visible. Voice pickers and some accessibility flows may break. |
| Hide media device list | Successful `enumerateDevices()` calls return an empty array, hiding the enumerated labels, counts, IDs and groups. Live settings are checked when the promise fulfills. | Native rejections are preserved. No device objects/IDs are fabricated. `getUserMedia()`, `selectAudioOutput()`, device-change events and track labels/settings remain native. Device pickers may break; this is **not capture blocking**. |
| Mask passive permission states | Native `PermissionStatus.state` getters return `prompt`; `Notification.permission` returns `default`. | `permissions.query()` itself, its validation/support errors, native status objects and change events remain intact. Grants and explicit request results stay real. Sites may show redundant permission UI or disable features despite a real grant. |

A permission-query rejection does not become a fake `prompt`. API support, event
timing and actual permission-using operations can still reveal information. Query
masking does not grant, revoke, dismiss or request a permission. Notification
**request interception** is the separate Push guard control: when disabled, real
request behavior is restored, including its return value and legacy callback.

Previously returned voice/device lists remain readable. Early page code can also
read opt-in surfaces before settings reach the page-world script. Pause/reload and
cached-object limitations still apply; these controls are not an atomic browser policy.

## WebGL, hardware capacity and WebRTC boundaries

The default WebGL control keeps the native call path first for receiver/error behavior, then
normalizes vendor, renderer and matching version strings. It withholds
`WEBGL_debug_renderer_info` both from `getExtension()` and from
`getSupportedExtensions()`. Standard RGBA/`UNSIGNED_BYTE` `readPixels()` calls made with a
byte view receive the same bounded, stable RGB low-bit changes as canvas reads; alpha is left
alone. Float/integer formats, unusual views, pixel-pack-buffer offset paths, shader precision,
limits, non-debug extensions and all worker WebGL stay native. This is hash damping, not a
complete GPU persona or graphics sandbox.

The default hardware-capacity control reports 8 for `navigator.hardwareConcurrency` and, only
when the browser already has a configurable `Navigator.prototype.deviceMemory` getter, reports
8 there too. It never adds `deviceMemory` to Firefox or changes worker navigators. Native getter
receiver errors still occur before a value is masked; disabling/allowlisting restores native
values/descriptors.

WebRTC address filtering is an opt-in page-world compatibility layer. It withholds host,
server-reflexive and peer-reflexive candidates from `icecandidate` listeners/property handlers,
`createOffer()`/`createAnswer()` results, `setLocalDescription()` input, and local-description
getters. It leaves relay/TURN candidates available. While enabled, `getStats()` resolves to a
new `Map` whose local-candidate values retain non-address metadata but neutralize modern and
legacy address/port fields; this deliberately changes the native report identity. Remote
candidate records, connection timing, broader WebRTC operations, existing references, early page
code, other realms and browser transport are not controlled. A page can still detect or replace
these hooks, so this is not equivalent to browser-enforced relay-only ICE policy.

## Experimental Math rounding

When enabled, these Math functions use their native implementation and then round
eligible results to 40 stored fraction bits (41 significant bits for normal doubles):

```
acos acosh asin asinh atan atanh atan2
cos cosh exp expm1 log log1p log2 log10
sin sinh tan tanh pow sqrt cbrt hypot
```

The last 12 fraction bits are rounded to nearest, ties to even. For an eligible
result, the added relative error versus the native result is at most approximately
`2^-41` (`4.55e-13`). NaN, infinities, signed zero, integer results and subnormals are
left unchanged. Arguments are still coerced by the native function, once; native
errors and non-constructibility remain intact. The rounding is deterministic and
uniform, not per-call/origin random noise.

**This is reduced precision, not a faithful cross-engine Math implementation.** It
can change exact identities (for example a trigonometric result compared with
`Math.PI`), cross a rounding boundary, or accumulate error in numerical algorithms.
It may itself be fingerprintable. Close results can land in different rounding
buckets, so cross-engine fingerprints are not guaranteed to converge.

Arithmetic operators (including `**`), Math constants, `random`, integer/rounding
helpers, WebAssembly and unpatched globals remain native. Native Math function
identities are preserved until the option is enabled, avoiding disabled-by-default
wrappers around hot JIT intrinsics. Turning it off restores the original descriptors;
allowlisting also retires cached rounding wrappers until reload.

## Default worker policy: preserve execution, diagnose the gap

No production Worker/SharedWorker constructor or worker response is rewritten.
The diagnostic fixtures use the same passive probes in the window and in fresh,
short-lived workers; they do **not** inject `src/inject.js` into those workers.
The separate [global lockdown](lockdown.md) can opt in to browser-enforced denial
of new worker execution on covered documents. This is not worker API normalization;
the table below describes workers that are allowed to run (including existing workers).

| Global | Current coverage | Diagnostic coverage |
|---|---|---|
| Dedicated classic worker | Native/unprotected | Local classic-worker fixture |
| Dedicated module worker | Native/unprotected | Local module entry and imports |
| Shared classic worker | Native/unprotected | Uniquely named shared worker; ports closed after the reply |
| Shared module worker | Native/unprotected | Not exercised by the current driver |
| Service worker | Existing Push guard rejects known ad registration URLs only; worker APIs and existing registrations are otherwise untouched | Not registered or unregistered by diagnostics, to avoid persistent changes |
| Worklets | Native/unprotected | Not loaded by diagnostics |

The probes compare Math, locale, core count, OffscreenCanvas/WebGL and whatever
font/passive APIs a global actually exposes. Not all window APIs exist in workers.
The font-set check is a capability/loading probe, not installed-font enumeration.
Equal values, missing APIs, load errors and timeouts **never prove protection**.
Raw device IDs and voice names are not included in the diagnostic report. Results
stay in the local page/worker message channel; no remote collector is used.

A production bootstrap would need to preserve CSP/Trusted Types, script URLs,
relative imports and `import.meta.url`, module dependency evaluation order,
credentials, message ordering, transferable ownership, and shared-worker identity.
Rewriting responses would require a new network interception design/permissions
and careful handling of caching and policy. Existing service workers/worklets also
cannot be retroactively patched by wrapping a window constructor. No CSP is relaxed
and default behavior does not block workers just to claim transparent coverage.
Opt-in lockdown explicitly trades execution for restrictions, with substantial breakage.

## TLS / HTTP: no implementation in this layer

Page-world API patches cannot select the browser's TLS ClientHello, ALPN, JA3/JA4
inputs, HTTP/2 settings or exact header serialization/order. This extension's DNR
rules can block requests and the new lockdown controls can remove selected cookie/identity
headers. They do not standardize the transport stack. Changing a few header values
is not equivalent to controlling the network stack.

For HTTPS, an ordinary pass-through VPN, SOCKS proxy or CONNECT tunnel generally
still forwards the browser's TLS handshake. A TLS-terminating relay with a different
outbound stack is a different trust boundary, potentially able to read traffic;
interception may require explicit certificate trust changes. Such a system needs
its own threat model, consent and deployment. This extension does not install a
proxy, trust a CA, weaken certificate validation, or expose a no-op TLS switch.

## Stable persona: what "consistency" means in practice

Values derive from a seed of `origin + date + session salt`, so a site sees one stable persona
per browser session. Per-call randomness would break image editors/audio tools and is itself a
loud, unique signal. Observed behaviour:

```
site A, reload 1       806dd20d
site A, reload 2       806dd20d   <- stable, as intended
site B, same session   b8589a2d   <- this damped value differs across origins
site A, next session   18a9f38d   <- rotates, long-term linking through this surface reduced
real canvas            ada5b8c5
```

## Protection behaviour in detail

### On by default (low breakage risk)

| Protection | Behaviour |
|---|---|
| Canvas / text metric noise | Up to 32 RGB low-bit flips on pixel readback/serialization (max channel delta 1/255), including main-thread `OffscreenCanvas`. The noise step is O(32); serialization needs a copy and skips canvases over 4 MP. `measureText()` fields get stable <0.01px jitter. This changes exact hashes, not reliable font-availability tests. |
| WebGL identity / readback | Vendor, renderer and matching version strings → `Mozilla` / `WebGL 1.0` or `2.0`; `WEBGL_debug_renderer_info` is hidden. Standard RGBA/UNSIGNED_BYTE `readPixels()` receives stable, low-bit RGB noise. Other WebGL capabilities, shader behavior, non-byte formats and PBO readback remain native. |
| Hardware capacity | `hardwareConcurrency` → 8 and, only if the browser already exposes it, `deviceMemory` → 8. No API is invented; worker navigators remain native. |
| Battery | `getBattery()` reports full and charging while keeping the native `BatteryManager` shell when its getters are patchable; native failures remain failures. Level plus discharge time is a startlingly good short-term cross-site correlator. |

### Opt-in (off by default since v1.2.0)

| Protection | Behaviour and trade-off |
|---|---|
| Count activity for the popup | Toolbar badge counts intercepted reads. Off by default for a quieter profile: it needs a page-visible event channel, which slightly increases detectability. |
| Audio noise | ~32 samples perturbed by 1e-7 in `AudioBuffer.getChannelData` and `AnalyserNode`. That array is the buffer's real backing store, so audio apps that read or export those samples see tiny drift. Inaudible; defeats AudioContext hashing. Off by default for that reason. |
| Window geometry | `screenX`/`screenY` → 0, `outerWidth/Height` → inner, `availWidth/Height` → full, colour depth → 24. Leaks OS, theme, toolbar count and monitor layout; needed by nothing. |
| Block notification permission prompts | `Notification.requestPermission()` resolves `"default"` with **no dialog** — but only for requests that do not follow transient user activation; requests made right after a deliberate click still prompt normally. `"default"` reads as *the user dismissed it*, which is commonplace and unremarkable. |
| Block ad service workers (experimental) | Rejects service-worker registrations whose host labels or script path match known ad-SDK patterns. Boundary-aware matching (host labels / path tokens), never raw substring tests. Pattern matching can hit unrelated apps — use the per-site pause as a bypass. |
| Network block | Static DNR blocks 78 known ad/push-network request domains: 10 original teardown hosts plus 68 unique entries from nine public [LanikSJ/ubo-filters](https://github.com/LanikSJ/ubo-filters) lists (MIT; four overlap). Source-derived domains apply only to third-party requests; provenance in [rules/NOTICE.md](../rules/NOTICE.md). Ships disabled; excludes `etacloud.org` and `tubeapi.org` (the actual conversion backend in the y2mate teardown). |
| Hide speech voice list | `getVoices()` returns an empty array. Native default speech remains available, but voice pickers and some accessibility flows may break. No fake voices are created. |
| Hide media device list | Successful `enumerateDevices()` calls return an empty array, hiding enumerated labels, counts and IDs. Native errors and capture APIs remain unchanged. Camera/microphone/speaker pickers may break; this does **not** block capture. |
| Mask passive permission states | Native `PermissionStatus.state` reads report `prompt`; `Notification.permission` reports `default`. Real grants, explicit request results, query support/errors and events stay native. Sites may show redundant permission UI or disable features. |
| Reduce Math precision (experimental) | Rounds 12 low fraction bits of eligible transcendental/root/power results (added relative error roughly at most 4.55e-13). Special values, integers and subnormals stay native. Can break exact identities or numerical code; not a faithful or complete cross-engine Math replacement. Native Math functions are left untouched until opted in. |
| ClientRects damping | Stable sub-pixel changes to `Element` and `Range` `getBoundingClientRect()` / `getClientRects()`. Native `DOMRect`/`DOMRectList` objects, zero dimensions, and bounding/fragment relationships are preserved (within floating-point precision). No DOM layout is changed, but callers using these measurements for positioning, selection or hit-testing may break. |
| Default to `en-US` language / locale | Sets navigator language and normalises default locale selection in available `Intl` formatters, numeric/date `toLocale*` methods, string collation and locale-sensitive casing. Supported explicit locale choices and Unicode extensions remain native; empty/unsupported requests fall back to `en-US`. Sites may stop showing your language. |
| Default to UTC timezone | Uses UTC for default `Intl.DateTimeFormat` and date `toLocale*` formatting, plus zero timezone offsets. Output and `resolvedOptions()` agree. Explicit time zones remain native. Can break calendars, bookings and delivery estimates; other local-time `Date` APIs are not masked. |
| WebRTC address filtering | Withholds host, server-reflexive and peer-reflexive ICE candidates from events, SDP creation/local-description reads and local candidate stats; relay (TURN) paths stay available. While enabled, `getStats()` resolves to a map-shaped sanitized copy. May break peer-to-peer applications without TURN and changes diagnostics. |

Locale/timezone settings affect **new formatters** and subsequent `toLocale*` calls.
Already-created formatter objects and already-returned measurement snapshots keep their values;
reload after a settings change to clear a site's cached objects. These controls reduce particular
observations, not all ways of inferring a machine's fonts, locale, or time zone. Previously
returned voice/device lists remain readable too. TLS/HTTP-stack normalization remains out of
scope; selected HTTP headers can be removed with the separate [lockdown tier](lockdown.md).

## Detailed limitations

- **Installed-font availability is not hidden.** `FontFace`/CSS `local()` loading and ordinary
  font selection remain native. `document.fonts` iterates document-managed faces, not the whole
  installed-font list; `check()` can return `true` for nonexistent families, so it is not itself
  an installed-font oracle. [MDN: FontFaceSet.check](https://developer.mozilla.org/en-US/docs/Web/API/FontFaceSet/check)
  Tiny text-metric/ClientRects jitter changes exact hashes, but rounding, tolerance-based probes,
  and other layout measurements can still identify fonts.
- **Intl engine data is not standardised.** The locale option changes default locale selection,
  not ICU/CLDR versions, `Intl.Locale`, static capability queries or results for supported
  explicit locales. Native local-time `Date` methods such as `toString()` and `getHours()` can
  still reveal the time zone even when the UTC option is on.
- **Worker and worklet globals are unprotected.** Content scripts run in window realms, not
  dedicated/shared/service workers or worklets. Any relevant API exposed in those globals — for
  example OffscreenCanvas/WebGL, worker font APIs, Intl or worker navigator fields — bypasses the
  window patches. The opt-in CSP worker/script lockdown blocks can deny new workers on covered
  documents; they do not normalize worker APIs or stop existing workers. Broader coverage needs a
  different architecture or browser-level protections, not another window-prototype patch.
- **Passive masking is not capability control.** Voice/device lists can be hidden, but cached
  objects, native change-event timing, real capture/track APIs and explicit permission outcomes
  remain available. Permission support/errors remain observable. The notification guard controls
  notification requests independently from passive permission-state masking.
- **Battery masking is value masking, not battery isolation.** Where the browser exposes patchable
  `BatteryManager` getters, the native manager identity/events remain so compatibility is
  preserved; event timing and saved native getters can still reveal changes. Native rejections
  stay rejections. With the battery switch off, `getBattery()` returns its native result.
- **WebGL and capacity masking are partial.** The standard byte-array `readPixels()` path is
  damped, but shader precision, limits, extensions other than debug-renderer info, non-byte/PBO
  readback and worker/OffscreenCanvas WebGL remain native. `deviceMemory` is masked only when it
  already exists; no worker navigator is altered.
- **WebRTC filtering is page-world compatibility masking, not transport isolation.** It cannot
  retract an address exposed before injection or through a saved native reference, block browser
  transport itself, or make latency/network characteristics anonymous. Remote candidates and the
  broader WebRTC API remain native.
- **Math rounding is experimental, not engine standardisation.** Exact identities and numerical
  algorithms can change. Arithmetic operators, WebAssembly, unpatched globals and
  rounding-boundary differences remain available to probes.
- **Cache lockdown is not storage cleanup or a service-worker bypass.** It removes validators and
  sets `Cache-Control: no-store` only on eligible responses after the rule is active. Existing
  HTTP cache entries, BFCache, service-worker caches and URL identifiers remain outside its
  control.
- **TLS/HTTP-stack fingerprinting remains outside scope.** Optional removal of selected HTTP
  headers is not transport normalization; see [the transport boundary](#tls--http-no-implementation-in-this-layer).
