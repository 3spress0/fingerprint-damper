# Verification

## Automated, dependency-free regressions

Run from the repository checkout with Node.js 18+ (standard full-ICU builds).
Node test files and the Node HTTP fixture server are excluded from the packaged extension zip:

```sh
node --test test/*.test.cjs
LANG=nl_NL.UTF-8 TZ=Europe/Amsterdam node --test test/*.test.cjs
LANG=tr_TR.UTF-8 TZ=Europe/Istanbul node --test test/*.test.cjs
```

The tests isolate installations in VMs. Canvas/geometry and passive browser APIs
use DOM doubles; locale/Math tests use the real Node implementations. Coverage
includes deterministic seeds, noise budgets, native containers, live settings,
restoration, explicit locale choices, permission/native-request separation, promise
errors, Math rounding/ties/special values, and argument/constructor semantics.
Math is also checked alongside canvas, rect and locale protection.

Worker-driver tests cover unsupported APIs, origin/CSP-style failures, timeouts,
late replies and resource cleanup. Isolated Node workers exercise the diagnostic
entry scripts' bootstrap/protocol; these are **not** tests of Firefox's worker
loader, CSP, GPU, permissions or SharedWorker lifecycle. Font-probe mocks likewise
do not prove which local fonts a browser exposes.

The lockdown tests cover all 256 switch combinations, global rule scope, server-CSP
append semantics, migration/restart, serialized saves, persistence/rollback failures,
UI consent/recovery and the local HTTP fixture. These use mocked extension APIs and
a simplified rule matcher: **not native DNR/CSP or sandbox validation**.

## Real browser regression fixture

1. **Disable the installed extension** so native references have not already been patched.
2. Open `test/browser-regression.html` directly in Firefox 142+.
3. The page captures native references, loads `src/inject.js`, and runs automatically.
4. All checks should pass. Repeat in a non-English browser profile, preferably
   with a non-UTC time zone. Reload to rerun; the final test restores the native APIs.

This checks native rect/list behavior, locale formatting, passive masking, Math
results and restoration. Unsupported/rejected passive APIs are labelled as skipped,
not successful protection. No automatic capture, speech playback or permission
requests are made. The window checks can run from a file without dependencies;
the worker audit may need HTTP (see below).

It does **not** certify MAIN/ISOLATED-world delivery, the startup race, actual
permission grants, real calling/accessibility applications, or complete resistance
to fingerprinting. Run these browser checks before declaring a build browser-verified.

## Extension integration / compatibility checks

With the extension loaded from `manifest.json` and **all global lockdown switches off**,
use `test/selftest.html` instead:

- Record an extension-off baseline, then enable it and compare.
- Enable **Damp client rects** separately. Element/Range hashes should change from
  the baseline but remain stable for the same layout, origin, day, and session salt.
  Resizing or changing fonts/layout can legitimately change the hashes.
- Enable **Default to en-US language / locale**. Check actual number, date and casing
  output, not only reported locale strings. The explicit `de-DE` example must stay
  German. A native formatter may report `en` instead of `en-US` for the same request.
- Enable **Default to UTC timezone**. Default date formatting must actually use UTC,
  not just report it in `resolvedOptions()`. Explicit time zones remain unchanged.
- Disable each setting and repeat. Pause API patches on the HTTP site and reload to verify restoration.
  API pause does not exempt a site from global DNR rules.
  Cached formatters and previously returned snapshots do not change retroactively.
- Enable voice/device hiding separately. The corresponding lists should be empty,
  while permission queries/capture/playback remain independent. A native empty list
  alone does not demonstrate protection. Check actual voice/device pickers manually
  before relying on these options for a site; the automated fixture never captures
  media or speaks.
- Enable passive permission-state masking. Supported state reads should report
  `prompt` and `Notification.permission` should report `default`. Unsupported query
  rejections must remain rejections, and actual browser permission grants must not change.
- The **notification request button** is the only notification request in the self-test.
  Clicking it may prompt when Push guard is off. With Push guard on it should return
  `default` without prompting. Passive state masking must not manufacture a grant or
  override an explicit native request result when Push guard is off.
- Enable experimental Math rounding and compare the hash; repeated reads should
  remain stable. Native Math identity/results should return when it is disabled.
  Do not treat this as a conformance or numerical-accuracy guarantee for applications.
- Check real positioning/selection consumers (tooltips, menus, editors, charts) before
  relying on ClientRects damping for a site. It is intentionally off by default.

## Window / worker comparison

Both browser pages include the same passive probe in the window plus fresh dedicated
classic, dedicated module and shared-classic workers. Results stay in the page; no
remote collector is contacted, no service workers are registered, and no worklets
are loaded. Dedicated workers are terminated and shared ports closed after reply,
error or timeout. The worker entry also closes its own short-lived scope.

File-origin policy or CSP may reject workers. If needed, run this **on your own
machine** from the repository root, bound to loopback only:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8000/test/selftest.html` or
`http://127.0.0.1:8000/test/browser-regression.html`. Do not expose the repository's
HTTP server to the internet. No server is started by the diagnostic scripts.

With window controls enabled, compare Math/canvas hashes, GPU, locale, core count,
font-set capability checks and whichever passive APIs a worker exposes. Workers
are deliberately **not API-patched**. Lockdown may deny new workers on covered HTTP
pages; this is different from normalizing worker APIs. Equal values, absent APIs, errors and timeouts
are not evidence of protection. The report omits raw voice names/device IDs and
summarizes enumerated device kinds/counts instead.

## Global lockdown HTTP integration

**Native Firefox checks have not been run in the development sandbox.** Use a fresh
Firefox 142+ test profile with no service workers/site data and the installed
extension. Keep other extensions out of this baseline. Browser testing is necessary
before describing the lockdown layer as browser-verified.

On your own machine, from this checkout:

```sh
node test/lockdown-server.cjs
```

Open `http://127.0.0.1:8765/`. The default server binds to loopback and serves only
fixed test routes, not repository files. Stop with Ctrl-C. For an explicitly exposed
development preview, `HOST=0.0.0.0 PORT=8765` changes its bind; browser code uses only
relative URLs. Do not expose it unnecessarily.

The fixture does **not** emulate the extension. It serves an original CSP, static
script markers, classic/module/shared/blob workers, a frame, image/stylesheet,
fetch/beacon and a deliberately rejected WebSocket handshake. `/events` reports
bounded, in-memory observations with header-presence booleans, never raw identifiers.
No service worker is registered and no grants, capture or playback are requested.
An explicit link primes only `__fpd_lockdown_probe=1`, a fake local session cookie.

Check each switch alone, then the combined maximum preset; bypass cache on reload:

| Check | Expected observation (not a complete security proof) |
|---|---|
| All lockdown off | Both inline/external script markers run; supported workers reply; server sees secondary requests. Record baseline failures rather than assuming support. |
| Preserve server CSP | The original `script-src-attr 'none'` must remain in response headers. With only worker denial enabled, the attribute control must say the original restriction is intact, never “SERVER CSP WAS LOST.” |
| Script denial | Inline/external markers stay at DID NOT RUN; confirm the added enforcing CSP in the main document response. This is not a passing JS-driven self-test. |
| Sandbox | Inspect the appended bare `sandbox`, without any allow tokens. Forms/popups/downloads must not escape. In developer tools, check opaque-origin/storage restrictions. Disabling rules doesn't release the already loaded document. |
| New workers | Classic, module, shared and blob workers that succeeded at baseline should be denied. Inspect policy violations, not just generic worker errors. Existing workers/service workers are a separate gap. |
| Embeds | Covered frame/object loads denied. Initial empty frames are not claimed to be forbidden. |
| Connection denial | Compare server events: no fetch/beacon/socket attempts from covered loads. A socket error alone proves nothing because the fixture intentionally rejects baseline handshakes too. |
| Secondary-request seal | Only initial/top-level visits remain in this fixture's server events; no image, CSS, frame, script or API requests. Verify policy headers even if the page looks empty. |
| Cookie stripping | Prime with locks off, enable cookie stripping, reload. Server `probeCookie` should be false; incoming Set-Cookie should be removed. With JS still allowed, the old fake cookie can remain JS-visible—this switch doesn't erase it. |
| Header removal | Compare actual request headers/server-presence booleans for UA, language and referrer. Origin/auth/security headers must not be removed. No claim of TLS/header-order normalization. |
| API pause | Global rules remain active on the paused HTTP origin. UI wording must not suggest otherwise. |
| Emergency off | Disable all lockdown in popup/Settings; reload bypassing cache. Original baseline behavior returns on fresh documents. Other API/ad-network preferences remain unchanged; no tabs auto-reload. |
| Restart/update | Selected lockdown settings/rules persist and reconcile. Fresh/default installations must not silently enable any lockdown. |

Service-worker registration/worklet tests, inherited-policy/blob/data cases, cached
responses, BFCache, private windows, restricted domains, revoked host access and
cross-extension header conflicts still need careful native testing. Do not register
or remove service workers in a real working profile merely for this fixture. Existing
contexts, WebRTC/other non-DNR traffic and data are not retroactively isolated.

For failures, inspect the popup/Settings error first. “Configured rules” is not a
match counter or an enforcement certificate. See [limits and recovery](../docs/lockdown.md).

## Reading the font audit

`font-probes.js` performs only local probes, never registers its faces in
`document.fonts`, and sends no results anywhere. It tries a small cross-platform
candidate list plus an intentionally nonexistent family.

Expected interpretation:

| Probe | Meaning |
|---|---|
| `document.fonts.check()` for the missing family returns `true` | Normal. It is not an installed-font oracle: nonexistent families can return `true`. [1](https://developer.mozilla.org/en-US/docs/Web/API/FontFaceSet/check) |
| `new FontFace(alias, 'local("candidate")').load()` succeeds | That local face is available to this page under the browser's current policy. This extension does not mask it. |
| A local load rejects | Absent **or** blocked/hidden by the browser. Not proof of extension protection. |
| Iterating `document.fonts` | Lists document-managed faces, not the full installed system-font list. |

The candidate list is a diagnostic, not exhaustive enumeration. CSS `local()` and
ordinary font fallback/selection remain unmodified. Tiny `measureText()` and rect
jitter change exact hashes but do not reliably stop font identification: tolerant
comparisons, rounding and other layout APIs remain available.

## Deliberate gaps

- Dedicated/shared/service workers and worklets run in other globals and are not
  patched. This applies to whichever relevant APIs each global actually exposes,
  not just worker-side OffscreenCanvas. There is no worker constructor shim. The new
  default-off lockdown tier can block new worker execution on covered documents;
  it does not normalize APIs in workers that run.
- Default locale normalisation does not standardise ICU/CLDR data, supported locale
  lists, `Intl.Locale`, explicit supported locales, or native local-time Date APIs.
- Voice/device hiding does not retract cached objects, suppress native event timing,
  or block capture/playback. Permission-state masking does not change grants,
  support/error probing, change events, or explicit native request outcomes.
- Math rounding is a bounded loss of precision, not a portable Math implementation.
  Arithmetic, WebAssembly, other globals and rounding-boundary differences remain.
- Selected HTTP headers can be removed by opt-in lockdown, but TLS/HTTP-stack
  fingerprints are not normalized. No proxy or certificate trust changes are made. See [coverage and trust boundaries](../docs/coverage.md).
- Browser-level/network fingerprints and adversarial bypasses are not certified by
  a passing regression suite. A browser-native privacy mode has a different scope.
