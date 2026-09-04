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
 * Fingerprint Damper - page-world patches.
 *
 * Runs in the MAIN world at document_start, before any page script.
 *
 * DESIGN RULES (these are why it doesn't break sites):
 *   1. Consistency over randomness. Values are derived from a seed of
 *      origin + date, so a site sees ONE stable persona for the day.
 *      Per-call randomness breaks image editors and is itself a signal.
 *   2. Never return null/undefined where a site expects a string. We return
 *      plausible generic values so feature-detection still succeeds.
 *   3. Only touch APIs with high fingerprint entropy and low functional use.
 *      navigator.plugins and maxTouchPoints are deliberately LEFT ALONE:
 *      ad SDKs use "plugins.length === 0" as a headless-bot signal, so
 *      emptying it makes you MORE conspicuous, not less.
 *   4. Everything is restorable. Originals are kept so an allowlisted site
 *      can be handed its real browser back.
 */
(() => {
  'use strict';

  const MARK = '__fpDamperInstalled';
  if (Object.prototype.hasOwnProperty.call(window, MARK)) return;
  try {
    Object.defineProperty(window, MARK, { value: true, enumerable: false, configurable: true });
  } catch (_) { return; }

  // ---------------------------------------------------------------- settings
  // Protective defaults apply instantly. bridge.js reconciles with the user's
  // real preferences a few ms later (see README "Timing" for why).
  const cfg = {
    canvas: true,
    webgl: true,
    audio: true,
    geometry: true,
    concurrency: true,
    battery: true,
    pushGuard: true,
    timezone: false,   // opt-in: breaks calendars/booking flows
    language: false,   // opt-in: breaks localisation
    stats: true
  };

  let salt = '';
  let active = true;
  const restore = [];   // [() => void]

  // -------------------------------------------------------------------- rng
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function baseSeed() {
    let origin = '';
    try { origin = location.origin || location.href || ''; } catch (_) {}
    const day = new Date().toISOString().slice(0, 10);   // rotates daily
    return fnv1a(origin + '|' + day + '|' + salt);
  }

  // ------------------------------------------------------------------ stats
  const counts = Object.create(null);
  let flushQueued = false;

  function report(kind) {
    if (!cfg.stats) return;
    counts[kind] = (counts[kind] || 0) + 1;
    if (flushQueued) return;
    flushQueued = true;
    setTimeout(() => {
      flushQueued = false;
      try {
        document.dispatchEvent(new CustomEvent('__fpd_stats', {
          detail: JSON.stringify(counts)
        }));
      } catch (_) {}
    }, 400);
  }

  // ------------------------------------------------------------- patch utils
  function patchMethod(obj, name, factory) {
    if (!obj) return;
    let desc;
    try { desc = Object.getOwnPropertyDescriptor(obj, name); } catch (_) { return; }
    if (!desc || !desc.configurable || typeof desc.value !== 'function') return;
    const original = desc.value;
    const replacement = factory(original);

    // Keep toString() honest-looking so naive tamper checks don't trip.
    try {
      Object.defineProperty(replacement, 'name', { value: name, configurable: true });
      Object.defineProperty(replacement, 'length', { value: original.length, configurable: true });
    } catch (_) {}

    try {
      Object.defineProperty(obj, name, { ...desc, value: replacement });
      restore.push(() => { try { Object.defineProperty(obj, name, desc); } catch (_) {} });
    } catch (_) {}
  }

  function patchGetter(obj, name, getter) {
    if (!obj) return;
    let desc;
    try { desc = Object.getOwnPropertyDescriptor(obj, name); } catch (_) { return; }
    if (!desc || !desc.configurable) return;
    try {
      Object.defineProperty(obj, name, {
        configurable: true,
        enumerable: desc.enumerable,
        get: getter,
        set: desc.set || undefined
      });
      restore.push(() => { try { Object.defineProperty(obj, name, desc); } catch (_) {} });
    } catch (_) {}
  }

  // Some window properties live on Window.prototype, some on the instance.
  function windowHost(name) {
    try {
      const proto = Object.getPrototypeOf(window);
      if (proto && Object.getOwnPropertyDescriptor(proto, name)) return proto;
    } catch (_) {}
    return Object.getOwnPropertyDescriptor(window, name) ? window : null;
  }

  // Native toString cloaking, so `fn.toString()` doesn't scream "patched".
  (function cloakToString() {
    const patched = new WeakSet();
    const origToString = Function.prototype.toString;
    patchMethod(Function.prototype, 'toString', (orig) => function toString() {
      if (patched.has(this)) return 'function () { [native code] }';
      return orig.call(this);
    });
    window.__fpdCloak = (fn) => { try { patched.add(fn); } catch (_) {} return fn; };
    void origToString;
  })();

  // ============================================================== 1. CANVAS
  // Flip the low bit of a handful of pixels. Imperceptible to humans, fatal to
  // a hash. Cost is O(32) regardless of canvas size, so no game-loop tax.
  const NOISE_PIXELS = 32;
  const noisedBuffers = new WeakSet();

  function noiseImageData(imgData, seed) {
    const d = imgData.data;
    const px = d.length >> 2;
    if (!px) return;
    const rnd = mulberry32(seed);
    const n = Math.min(NOISE_PIXELS, px);
    for (let i = 0; i < n; i++) {
      const p = Math.floor(rnd() * px) << 2;
      d[p] ^= 1;
      d[p + 1] ^= 1;
      d[p + 2] ^= 1;
    }
  }

  const rawGetImageData = window.CanvasRenderingContext2D
    ? CanvasRenderingContext2D.prototype.getImageData
    : null;

  if (window.CanvasRenderingContext2D) {
    patchMethod(CanvasRenderingContext2D.prototype, 'getImageData', (orig) =>
      function getImageData(sx, sy, sw, sh) {
        const res = orig.apply(this, arguments);
        if (active && cfg.canvas) {
          try {
            noiseImageData(res, baseSeed() ^ fnv1a(sw + 'x' + sh));
            report('canvas');
          } catch (_) {}
        }
        return res;
      });
  }

  // Serialise from a noised copy so we never mutate the live canvas.
  function noisedCopy(canvas) {
    const w = canvas.width, h = canvas.height;
    if (!w || !h || w * h > 4000000) return null;   // skip huge canvases (perf)
    const copy = document.createElement('canvas');
    copy.width = w; copy.height = h;
    const ctx = copy.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(canvas, 0, 0);                    // throws if tainted -> caught
    const data = rawGetImageData.call(ctx, 0, 0, w, h);
    noiseImageData(data, baseSeed());
    ctx.putImageData(data, 0, 0);
    return copy;
  }

  if (window.HTMLCanvasElement) {
    patchMethod(HTMLCanvasElement.prototype, 'toDataURL', (orig) =>
      function toDataURL() {
        if (active && cfg.canvas) {
          try {
            const copy = noisedCopy(this);
            if (copy) { report('canvas'); return orig.apply(copy, arguments); }
          } catch (_) {}
        }
        return orig.apply(this, arguments);
      });

    patchMethod(HTMLCanvasElement.prototype, 'toBlob', (orig) =>
      function toBlob(cb) {
        if (active && cfg.canvas) {
          try {
            const copy = noisedCopy(this);
            if (copy) {
              report('canvas');
              const rest = Array.prototype.slice.call(arguments, 1);
              return orig.apply(copy, [cb].concat(rest));
            }
          } catch (_) {}
        }
        return orig.apply(this, arguments);
      });
  }

  // ============================================================== 2. WEBGL
  // The single highest-entropy item in the SDK we analysed: the unmasked GPU
  // string. "Mozilla" is what Firefox's own resistFingerprinting reports, so
  // it hides us in the largest available crowd rather than inventing a value.
  const UNMASKED_VENDOR = 0x9245;    // 37445
  const UNMASKED_RENDERER = 0x9246;  // 37446
  const GL_VENDOR = 0x1f00;          // 7936
  const GL_RENDERER = 0x1f01;        // 7937
  const GL_VERSION = 0x1f02;         // 7938

  for (const ctor of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!ctor) continue;
    patchMethod(ctor.prototype, 'getParameter', (orig) =>
      function getParameter(p) {
        if (active && cfg.webgl) {
          if (p === UNMASKED_VENDOR || p === GL_VENDOR) { report('webgl'); return 'Mozilla'; }
          if (p === UNMASKED_RENDERER || p === GL_RENDERER) { report('webgl'); return 'Mozilla'; }
          if (p === GL_VERSION) { report('webgl'); return 'WebGL 1.0'; }
        }
        return orig.apply(this, arguments);
      });
  }

  // ============================================================== 3. AUDIO
  // Perturb ~32 samples by ~1e-7. Inaudible; breaks AudioContext hashing.
  // WeakSet guard stops repeated calls from accumulating drift.
  if (window.AudioBuffer) {
    patchMethod(AudioBuffer.prototype, 'getChannelData', (orig) =>
      function getChannelData(channel) {
        const data = orig.apply(this, arguments);
        if (active && cfg.audio && !noisedBuffers.has(data)) {
          try {
            noisedBuffers.add(data);
            const rnd = mulberry32(baseSeed() ^ (channel | 0));
            const step = Math.max(1, Math.floor(data.length / 32));
            for (let i = 0; i < data.length; i += step) {
              data[i] += (rnd() - 0.5) * 1e-7;
            }
            report('audio');
          } catch (_) {}
        }
        return data;
      });
  }

  if (window.AnalyserNode) {
    patchMethod(AnalyserNode.prototype, 'getFloatFrequencyData', (orig) =>
      function getFloatFrequencyData(array) {
        orig.apply(this, arguments);
        if (active && cfg.audio) {
          try {
            const rnd = mulberry32(baseSeed());
            const step = Math.max(1, Math.floor(array.length / 32));
            for (let i = 0; i < array.length; i += step) {
              array[i] += (rnd() - 0.5) * 1e-4;
            }
            report('audio');
          } catch (_) {}
        }
      });
  }

  // =========================================================== 4. GEOMETRY
  // Window position and the outer/inner delta leak OS, theme, toolbar count
  // and multi-monitor layout. None of it is needed for layout, so it is free
  // to normalise. screen.width/height are left REAL by default: quantising
  // them is a genuine responsive-design breakage risk.
  if (window.Screen) {
    patchGetter(Screen.prototype, 'availWidth', function () {
      return (active && cfg.geometry) ? this.width : screenDesc('availWidth', this);
    });
    patchGetter(Screen.prototype, 'availHeight', function () {
      return (active && cfg.geometry) ? this.height : screenDesc('availHeight', this);
    });
    patchGetter(Screen.prototype, 'availLeft', function () { return (active && cfg.geometry) ? 0 : 0; });
    patchGetter(Screen.prototype, 'availTop', function () { return (active && cfg.geometry) ? 0 : 0; });
    patchGetter(Screen.prototype, 'colorDepth', function () { return (active && cfg.geometry) ? 24 : 24; });
    patchGetter(Screen.prototype, 'pixelDepth', function () { return (active && cfg.geometry) ? 24 : 24; });
  }
  function screenDesc() { return 0; }

  for (const [prop, fallback] of [['screenX', 0], ['screenY', 0], ['screenLeft', 0], ['screenTop', 0]]) {
    const host = windowHost(prop);
    if (host) patchGetter(host, prop, function () { return (active && cfg.geometry) ? fallback : fallback; });
  }

  for (const [outer, inner] of [['outerWidth', 'innerWidth'], ['outerHeight', 'innerHeight']]) {
    const host = windowHost(outer);
    if (!host) continue;
    const desc = Object.getOwnPropertyDescriptor(host, outer);
    const origGet = desc && desc.get;
    patchGetter(host, outer, function () {
      if (active && cfg.geometry) return window[inner];
      return origGet ? origGet.call(this) : window[inner];
    });
  }

  // ======================================================== 5. NAVIGATOR BITS
  if (window.Navigator) {
    if (cfg.concurrency) {
      const d = Object.getOwnPropertyDescriptor(Navigator.prototype, 'hardwareConcurrency');
      const og = d && d.get;
      patchGetter(Navigator.prototype, 'hardwareConcurrency', function () {
        if (active && cfg.concurrency) return 8;
        return og ? og.call(this) : 8;
      });
    }

    // Battery level + charge/discharge time is a startlingly good short-term
    // cross-site correlator. Firefox gates this already; belt and braces.
    patchMethod(Navigator.prototype, 'getBattery', () =>
      function getBattery() {
        if (!(active && cfg.battery)) return Promise.reject(new Error('unavailable'));
        report('battery');
        return Promise.resolve({
          charging: true,
          chargingTime: 0,
          dischargingTime: Infinity,
          level: 1,
          addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
          onchargingchange: null, onchargingtimechange: null,
          ondischargingtimechange: null, onlevelchange: null
        });
      });
  }

  // ==================================================== 6. PUSH / SW GUARD
  // The concrete harm from the y2mate teardown: a fake in-page "Allow
  // notifications" card funnels you into the real prompt, then a service
  // worker is registered for permanent ad delivery.
  const AD_SW = /(sw-check-permissions|sw\.hid\.js|pushsdk|9hito|rtmark|zdzhk|kbvcd|dulotadtor|abunownon|dawac|\bzoneid=)/i;

  if (window.Notification) {
    patchMethod(Notification, 'requestPermission', () =>
      function requestPermission(cb) {
        report('notify');
        // "default" (not "denied") - the site is told the user dismissed it,
        // which is the least distinguishable, least sticky answer.
        const result = 'default';
        if (typeof cb === 'function') { try { cb(result); } catch (_) {} }
        return Promise.resolve(result);
      });
  }

  if (window.ServiceWorkerContainer) {
    patchMethod(ServiceWorkerContainer.prototype, 'register', (orig) =>
      function register(url) {
        if (active && cfg.pushGuard) {
          try {
            const u = String(url);
            if (AD_SW.test(u)) {
              report('swblock');
              return Promise.reject(new DOMException(
                'Registration blocked by Fingerprint Damper', 'SecurityError'));
            }
          } catch (_) {}
        }
        return orig.apply(this, arguments);
      });
  }

  // ==================================================== 7. OPT-IN SPOOFS
  // Off by default. Both are real breakage risks, so the user opts in.
  const realTZ = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return 'UTC'; }
  })();

  if (window.Intl && Intl.DateTimeFormat) {
    const origResolved = Intl.DateTimeFormat.prototype.resolvedOptions;
    patchMethod(Intl.DateTimeFormat.prototype, 'resolvedOptions', () =>
      function resolvedOptions() {
        const o = origResolved.call(this);
        if (active && cfg.timezone) { o.timeZone = 'UTC'; report('timezone'); }
        return o;
      });
    patchMethod(Date.prototype, 'getTimezoneOffset', (orig) =>
      function getTimezoneOffset() {
        if (active && cfg.timezone) { report('timezone'); return 0; }
        return orig.call(this);
      });
  }
  void realTZ;

  if (window.Navigator) {
    const dl = Object.getOwnPropertyDescriptor(Navigator.prototype, 'language');
    const dls = Object.getOwnPropertyDescriptor(Navigator.prototype, 'languages');
    patchGetter(Navigator.prototype, 'language', function () {
      if (active && cfg.language) { report('language'); return 'en-US'; }
      return dl && dl.get ? dl.get.call(this) : 'en-US';
    });
    patchGetter(Navigator.prototype, 'languages', function () {
      if (active && cfg.language) { report('language'); return Object.freeze(['en-US', 'en']); }
      return dls && dls.get ? dls.get.call(this) : ['en-US', 'en'];
    });
  }

  // ==================================================== control channel
  document.addEventListener('__fpd_config', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.detail); } catch (_) { return; }
    if (msg.salt != null) salt = String(msg.salt);
    if (msg.settings) Object.assign(cfg, msg.settings);
    if (msg.allowlisted === true && active) {
      active = false;
      while (restore.length) restore.pop()();
    } else if (msg.allowlisted === false) {
      active = true;
    }
  });

  try {
    document.dispatchEvent(new CustomEvent('__fpd_ready'));
  } catch (_) {}
})();
