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
 */
(() => {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;

  function send(msg) {
    try {
      document.dispatchEvent(new CustomEvent('__fpd_config', {
        detail: JSON.stringify(msg)
      }));
    } catch (_) {}
  }

  let delivered = false;

  async function deliver() {
    let res;
    try {
      res = await api.runtime.sendMessage({ type: 'getConfig', href: location.href });
    } catch (_) {
      return;   // background not ready; protective defaults stay in force
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

  // Live-apply page API settings. New CSP/sandbox policies require a fresh
  // document response; this broadcast does not retrofit them onto loaded pages.
  api.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'configChanged') return;
    delivered = false;
    deliver();
  });

  void delivered;
})();
