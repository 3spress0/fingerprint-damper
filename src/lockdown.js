/* Fingerprint Damper — API-level anti-fingerprinting for Firefox.
 * Copyright (C) 2026 espress0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Pure policy definitions shared by extension pages only. Never loaded into a
// website: page-world config events cannot install or remove these DNR rules.
(() => {
  'use strict';
  const controls = [
    ['lockScripts', 'Block site scripts',
      'Blocks inline/external site JavaScript and new workers via CSP, plus network script loads. Apps, logins and challenges may stop working. Reload required.'],
    ['lockSandbox', 'Force an opaque-origin sandbox',
      'No allow-scripts or allow-same-origin escape: also restricts forms, popups, downloads, embeds and origin storage access. Many pages become unusable. Not an OS sandbox; does not erase cookies or stop HTTP from sending them.'],
    ['lockWorkers', 'Block new workers',
      'CSP worker-src none denies new dedicated/shared workers and service-worker registrations on covered documents. Does not terminate existing workers or unregister service workers; worklets are not covered by this switch.'],
    ['lockEmbeds', 'Block embedded content loads',
      'Blocks frame, object and embed loads. Breaks video embeds, payment widgets and embedded apps. Not a ban on creating an initial about:blank frame.'],
    ['lockConnect', 'Block fetch, sockets and beacons',
      'Denies fetch/XHR, new WebSocket connections, beacons, pings and CSP reports. Breaks API calls and live updates. Images, forms and navigation are not a substitute-proof network boundary.'],
    ['lockResources', 'Text-only / block secondary requests',
      'Blocks eligible non-navigation HTTP(S)/WS(S) requests, plus CSP default-src none. Only inline styles remain permitted by this added policy. Scripts, media, fonts, frames and most styling fail. The initial document and top-level navigations still go out.'],
    ['lockCookies', 'Strip network cookies',
      'Removes outgoing Cookie and incoming Set-Cookie headers on eligible requests. Sessions/logins break. Existing cookies, DOM storage, cached data and authorization are NOT deleted or isolated by this switch.'],
    ['lockHeaders', 'Remove selected identity headers',
      'Removes User-Agent, Accept-Language, Referer and known UA client-hint headers. Can break localization and bot checks; missing headers are fingerprintable. Does not hide IP/TLS or change header order, Origin, authorization or security headers.']
  ].map(row => Object.freeze(row));
  const keys = Object.freeze(controls.map(row => row[0]));
  const defaults = Object.freeze(Object.fromEntries(keys.map(key => [key, false])));
  // Only these IDs are owned here. Never remove unrelated dynamic/static rules.
  const ids = Object.freeze({ csp: 15001, block: 15002, headers: 15003 });
  const ruleIds = Object.freeze(Object.values(ids));
  const http = '^https?://';
  const network = '^(https?|wss?)://';

  function buildRules(settings = {}) {
    const on = key => settings[key] === true;
    const policy = new Set();
    const blocked = new Set();
    const rules = [];
    if (on('lockScripts') || on('lockSandbox')) {
      policy.add("script-src 'none'").add("worker-src 'none'").add("object-src 'none'");
      blocked.add('script');
    }
    if (on('lockSandbox')) {
      policy.add('sandbox').add("form-action 'none'").add("base-uri 'none'");
    }
    if (on('lockWorkers')) policy.add("worker-src 'none'");
    if (on('lockEmbeds') || on('lockSandbox')) {
      policy.add("frame-src 'none'").add("object-src 'none'");
      for (const type of ['sub_frame', 'object', 'object_subrequest']) blocked.add(type);
    }
    if (on('lockConnect')) {
      policy.add("connect-src 'none'");
      // Firefox has a separate beacon type (not just Chromium's ping type).
      for (const type of ['xmlhttprequest', 'websocket', 'beacon', 'ping', 'csp_report']) blocked.add(type);
    }
    if (on('lockResources')) {
      policy.add("default-src 'none'").add("style-src 'unsafe-inline'")
        .add("form-action 'none'").add("base-uri 'none'");
    }
    if (policy.size) rules.push({
      id: ids.csp, priority: 1,
      action: { type: 'modifyHeaders', responseHeaders: [
        // APPEND, never SET: every server CSP remains enforced, in intersection.
        { header: 'content-security-policy', operation: 'append', value: [...policy].join('; ') }
      ] },
      condition: { regexFilter: http, resourceTypes: ['main_frame', 'sub_frame'] }
    });
    if (on('lockResources') || blocked.size) rules.push({
      id: ids.block, priority: 100,
      action: { type: 'block' },
      condition: { regexFilter: network, ...(on('lockResources')
        ? { excludedResourceTypes: ['main_frame'] }
        : { resourceTypes: [...blocked].sort() }) }
    });
    const requestHeaders = [], responseHeaders = [];
    if (on('lockCookies')) {
      requestHeaders.push({ header: 'cookie', operation: 'remove' });
      responseHeaders.push({ header: 'set-cookie', operation: 'remove' });
    }
    if (on('lockHeaders')) {
      for (const header of ['user-agent', 'accept-language', 'referer', 'sec-ch-ua',
        'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-ch-ua-platform-version',
        'sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-model', 'sec-ch-ua-full-version',
        'sec-ch-ua-full-version-list', 'sec-ch-ua-wow64', 'sec-ch-ua-form-factors']) {
        requestHeaders.push({ header, operation: 'remove' });
      }
      responseHeaders.push({ header: 'referrer-policy', operation: 'set', value: 'no-referrer' });
    }
    if (requestHeaders.length || responseHeaders.length) rules.push({
      id: ids.headers, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders, responseHeaders },
      condition: { regexFilter: network }
    });
    return rules;
  }

  globalThis.FPDLockdown = Object.freeze({ controls: Object.freeze(controls), keys, defaults, ruleIds, buildRules });
})();
