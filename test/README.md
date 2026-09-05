# Verification

## Automated, dependency-free regressions

Run from the repository checkout with Node.js 18+ (standard full-ICU builds).
Node test files are excluded from the packaged extension zip:

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

With the extension loaded from `manifest.json`, use `test/selftest.html` instead:

- Record an extension-off baseline, then enable it and compare.
- Enable **Damp client rects** separately. Element/Range hashes should change from
  the baseline but remain stable for the same layout, origin, day, and session salt.
  Resizing or changing fonts/layout can legitimately change the hashes.
- Enable **Default to en-US language / locale**. Check actual number, date and casing
  output, not only reported locale strings. The explicit `de-DE` example must stay
  German. A native formatter may report `en` instead of `en-US` for the same request.
- Enable **Default to UTC timezone**. Default date formatting must actually use UTC,
  not just report it in `resolvedOptions()`. Explicit time zones remain unchanged.
- Disable each setting and repeat. Pause on the site and reload to verify restoration.
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
are deliberately **unprotected**. Equal values, absent APIs, errors and timeouts
are not evidence of protection. The report omits raw voice names/device IDs and
summarizes enumerated device kinds/counts instead.

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
  not just worker-side OffscreenCanvas. There is no worker constructor shim.
- Default locale normalisation does not standardise ICU/CLDR data, supported locale
  lists, `Intl.Locale`, explicit supported locales, or native local-time Date APIs.
- Voice/device hiding does not retract cached objects, suppress native event timing,
  or block capture/playback. Permission-state masking does not change grants,
  support/error probing, change events, or explicit native request outcomes.
- Math rounding is a bounded loss of precision, not a portable Math implementation.
  Arithmetic, WebAssembly, other globals and rounding-boundary differences remain.
- TLS/HTTP transport fingerprints are not changed. No proxy or certificate trust
  changes are made. See [coverage and trust boundaries](../docs/coverage.md).
- Browser-level/network fingerprints and adversarial bypasses are not certified by
  a passing regression suite. A browser-native privacy mode has a different scope.
