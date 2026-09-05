# Coverage and trust boundaries

The 1.4 controls below are **off by default**. They reduce specific page-visible
observations; they do not establish an undetectable browser persona or replace
browser-level privacy policies. They add no extension permissions and make no
proxy, certificate, capture or grant changes. Page-world configuration/statistics
channels are observable and configuration events can be spoofed by hostile page
code. These hooks are not a tamper-proof security boundary.

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
The separate [v1.5 global lockdown](lockdown.md) can opt in to browser-enforced denial
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
