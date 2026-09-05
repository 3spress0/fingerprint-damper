# Global lockdown (v1.5)

**Eight independent opt-ins, all off by default.** These are intentionally
high-breakage browser network/CSP rules, not more spoofed API results. They apply
globally to eligible HTTP(S) documents and HTTP(S)/WS(S) requests. The existing
per-origin **API pause does not exempt a site** from these rules.

There is no honest “the website gets absolutely nothing” switch while visiting
its server. The initial visit, IP/TLS/transport properties, URLs and user navigation
still convey information. Existing contexts, site data and requests outside DNR's
coverage remain important. Use a fresh test profile, enable before visiting, and
verify the actual browser behavior rather than trusting an empty page or badge.

## Controls

| Control | Browser policy | Cost and boundaries |
|---|---|---|
| Block site scripts | Appends `script-src 'none'; worker-src 'none'; object-src 'none'` on document responses; blocks network `script` loads. | Inline/external site code, applications and challenges fail. This is **no-script**, not transparent API emulation. Existing code isn't stopped retroactively. |
| Opaque-origin sandbox | Adds bare CSP `sandbox` (no allow tokens), script/worker/object/frame denial, `form-action 'none'` and `base-uri 'none'`. | Restricts origin storage access, scripts, forms, popups and downloads. It is a document sandbox, **not an OS/process sandbox**. Does not by itself strip HTTP cookies or suppress all passive resource loads. |
| Block new workers | Adds `worker-src 'none'` to covered documents. | Denies new dedicated/shared workers, including blob/module workers, and service-worker registration under that policy. Does not terminate/unregister existing workers or claim worklet coverage. |
| Block embedded content loads | Adds `frame-src 'none'; object-src 'none'`; blocks network subframes/objects/object subrequests. | Embeds, payment widgets and iframe apps break. Creating an initial empty `about:blank` frame is not the same as loading a blocked frame URL. |
| Block fetch/sockets/beacons | Adds `connect-src 'none'`; blocks XHR/fetch, new WebSocket, **Firefox beacon**, ping and CSP-report requests. | Breaks API calls/live updates and suppresses network CSP reports. Images, forms, navigation and existing connections are not comprehensively stopped by this control alone. |
| Text-only / secondary-request seal | Adds `default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'`; blocks eligible non-`main_frame` network requests. | Only inline CSS is permitted by this added policy. Scripts, fonts, images, media, frames and external styling fail. The server's own CSS restrictions still apply. Initial documents/top-level navigation remain allowed: **not an air gap or firewall**. |
| Strip network cookies | Removes request `Cookie` and response `Set-Cookie` headers on eligible requests. | Breaks sessions. Does not erase/hide existing `document.cookie`, other storage, URL tokens or authorization. Pair with no-script/sandbox for stronger restrictions; do not interpret this as a fresh browser profile. |
| Minimize selected identity headers | Removes User-Agent, Accept-Language, Referer and the enumerated UA client hints; sets response Referrer-Policy to `no-referrer`. | Missing headers are detectable and may break bot checks/localization. Does not normalize TLS, HTTP/2, header order, request payloads or all JS-visible equivalents. Leaves Origin, authorization and security headers alone. |

Stronger controls imply some weaker restrictions even if the weaker checkbox is
unticked (for example, the sandbox also forbids scripts). Combining controls only
tightens the added policy. There are no fabricated success responses or deliberately
never-settling promises: the browser denies the operation/request normally.

## Opt in and recover

1. Open Settings → **Global lockdown** and select individual controls, or confirm
   **Enable all lockdown controls**. Ordinary and risky API settings are unchanged.
2. Wait for confirmation, then reload affected tabs, bypassing cache. Prefer a new
   profile with no site data/service workers for meaningful isolation testing.
3. To recover, use **Turn off all lockdown** in the popup or Settings. This changes
   only lockdown settings and managed rules; it leaves API preferences, API pause
   entries and the separate ad-network switch alone.
4. Reload affected pages again. Already delivered CSP/sandbox policies remain on
   those documents until replaced; back/forward cache can resurrect old documents.
   Tabs are **not auto-reloaded**, to avoid destroying unsaved work.
5. If rule removal fails, the UI reports failure, not “off.” Disable the extension
   through `about:addons` and load a fresh document. Site-data cleanup, if desired,
   is a separate user action; the extension does not delete it automatically.

## Enforcement and configuration boundary

`src/lockdown.js` is loaded only by extension pages/background. It builds at most
three managed dynamic DNR rules (IDs 15001–15003). The browser evaluates them; the
extension does not inspect request bodies or record their contents.

CSP is **appended**, never replaced or relaxed. Multiple enforcing CSP policies
intersect. No `allow-scripts`/`allow-same-origin` sandbox bypass is added, no CORS or
certificate checks are weakened, and no new extension permissions are requested.
Only eligible HTTP(S) document responses receive CSP; this is not a DOM mutation
observer or a late `<meta>` injection (CSP sandbox cannot be delivered through meta).

Unlike the old page-world API hooks, these rules cannot be switched off with
`__fpd_config`/stats events. Settings mutations require the extension's own runtime
sender ID **and** extension-page URL. Lockdown preferences are not sent through the
page-world configuration channel. The old API hooks are still tamperable; this does
not turn them into a security boundary.

Writes and startup reconciliation are serialized. Dynamic rules survive browser
restarts/extension updates; defaults never auto-enable lockdown. Only owned rule IDs
and the `adnets` static toggle are managed. DNR and storage are not one transaction:
failures trigger best-effort restoration and explicit error reporting, including
rollback failures. A document loaded during a failed change may still retain the
policy it received and need reloading. “Rules configured” confirms configuration,
**not that every request matched or that native enforcement was verified**.

## Remaining gaps

- DNR/host-permission/restricted-domain rules limit interception. Privileged browser
  requests, restricted domains and other extensions are outside coverage. Header
  modification also needs host access, including initiator access where required.
- Cached documents, BFCache, and synthetic/cached service-worker responses need
  special care; a response that doesn't traverse the applicable header-processing
  path isn't guaranteed to receive the added CSP. Existing service workers and
  background contexts are not removed. Test with fresh loads and inspect headers.
- Enabling a switch doesn't close existing sockets, terminate scripts/workers,
  retract already exposed information, clear storage/cache or revoke permissions.
- Top-level navigation, URLs, ordinary HTTP authorization, client certificates,
  transport fingerprints and browser-generated traffic are not made anonymous.
- Files, extension/internal pages, data/blob documents and inherited-policy edge
  cases are not blanket-covered by the HTTP response rule. No OS sandbox, proxy,
  VPN, certificate installation or wholesale browser privacy policy is supplied.
- Native Firefox verification is still required. The Node tests model rule generation,
  configuration failure/rollback and UI behavior—not actual CSP or network enforcement.

## Verification / references

Use the [HTTP fixture and checklist](../test/README.md#global-lockdown-http-integration).
The legacy JS-driven self-test cannot prove no-script enforcement when its scripts
are forbidden to run. No automated diagnostic registers service workers or requests
permissions/capture/playback.

Relevant platform contracts:
- [DNR permissions, matching and persistence](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest)
- [Header append/set/remove rules](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest/ModifyHeaderInfo)
- [CSP sandbox, opaque origin and allow tokens](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox)
- [Firefox-specific resource types, including beacon](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest/ResourceType)
