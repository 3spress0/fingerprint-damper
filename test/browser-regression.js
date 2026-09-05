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
    query: navigator.permissions && navigator.permissions.query,
    state: window.PermissionStatus && Object.getOwnPropertyDescriptor(PermissionStatus.prototype, 'state'),
    notification: window.Notification && Object.getOwnPropertyDescriptor(Notification, 'permission'),
    request: window.Notification && Notification.requestPermission,
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

    await check('Allowlisting restores original methods and constructor descriptors', () => {
      document.dispatchEvent(new CustomEvent('__fpd_config', { detail: JSON.stringify({ allowlisted: true }) }));
      assert(Element.prototype.getClientRects === native.elementRects, 'Element method not restored');
      assert(Range.prototype.getClientRects === native.rangeRects, 'Range method not restored');
      assert(Intl.NumberFormat === native.intl.NumberFormat, 'Intl constructor not restored');
      assert(Intl.NumberFormat.prototype.constructor === native.intl.NumberFormat, 'prototype constructor not restored');
      assert(Number.prototype.toLocaleString === native.number && Date.prototype.toLocaleString === native.date, 'built-in formatting methods not restored');
      if (native.voices) assert(SpeechSynthesis.prototype.getVoices === native.voices, 'voice method not restored');
      if (native.devices) assert(MediaDevices.prototype.enumerateDevices === native.devices, 'device method not restored');
      if (native.state) assert(Object.getOwnPropertyDescriptor(PermissionStatus.prototype, 'state').get === native.state.get, 'permission getter not restored');
      if (native.notification) assert(Object.getOwnPropertyDescriptor(Notification, 'permission').get === native.notification.get, 'notification getter not restored');
      if (native.request) assert(Notification.requestPermission === native.request, 'request method not restored');
      assert(Math.sin === native.math.sin && Math.pow === native.math.pow, 'Math methods not restored');
    });
    const failed = results.filter(r => r.passed === false).length;
    const skipped = results.filter(r => r.skipped).length;
    summary.textContent = `${results.length - failed - skipped} passed; ${failed} failed; ${skipped} skipped.`;
    summary.className = failed ? 'fail' : 'pass';
    summary.dataset.failed = String(failed);
    window.__fpdBrowserResults = results;
  }, { once: true });
})();
