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
 *   3. Keep defaults conservative; higher-breakage surfaces are opt-in.
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
    clientRects: false, // opt-in: affects positioning, selection, and hit-testing
    timezone: false,   // opt-in: breaks calendars/booking flows
    language: false,   // opt-in: breaks localisation
    webrtc: false,      // opt-in: breaks P2P calls with no TURN fallback
    speechVoices: false, // opt-in: voice pickers may stop working
    mediaDevices: false, // opt-in: camera/microphone/speaker pickers may break
    permissionStates: false, // opt-in: sites may show redundant permission UI
    mathRounding: false, // experimental: reduces numerical precision
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
  function patchMethod(obj, name, factory, restorers = restore) {
    if (!obj) return;
    let desc;
    try { desc = Object.getOwnPropertyDescriptor(obj, name); } catch (_) { return; }
    if (!desc || !desc.configurable || typeof desc.value !== 'function') return;
    const original = desc.value;
    const replacement = factory(original);

    // Preserve call metadata without redefining matching Proxy-target properties.
    try {
      if (replacement.name !== original.name) {
        Object.defineProperty(replacement, 'name', { value: original.name, configurable: true });
      }
      if (replacement.length !== original.length) {
        Object.defineProperty(replacement, 'length', { value: original.length, configurable: true });
      }
    } catch (_) {}

    try {
      Object.defineProperty(obj, name, { ...desc, value: replacement });
      restorers.push(() => { try { Object.defineProperty(obj, name, desc); } catch (_) {} });
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

  // ======================================================= 1b. TEXT METRICS
  // Text metrics do not pass through pixel readback. Stable, tiny jitter changes
  // exact metric hashes, but does NOT hide font availability from probes that
  // round measurements or compare substantially different font metrics.
  const TEXT_METRIC_FIELDS = [
    'width', 'actualBoundingBoxLeft', 'actualBoundingBoxRight',
    'actualBoundingBoxAscent', 'actualBoundingBoxDescent',
    'fontBoundingBoxAscent', 'fontBoundingBoxDescent'
  ];

  for (const ctx2d of [window.CanvasRenderingContext2D, window.OffscreenCanvasRenderingContext2D]) {
    if (!ctx2d || !ctx2d.prototype.measureText) continue;
    patchMethod(ctx2d.prototype, 'measureText', (orig) =>
      function measureText(text) {
        const m = orig.apply(this, arguments);
        if (active && cfg.canvas) {
          try {
            const seed = baseSeed() ^ fnv1a((this.font || '') + '|' + text);
            const rnd = mulberry32(seed);
            for (const f of TEXT_METRIC_FIELDS) {
              if (typeof m[f] !== 'number') continue;
              Object.defineProperty(m, f, {
                value: m[f] + (rnd() - 0.5) * 0.02, configurable: true, enumerable: true
              });
            }
            report('canvas');
          } catch (_) {}
        }
        return m;
      });
  }

  // OffscreenCanvas main-thread pixel readback. Same noise budget as
  // HTMLCanvasElement above. Worker code has a separate global: none of its
  // APIs are patched here, not just its canvas APIs. See README limitations.
  const rawOffscreenGetImageData = window.OffscreenCanvasRenderingContext2D
    ? OffscreenCanvasRenderingContext2D.prototype.getImageData
    : null;

  if (rawOffscreenGetImageData) {
    patchMethod(OffscreenCanvasRenderingContext2D.prototype, 'getImageData', (orig) =>
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

  if (window.OffscreenCanvas && OffscreenCanvas.prototype.convertToBlob) {
    patchMethod(OffscreenCanvas.prototype, 'convertToBlob', (orig) =>
      function convertToBlob() {
        if (active && cfg.canvas) {
          try {
            const w = this.width, h = this.height;
            if (w && h && w * h <= 4000000) {
              const copy = new OffscreenCanvas(w, h);
              const ctx = copy.getContext('2d');
              if (ctx) {
                ctx.drawImage(this, 0, 0);
                // Bypass our getter so the copy receives only one noise pass.
                const data = rawOffscreenGetImageData.call(ctx, 0, 0, w, h);
                noiseImageData(data, baseSeed());
                ctx.putImageData(data, 0, 0);
                report('canvas');
                return orig.apply(copy, arguments);
              }
            }
          } catch (_) {}
        }
        return orig.apply(this, arguments);
      });
  }

  // ====================================================== 1c. CLIENT RECTS
  // Opt-in: these snapshots drive real positioning and hit-testing too. Dampen
  // exact hashes, not layout itself; rounded/tolerant measurements can evade it.
  // Mutate native DOMRect snapshots, not DOMRect/DOMRectList prototypes, so
  // item(), iteration, JSON, branding and right/bottom relationships stay native.
  function rectTransform(bounds) {
    const { x, y, width, height } = bounds;
    if (![x, y, width, height].every(Number.isFinite) || (!width && !height)) return null;
    const rnd = mulberry32(baseSeed() ^ fnv1a([x, y, width, height].join('|')));
    const dx = (rnd() - 0.5) * 0.02;
    const dy = (rnd() - 0.5) * 0.02;
    // Zero dimensions stay zero; even very small positive dimensions stay positive.
    const dw = (rnd() - 0.5) * Math.min(0.02, Math.abs(width));
    const dh = (rnd() - 0.5) * Math.min(0.02, Math.abs(height));
    return { x, y, targetX: x + dx, targetY: y + dy,
      scaleX: width ? (width + dw) / width : 1,
      scaleY: height ? (height + dh) / height : 1 };
  }

  function transformRect(rect, transform) {
    if (!transform) return;
    rect.x = transform.targetX + (rect.x - transform.x) * transform.scaleX;
    rect.y = transform.targetY + (rect.y - transform.y) * transform.scaleY;
    rect.width *= transform.scaleX;
    rect.height *= transform.scaleY;
  }

  if (window.DOMRect) {
    for (const ctor of [window.Element, window.Range]) {
      if (!ctor) continue;
      const rawBounds = ctor.prototype.getBoundingClientRect;
      if (typeof rawBounds !== 'function') continue;
      patchMethod(ctor.prototype, 'getBoundingClientRect', (orig) =>
        function getBoundingClientRect() {
          const rect = orig.apply(this, arguments);
          if (active && cfg.clientRects) {
            try { transformRect(rect, rectTransform(rect)); report('clientRects'); } catch (_) {}
          }
          return rect;
        });
      patchMethod(ctor.prototype, 'getClientRects', (orig) =>
        function getClientRects() {
          const rects = orig.apply(this, arguments);
          if (active && cfg.clientRects && rects.length) {
            try {
              // One transform per snapshot keeps multiline fragments coherent
              // with the separately queried bounding rect, rather than jittering
              // each fragment independently. Bypass the patched bounds method.
              const transform = rectTransform(rawBounds.call(this));
              for (let i = 0; i < rects.length; i++) transformRect(rects[i], transform);
              report('clientRects');
            } catch (_) {}
          }
          return rects;
        });
    }
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
    // A WebGL2 context claiming version "1.0" while answering WebGL2-only
    // calls is its own tell, so report the version that matches the class
    // actually being patched rather than a single hardcoded string.
    const versionStr = ctor === window.WebGL2RenderingContext ? 'WebGL 2.0' : 'WebGL 1.0';
    patchMethod(ctor.prototype, 'getParameter', (orig) =>
      function getParameter(p) {
        if (active && cfg.webgl) {
          if (p === UNMASKED_VENDOR || p === GL_VENDOR) { report('webgl'); return 'Mozilla'; }
          if (p === UNMASKED_RENDERER || p === GL_RENDERER) { report('webgl'); return 'Mozilla'; }
          if (p === GL_VERSION) { report('webgl'); return versionStr; }
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
    // Capture real getters BEFORE patching so "off" genuinely means real,
    // not a second flavour of fake. (Previous version returned 0 either way.)
    const screenOrig = {};
    for (const p of ['availWidth', 'availHeight', 'availLeft', 'availTop', 'colorDepth', 'pixelDepth']) {
      const d = Object.getOwnPropertyDescriptor(Screen.prototype, p);
      screenOrig[p] = d && d.get;
    }
    patchGetter(Screen.prototype, 'availWidth', function () {
      if (active && cfg.geometry) return this.width;
      return screenOrig.availWidth ? screenOrig.availWidth.call(this) : this.width;
    });
    patchGetter(Screen.prototype, 'availHeight', function () {
      if (active && cfg.geometry) return this.height;
      return screenOrig.availHeight ? screenOrig.availHeight.call(this) : this.height;
    });
    patchGetter(Screen.prototype, 'availLeft', function () {
      if (active && cfg.geometry) return 0;
      return screenOrig.availLeft ? screenOrig.availLeft.call(this) : 0;
    });
    patchGetter(Screen.prototype, 'availTop', function () {
      if (active && cfg.geometry) return 0;
      return screenOrig.availTop ? screenOrig.availTop.call(this) : 0;
    });
    patchGetter(Screen.prototype, 'colorDepth', function () {
      if (active && cfg.geometry) return 24;
      return screenOrig.colorDepth ? screenOrig.colorDepth.call(this) : 24;
    });
    patchGetter(Screen.prototype, 'pixelDepth', function () {
      if (active && cfg.geometry) return 24;
      return screenOrig.pixelDepth ? screenOrig.pixelDepth.call(this) : 24;
    });
  }

  for (const [prop, fallback] of [['screenX', 0], ['screenY', 0], ['screenLeft', 0], ['screenTop', 0]]) {
    const host = windowHost(prop);
    if (!host) continue;
    const desc = Object.getOwnPropertyDescriptor(host, prop);
    const origGet = desc && desc.get;
    patchGetter(host, prop, function () {
      if (active && cfg.geometry) return fallback;
      return origGet ? origGet.call(this) : fallback;
    });
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
    patchMethod(Notification, 'requestPermission', (orig) =>
      function requestPermission(cb) {
        if (!(active && cfg.pushGuard)) return orig.apply(this, arguments);
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
  // Normalise default locale selection, not the engine's ICU/CLDR data. Explicit
  // supported locales and explicit time zones remain the application's choice.
  // Configure the real formatter, never just lie about its resolvedOptions().
  if (window.Intl && Intl.getCanonicalLocales) {
    const canonicalLocales = Intl.getCanonicalLocales;

    function localeArguments(args, index = 0) {
      const copy = Array.from(args);
      if (active && cfg.language) {
        // Native canonicalisation handles strings, arrays, array-like lists and
        // invalid tags, and consumes user-supplied getters only once. Appending
        // en-US also handles an explicit but unsupported locale's fallback.
        const locales = canonicalLocales(copy[index]);
        if (!locales.includes('en-US')) locales.push('en-US');
        copy[index] = locales;
        report('language');
      }
      return copy;
    }

    function defaultTimeZone(options) {
      if (options === null) return options; // preserve the native TypeError
      const source = options === undefined ? Object.create(null) : Object(options);
      // A facade, not a Proxy of source: frozen { timeZone: undefined } must not
      // violate Proxy invariants. Preserve inherited/non-enumerable options and
      // getter receivers/order without spreading or mutating the caller's object.
      return new Proxy(Object.create(null), {
        get(_, key) {
          const value = Reflect.get(source, key, source);
          return key === 'timeZone' && value === undefined ? 'UTC' : value;
        }
      });
    }

    function dateArguments(args) {
      const copy = localeArguments(args);
      if (active && cfg.timezone) {
        copy[1] = defaultTimeZone(copy[1]);
        report('timezone');
      }
      return copy;
    }

    const callable = new Set(['DateTimeFormat', 'NumberFormat', 'Collator']);
    for (const name of ['DateTimeFormat', 'NumberFormat', 'Collator', 'PluralRules',
                        'RelativeTimeFormat', 'ListFormat', 'Segmenter', 'DisplayNames', 'DurationFormat']) {
      const original = Intl[name];
      if (typeof original !== 'function') continue;
      const prepare = name === 'DateTimeFormat' ? dateArguments : localeArguments;
      patchMethod(Intl, name, (orig) => {
        const handler = {
          construct(target, args, newTarget) {
            return Reflect.construct(target, prepare(args), newTarget);
          }
        };
        // New-only constructors must still reject calls without `new` before
        // inspecting locale arguments. Legacy callable Intl constructors retain
        // their native call/chaining semantics and all static methods.
        if (callable.has(name)) handler.apply = (target, receiver, args) =>
          Reflect.apply(target, receiver, prepare(args));
        return new Proxy(orig, handler);
      });
      if (Intl[name] === original) continue;
      const desc = Object.getOwnPropertyDescriptor(original.prototype, 'constructor');
      if (desc && desc.configurable && desc.value === original) {
        try {
          Object.defineProperty(original.prototype, 'constructor', { ...desc, value: Intl[name] });
          restore.push(() => { try { Object.defineProperty(original.prototype, 'constructor', desc); } catch (_) {} });
        } catch (_) {}
      }
    }

    // Built-in toLocale* methods don't necessarily consult the public Intl
    // constructor. Patch their locale inputs too; arrays delegate to elements.
    for (const ctor of [window.Number, window.BigInt]) {
      if (!ctor) continue;
      const valueOf = ctor.prototype.valueOf;
      patchMethod(ctor.prototype, 'toLocaleString', (orig) =>
        function toLocaleString() {
          if (!(active && cfg.language)) return orig.apply(this, arguments);
          valueOf.call(this); // native brand check precedes locale getters
          return orig.apply(this, localeArguments(arguments));
        });
    }

    const rawGetTime = Date.prototype.getTime;
    for (const name of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
      patchMethod(Date.prototype, name, (orig) => function () {
        if (!(active && (cfg.language || cfg.timezone))) return orig.apply(this, arguments);
        // Invalid dates return "Invalid Date" without touching locales/options.
        if (!Number.isFinite(rawGetTime.call(this))) return orig.apply(this, arguments);
        return orig.apply(this, dateArguments(arguments));
      });
    }

    for (const name of ['localeCompare', 'toLocaleLowerCase', 'toLocaleUpperCase']) {
      patchMethod(String.prototype, name, (orig) => function () {
        if (!(active && cfg.language) || this == null) return orig.apply(this, arguments);
        // ToString, not String(): Symbols must throw. Coerce each input once,
        // before locale getters, just as the native string methods do.
        const text = `${this}`;
        const args = Array.from(arguments);
        if (name === 'localeCompare') args[0] = `${args[0]}`;
        return orig.apply(text, localeArguments(args, name === 'localeCompare' ? 1 : 0));
      });
    }

    patchMethod(Date.prototype, 'getTimezoneOffset', (orig) =>
      function getTimezoneOffset() {
        const offset = orig.call(this);
        if (active && cfg.timezone && Number.isFinite(offset)) { report('timezone'); return 0; }
        return offset;
      });
  }

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

  // ============================================================== 8. WEBRTC
  // Off by default: strips "host" (LAN, already mDNS-obfuscated by Firefox)
  // and "srflx" (public IP via STUN — the actual VPN-bypass leak) candidates,
  // leaving only "relay" (TURN) candidates. Handles both trickle-ICE events
  // and non-trickle SDP blobs. Opt-in because P2P apps with no TURN fallback
  // will simply fail to connect.
  const ICE_LEAK = /\b(typ (srflx|host))\b/;

  function stripSdp(sdp) {
    if (typeof sdp !== 'string') return sdp;
    return sdp.split('\r\n').filter((l) => !(l.startsWith('a=candidate:') && ICE_LEAK.test(l))).join('\r\n');
  }

  if (window.RTCPeerConnection) {
    patchMethod(RTCPeerConnection.prototype, 'setLocalDescription', (orig) =>
      function setLocalDescription(desc, ...rest) {
        if (active && cfg.webrtc && desc && desc.sdp) {
          report('webrtc');
          const clean = stripSdp(desc.sdp);
          desc = window.RTCSessionDescription
            ? new RTCSessionDescription({ type: desc.type, sdp: clean })
            : { type: desc.type, sdp: clean };
        }
        return orig.call(this, desc, ...rest);
      });

    const filterCandidate = (ev) =>
      active && cfg.webrtc && ev && ev.candidate && ICE_LEAK.test(ev.candidate.candidate || '');

    const onIceDesc = Object.getOwnPropertyDescriptor(RTCPeerConnection.prototype, 'onicecandidate');
    if (onIceDesc && onIceDesc.configurable) {
      Object.defineProperty(RTCPeerConnection.prototype, 'onicecandidate', {
        configurable: true,
        get() { return this.__fpdOnIce; },
        set(h) {
          this.__fpdOnIce = h;
          onIceDesc.set.call(this, typeof h !== 'function' ? h : function (ev) {
            if (filterCandidate(ev)) { report('webrtc'); return; }
            return h.call(this, ev);
          });
        }
      });
      restore.push(() => { try { Object.defineProperty(RTCPeerConnection.prototype, 'onicecandidate', onIceDesc); } catch (_) {} });
    }

    // addEventListener lives on EventTarget.prototype, not RTCPeerConnection's.
    patchMethod(EventTarget.prototype, 'addEventListener', (orig) =>
      function addEventListener(type, listener, opts) {
        if (type === 'icecandidate' && typeof listener === 'function') {
          return orig.call(this, type, function (ev) {
            if (filterCandidate(ev)) { report('webrtc'); return; }
            return listener.call(this, ev);
          }, opts);
        }
        return orig.call(this, type, listener, opts);
      });
  }

  // ========================================= 9. PASSIVE ENUMERATION / STATE
  // Strict, explicit opt-ins. Do not invent voice/device objects or IDs: native
  // speak()/getUserMedia() remain available, but list-driven UIs may break.
  if (window.SpeechSynthesis) {
    patchMethod(SpeechSynthesis.prototype, 'getVoices', (orig) =>
      function getVoices() {
        const voices = orig.apply(this, arguments); // preserve native brand checks
        if (active && cfg.speechVoices) { report('speechVoices'); return []; }
        return voices;
      });
  }

  if (window.MediaDevices) {
    patchMethod(MediaDevices.prototype, 'enumerateDevices', (orig) =>
      function enumerateDevices() {
        // Never turn a native security/policy rejection into a successful list.
        // Check settings at fulfillment so an in-flight read respects live changes.
        return orig.apply(this, arguments).then((devices) => {
          if (active && cfg.mediaDevices) { report('mediaDevices'); return []; }
          return devices;
        });
      });
  }

  // Keep query() and its actual PermissionStatus objects/events native. Mask
  // passive state reads, not browser grants, request outcomes or support/errors.
  if (window.PermissionStatus) {
    const desc = Object.getOwnPropertyDescriptor(PermissionStatus.prototype, 'state');
    if (desc && desc.get) patchGetter(PermissionStatus.prototype, 'state', function () {
      const state = desc.get.call(this);
      if (active && cfg.permissionStates) { report('permissionStates'); return 'prompt'; }
      return state;
    });
  }
  if (window.Notification) {
    const desc = Object.getOwnPropertyDescriptor(Notification, 'permission');
    if (desc && desc.get) patchGetter(Notification, 'permission', function () {
      const state = desc.get.call(this);
      if (active && cfg.permissionStates) { report('permissionStates'); return 'default'; }
      return state;
    });
  }

  // ============================================== 10. EXPERIMENTAL MATH
  // Coarsen the result, not the inputs or implementation. This is NOT a faithful
  // cross-engine Math replacement: exact identities can change, and arithmetic,
  // WebAssembly and other globals remain native. Off by default for that reason.
  let updateMathRounding = () => {};
  if (window.Math && window.DataView && window.ArrayBuffer) {
    const bits = new DataView(new ArrayBuffer(8));
    const mathRestorers = [];
    let retired = false;
    const removeMath = () => { while (mathRestorers.length) mathRestorers.pop()(); };
    restore.push(() => { retired = true; removeMath(); });
    function roundedMathResult(value) {
      // Preserve native special values, signed zero and integer results.
      if (!Number.isFinite(value) || value === 0 || Number.isInteger(value)) return value;
      bits.setFloat64(0, value, false);
      let high = bits.getUint32(0, false);
      if (((high >>> 20) & 0x7ff) === 0) return value; // preserve subnormals too
      const low = bits.getUint32(4, false);
      const discarded = low & 0xfff;
      let rounded = (low & 0xfffff000) >>> 0;
      // Keep 40 fraction bits (41 significant bits for normal doubles), rounding
      // to nearest, ties to even. Relative error is at most roughly 2^-41.
      if (discarded > 0x800 || (discarded === 0x800 && (rounded & 0x1000))) {
        rounded += 0x1000;
        if (rounded > 0xffffffff) { rounded = 0; high++; }
      }
      bits.setUint32(0, high, false);
      bits.setUint32(4, rounded, false);
      return bits.getFloat64(0, false);
    }

    // Leave native Math identities/JIT intrinsics alone while the option is off.
    // Once allowlisting restores the whole page, wait for reload like other hooks.
    updateMathRounding = () => {
      if (retired || !(active && cfg.mathRounding)) { removeMath(); return; }
      if (mathRestorers.length) return;
      for (const name of ['acos', 'acosh', 'asin', 'asinh', 'atan', 'atanh', 'atan2',
                          'cos', 'cosh', 'exp', 'expm1', 'log', 'log1p', 'log2', 'log10',
                          'sin', 'sinh', 'tan', 'tanh', 'pow', 'sqrt', 'cbrt', 'hypot']) {
        // A Proxy keeps native non-constructibility, name/length and call behavior.
        patchMethod(Math, name, (orig) => new Proxy(orig, {
          apply(target, receiver, args) {
            const value = Reflect.apply(target, receiver, args); // coerce inputs once
            if (retired || !(active && cfg.mathRounding)) return value;
            const rounded = roundedMathResult(value);
            if (!Object.is(rounded, value)) report('mathRounding');
            return rounded;
          }
        }), mathRestorers);
      }
    };
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
    updateMathRounding();
  });

  try {
    document.dispatchEvent(new CustomEvent('__fpd_ready'));
  } catch (_) {}
})();