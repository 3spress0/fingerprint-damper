/* Fingerprint Damper — API-level anti-fingerprinting for Firefox.
 * Copyright (C) 2026 espress0
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version. It is distributed WITHOUT ANY WARRANTY; without even the
 * implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU General Public License (LICENSE) for more details.
 */

/*
 * Fingerprint Damper - isolated-world bridge.
 *
 * The MAIN-world script cannot touch browser.* APIs, and this script cannot
 * touch page objects. This file is the only link between them.
 *
 * detail is passed as a JSON *string* on purpose: strings clone cleanly across
 * Firefox's Xray boundary, whereas plain objects need cloneInto() and fail
 * silently if you forget.
 *
 * Bootstrap order (v1.2.0): the background keeps a config snapshot in
 * storage.session ({ salt, settings, allowlist }) and opens session storage
 * to content scripts. At document_start this script reads that snapshot
 * directly - no background wake, so the MAIN-world hooks reconcile with the
 * user's real settings within a few milliseconds of injection, before page
 * scripts run. If the snapshot is empty (first tab of a browser session
 * before the background has started), fall back to one runtime.sendMessage,
 * which creates it.
 */
(() => {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;

  // Must match background.js SESSION_KEY.
  const SESSION_KEY = 'fpdSession';

  function send(msg) {
    try {
      document.dispatchEvent(new CustomEvent('__fpd_config', {
        detail: JSON.stringify(msg)
      }));
    } catch (_) {}
  }

  async function snapshotConfig() {
    let origin = '';
    try { origin = location.origin || location.href; } catch (_) {}
    let snap = null;
    try {
      const got = await api.storage.session.get(SESSION_KEY);
      snap = (got && got[SESSION_KEY]) || null;
    } catch (_) { snap = null; }
    if (!snap || typeof snap !== 'object' || typeof snap.salt !== 'string' ||
        !snap.settings || typeof snap.settings !== 'object') return null;
    return {
      salt: snap.salt,
      settings: snap.settings,
      allowlisted: origin && Array.isArray(snap.allowlist)
        ? snap.allowlist.includes(origin) : false
    };
  }

  let delivered = false;

  async function deliver() {
    let res = null;
    try { res = await snapshotConfig(); } catch (_) { res = null; }
    if (!res) {
      // Cold-start fallback: no snapshot yet (background not started in this
      // browser session). Waking the background also creates the snapshot.
      try {
        res = await api.runtime.sendMessage({ type: 'getConfig', href: location.href });
      } catch (_) {
        return;   // background not ready; shipped defaults stay in force
      }
    }
    if (!res) return;
    delivered = true;
    send({
      salt: res.salt,
      settings: res.settings,
      allowlisted: res.allowlisted
    });
  }

  // The MAIN script announces itself; if we missed it, deliver anyway.
  document.addEventListener('__fpd_ready', deliver, { once: true });
  deliver();

  // ------------------------------------------------------------- stats relay
  let pending = null;
  let timer = null;

  document.addEventListener('__fpd_stats', (ev) => {
    let counts;
    try { counts = JSON.parse(ev.detail); } catch (_) { return; }
    pending = counts;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const payload = pending;
      pending = null;
      if (!payload) return;
      try {
        api.runtime.sendMessage({ type: 'stats', counts: payload, href: location.href });
      } catch (_) {}
    }, 700);
  });

  // Live-apply page API settings and pause/resume changes. The background
  // refreshes the session snapshot before sending this, so re-reading it here
  // always yields the new state without another background round trip.
  api.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'configChanged') return;
    delivered = false;
    deliver();
  });

  void delivered;
})();