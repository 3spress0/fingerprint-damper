/* Fingerprint Damper — API-level anti-fingerprinting for Firefox.
 * Copyright (C) 2026 espress0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Loaded before inject.js so these are native references, not a second patched
// realm. The installed extension must be disabled when running this fixture.
(() => {
  'use strict';
  const summary = document.getElementById('summary');
  if (window.__fpDamperInstalled) {
    summary.textContent = 'Disable the installed extension and reload: native methods were already patched.';
    summary.className = 'fail';
    return;
  }
  const native = {
    elementBounds: Element.prototype.getBoundingClientRect,
    elementRects: Element.prototype.getClientRects,
    rangeBounds: Range.prototype.getBoundingClientRect,
    rangeRects: Range.prototype.getClientRects,
    number: Number.prototype.toLocaleString,
    date: Date.prototype.toLocaleString,
    intl: Object.fromEntries(Object.getOwnPropertyNames(Intl).map((name) => [name, Intl[name]])),
    fontFace: window.FontFace,
    fontCheck: document.fonts && document.fonts.check,
    voices: window.SpeechSynthesis && SpeechSynthesis.prototype.getVoices,
    speak: window.SpeechSynthesis && SpeechSynthesis.prototype.speak,
    devices: window.MediaDevices && MediaDevices.prototype.enumerateDevices,
    capture: navigator.mediaDevices && navigator.mediaDevices.getUserMedia,
    battery: navigator.getBattery,
    batteryValues: window.BatteryManager && Object.fromEntries(['charging', 'chargingTime', 'dischargingTime', 'level']
      .map(name => [name, Object.getOwnPropertyDescriptor(BatteryManager.prototype, name)])),
    query: navigator.permissions && navigator.permissions.query,
    state: window.PermissionStatus && Object.getOwnPropertyDescriptor(PermissionStatus.prototype, 'state'),
    notification: window.Notification && Object.getOwnPropertyDescriptor(Notification, 'permission'),
    request: window.Notification && Notification.requestPermission,
    hardware: window.Navigator && Object.getOwnPropertyDescriptor(Navigator.prototype, 'hardwareConcurrency'),
    deviceMemory: window.Navigator && Object.getOwnPropertyDescriptor(Navigator.prototype, 'deviceMemory'),
    deviceMemoryPresent: 'deviceMemory' in navigator,
    webgl: window.WebGLRenderingContext && {
      getExtension: WebGLRenderingContext.prototype.getExtension,
      getSupportedExtensions: WebGLRenderingContext.prototype.getSupportedExtensions,
      readPixels: WebGLRenderingContext.prototype.readPixels
    },
    webrtc: window.RTCPeerConnection && {
      setLocalDescription: RTCPeerConnection.prototype.setLocalDescription,
      createOffer: RTCPeerConnection.prototype.createOffer,
      createAnswer: RTCPeerConnection.prototype.createAnswer,
      getStats: RTCPeerConnection.prototype.getStats,
      onicecandidate: Object.getOwnPropertyDescriptor(RTCPeerConnection.prototype, 'onicecandidate')
    },
    math: Object.fromEntries(Object.getOwnPropertyNames(Math).map(name => [name, Math[name]])),
    worker: window.Worker, sharedWorker: window.SharedWorker
  };
  const fields = ['x', 'y', 'width', 'height', 'left', 'right', 'top', 'bottom'];
  const snapshot = (rect) => fields.map((key) => rect[key]);
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const equal = (a, b, message) => assert(JSON.stringify(a) === JSON.stringify(b), message);
  const close = (a, b) => assert(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
  const skip = message => { const error = new Error(message); error.skipped = true; throw error; };
  const settings = (value) => document.dispatchEvent(new CustomEvent('__fpd_config', {
    detail: JSON.stringify({ settings: value, salt: 'browser-regression-session' })
  }));

  window.addEventListener('load', async () => {
    const results = [];
    async function check(name, run) {
      const li = document.createElement('li');
      try {
        await run();
        li.textContent = 'PASS — ' + name;
        li.className = 'pass';
        results.push({ name, passed: true });
      } catch (error) {
        li.textContent = (error.skipped ? 'SKIP — ' : 'FAIL — ') + name + ': ' + error.message;
        li.className = error.skipped ? 'skip' : 'fail';
        results.push({ name, passed: error.skipped ? null : false, skipped: !!error.skipped, error: error.message });
      }
      document.getElementById('results').appendChild(li);
    }
    const node = document.getElementById('text-probe');
    const range = document.createRange();
    range.selectNodeContents(node);
    settings({ canvas: false, geometry: false, stats: false });

    await check('New protections are off by default', () => {
      equal(snapshot(node.getBoundingClientRect()), snapshot(native.elementBounds.call(node)), 'element bounds changed');
      equal(snapshot(range.getBoundingClientRect()), snapshot(native.rangeBounds.call(range)), 'range bounds changed');
      equal((12345.6).toLocaleString(), native.number.call(12345.6), 'default number formatting changed');
      assert(Math.sin === native.math.sin, 'disabled Math control replaced a native function');
      if (native.notification) equal(Notification.permission, native.notification.get.call(Notification), 'default permission state changed');
    });

    settings({ clientRects: true });
    for (const [name, target, rawBounds] of [
      ['Element', node, native.elementBounds], ['Range', range, native.rangeBounds]
    ]) {
      await check(name + ' returns stable, native, coherent rectangle snapshots', () => {
        const raw = rawBounds.call(target);
        const bounds = target.getBoundingClientRect();
        assert(bounds instanceof DOMRect, 'bounding rect lost its native type');
        assert(bounds.width !== raw.width, 'width was not damped');
        for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(bounds[key] - raw[key]) < 0.011, key + ' noise too large');
        equal(snapshot(bounds), snapshot(target.getBoundingClientRect()), 'repeated read drifted');
        const list = target.getClientRects();
        assert(list instanceof DOMRectList && list.length > 1, 'expected a native multiline rect list');
        assert(DOMRectList.prototype.item.call(list, 0) === list[0], 'native item() or identity broken');
        assert(list.item(list.length) === null && [...list][0] === list[0], 'list iteration/bounds broken');
        for (const rect of list) {
          close(rect.right, rect.x + rect.width);
          close(rect.bottom, rect.y + rect.height);
          equal(rect.toJSON().width, rect.width, 'native JSON disagrees');
        }
        close(Math.min(...Array.from(list, r => r.left)), bounds.left);
        close(Math.max(...Array.from(list, r => r.right)), bounds.right);
        close(Math.min(...Array.from(list, r => r.top)), bounds.top);
        close(Math.max(...Array.from(list, r => r.bottom)), bounds.bottom);
      });
    }

    await check('Empty elements and collapsed ranges retain zero dimensions', () => {
      const empty = document.getElementById('empty-probe');
      equal(snapshot(empty.getBoundingClientRect()), snapshot(native.elementBounds.call(empty)), 'empty bounds changed');
      assert(empty.getClientRects().length === 0, 'empty rect list changed');
      const caret = range.cloneRange();
      caret.collapse(true);
      const raw = native.rangeBounds.call(caret);
      const rect = caret.getBoundingClientRect();
      assert((raw.width === 0) === (rect.width === 0), 'collapsed width became nonzero');
      assert((raw.height === 0) === (rect.height === 0), 'collapsed height became nonzero');
    });

    await check('WebGL debug metadata is withheld without changing unrelated extensions', () => {
      if (!native.webgl || !native.webgl.getExtension || !native.webgl.getSupportedExtensions || !window.WebGLRenderingContext) {
        skip('WebGL debug APIs are unavailable.');
      }
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl');
      if (!gl) skip('A WebGL context is unavailable.');
      const advertised = native.webgl.getSupportedExtensions.call(gl) || [];
      if (!advertised.includes('WEBGL_debug_renderer_info')) skip('Debug renderer extension is unavailable.');
      assert(gl.getExtension('WEBGL_debug_renderer_info') === null, 'debug extension remains visible');
      assert(!(gl.getSupportedExtensions() || []).includes('WEBGL_debug_renderer_info'), 'debug extension remains advertised');
      assert((gl.getSupportedExtensions() || []).every(name => advertised.includes(name)), 'an unrelated extension was invented');
    });

    await check('WebGL standard byte readback is stable, bounded and can be disabled', () => {
      if (!native.webgl || !native.webgl.readPixels || !window.WebGLRenderingContext) {
        skip('WebGL readPixels is unavailable.');
      }
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl');
      if (!gl) skip('A WebGL context is unavailable.');
      gl.clearColor(0.25, 0.5, 0.75, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const raw = new Uint8Array(4 * 4 * 4);
      const first = new Uint8Array(raw.length);
      const second = new Uint8Array(raw.length);
      native.webgl.readPixels.call(gl, 0, 0, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, raw);
      gl.readPixels(0, 0, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, first);
      gl.readPixels(0, 0, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, second);
      assert(first.some((value, index) => index % 4 !== 3 && value !== raw[index]), 'no colour byte changed');
      for (let index = 3; index < raw.length; index += 4) assert(first[index] === raw[index], 'alpha changed');
      equal(Array.from(first), Array.from(second), 'readback noise drifted');
      settings({ webgl: false });
      const restored = new Uint8Array(raw.length);
      gl.readPixels(0, 0, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, restored);
      equal(Array.from(restored), Array.from(raw), 'native WebGL readback was not restored');
      settings({ webgl: true });
    });

    await check('Hardware capacity normalisation only masks APIs the browser already exposes', () => {
      if (!native.hardware || !native.hardware.get) skip('hardwareConcurrency is unavailable or unpatchable.');
      assert(navigator.hardwareConcurrency === 8, 'CPU count was not normalised');
      if (native.deviceMemory && native.deviceMemory.get) {
        assert(navigator.deviceMemory === 8, 'deviceMemory was not normalised');
      } else {
        assert(('deviceMemory' in navigator) === native.deviceMemoryPresent, 'deviceMemory was invented');
      }
    });

    await check('Battery masking keeps a native manager shell and can be disabled', async () => {
      if (!native.battery || !window.BatteryManager || !native.batteryValues ||
          !Object.values(native.batteryValues).every(value => value && value.get)) {
        skip('A patchable Battery API is unavailable.');
      }
      let raw;
      try { raw = await native.battery.call(navigator); }
      catch (e) { skip('Native Battery API is rejected: ' + e.name); }
      const first = await navigator.getBattery();
      const second = await navigator.getBattery();
      assert(first === raw && first === second && first instanceof BatteryManager, 'native battery manager identity/type changed');
      assert(first.charging === true && first.chargingTime === 0 && first.dischargingTime === Infinity && first.level === 1,
        'battery values were not masked');
      settings({ battery: false });
      const restored = await navigator.getBattery();
      assert(restored === raw && restored.charging === native.batteryValues.charging.get.call(raw) &&
        restored.level === native.batteryValues.level.get.call(raw), 'native battery result was not restored');
      settings({ battery: true });
    });

    settings({ language: true, timezone: true });
    await check('Intl constructors use real en-US formatting, including empty/unsupported requests', () => {
      for (const name of ['DateTimeFormat', 'NumberFormat', 'Collator', 'PluralRules', 'RelativeTimeFormat',
                          'ListFormat', 'Segmenter', 'DisplayNames', 'DurationFormat']) {
        if (!Intl[name]) continue;
        const options = name === 'DisplayNames' ? { type: 'language' } : undefined;
        const expected = new native.intl[name]('en-US', options).resolvedOptions().locale;
        for (const locales of [undefined, [], { length: 0 }, 'zz-ZZ']) {
          equal(new Intl[name](locales, options).resolvedOptions().locale, expected, name + ' locale mismatch');
        }
      }
      equal(new Intl.NumberFormat().format(12345.6), new native.intl.NumberFormat('en-US').format(12345.6), 'format still uses native default');
      equal((12345.6).toLocaleString(), native.number.call(12345.6, 'en-US'), 'toLocaleString bypassed locale policy');
      equal('i'.toLocaleUpperCase(), 'I', 'default casing mismatch');
      equal(new Intl.NumberFormat('de-DE').format(12345.6), new native.intl.NumberFormat('de-DE').format(12345.6), 'explicit locale changed');
      equal('i'.toLocaleUpperCase('tr'), '\u0130', 'explicit Turkish casing changed');
      assert(new Intl.NumberFormat().constructor === Intl.NumberFormat, 'prototype constructor bypass');
    });

    await check('UTC changes output, not just metadata; explicit time zones stay native', () => {
      const date = new Date('2026-09-05T23:30:00Z');
      const options = Object.freeze({ dateStyle: 'short', timeStyle: 'long', timeZone: undefined });
      const format = new Intl.DateTimeFormat(undefined, options);
      equal(format.resolvedOptions().timeZone, 'UTC', 'default timezone mismatch');
      equal(format.format(date), new native.intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(date), 'format is not UTC');
      equal(date.toLocaleString(), native.date.call(date, 'en-US', { timeZone: 'UTC' }), 'date toLocaleString bypass');
      const explicit = new Intl.DateTimeFormat('de-DE', { timeZone: 'America/New_York' });
      equal(explicit.resolvedOptions().timeZone, 'America/New_York', 'explicit time zone overwritten');
      equal(new Date(NaN).toLocaleString('bad_tag'), 'Invalid Date', 'invalid-date semantics changed');
    });

    await check('Local fonts are audited, not falsely reported as protected', async () => {
      assert(FontFace === native.fontFace && document.fonts.check === native.fontCheck, 'unexpected font API patch');
      const audit = await probeLocalFonts();
      document.getElementById('font-audit').textContent = JSON.stringify(audit, null, 2);
      assert(audit.supported, 'FontFace API unavailable');
      assert(audit.missingCheck === true && audit.missingLoaded === false, 'missing-font controls did not match expected semantics');
    });

    settings({ speechVoices: true, mediaDevices: true, permissionStates: true, mathRounding: true });
    await check('Voice enumeration is hidden without replacing speech playback', () => {
      if (!native.voices || !window.speechSynthesis) skip('Speech synthesis is unavailable.');
      const voices = speechSynthesis.getVoices();
      assert(Array.isArray(voices) && voices.length === 0, 'voice list still visible');
      assert(speechSynthesis.speak === native.speak, 'speak() was changed');
    });
    await check('Device enumeration is hidden without invoking or replacing capture', async () => {
      if (!native.devices || !navigator.mediaDevices) skip('Media device API is unavailable.');
      try { await native.devices.call(navigator.mediaDevices); }
      catch (e) { skip('Native enumeration is rejected: ' + e.name); }
      const devices = await navigator.mediaDevices.enumerateDevices();
      assert(Array.isArray(devices) && devices.length === 0, 'device list still visible');
      assert(navigator.mediaDevices.getUserMedia === native.capture, 'capture API was changed');
    });
    await check('Passive permission masking preserves query and native status objects', async () => {
      if (!native.query || !native.state) skip('PermissionStatus API is unavailable.');
      let status;
      try { status = await navigator.permissions.query({ name: 'geolocation' }); }
      catch (e) { skip('Native query is rejected: ' + e.name); }
      assert(status instanceof PermissionStatus, 'status lost its native type');
      equal(status.state, 'prompt', 'permission state was not masked');
      assert(['prompt', 'granted', 'denied'].includes(native.state.get.call(status)), 'native state getter failed');
      assert(navigator.permissions.query === native.query, 'query validation/support behavior was replaced');
      if (native.notification) equal(Notification.permission, 'default', 'notification state was not masked');
      // Do not request any real permissions as part of automatic browser checks.
    });
    await check('Experimental Math rounding is stable, bounded and preserves special values', () => {
      for (const [name, args] of [['sin', [1]], ['exp', [.123]], ['log1p', [.123]], ['sqrt', [2]], ['hypot', [.123, .456]]]) {
        const raw = native.math[name](...args), value = Math[name](...args);
        assert(Math.abs(value - raw) / Math.abs(raw) <= 2 ** -41, 'Math error exceeds budget: ' + name);
        equal(value, Math[name](...args), 'Math result drifted');
      }
      assert(Math.sin(1) !== native.math.sin(1), 'Math sample was not rounded');
      assert(Object.is(Math.sin(-0), -0) && Math.exp(Infinity) === Infinity && Number.isNaN(Math.sqrt(-1)), 'special value changed');
      assert(Math.pow(2, 40) === native.math.pow(2, 40), 'integer result changed');
      assert(Math.random === native.math.random && Math.imul === native.math.imul, 'unrelated Math operation changed');
      let threw = false;
      try { new Math.sin(1); } catch (e) { threw = e instanceof TypeError; }
      assert(threw, 'Math function became constructible');
    });
    await check('Worker constructors remain deliberately unmodified', () => {
      assert(window.Worker === native.worker && window.SharedWorker === native.sharedWorker, 'worker execution was changed');
    });
    settings({ canvas: true });
    try {
      const [page, workers] = await Promise.all([globalThis.__fpdProbeValues(), probeWorkers()]);
      document.getElementById('worker-audit').textContent = JSON.stringify({ page, workers }, null, 2);
    } catch (e) { document.getElementById('worker-audit').textContent = 'Diagnostic error: ' + e.message; }

    settings({ clientRects: false, language: false, timezone: false, speechVoices: false,
      mediaDevices: false, permissionStates: false, mathRounding: false });
    await check('Turning settings off returns native results', () => {
      equal(snapshot(node.getBoundingClientRect()), snapshot(native.elementBounds.call(node)), 'rect setting did not turn off');
      equal((12345.6).toLocaleString(), native.number.call(12345.6), 'locale setting did not turn off');
      equal(new Intl.DateTimeFormat().resolvedOptions().timeZone, new native.intl.DateTimeFormat().resolvedOptions().timeZone, 'timezone setting did not turn off');
      equal(Math.sin(1), native.math.sin(1), 'Math setting did not turn off');
      if (native.notification) equal(Notification.permission, native.notification.get.call(Notification), 'permission state did not turn off');
    });

    await check('Pausing passes calls through while hooks stay installed (v1.2 semantics)', () => {
      document.dispatchEvent(new CustomEvent('__fpd_config', { detail: JSON.stringify({ allowlisted: true }) }));
      // Hooks must NOT be uninstalled: every surface stays wrapped.
      assert(Element.prototype.getClientRects !== native.elementRects, 'Element hook was uninstalled');
      assert(Range.prototype.getClientRects !== native.rangeRects, 'Range hook was uninstalled');
      assert(Intl.NumberFormat !== native.intl.NumberFormat, 'Intl constructor hook was uninstalled');
      assert(Number.prototype.toLocaleString !== native.number && Date.prototype.toLocaleString !== native.date,
        'locale method hooks were uninstalled');
      if (native.voices) assert(SpeechSynthesis.prototype.getVoices !== native.voices, 'voice hook was uninstalled');
      if (native.devices) assert(MediaDevices.prototype.enumerateDevices !== native.devices, 'device hook was uninstalled');
      if (native.battery) assert(navigator.getBattery !== native.battery, 'battery hook was uninstalled');
      if (native.request) assert(Notification.requestPermission !== native.request, 'notification request hook was uninstalled');
      if (native.webgl) {
        assert(WebGLRenderingContext.prototype.getExtension !== native.webgl.getExtension,
          'WebGL getExtension hook was uninstalled');
        assert(WebGLRenderingContext.prototype.readPixels !== native.webgl.readPixels,
          'WebGL readPixels hook was uninstalled');
      }
      if (native.webrtc) {
        assert(RTCPeerConnection.prototype.setLocalDescription !== native.webrtc.setLocalDescription,
          'WebRTC setLocalDescription hook was uninstalled');
      }
      // Behaviour passes through: settings were turned off in the previous
      // step, so every read must match the saved native outputs.
      equal(snapshot(node.getBoundingClientRect()), snapshot(native.elementBounds.call(node)),
        'paused rects are not native');
      equal((12345.6).toLocaleString(), native.number.call(12345.6), 'paused locale is not native');
      equal(Math.sin(1), native.math.sin(1), 'paused Math is not native');
      // Resuming is a flag flip: the still-installed hooks re-arm in place.
      document.dispatchEvent(new CustomEvent('__fpd_config', { detail: JSON.stringify({ allowlisted: false }) }));
      assert(Element.prototype.getClientRects !== native.elementRects, 'hook lost on resume');
      equal(Math.sin(1), native.math.sin(1), 'Math rounding stays off until opted in again');
      // Forged pause shapes cannot flip the flag.
      document.dispatchEvent(new CustomEvent('__fpd_config', { detail: JSON.stringify({ allowlisted: { forged: 1 } }) }));
      assert(Element.prototype.getClientRects !== native.elementRects, 'forged pause shape was honoured');
    });
    const failed = results.filter(r => r.passed === false).length;
    const skipped = results.filter(r => r.skipped).length;
    summary.textContent = `${results.length - failed - skipped} passed; ${failed} failed; ${skipped} skipped.`;
    summary.className = failed ? 'fail' : 'pass';
    summary.dataset.failed = String(failed);
    window.__fpdBrowserResults = results;
  }, { once: true });
})();
