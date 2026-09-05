# Verification

## Automated, dependency-free regressions

Use Node.js 18+ (standard full-ICU builds):

```sh
node --test test/*.test.cjs
LANG=nl_NL.UTF-8 TZ=Europe/Amsterdam node --test test/*.test.cjs
LANG=tr_TR.UTF-8 TZ=Europe/Istanbul node --test test/*.test.cjs
```

The tests isolate each installation in a VM. Canvas and geometry use DOM doubles;
locale tests exercise the real Node Intl implementation, not a mocked formatter.
They cover deterministic seeds, noise budgets, geometry/list relationships, zero
sizes, native output when disabled, restoration, explicit locales/time zones,
constructor/prototype behavior, built-in formatting paths, and argument semantics.
The font diagnostic has separate tests; those do not verify which fonts a real
browser makes available.

## Real browser regression fixture

1. **Disable the installed extension** so native references have not already been patched.
2. Open `test/browser-regression.html` directly in Firefox 142+.
3. The page captures native references, loads `src/inject.js`, and runs automatically.
4. All checks should pass. Repeat in a non-English browser profile, preferably
   with a non-UTC time zone. Reload to rerun; the final test restores the native APIs.

This checks actual `DOMRect`/`DOMRectList` branding, indexed access, native `item()`,
iteration, JSON, multiline relationships, empty/collapsed ranges, Intl formatting,
frozen options, font controls, and restoration. It does **not** test the extension's
MAIN/ISOLATED-world delivery, startup race, or complete fingerprinting resistance.
No package installation or server is required.

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
- Check real positioning/selection consumers (tooltips, menus, editors, charts) before
  relying on ClientRects damping for a site. It is intentionally off by default.

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
- Speech voices, media-device enumeration and permission-state probing are not part
  of this phase. Notification prompt interception does not mask permission state.
- Browser-level/network fingerprints and adversarial bypasses are not certified by
  a passing regression suite. A browser-native privacy mode has a different scope.
